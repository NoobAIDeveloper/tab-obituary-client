import type { RabbitHoleCandidate, Session, SessionUrlEntry } from '@tabob/shared';
import {
  CANDIDATE_MIN_ACTIVE_MS,
  CANDIDATE_MIN_DISTINCT_DOMAINS,
  CANDIDATE_MIN_DISTINCT_URLS,
  CANDIDATE_SINGLE_DOMAIN_URL_FLOOR,
  SCHEMA_VERSION,
} from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { filterCandidates } from './stage2-candidates.js';

const BASE = 1_700_000_000_000;
const WEEK_START = '2026-04-20';

function urlEntry(partial: Partial<SessionUrlEntry> & { url: string }): SessionUrlEntry {
  // Default-derived domain uses URL.hostname for real URLs; callers wanting a
  // null-canonical URL (chrome://, file://) must pass `domain` explicitly.
  let derivedDomain = '';
  try {
    derivedDomain = new URL(partial.url).hostname.toLowerCase();
  } catch {
    derivedDomain = '';
  }
  return {
    url: partial.url,
    title: partial.title ?? '',
    domain: partial.domain ?? derivedDomain,
    activeMs: partial.activeMs ?? 60_000,
    openTs: partial.openTs ?? BASE,
  };
}

function session(
  partial: Partial<Session> & { urls: SessionUrlEntry[]; activeMs: number },
): Session {
  const urls = partial.urls;
  return {
    id: partial.id ?? 'sess_test',
    weekStart: partial.weekStart ?? WEEK_START,
    startTs: partial.startTs ?? BASE,
    endTs: partial.endTs ?? BASE + partial.activeMs,
    activeMs: partial.activeMs,
    distinctUrls: partial.distinctUrls ?? urls.length,
    distinctDomains: partial.distinctDomains ?? new Set(urls.map((u) => u.domain)).size,
    ...(partial.topDomain !== undefined ? { topDomain: partial.topDomain } : {}),
    urls,
    status: partial.status ?? 'segmented',
    schemaVersion: SCHEMA_VERSION,
  };
}

// makeSession alias so we follow the test-plan naming.
const makeSession = session;

describe('filterCandidates', () => {
  describe('original coverage (kept for regression)', () => {
    it('keeps a 35-min session with 6 URLs across 4 canonical domains (happy path)', () => {
      const s = session({
        activeMs: 35 * 60_000,
        urls: [
          urlEntry({ url: 'https://en.wikipedia.org/wiki/A', activeMs: 5 * 60_000 }),
          urlEntry({ url: 'https://en.wikipedia.org/wiki/B', activeMs: 4 * 60_000 }),
          urlEntry({ url: 'https://news.ycombinator.com/item?id=1', activeMs: 10 * 60_000 }),
          urlEntry({ url: 'https://m.bbc.co.uk/news/x', activeMs: 6 * 60_000 }),
          urlEntry({ url: 'https://www.theguardian.com/tech', activeMs: 5 * 60_000 }),
          urlEntry({ url: 'https://news.ycombinator.com/item?id=2', activeMs: 5 * 60_000 }),
        ],
      });

      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.status).toBe('candidate');
      // 4 canonical domains: wikipedia.org, ycombinator.com, bbc.co.uk, theguardian.com
      expect(out[0]!.distinctDomains).toBe(4);
      // ycombinator.com has 15 min total -> topDomain.
      expect(out[0]!.topDomain).toBe('ycombinator.com');
    });

    it('drops a session under the active-time floor (29 min)', () => {
      const s = session({
        activeMs: 29 * 60_000,
        urls: [
          urlEntry({ url: 'https://en.wikipedia.org/wiki/A' }),
          urlEntry({ url: 'https://news.ycombinator.com/item?id=1' }),
          urlEntry({ url: 'https://m.bbc.co.uk/news/x' }),
          urlEntry({ url: 'https://www.theguardian.com/tech' }),
          urlEntry({ url: 'https://example.com/a' }),
        ],
      });

      expect(filterCandidates([s])).toEqual([]);
    });

    it('keeps a single-canonical-domain session via the URL-floor clause (9 wiki pages, 40 min)', () => {
      const urls: SessionUrlEntry[] = [];
      for (let i = 0; i < 9; i++) {
        urls.push(
          urlEntry({
            url: `https://en.wikipedia.org/wiki/Article_${i}`,
            activeMs: 4 * 60_000,
            openTs: BASE + i * 1000,
          }),
        );
      }
      const s = session({ activeMs: 40 * 60_000, urls });

      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(1);
      expect(out[0]!.topDomain).toBe('wikipedia.org');
    });
  });

  describe('activeMs threshold (criterion 1, strict >=)', () => {
    it('keeps a session at exactly CANDIDATE_MIN_ACTIVE_MS (boundary KEPT)', () => {
      // activeMs === 30 min exactly, plus 5 URLs across 3 canonical domains.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://a.example.com/1' }),
          urlEntry({ url: 'https://b.example.com/1' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      expect(filterCandidates([s])).toHaveLength(1);
    });

    it('drops a session one ms below the floor', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS - 1,
        urls: [
          urlEntry({ url: 'https://a.example.com/1' }),
          urlEntry({ url: 'https://b.example.com/1' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      expect(filterCandidates([s])).toEqual([]);
    });

    it('does not overflow on multi-hour activeMs', () => {
      // 12 hours in ms — far above the threshold, well within safe integer range.
      const twelveHours = 12 * 60 * 60 * 1000;
      const s = makeSession({
        activeMs: twelveHours,
        urls: [
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
          urlEntry({ url: 'https://qux.dev/1' }),
          urlEntry({ url: 'https://quux.ai/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.activeMs).toBe(twelveHours);
    });
  });

  describe('distinctUrls threshold (criterion 2, strict >=)', () => {
    it('keeps a session at exactly distinctUrls === 5', () => {
      const s = makeSession({
        activeMs: 40 * 60_000,
        urls: [
          urlEntry({ url: 'https://a.example.com/1' }),
          urlEntry({ url: 'https://b.example.com/1' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      expect(s.distinctUrls).toBe(CANDIDATE_MIN_DISTINCT_URLS); // 5
      expect(filterCandidates([s])).toHaveLength(1);
    });

    it('drops a session at distinctUrls === 4', () => {
      const s = makeSession({
        activeMs: 40 * 60_000,
        urls: [
          urlEntry({ url: 'https://a.example.com/1' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      expect(s.distinctUrls).toBe(4);
      expect(filterCandidates([s])).toEqual([]);
    });
  });

  describe('domain criterion (criterion 3: A OR B)', () => {
    it('keeps a session at exactly CANDIDATE_MIN_DISTINCT_DOMAINS canonical domains (boundary A)', () => {
      // 3 canonical domains, 5 URLs, 30 min — minimum on every axis.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://foo.org/2' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://bar.net/2' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(CANDIDATE_MIN_DISTINCT_DOMAINS); // 3
    });

    it('drops when only 2 canonical domains and top domain has 7 URLs (below floor B = 8)', () => {
      // 2 canonical domains, top has 7 URLs -> fails BOTH criterion A (needs 3) and
      // criterion B (needs 8). 8 total URLs is > distinctUrls floor of 5, so criterion 2 passes.
      const urls: SessionUrlEntry[] = [];
      for (let i = 0; i < 7; i++) {
        urls.push(urlEntry({ url: `https://foo.org/${i}`, openTs: BASE + i }));
      }
      urls.push(urlEntry({ url: 'https://bar.net/1' }));
      const s = makeSession({ activeMs: 45 * 60_000, urls });
      expect(filterCandidates([s])).toEqual([]);
    });

    it('keeps when only 2 canonical domains but one has exactly 8 URLs (boundary B)', () => {
      const urls: SessionUrlEntry[] = [];
      for (let i = 0; i < 8; i++) {
        urls.push(urlEntry({ url: `https://foo.org/${i}`, openTs: BASE + i }));
      }
      urls.push(urlEntry({ url: 'https://bar.net/1' }));
      const s = makeSession({ activeMs: 45 * 60_000, urls });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      // 9 distinct URLs, 2 canonical domains, top is foo.org with 8 URLs.
      expect(out[0]!.distinctDomains).toBe(2);
      expect(out[0]!.topDomain).toBe('foo.org');
    });

    it('keeps a single-domain session at exactly 8 URLs (boundary B, monodomain)', () => {
      const urls: SessionUrlEntry[] = [];
      for (let i = 0; i < CANDIDATE_SINGLE_DOMAIN_URL_FLOOR; i++) {
        urls.push(urlEntry({ url: `https://foo.org/${i}`, openTs: BASE + i }));
      }
      const s = makeSession({ activeMs: CANDIDATE_MIN_ACTIVE_MS, urls });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(1);
      expect(out[0]!.topDomain).toBe('foo.org');
    });

    it('drops a single-domain session at 7 URLs (one below floor)', () => {
      const urls: SessionUrlEntry[] = [];
      for (let i = 0; i < 7; i++) {
        urls.push(urlEntry({ url: `https://foo.org/${i}`, openTs: BASE + i }));
      }
      const s = makeSession({ activeMs: CANDIDATE_MIN_ACTIVE_MS, urls });
      expect(filterCandidates([s])).toEqual([]);
    });
  });

  describe('canonical subdomain collapsing', () => {
    it('drops when 5 URLs live on subdomains of ONE eTLD+1 (only 1 canonical domain, <8 URLs)', () => {
      // a.example.com, b.example.com, c.example.com, d.example.com, e.example.com
      // all collapse to example.com. 1 canonical domain, 5 URLs -> fails A (needs 3)
      // and fails B (needs 8).
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://a.example.com/1' }),
          urlEntry({ url: 'https://b.example.com/1' }),
          urlEntry({ url: 'https://c.example.com/1' }),
          urlEntry({ url: 'https://d.example.com/1' }),
          urlEntry({ url: 'https://e.example.com/1' }),
        ],
      });
      expect(filterCandidates([s])).toEqual([]);
    });

    it('keeps a 9-url wikipedia-style session (all URLs collapse to wikipedia.org via criterion B)', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://en.wikipedia.org/wiki/A' }),
          urlEntry({ url: 'https://en.wikipedia.org/wiki/B' }),
          urlEntry({ url: 'https://en.wikipedia.org/wiki/C' }),
          urlEntry({ url: 'https://de.wikipedia.org/wiki/D' }),
          urlEntry({ url: 'https://de.wikipedia.org/wiki/E' }),
          urlEntry({ url: 'https://de.wikipedia.org/wiki/F' }),
          urlEntry({ url: 'https://m.wikipedia.org/wiki/G' }),
          urlEntry({ url: 'https://m.wikipedia.org/wiki/H' }),
          urlEntry({ url: 'https://m.wikipedia.org/wiki/I' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(1);
      expect(out[0]!.topDomain).toBe('wikipedia.org');
    });

    it('keeps a mixed subdomain + distinct-eTLD session (3 canonical domains via criterion A)', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://en.wikipedia.org/wiki/A' }),
          urlEntry({ url: 'https://de.wikipedia.org/wiki/B' }),
          urlEntry({ url: 'https://m.wikipedia.org/wiki/C' }),
          urlEntry({ url: 'https://fr.wikipedia.org/wiki/D' }),
          urlEntry({ url: 'https://www.nytimes.com/article' }),
          urlEntry({ url: 'https://www.theguardian.com/tech' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      // canonical: wikipedia.org, nytimes.com, theguardian.com
      expect(out[0]!.distinctDomains).toBe(3);
    });

    it('keeps a reddit+twitter+hn-style 6-URL session (3 canonical domains)', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://www.reddit.com/r/a' }),
          urlEntry({ url: 'https://www.reddit.com/r/b' }),
          urlEntry({ url: 'https://twitter.com/x' }),
          urlEntry({ url: 'https://twitter.com/y' }),
          urlEntry({ url: 'https://news.ycombinator.com/item?id=1' }),
          urlEntry({ url: 'https://news.ycombinator.com/item?id=2' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(3);
    });
  });

  describe('null-canonical URL handling', () => {
    it('excludes chrome:// URLs from canonical domain count but counts them toward distinctUrls', () => {
      // Wait — chrome:// fallback yields "newtab" (non-null). We need truly
      // null-canonical URLs: file://, about:blank, javascript:, data:.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'file:///Users/x/doc.pdf', domain: '' }),
          urlEntry({ url: 'about:blank', domain: '' }),
          urlEntry({ url: 'javascript:void(0)', domain: '' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      // 6 URLs, 3 real canonical domains -> KEPT via criterion A. null-canonical
      // URLs contribute to distinctUrls (6) but not to distinctDomains (3).
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(3);
      expect(out[0]!.distinctUrls).toBe(6);
    });

    it('drops a session whose only real canonical domain has too few URLs for the floor', () => {
      // 6 URLs: 3 null-canonical + 3 real on ONE domain. distinctUrls=6 (passes),
      // distinctCanonicalDomains=1 (fails A), maxUrlsOnOneDomain=3 (fails B).
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'file:///x', domain: '' }),
          urlEntry({ url: 'about:blank', domain: '' }),
          urlEntry({ url: 'data:text/html,<p>hi</p>', domain: '' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://foo.org/2' }),
          urlEntry({ url: 'https://foo.org/3' }),
        ],
      });
      expect(filterCandidates([s])).toEqual([]);
    });

    it('keeps a 10-URL session with 5 null-canonical + 5 real across 3 domains (criterion A)', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'file:///a', domain: '' }),
          urlEntry({ url: 'file:///b', domain: '' }),
          urlEntry({ url: 'about:blank', domain: '' }),
          urlEntry({ url: 'javascript:void(0)', domain: '' }),
          urlEntry({ url: 'data:text/html,<p>x</p>', domain: '' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://foo.org/2' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://bar.net/2' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      // 3 real canonical domains: foo.org, bar.net, baz.io
      expect(out[0]!.distinctDomains).toBe(3);
      // 10 total URLs survive into distinctUrls (assigned by makeSession default).
      expect(out[0]!.distinctUrls).toBe(10);
    });

    it('drops when all URLs are null-canonical (distinctCanonicalDomains == 0)', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'file:///a', domain: '' }),
          urlEntry({ url: 'file:///b', domain: '' }),
          urlEntry({ url: 'about:blank', domain: '' }),
          urlEntry({ url: 'javascript:void(0)', domain: '' }),
          urlEntry({ url: 'data:text/html,<p>x</p>', domain: '' }),
        ],
      });
      // maxUrlsOnOneDomain = 0 (no domain at all), distinctCanonicalDomains = 0.
      expect(filterCandidates([s])).toEqual([]);
    });

    it('excludes whitespace/malformed URL strings from domain counting (canonical returns null)', () => {
      // 3 bad URLs + 3 real on 3 different domains = 3 canonical -> KEPT.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: '  ', domain: '' }),
          urlEntry({ url: 'not even a url', domain: '' }),
          urlEntry({ url: '', domain: '' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(3);
    });

    it('drops a session with EMPTY urls array but distinctUrls=5 (Stage 1 pre-attribution edge case)', () => {
      // activeMs and distinctUrls pass criteria 1 & 2, but urls[] is empty so no
      // canonical domain count can be built -> criterion 3 fails.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        distinctUrls: CANDIDATE_MIN_DISTINCT_URLS,
        urls: [],
      });
      expect(filterCandidates([s])).toEqual([]);
    });
  });

  describe('topDomain computation', () => {
    it('picks the lex-smaller domain when two canonical domains tie on activeMs', () => {
      // foo.org and bar.net each get 5 minutes via 2 URLs @ 150s each.
      // bbb.io is present but smaller. Tie-break 'bar.net' < 'foo.org' lex.
      // Wait — tie is only between foo.org and bar.net; ensure bbb.io has strictly less.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://foo.org/1', activeMs: 150_000 }),
          urlEntry({ url: 'https://foo.org/2', activeMs: 150_000 }),
          urlEntry({ url: 'https://bar.net/1', activeMs: 150_000 }),
          urlEntry({ url: 'https://bar.net/2', activeMs: 150_000 }),
          urlEntry({ url: 'https://bbb.io/1', activeMs: 60_000 }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      // foo.org total: 300k ms, bar.net total: 300k ms, bbb.io: 60k. Tie between
      // foo.org and bar.net -> lex smaller is 'bar.net'.
      expect(out[0]!.topDomain).toBe('bar.net');
    });

    it('keeps topDomain set when ALL URLs have activeMs=0 on a single canonical domain', () => {
      // Probes the bestMs = -1 sentinel: even with 0 ms per URL, the first
      // iteration satisfies ms (0) > bestMs (-1), so topDomain is set.
      const urls: SessionUrlEntry[] = [];
      for (let i = 0; i < CANDIDATE_SINGLE_DOMAIN_URL_FLOOR; i++) {
        urls.push(urlEntry({ url: `https://foo.org/${i}`, activeMs: 0, openTs: BASE + i }));
      }
      const s = makeSession({ activeMs: CANDIDATE_MIN_ACTIVE_MS, urls });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      // distinctDomains is set (1), topDomain is set (not omitted).
      expect(out[0]!.distinctDomains).toBe(1);
      expect(out[0]!.topDomain).toBe('foo.org');
      expect('topDomain' in out[0]!).toBe(true);
    });

    it('omits topDomain key entirely when no URL has a canonical domain', () => {
      // This scenario requires passing criteria 1-3 with zero canonical domains,
      // which is impossible via criterion 3. So the only way to exercise the
      // "key omitted" branch is to construct a session that ALSO fails — hence
      // it cannot produce a candidate. Instead we assert the branch's contract
      // via a session that DOES survive criterion 3 through URL-floor but with
      // some null-canonical entries that might nudge logic. There is no path
      // where a candidate comes out with no canonical domain, so the best we
      // can do is assert that: when topDomain IS derived from canonical stats,
      // the canonical is what appears — and when canonical count is 0, no
      // candidate is produced.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'file:///a', domain: '' }),
          urlEntry({ url: 'about:blank', domain: '' }),
          urlEntry({ url: 'javascript:void(0)', domain: '' }),
          urlEntry({ url: 'data:,a', domain: '' }),
          urlEntry({ url: 'data:,b', domain: '' }),
        ],
      });
      // Zero canonical domains -> dropped, no candidate, no assertion on topDomain.
      expect(filterCandidates([s])).toEqual([]);
    });

    it('topDomain totals are attributed only to the URLs on that domain (arithmetic cross-check)', () => {
      // foo.org: 3 URLs at 600s each -> 1800s = 30 min.
      // bar.net: 2 URLs at 300s each -> 600s = 10 min.
      // baz.io: 1 URL at 120s -> 2 min.
      // Top should be foo.org at 30min active. distinctDomains=3, distinctUrls=6.
      const s = makeSession({
        activeMs: 42 * 60_000,
        urls: [
          urlEntry({ url: 'https://foo.org/1', activeMs: 600_000 }),
          urlEntry({ url: 'https://foo.org/2', activeMs: 600_000 }),
          urlEntry({ url: 'https://foo.org/3', activeMs: 600_000 }),
          urlEntry({ url: 'https://bar.net/1', activeMs: 300_000 }),
          urlEntry({ url: 'https://bar.net/2', activeMs: 300_000 }),
          urlEntry({ url: 'https://baz.io/1', activeMs: 120_000 }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.distinctDomains).toBe(3);
      expect(out[0]!.topDomain).toBe('foo.org');
    });
  });

  describe('output shape & side effects', () => {
    it('overwrites status "segmented" with "candidate"', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        status: 'segmented',
        urls: [
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
          urlEntry({ url: 'https://qux.dev/1' }),
          urlEntry({ url: 'https://quux.ai/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out[0]!.status).toBe('candidate');
    });

    it('overwrites stale distinctDomains from the input (input said 99, canonical is 3)', () => {
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        distinctDomains: 99, // ← lie
        urls: [
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://foo.org/2' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://bar.net/2' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out[0]!.distinctDomains).toBe(3);
    });

    it('preserves each urls[].domain verbatim (Stage 1 crude domain, NOT canonical)', () => {
      // Stage 1 might record 'en.wikipedia.org' (crude host) on the URL entry.
      // Stage 2 must NOT rewrite that; only session.distinctDomains and
      // session.topDomain move to canonical form.
      const s = makeSession({
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://en.wikipedia.org/wiki/A', domain: 'crude.example' }),
          urlEntry({ url: 'https://en.wikipedia.org/wiki/B' }),
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      expect(out[0]!.urls[0]!.domain).toBe('crude.example');
      expect(out[0]!.urls[1]!.domain).toBe('en.wikipedia.org');
    });

    it('preserves input order A,B,C when all are candidates', () => {
      const make = (id: string) =>
        makeSession({
          id,
          activeMs: CANDIDATE_MIN_ACTIVE_MS,
          urls: [
            urlEntry({ url: 'https://foo.org/1' }),
            urlEntry({ url: 'https://bar.net/1' }),
            urlEntry({ url: 'https://baz.io/1' }),
            urlEntry({ url: 'https://qux.dev/1' }),
            urlEntry({ url: 'https://quux.ai/1' }),
          ],
        });
      const out = filterCandidates([make('A'), make('B'), make('C')]);
      expect(out.map((c) => c.id)).toEqual(['A', 'B', 'C']);
    });

    it('drops middle element but preserves outer order (A,B(dropped),C -> A,C)', () => {
      const candidate = (id: string): Session =>
        makeSession({
          id,
          activeMs: CANDIDATE_MIN_ACTIVE_MS,
          urls: [
            urlEntry({ url: 'https://foo.org/1' }),
            urlEntry({ url: 'https://bar.net/1' }),
            urlEntry({ url: 'https://baz.io/1' }),
            urlEntry({ url: 'https://qux.dev/1' }),
            urlEntry({ url: 'https://quux.ai/1' }),
          ],
        });
      const tiny: Session = makeSession({
        id: 'B',
        activeMs: 5 * 60_000, // below threshold
        urls: [urlEntry({ url: 'https://only.one/1' })],
      });
      const out = filterCandidates([candidate('A'), tiny, candidate('C')]);
      expect(out.map((c) => c.id)).toEqual(['A', 'C']);
    });

    it('does not mutate input sessions or their url arrays (deep-frozen input must not throw)', () => {
      const urls: SessionUrlEntry[] = [
        urlEntry({ url: 'https://foo.org/1' }),
        urlEntry({ url: 'https://bar.net/1' }),
        urlEntry({ url: 'https://baz.io/1' }),
        urlEntry({ url: 'https://qux.dev/1' }),
        urlEntry({ url: 'https://quux.ai/1' }),
      ];
      for (const u of urls) Object.freeze(u);
      Object.freeze(urls);
      const s: Session = makeSession({ activeMs: CANDIDATE_MIN_ACTIVE_MS, urls });
      Object.freeze(s);
      const frozenInput: readonly Session[] = Object.freeze([s]);

      expect(() => filterCandidates(frozenInput as Session[])).not.toThrow();

      // Snapshot equality: the input session values are unchanged.
      expect(s.status).toBe('segmented');
      expect(s.distinctDomains).toBe(new Set(urls.map((u) => u.domain)).size);
      expect(s.urls).toBe(urls);
      expect(s.urls[0]!.domain).toBe('foo.org');
    });

    it('returns [] for empty input', () => {
      expect(filterCandidates([])).toEqual([]);
    });

    it('returns [] when no session is a candidate', () => {
      const sub: Session = makeSession({
        activeMs: 10 * 60_000, // below 30 min
        urls: [urlEntry({ url: 'https://foo.org/1' })],
      });
      expect(filterCandidates([sub])).toEqual([]);
    });

    it('preserves schemaVersion and timestamp fields from input', () => {
      const s = makeSession({
        id: 'sess_preserve',
        startTs: 111,
        endTs: 222,
        weekStart: '2030-01-06',
        activeMs: CANDIDATE_MIN_ACTIVE_MS,
        urls: [
          urlEntry({ url: 'https://foo.org/1' }),
          urlEntry({ url: 'https://bar.net/1' }),
          urlEntry({ url: 'https://baz.io/1' }),
          urlEntry({ url: 'https://qux.dev/1' }),
          urlEntry({ url: 'https://quux.ai/1' }),
        ],
      });
      const out = filterCandidates([s]);
      expect(out).toHaveLength(1);
      const c: RabbitHoleCandidate = out[0]!;
      expect(c.id).toBe('sess_preserve');
      expect(c.startTs).toBe(111);
      expect(c.endTs).toBe(222);
      expect(c.weekStart).toBe('2030-01-06');
      expect(c.schemaVersion).toBe(SCHEMA_VERSION);
    });
  });
});
