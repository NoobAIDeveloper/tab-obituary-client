import { getDomain } from 'tldts';

/**
 * Extract a canonical domain from a URL string.
 *
 * Primary path: `tldts.getDomain` returns the registrable eTLD+1 for standard http(s) URLs:
 *   - `https://m.bbc.co.uk/news/x` -> `bbc.co.uk`
 *   - `https://news.ycombinator.com/item?id=1` -> `ycombinator.com`
 *
 * Fallback path (when `getDomain` returns null — e.g. IPs, single-label hosts, browser/app
 * schemes): use `new URL(rawUrl).hostname.toLowerCase()` with a leading `www.` stripped:
 *   - `http://127.0.0.1:3000` -> `127.0.0.1`
 *   - `http://localhost` -> `localhost`
 *   - `chrome://newtab` -> `newtab`
 *
 * Returns `null` if both paths fail (e.g. unparseable strings, opaque schemes like
 * `file://`, `about:blank`, `javascript:` whose URL hostname is empty).
 *
 * Pure: no side-effects, no globals, no exceptions escape.
 */
export function canonicalDomain(rawUrl: string): string | null {
  try {
    const etld1 = getDomain(rawUrl);
    if (etld1) return etld1;
  } catch {
    // tldts is defensive, but swallow anything anyway so we can try the fallback.
  }

  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (!host) return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const BLOCKLIST_ALLOWLIST = new Set(['localhost']);

/**
 * Decide whether a `canonicalDomain` output is acceptable as a blocklist key.
 *
 * A valid blocklist key must be a plausible host bucket:
 *   - non-null, whitespace-free, length >= 3
 *   - contains a dot (e.g. `example.com`, `bbc.co.uk`) OR is a known single-label
 *     host we want to support (`localhost`) OR a bare IPv4 literal
 *
 * This rejects degenerate outputs like `"https"` (scheme-only retry fallout),
 * `"not a domain"` (free-text), or `"foo"` (single-label non-host).
 *
 * Pure; does not mutate.
 */
export function isValidBlocklistDomain(canonical: string | null): canonical is string {
  if (canonical === null) return false;
  if (canonical.length < 3) return false;
  if (/\s/.test(canonical)) return false;
  if (BLOCKLIST_ALLOWLIST.has(canonical)) return true;
  if (IPV4_RE.test(canonical)) return true;
  return canonical.includes('.');
}
