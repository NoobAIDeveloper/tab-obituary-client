import { describe, expect, it } from 'vitest';
import { canonicalDomain, isValidBlocklistDomain } from './url-normalize.js';

describe('canonicalDomain', () => {
  describe('original coverage (kept for regression)', () => {
    it('returns eTLD+1 for standard http(s) URLs', () => {
      expect(canonicalDomain('https://news.ycombinator.com/item?id=1')).toBe('ycombinator.com');
      expect(canonicalDomain('https://m.bbc.co.uk/news/x')).toBe('bbc.co.uk');
    });

    it('falls back to hostname (www-stripped) for non-public-suffix hosts', () => {
      expect(canonicalDomain('chrome://newtab')).toBe('newtab');
      expect(canonicalDomain('http://127.0.0.1:3000')).toBe('127.0.0.1');
      expect(canonicalDomain('http://localhost')).toBe('localhost');
    });

    it('returns null for unparseable / opaque-scheme inputs', () => {
      expect(canonicalDomain('not a url')).toBeNull();
      expect(canonicalDomain('')).toBeNull();
      expect(canonicalDomain('about:blank')).toBeNull();
    });
  });

  describe('standard eTLD+1 extraction', () => {
    it('reduces wikipedia subdomains to wikipedia.org', () => {
      expect(canonicalDomain('https://en.wikipedia.org/wiki/X')).toBe('wikipedia.org');
    });

    it('reduces multi-label subdomains to registrable domain', () => {
      // a.b.c.d.example.com -> example.com (tldts strips all subdomain labels).
      expect(canonicalDomain('https://a.b.c.d.example.com/x')).toBe('example.com');
    });

    it('handles multi-part public suffixes (example.co.uk)', () => {
      // .co.uk is itself a public suffix, so registrable = example.co.uk.
      expect(canonicalDomain('https://subdomain.example.co.uk/path')).toBe('example.co.uk');
    });

    it('is case-insensitive on the hostname', () => {
      expect(canonicalDomain('https://WWW.EXAMPLE.COM/x')).toBe('example.com');
    });

    it('strips www. via tldts (not the fallback)', () => {
      // tldts already returns the registrable form without www; our fallback only
      // triggers when tldts returns null.
      expect(canonicalDomain('https://www.example.com/x')).toBe('example.com');
    });

    it('ignores explicit ports', () => {
      expect(canonicalDomain('https://example.com:8443/x')).toBe('example.com');
    });

    it('ignores userinfo in URL', () => {
      expect(canonicalDomain('https://user:pass@example.com/x')).toBe('example.com');
    });

    it('ignores query and fragment', () => {
      expect(canonicalDomain('https://example.com/?a=b#frag')).toBe('example.com');
    });

    it('normalises trailing-dot hostnames', () => {
      // tldts canonicalises `example.com.` -> `example.com`; downstream code can rely
      // on trailing-dot and bare hosts collapsing into one bucket.
      expect(canonicalDomain('https://example.com./x')).toBe('example.com');
    });
  });

  describe('fallback path (tldts returns null)', () => {
    it('returns raw hostname for IPv4 literals (keeps port off)', () => {
      expect(canonicalDomain('http://127.0.0.1:3000/foo')).toBe('127.0.0.1');
    });

    it('returns raw hostname for localhost with port', () => {
      expect(canonicalDomain('http://localhost:8080/x')).toBe('localhost');
    });

    it('returns the browser-scheme hostname (chrome://newtab)', () => {
      expect(canonicalDomain('chrome://newtab/')).toBe('newtab');
    });

    it('returns the bracketed IPv6 hostname verbatim', () => {
      // tldts returns null for IPv6; URL.hostname preserves the brackets as `[::1]`,
      // which we expose unchanged. That's fine for the pipeline's bucketing purposes.
      expect(canonicalDomain('http://[::1]/foo')).toBe('[::1]');
    });

    it('returns the chrome-extension host id as canonical', () => {
      // `chrome-extension://abcdefg/popup.html` — tldts null, URL.hostname = 'abcdefg'.
      // So the extension id becomes the canonical bucket.
      expect(canonicalDomain('chrome-extension://abcdefg/popup.html')).toBe('abcdefg');
    });
  });

  describe('null-returning inputs', () => {
    it('returns null for file:// (empty hostname)', () => {
      expect(canonicalDomain('file:///Users/bharat/doc.pdf')).toBeNull();
    });

    it('returns null for about:blank', () => {
      expect(canonicalDomain('about:blank')).toBeNull();
    });

    it('returns null for javascript: pseudo-URL', () => {
      expect(canonicalDomain('javascript:void(0)')).toBeNull();
    });

    it('returns null for data: URL', () => {
      expect(canonicalDomain('data:text/html,<h1>hi</h1>')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(canonicalDomain('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(canonicalDomain('  ')).toBeNull();
    });

    it('returns null for junk non-URL strings', () => {
      expect(canonicalDomain('not a url at all')).toBeNull();
    });
  });

  describe('documented surprising / judgement-call behaviours', () => {
    it('mailto: URLs yield the user@host eTLD+1 via tldts, NOT null', () => {
      // Surprising: tldts pulls `example.com` out of `mailto:user@example.com` even
      // though URL.hostname is empty. The code agent flagged this as "null" in the
      // spec comment, but the implementation + tldts actually returns `example.com`.
      // For the Stage-2 candidate pipeline this is benign — browsing events are
      // logged with http(s) URLs, mailto: never reaches the session store.
      expect(canonicalDomain('mailto:user@example.com')).toBe('example.com');
    });

    it('preserves unicode IDN host (does not punycode)', () => {
      // tldts returns the unicode eTLD+1 as typed. Downstream consumers must not
      // assume ASCII-only — but for bucket equality this is stable.
      expect(canonicalDomain('https://münchen.de/x')).toBe('münchen.de');
    });

    it('keeps punycode host in its punycode form', () => {
      // Already-ASCII-encoded IDN stays ASCII.
      expect(canonicalDomain('https://xn--mnchen-3ya.de/x')).toBe('xn--mnchen-3ya.de');
    });
  });

  describe('resilience', () => {
    it('does not throw on exceptionally long input', () => {
      // Defensive: tldts/URL should handle long strings. Contract we care about:
      // the call completes without throwing and returns string-or-null. (tldts
      // treats over-long labels as non-registrable and may return the raw
      // hostname; we don't want to pin the exact string here since label-length
      // handling is a library detail.)
      const long = `https://${'a'.repeat(5000)}.example.com/`;
      const result = canonicalDomain(long);
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it('does not throw on bidi / control characters in hostname', () => {
      // Bidi marks in the input: implementation MUST NOT throw. We don't assert
      // the exact return value (it varies by tldts/URL normalisation), only that
      // the call completes and the result is string-or-null.
      const input = 'https://\u202Eexample.com/x';
      const result = canonicalDomain(input);
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });
});

describe('isValidBlocklistDomain', () => {
  it('accepts a bare eTLD+1 with a dot', () => {
    expect(isValidBlocklistDomain('example.com')).toBe(true);
    expect(isValidBlocklistDomain('bbc.co.uk')).toBe(true);
  });

  it('accepts localhost as a single-label allowlisted host', () => {
    expect(isValidBlocklistDomain('localhost')).toBe(true);
  });

  it('accepts an IPv4 literal', () => {
    expect(isValidBlocklistDomain('127.0.0.1')).toBe(true);
    expect(isValidBlocklistDomain('10.0.0.1')).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidBlocklistDomain(null)).toBe(false);
  });

  it('rejects whitespace-containing strings', () => {
    expect(isValidBlocklistDomain('not a domain')).toBe(false);
    expect(isValidBlocklistDomain('example .com')).toBe(false);
  });

  it('rejects single-label junk without allowlist', () => {
    expect(isValidBlocklistDomain('foo')).toBe(false);
    expect(isValidBlocklistDomain('https')).toBe(false);
  });

  it('rejects too-short strings', () => {
    expect(isValidBlocklistDomain('')).toBe(false);
    expect(isValidBlocklistDomain('ab')).toBe(false);
  });
});
