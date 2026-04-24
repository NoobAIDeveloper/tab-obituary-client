import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY,
  CLIENT_TOKEN_STORAGE_KEY,
  clearClientToken,
  getClientToken,
  setClientToken,
} from './token-store.js';

// Mirror the chrome-stub pattern from popup/router.test.ts — tests need to
// delete the binding (not just assign undefined) so `typeof chrome` reports
// `'undefined'` when we want it to.

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: removing the binding entirely
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

// A minimal in-memory `chrome.storage.local` stub. `get(key)` returns the
// whole store if key omitted, a one-key slice otherwise (mirroring the
// real Chrome API shape that token-store.ts calls into).
function makeStorageStub(seed: Record<string, unknown> = {}): {
  chrome: {
    storage: {
      local: {
        get: ReturnType<typeof vi.fn>;
        set: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
      };
    };
  };
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...seed };
  return {
    data,
    chrome: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => {
            if (key in data) return { [key]: data[key] };
            return {};
          }),
          set: vi.fn(async (patch: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(patch)) data[k] = v;
          }),
          remove: vi.fn(async (key: string) => {
            delete data[key];
          }),
        },
      },
    },
  };
}

describe('CLIENT_TOKEN_STORAGE_KEY', () => {
  it('is the literal "clientToken"', () => {
    expect(CLIENT_TOKEN_STORAGE_KEY).toBe('clientToken');
  });
});

describe('getClientToken', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('returns null when chrome global is absent', async () => {
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('returns null when chrome.storage is absent', async () => {
    setChrome({});
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('returns null when chrome.storage.local is absent', async () => {
    setChrome({ storage: {} });
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('returns null when the stored key is missing', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('returns the stored string token', async () => {
    const stub = makeStorageStub({ clientToken: 'abc123' });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBe('abc123');
  });

  it('returns null when storage.local.get rejects', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockRejectedValue(new Error('ctx gone')),
          set: vi.fn(),
          remove: vi.fn(),
        },
      },
    });
    await expect(getClientToken()).resolves.toBeNull();
  });

  it.each([
    ['number', 42],
    ['boolean true', true],
    ['boolean false', false],
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['object', { token: 'x' }],
    ['array', ['a', 'b']],
  ] as const)(
    'returns null when stored value is a corrupt %s',
    async (_label, value) => {
      const stub = makeStorageStub({ clientToken: value });
      setChrome(stub.chrome);
      await expect(getClientToken()).resolves.toBeNull();
    },
  );

  it('requests the "clientToken" key specifically', async () => {
    const stub = makeStorageStub({ clientToken: 'abc' });
    setChrome(stub.chrome);
    await getClientToken();
    expect(stub.chrome.storage.local.get).toHaveBeenCalledWith('clientToken');
  });
});

describe('setClientToken', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('is a no-op when chrome is undefined', async () => {
    await expect(setClientToken('abc')).resolves.toBeUndefined();
  });

  it('is a no-op when chrome.storage.local is missing', async () => {
    setChrome({ storage: {} });
    await expect(setClientToken('abc')).resolves.toBeUndefined();
  });

  it('persists the token under "clientToken" as an encrypted envelope', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('abc123');
    // The value written under `clientToken` is no longer the plaintext;
    // it's a versioned envelope `{v:1, iv, ct}`. We only assert shape here
    // — the round-trip test below verifies decryption end-to-end.
    const stored = stub.data['clientToken'];
    expect(stored).toMatchObject({
      v: 1,
      iv: expect.any(String),
      ct: expect.any(String),
    });
    expect(stored).not.toBe('abc123');
    // A crypto key should have been persisted alongside the envelope.
    expect(stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]).toBeDefined();
  });

  it('round-trips through getClientToken', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('round-trip');
    await expect(getClientToken()).resolves.toBe('round-trip');
  });

  it('does not throw when storage.local.set rejects', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn(),
          set: vi.fn().mockRejectedValue(new Error('quota')),
          remove: vi.fn(),
        },
      },
    });
    await expect(setClientToken('abc')).resolves.toBeUndefined();
  });
});

describe('clearClientToken', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('is a no-op when chrome is undefined', async () => {
    await expect(clearClientToken()).resolves.toBeUndefined();
  });

  it('is a no-op when chrome.storage.local is missing', async () => {
    setChrome({ storage: {} });
    await expect(clearClientToken()).resolves.toBeUndefined();
  });

  it('removes the "clientToken" key', async () => {
    const stub = makeStorageStub({ clientToken: 'doomed' });
    setChrome(stub.chrome);
    await clearClientToken();
    expect(stub.chrome.storage.local.remove).toHaveBeenCalledWith('clientToken');
    expect('clientToken' in stub.data).toBe(false);
  });

  it('leaves getClientToken returning null after clearing', async () => {
    const stub = makeStorageStub({ clientToken: 'doomed' });
    setChrome(stub.chrome);
    await clearClientToken();
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('does not throw when storage.local.remove rejects', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn(),
          set: vi.fn(),
          remove: vi.fn().mockRejectedValue(new Error('ctx gone')),
        },
      },
    });
    await expect(clearClientToken()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11.2a encryption smoke tests
//
// The comprehensive edge-case coverage comes in the test-agent pass. These
// three tests just prove the module works end-to-end with real Web Crypto.
// ---------------------------------------------------------------------------

describe('token-store encryption (smoke)', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('set-then-get round-trips the original token through encryption', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('super-secret-token-xyz');

    // Storage holds an envelope, not the plaintext.
    const stored = stub.data[CLIENT_TOKEN_STORAGE_KEY];
    expect(stored).not.toBe('super-secret-token-xyz');
    expect(stored).toMatchObject({ v: 1 });

    await expect(getClientToken()).resolves.toBe('super-secret-token-xyz');
  });

  it('returns legacy plaintext and re-encrypts it on the next read', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: 'legacy-plaintext',
    });
    setChrome(stub.chrome);

    // First read: returns plaintext, triggers re-encrypt write.
    await expect(getClientToken()).resolves.toBe('legacy-plaintext');

    // After the read, storage should now hold an envelope under the same key.
    const stored = stub.data[CLIENT_TOKEN_STORAGE_KEY];
    expect(stored).toMatchObject({ v: 1 });

    // Second read: still returns the original plaintext, now via decryption.
    await expect(getClientToken()).resolves.toBe('legacy-plaintext');
  });

  it('returns null when no token has ever been stored', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11.2a encryption — comprehensive edge-case coverage (test-agent pass).
//
// These complement the smoke tests above. Grouped by concern so regressions
// point at the category, not a single assertion.
// ---------------------------------------------------------------------------

describe('token-store encryption: IV and correctness invariants', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('uses a fresh IV per set (no IV reuse — catastrophic GCM break)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    // Encrypt the SAME plaintext twice. Under correct GCM use, IVs must
    // differ, so the ciphertext envelopes must differ even with identical
    // plaintext and the same key.
    await setClientToken('same-plaintext');
    const first = stub.data[CLIENT_TOKEN_STORAGE_KEY] as {
      v: number;
      iv: string;
      ct: string;
    };
    const firstIv = first.iv;
    const firstCt = first.ct;

    await setClientToken('same-plaintext');
    const second = stub.data[CLIENT_TOKEN_STORAGE_KEY] as {
      v: number;
      iv: string;
      ct: string;
    };

    expect(second.iv).not.toBe(firstIv);
    expect(second.ct).not.toBe(firstCt);
  });

  it('generates distinct IVs across many sequential sets', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    const ivs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      await setClientToken(`token-${i}`);
      const env = stub.data[CLIENT_TOKEN_STORAGE_KEY] as { iv: string };
      ivs.add(env.iv);
    }
    expect(ivs.size).toBe(25);
  });

  it('set → clear → get returns null', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('abc');
    await clearClientToken();
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('overwrites the previous token when set is called again', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('first');
    await setClientToken('second');
    await expect(getClientToken()).resolves.toBe('second');
  });

  it('round-trips a 1KB token', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    const big = 'x'.repeat(1024);
    await setClientToken(big);
    await expect(getClientToken()).resolves.toBe(big);
  });

  it('round-trips a 10KB token', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    const huge = 'y'.repeat(10 * 1024);
    await setClientToken(huge);
    await expect(getClientToken()).resolves.toBe(huge);
  });

  it('round-trips a token containing multi-byte unicode', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    const unicode = 'токен-🔒-中文-\u{1F680}';
    await setClientToken(unicode);
    await expect(getClientToken()).resolves.toBe(unicode);
  });

  it('round-trips a token containing NUL bytes and control chars', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    const weird = 'a bcd';
    await setClientToken(weird);
    await expect(getClientToken()).resolves.toBe(weird);
  });

  it('getClientToken on empty storage does not generate a crypto key', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
    // Read-only path: no key generation should have happened.
    expect(stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]).toBeUndefined();
  });

  it('handles concurrent setClientToken calls without corrupting storage', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    // Fire off two sets in parallel. Last write wins; get() must return one
    // of the tokens OR null (if a key/envelope race landed misaligned), and
    // must never throw a TypeError.
    await Promise.all([
      setClientToken('alpha'),
      setClientToken('beta'),
      setClientToken('gamma'),
    ]);

    const result = await getClientToken();
    // Either one of the three values won the race, or they landed in a
    // misaligned state and decryption cleanly yields null.
    expect(result === null || ['alpha', 'beta', 'gamma'].includes(result)).toBe(
      true,
    );
    // And the final envelope is still shape-valid — no torn write.
    const stored = stub.data[CLIENT_TOKEN_STORAGE_KEY];
    if (stored !== undefined) {
      expect(stored).toMatchObject({
        v: 1,
        iv: expect.any(String),
        ct: expect.any(String),
      });
    }
  });

  it('setClientToken("") stores an envelope (decrypts to empty string)', async () => {
    // Empty tokens are a caller-layer concern (client.ts treats '' as no_token
    // in outbound requests). Token-store itself must not special-case '';
    // that invariant is what lets the legacy-migration path distinguish a
    // legacy plaintext from an already-encrypted envelope.
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('');
    const stored = stub.data[CLIENT_TOKEN_STORAGE_KEY];
    expect(stored).toMatchObject({ v: 1 });
    await expect(getClientToken()).resolves.toBe('');
  });
});

describe('token-store encryption: legacy plaintext migration', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('first get returns legacy plaintext and writes the envelope back', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: 'legacy-token',
    });
    setChrome(stub.chrome);

    await expect(getClientToken()).resolves.toBe('legacy-token');

    // After the read, storage must now hold an envelope, not the plaintext.
    const stored = stub.data[CLIENT_TOKEN_STORAGE_KEY];
    expect(typeof stored).toBe('object');
    expect(stored).toMatchObject({ v: 1 });
    // And a crypto key was persisted as a side-effect of the re-encrypt.
    expect(stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]).toBeDefined();
  });

  it('two sequential gets on a legacy value both return the same plaintext', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: 'legacy-both',
    });
    setChrome(stub.chrome);

    const firstRead = await getClientToken();
    const secondRead = await getClientToken();

    expect(firstRead).toBe('legacy-both');
    expect(secondRead).toBe('legacy-both');
    // Second read went through the envelope path — storage is still an envelope.
    expect(stub.data[CLIENT_TOKEN_STORAGE_KEY]).toMatchObject({ v: 1 });
  });

  it('legacy empty string returns null without writing an envelope', async () => {
    const stub = makeStorageStub({ [CLIENT_TOKEN_STORAGE_KEY]: '' });
    setChrome(stub.chrome);

    await expect(getClientToken()).resolves.toBeNull();
    // Empty legacy shouldn't migrate to an envelope — there's nothing to protect.
    expect(stub.data[CLIENT_TOKEN_STORAGE_KEY]).toBe('');
  });

  it('legacy plaintext that looks like JSON is still treated as a string', async () => {
    // Previously a user could have a token that happens to start with `{`.
    // The check is `typeof raw === 'string'`, not JSON.parse — so this must
    // round-trip as plaintext and then re-encrypt to an envelope.
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: '{"not":"an envelope"}',
    });
    setChrome(stub.chrome);

    await expect(getClientToken()).resolves.toBe('{"not":"an envelope"}');
    expect(stub.data[CLIENT_TOKEN_STORAGE_KEY]).toMatchObject({ v: 1 });
  });
});

describe('token-store encryption: malformed stored values', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('unknown wire version v:2 returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 2, iv: 'aaa', ct: 'bbb' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope-ish object missing ct returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: 'aaa' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope-ish object missing iv returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, ct: 'bbb' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope with empty iv returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: '', ct: 'bbb' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope with empty ct returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: 'aaa', ct: '' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope with non-base64url iv/ct returns null (no throw)', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: {
        v: 1,
        iv: '!!!not-base64!!!',
        ct: '###also-bad###',
      },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope shape valid but decryption fails (wrong key) returns null', async () => {
    // Seed a valid-looking envelope produced under a different key. The
    // module generates a fresh key, then tries to decrypt with it — will fail.
    const foreignKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      foreignKey,
      new TextEncoder().encode('victim-plaintext'),
    );
    const b64url = (bytes: Uint8Array): string => {
      let bin = '';
      for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i] as number);
      return btoa(bin)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    };
    const ourKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const ourJwk = await crypto.subtle.exportKey('jwk', ourKey);

    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: {
        v: 1,
        iv: b64url(iv),
        ct: b64url(new Uint8Array(ct)),
      },
      [CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]: ourJwk,
    });
    setChrome(stub.chrome);

    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope present but __tokenCryptoKey missing returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: 'aaaa', ct: 'bbbb' },
      // No CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY seeded.
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('__tokenCryptoKey present but is not an object returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: 'aaaa', ct: 'bbbb' },
      [CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]: 'not-a-jwk',
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('__tokenCryptoKey is a malformed JWK object returns null (no throw)', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: 'aaaa', ct: 'bbbb' },
      [CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]: { kty: 'nonsense', k: 'xxx' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });

  it('envelope with numeric v="1" (string, not number) returns null', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: '1', iv: 'aaaa', ct: 'bbbb' },
    });
    setChrome(stub.chrome);
    await expect(getClientToken()).resolves.toBeNull();
  });
});

describe('token-store encryption: missing crypto.subtle', () => {
  let saved: ChromeHandle;
  const realCrypto = globalThis.crypto;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
    // vi.stubGlobal tracks replacements; unstubAllGlobals restores them.
    vi.unstubAllGlobals();
  });

  function disableSubtle(): void {
    // Stub crypto so `crypto.subtle` is undefined but `crypto.getRandomValues`
    // still works (covers "partial WebCrypto" platforms like older WebViews).
    // `vi.stubGlobal` handles node's getter-only `globalThis.crypto` — a raw
    // assignment throws "Cannot set property crypto ... which has only a getter".
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });
  }

  it('setClientToken is a silent no-op — does NOT write plaintext as a fallback', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    disableSubtle();

    await expect(setClientToken('leaky')).resolves.toBeUndefined();
    // Nothing must have been written under the token key.
    expect(stub.data[CLIENT_TOKEN_STORAGE_KEY]).toBeUndefined();
    // And no crypto key should have been persisted either.
    expect(stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]).toBeUndefined();
  });

  it("getClientToken on an envelope-shaped value returns null (can't decrypt)", async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: { v: 1, iv: 'aaaa', ct: 'bbbb' },
    });
    setChrome(stub.chrome);
    disableSubtle();

    await expect(getClientToken()).resolves.toBeNull();
  });

  it('getClientToken on a LEGACY plaintext returns the plaintext (re-encrypt skipped)', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: 'legacy-still-readable',
    });
    setChrome(stub.chrome);
    disableSubtle();

    // Degraded runtime must not sink auth — return plaintext, leave storage as-is.
    await expect(getClientToken()).resolves.toBe('legacy-still-readable');
    expect(stub.data[CLIENT_TOKEN_STORAGE_KEY]).toBe('legacy-still-readable');
    expect(stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]).toBeUndefined();
  });

  it('when crypto is entirely undefined, all APIs degrade gracefully', async () => {
    const stub = makeStorageStub({
      [CLIENT_TOKEN_STORAGE_KEY]: 'legacy-no-crypto',
    });
    setChrome(stub.chrome);
    vi.stubGlobal('crypto', undefined);

    await expect(getClientToken()).resolves.toBe('legacy-no-crypto');
    await expect(setClientToken('ignored')).resolves.toBeUndefined();
    // set short-circuited, so legacy plaintext is still the stored value.
    expect(stub.data[CLIENT_TOKEN_STORAGE_KEY]).toBe('legacy-no-crypto');
  });
});

describe('clearClientToken: crypto-key retention', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('does NOT remove __tokenCryptoKey (kept for subsequent sets)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    await setClientToken('before-clear');
    const keyBefore = stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY];
    expect(keyBefore).toBeDefined();

    await clearClientToken();

    // Token cleared, but the key remains — next `set` reuses it.
    expect(CLIENT_TOKEN_STORAGE_KEY in stub.data).toBe(false);
    expect(stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY]).toBe(keyBefore);
  });

  it('a set after clear reuses the same crypto key', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    await setClientToken('first');
    const keyBefore = stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY];

    await clearClientToken();
    await setClientToken('second');
    const keyAfter = stub.data[CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY];

    expect(keyAfter).toBe(keyBefore);
    await expect(getClientToken()).resolves.toBe('second');
  });
});

describe('token-store encryption: wire format stability', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('envelope has exactly three keys: v, iv, ct', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('wire-check');
    const env = stub.data[CLIENT_TOKEN_STORAGE_KEY] as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual(['ct', 'iv', 'v']);
  });

  it('envelope v is the number literal 1 (not "1")', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('wire-check');
    const env = stub.data[CLIENT_TOKEN_STORAGE_KEY] as { v: unknown };
    expect(env.v).toBe(1);
    expect(typeof env.v).toBe('number');
  });

  it('envelope iv decodes to a 12-byte value (AES-GCM standard)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('wire-check');
    const env = stub.data[CLIENT_TOKEN_STORAGE_KEY] as { iv: string };
    // Re-pad and decode.
    const b64 = env.iv.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (b64.length % 4)) % 4;
    const bin = atob(b64 + '='.repeat(padLen));
    expect(bin.length).toBe(12);
  });

  it('iv and ct are base64url (no +, /, or = chars)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await setClientToken('wire-check');
    const env = stub.data[CLIENT_TOKEN_STORAGE_KEY] as {
      iv: string;
      ct: string;
    };
    expect(env.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(env.ct).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
