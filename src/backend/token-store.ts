/**
 * Small wrapper around `chrome.storage.local` for the backend auth token.
 *
 * The `clientToken` is minted by the Worker's `POST /subscribe` handler and
 * is the bearer credential for every authenticated backend call. It is
 * encrypted at rest with AES-GCM under a per-install random 256-bit key
 * stored alongside it in `chrome.storage.local` (`__tokenCryptoKey`).
 *
 * Threat model note: the key is itself unencrypted, so an attacker with
 * full disk access gets both halves and can decrypt. This is defense in
 * depth against casual disk inspection, filesystem backup leaks, and cloud
 * sync artifacts — NOT protection from a full forensic image. It does stop
 * plaintext bearer tokens showing up in `grep` / file-content search.
 *
 * The surface is intentionally tiny (get/set/clear) so unit tests can stub
 * `chrome.storage.local` with a plain object and not need a full MV3 harness.
 * When `chrome.storage.local` isn't available (non-extension contexts like
 * vitest without a mock), reads short-circuit to `null` and writes/clears
 * no-op — the same forgiving style used by `popup/router.ts` for the popup
 * route key. That keeps the client usable in preview code paths that might
 * run under happy-dom without a chrome mock installed. Web Crypto missing
 * is treated the same way (reads → null, writes no-op) so the extension
 * never crashes in a degraded runtime.
 */

import { hasChromeStorage } from '../lib/chrome-env.js';

const CLIENT_TOKEN_KEY = 'clientToken';
const CRYPTO_KEY_STORAGE_KEY = '__tokenCryptoKey';
const WIRE_VERSION = 1;

interface EncryptedEnvelope {
  v: typeof WIRE_VERSION;
  iv: string;
  ct: string;
}

function hasSubtleCrypto(): boolean {
  return (
    typeof globalThis.crypto !== 'undefined' &&
    globalThis.crypto.subtle !== undefined
  );
}

// ---------------------------------------------------------------------------
// base64url (no padding)
// ---------------------------------------------------------------------------

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] as number);
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  // Re-pad to a multiple of 4 so atob is happy.
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + '='.repeat(padLen));
  // Back by a concrete ArrayBuffer (not ArrayBufferLike) so Web Crypto's
  // `BufferSource` parameter type accepts the result in strict TS.
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

async function loadExistingKey(): Promise<CryptoKey | null> {
  try {
    const out = await chrome.storage.local.get(CRYPTO_KEY_STORAGE_KEY);
    const raw = out[CRYPTO_KEY_STORAGE_KEY];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object') return null;
    return await globalThis.crypto.subtle.importKey(
      'jwk',
      raw as JsonWebKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    return null;
  }
}

async function generateAndPersistKey(): Promise<CryptoKey | null> {
  try {
    const key = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', key);
    await chrome.storage.local.set({ [CRYPTO_KEY_STORAGE_KEY]: jwk });
    return key;
  } catch {
    return null;
  }
}

async function getOrCreateKey(): Promise<CryptoKey | null> {
  const existing = await loadExistingKey();
  if (existing !== null) return existing;
  return generateAndPersistKey();
}

// ---------------------------------------------------------------------------
// Envelope shape helpers
// ---------------------------------------------------------------------------

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['v'] === WIRE_VERSION &&
    typeof obj['iv'] === 'string' &&
    typeof obj['ct'] === 'string' &&
    (obj['iv'] as string).length > 0 &&
    (obj['ct'] as string).length > 0
  );
}

async function decryptEnvelope(
  env: EncryptedEnvelope,
): Promise<string | null> {
  const key = await loadExistingKey();
  if (key === null) return null;
  try {
    const iv = b64UrlToBytes(env.iv);
    const ct = b64UrlToBytes(env.ct);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

async function encryptToken(
  token: string,
): Promise<EncryptedEnvelope | null> {
  const key = await getOrCreateKey();
  if (key === null) return null;
  try {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ptBytes = new TextEncoder().encode(token);
    const ctBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      ptBytes,
    );
    return {
      v: WIRE_VERSION,
      iv: bytesToB64Url(iv),
      ct: bytesToB64Url(new Uint8Array(ctBuf)),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getClientToken(): Promise<string | null> {
  if (!hasChromeStorage()) return null;
  try {
    const out = await chrome.storage.local.get(CLIENT_TOKEN_KEY);
    const raw = out[CLIENT_TOKEN_KEY];

    // Legacy plaintext path — tokens written before at-rest encryption. Remove after two weekly-report cycles post-launch (all active users will have re-opened the popup and rewritten to envelope form).
    if (typeof raw === 'string') {
      if (raw.length === 0) return null;
      // Re-encrypt on the fly so the next read is covered. Best-effort —
      // if Web Crypto is missing we still return the plaintext so the
      // client doesn't spuriously lose auth.
      if (hasSubtleCrypto()) {
        // Fire-and-await: we don't want to return before the rewrite lands,
        // otherwise a caller who immediately reads again would see the
        // plaintext and re-encrypt twice. Failures inside are swallowed.
        const envelope = await encryptToken(raw);
        if (envelope !== null) {
          try {
            await chrome.storage.local.set({
              [CLIENT_TOKEN_KEY]: envelope,
            });
          } catch {
            // Ignore — legacy value still readable next time.
          }
        }
      }
      return raw;
    }

    if (isEnvelope(raw)) {
      if (!hasSubtleCrypto()) return null;
      return await decryptEnvelope(raw);
    }

    return null;
  } catch {
    // Storage can reject if the extension context is torn down mid-read
    // (e.g. during an update). Treat as "no token" — the caller will get a
    // 401-shaped `ApiResult` and surface a re-auth prompt.
    return null;
  }
}

export async function setClientToken(token: string): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    if (!hasSubtleCrypto()) {
      // Degraded runtime: skip persistence rather than write plaintext
      // under a key that's supposed to be encrypted post-11.2a.
      return;
    }
    const envelope = await encryptToken(token);
    if (envelope === null) return;
    await chrome.storage.local.set({ [CLIENT_TOKEN_KEY]: envelope });
  } catch {
    // Best-effort: token persistence is a convenience, not a correctness
    // invariant. If the write fails the user re-authenticates next session.
  }
}

export async function clearClientToken(): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.remove(CLIENT_TOKEN_KEY);
  } catch {
    // Same rationale as setClientToken — best-effort.
  }
  // Intentionally keep `__tokenCryptoKey` so a subsequent set reuses it.
  // Key rotation is out of scope for 11.2a.
}

// Exported for tests that want to assert the storage key without
// hard-coding the literal in every assertion.
export const CLIENT_TOKEN_STORAGE_KEY = CLIENT_TOKEN_KEY;
export const CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY = CRYPTO_KEY_STORAGE_KEY;
