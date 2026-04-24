import type { RabbitHoleCandidate, Session } from '@tabob/shared';
import {
  CANDIDATE_MIN_ACTIVE_MS,
  CANDIDATE_MIN_DISTINCT_DOMAINS,
  CANDIDATE_MIN_DISTINCT_URLS,
  CANDIDATE_SINGLE_DOMAIN_URL_FLOOR,
} from '@tabob/shared';
import { canonicalDomain } from '../lib/url-normalize.js';

/**
 * Stage 2 candidate filter.
 *
 * Keeps sessions that satisfy ALL of:
 *   1. `activeMs >= CANDIDATE_MIN_ACTIVE_MS`
 *   2. `distinctUrls >= CANDIDATE_MIN_DISTINCT_URLS`
 *   3. Either `distinctCanonicalDomains >= CANDIDATE_MIN_DISTINCT_DOMAINS`,
 *      or some single canonical domain accounts for `>= CANDIDATE_SINGLE_DOMAIN_URL_FLOOR`
 *      distinct URLs (admits single-domain rabbit holes like 8+ Wikipedia articles).
 *
 * URL-distinctness uses the session's existing URL strings (already deduped in Stage 1).
 * Domain-distinctness uses `canonicalDomain` (eTLD+1 via tldts); URLs whose canonical
 * domain is null are excluded from domain counting but still count toward distinctUrls.
 *
 * On each kept session the returned candidate:
 *   - spreads the session fields,
 *   - sets `status: 'candidate'`,
 *   - overwrites `distinctDomains` with the canonical count,
 *   - overwrites `topDomain` with the canonical domain holding the most total `activeMs`
 *     (lex tie-break); the key is omitted (not set to undefined) if no URL has a
 *     canonical domain.
 *
 * Leaves per-URL `urls[].domain` values as Stage 1 wrote them — downstream consumers
 * that need canonical per-URL domain should call `canonicalDomain(url)` themselves.
 *
 * Blocklist is not re-applied here: upstream (background/gates.ts) already filters
 * blocklisted URLs at event-log time.
 *
 * Pure: does not mutate input sessions or their URL arrays. No chrome.* / wall clock.
 * Returns candidates in the same chronological order as input.
 */
export function filterCandidates(sessions: Session[]): RabbitHoleCandidate[] {
  const out: RabbitHoleCandidate[] = [];

  for (const session of sessions) {
    if (session.activeMs < CANDIDATE_MIN_ACTIVE_MS) continue;
    if (session.distinctUrls < CANDIDATE_MIN_DISTINCT_URLS) continue;

    // Tally canonical-domain activeMs and URL counts. `urls` is already URL-deduped by
    // Stage 1, so each entry contributes once to the per-domain URL count.
    const domainActiveMs = new Map<string, number>();
    const domainUrlCount = new Map<string, number>();
    for (const u of session.urls) {
      const canon = canonicalDomain(u.url);
      if (canon === null) continue;
      domainActiveMs.set(canon, (domainActiveMs.get(canon) ?? 0) + u.activeMs);
      domainUrlCount.set(canon, (domainUrlCount.get(canon) ?? 0) + 1);
    }

    const distinctCanonicalDomains = domainActiveMs.size;

    let maxUrlsOnOneDomain = 0;
    for (const c of domainUrlCount.values()) {
      if (c > maxUrlsOnOneDomain) maxUrlsOnOneDomain = c;
    }

    const passesDomainTest =
      distinctCanonicalDomains >= CANDIDATE_MIN_DISTINCT_DOMAINS ||
      maxUrlsOnOneDomain >= CANDIDATE_SINGLE_DOMAIN_URL_FLOOR;
    if (!passesDomainTest) continue;

    // Recompute topDomain from canonical-domain activeMs totals (lex tie-break).
    let topDomain: string | undefined;
    if (domainActiveMs.size > 0) {
      let bestDomain = '';
      let bestMs = -1;
      for (const [domain, ms] of domainActiveMs) {
        if (ms > bestMs || (ms === bestMs && domain < bestDomain)) {
          bestDomain = domain;
          bestMs = ms;
        }
      }
      topDomain = bestDomain;
    }

    // Spread session, then overwrite the fields we own. Use `status: 'candidate'`.
    // exactOptionalPropertyTypes: omit topDomain when undefined rather than set it.
    const { topDomain: _oldTop, ...rest } = session;
    const base: RabbitHoleCandidate = {
      ...rest,
      status: 'candidate',
      distinctDomains: distinctCanonicalDomains,
    };
    out.push(topDomain !== undefined ? { ...base, topDomain } : base);
  }

  return out;
}
