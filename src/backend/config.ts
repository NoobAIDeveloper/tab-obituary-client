/**
 * Backend base-URL resolution.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time. We intentionally read
 * it here (once) rather than scattering `import.meta.env` references through
 * the client — gives us a single place to document fallback behavior and
 * makes the value testable via the exported `setBackendBaseUrl` override.
 *
 * Fallback: `http://localhost:8787` is Wrangler's default dev port. Shipping
 * a build without `VITE_API_URL` set would be a deploy bug; we prefer a
 * noisy-but-recoverable dev default over a cryptic undefined-URL fetch error.
 */

// `ImportMeta.env` is injected by Vite at build time. Declare the local
// shape here instead of a global `vite-env.d.ts` so this module stands on
// its own and doesn't silently break if someone removes/moves the ambient
// declaration file later.
interface TabobImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface TabobImportMeta {
  readonly env: TabobImportMetaEnv;
}

const DEFAULT_BASE_URL = 'http://localhost:8787';

function resolveDefaultBaseUrl(): string {
  // `import.meta.env` is a Vite-only field. At typecheck time without
  // Vite's ambient types it's `any`; we cast through a narrow interface
  // so a renamed env key becomes a type error.
  const meta = import.meta as unknown as TabobImportMeta;
  const raw = meta.env?.VITE_API_URL;
  if (typeof raw === 'string' && raw.length > 0) {
    // Strip trailing slash so `${base}/subscribe` never produces a
    // double-slash URL.
    return raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }
  return DEFAULT_BASE_URL;
}

let currentBaseUrl: string = resolveDefaultBaseUrl();

export function getBackendBaseUrl(): string {
  return currentBaseUrl;
}

/**
 * Test hook: override the base URL for unit tests. Production code should
 * never call this. Pass `null` to reset to the build-time default.
 */
export function setBackendBaseUrl(url: string | null): void {
  currentBaseUrl = url === null ? resolveDefaultBaseUrl() : url;
}

export const BACKEND_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
