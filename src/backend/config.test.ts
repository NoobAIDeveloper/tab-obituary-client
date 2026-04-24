import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKEND_DEFAULT_BASE_URL,
  getBackendBaseUrl,
  setBackendBaseUrl,
} from './config.js';

// `import.meta.env.VITE_API_URL` is inlined at build time by Vite. In the
// vitest environment it is unset (there's no `VITE_API_URL` in the node
// env, and Vite's preset doesn't define one for this package's test run),
// so the module's default-resolution path returns `DEFAULT_BASE_URL`. Each
// test resets the override afterwards so they don't bleed into each other.

describe('BACKEND_DEFAULT_BASE_URL', () => {
  it('is the wrangler-default dev URL', () => {
    expect(BACKEND_DEFAULT_BASE_URL).toBe('http://localhost:8787');
  });
});

describe('getBackendBaseUrl (default resolution)', () => {
  afterEach(() => {
    setBackendBaseUrl(null);
  });

  it('returns the default when VITE_API_URL is unset', () => {
    setBackendBaseUrl(null);
    expect(getBackendBaseUrl()).toBe('http://localhost:8787');
  });
});

describe('setBackendBaseUrl', () => {
  afterEach(() => {
    setBackendBaseUrl(null);
  });

  it('overrides the base URL returned by getBackendBaseUrl', () => {
    setBackendBaseUrl('https://api.example.com');
    expect(getBackendBaseUrl()).toBe('https://api.example.com');
  });

  it('setBackendBaseUrl(null) restores default resolution', () => {
    setBackendBaseUrl('https://api.example.com');
    expect(getBackendBaseUrl()).toBe('https://api.example.com');
    setBackendBaseUrl(null);
    expect(getBackendBaseUrl()).toBe(BACKEND_DEFAULT_BASE_URL);
  });

  it('preserves the override verbatim (trailing slash from caller is not stripped by the override path)', () => {
    // NOTE: Only the build-time env-var resolver strips trailing slashes.
    // The test hook takes values verbatim — the test agent documents the
    // shipped behavior rather than adding stripping.
    setBackendBaseUrl('https://api.example.com/');
    expect(getBackendBaseUrl()).toBe('https://api.example.com/');
  });

  it('empty-string override is taken verbatim (not treated as default)', () => {
    // Again: the override path is a raw setter. Callers who want "default"
    // pass `null`. Empty string is a meaningful value (albeit a nonsensical
    // URL) and we lock that in so a future refactor is a conscious choice.
    setBackendBaseUrl('');
    expect(getBackendBaseUrl()).toBe('');
  });

  it('subsequent overrides replace earlier ones', () => {
    setBackendBaseUrl('https://one.example.com');
    setBackendBaseUrl('https://two.example.com');
    expect(getBackendBaseUrl()).toBe('https://two.example.com');
  });
});
