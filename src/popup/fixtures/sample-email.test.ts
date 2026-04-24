import { describe, expect, it } from 'vitest';
import { SAMPLE_EMAIL_HTML, SAMPLE_EMAIL_PREHEADER, SAMPLE_EMAIL_SUBJECT } from './sample-email.js';

describe('sample-email fixture', () => {
  it('SAMPLE_EMAIL_HTML starts with <!doctype html>', () => {
    expect(SAMPLE_EMAIL_HTML.startsWith('<!doctype html>')).toBe(true);
  });

  it('SAMPLE_EMAIL_HTML includes core structural tags', () => {
    expect(SAMPLE_EMAIL_HTML).toContain('<html');
    expect(SAMPLE_EMAIL_HTML).toContain('<head>');
    expect(SAMPLE_EMAIL_HTML).toContain('<meta charset="utf-8">');
    expect(SAMPLE_EMAIL_HTML).toContain('<style>');
    expect(SAMPLE_EMAIL_HTML).toContain('<body>');
    expect(SAMPLE_EMAIL_HTML).toContain('</html>');
  });

  it('SAMPLE_EMAIL_HTML contains the core PRD §6.3 facts', () => {
    expect(SAMPLE_EMAIL_HTML).toContain('Peter Attia');
    expect(SAMPLE_EMAIL_HTML).toContain('zillow.com');
    expect(SAMPLE_EMAIL_HTML).toContain('youtube.com');
    expect(SAMPLE_EMAIL_HTML).toContain('news.ycombinator.com');
    expect(SAMPLE_EMAIL_HTML).toContain('7 tabs older than 3 days');
    expect(SAMPLE_EMAIL_HTML).toContain('rapamycin');
  });

  it('SAMPLE_EMAIL_HTML keeps the footer line as plain text (not a link)', () => {
    expect(SAMPLE_EMAIL_HTML).toContain('Pause tracking · Delete all data · Export · Settings');
    // Footer must not be wrapped in anchors in the fixture.
    expect(SAMPLE_EMAIL_HTML).not.toMatch(/<a[^>]*>\s*Pause tracking/);
  });

  it('SAMPLE_EMAIL_HTML contains no <script> tags', () => {
    expect(SAMPLE_EMAIL_HTML.toLowerCase()).not.toContain('<script');
  });

  it('SAMPLE_EMAIL_SUBJECT matches the PRD subject line exactly', () => {
    expect(SAMPLE_EMAIL_SUBJECT).toBe('Last week, you fell down a hole about Peter Attia.');
  });

  it('SAMPLE_EMAIL_PREHEADER matches the PRD preheader line exactly', () => {
    expect(SAMPLE_EMAIL_PREHEADER).toBe(
      'Also, you are apparently still thinking about that apartment.',
    );
  });

  it('exports are non-empty strings', () => {
    expect(typeof SAMPLE_EMAIL_HTML).toBe('string');
    expect(SAMPLE_EMAIL_HTML.length).toBeGreaterThan(0);
    expect(SAMPLE_EMAIL_SUBJECT.length).toBeGreaterThan(0);
    expect(SAMPLE_EMAIL_PREHEADER.length).toBeGreaterThan(0);
  });

  it('starts with <!doctype html> case-insensitively', () => {
    expect(SAMPLE_EMAIL_HTML.slice(0, 15).toLowerCase()).toBe('<!doctype html>');
  });

  it('contains the full structural skeleton', () => {
    const lower = SAMPLE_EMAIL_HTML.toLowerCase();
    expect(lower).toContain('<html');
    expect(lower).toContain('<head');
    expect(lower).toContain('<body');
    expect(lower).toContain('</html>');
    expect(lower).toContain('</body>');
    expect(lower).toContain('</head>');
  });

  it('declares a utf-8 charset meta', () => {
    // Either <meta charset="utf-8"> or the http-equiv form is acceptable.
    expect(/<meta[^>]+charset\s*=\s*["']?utf-?8/i.test(SAMPLE_EMAIL_HTML)).toBe(true);
  });

  it('contains an inline <style> block', () => {
    expect(/<style[^>]*>[\s\S]*<\/style>/i.test(SAMPLE_EMAIL_HTML)).toBe(true);
  });

  it('contains every PRD §6.3 string verbatim', () => {
    const required = [
      'Peter Attia',
      'autophagy',
      'rapamycin actually work',
      'zillow.com',
      'ycombinator.com',
      'youtube.com',
      'keto',
      "cover letter that doesn't suck",
      '7 tabs older than 3 days',
      'Huberman',
      'Pause tracking · Delete all data · Export · Settings',
    ];
    for (const phrase of required) {
      expect(SAMPLE_EMAIL_HTML).toContain(phrase);
    }
  });

  it('contains each of the PRD section headings verbatim', () => {
    const headings = [
      'Your week',
      'What you kept coming back to',
      'What the week was about',
      'Tabs you opened and never really visited',
      'Since last week',
      'Tabs still alive',
    ];
    for (const h of headings) {
      expect(SAMPLE_EMAIL_HTML).toContain(h);
    }
  });

  it('SAMPLE_EMAIL_SUBJECT equals the exact PRD string', () => {
    expect(SAMPLE_EMAIL_SUBJECT).toBe('Last week, you fell down a hole about Peter Attia.');
  });

  it('SAMPLE_EMAIL_PREHEADER equals the exact PRD string', () => {
    expect(SAMPLE_EMAIL_PREHEADER).toBe(
      'Also, you are apparently still thinking about that apartment.',
    );
  });

  it('does not contain a <script tag (case-insensitive)', () => {
    expect(SAMPLE_EMAIL_HTML.toLowerCase().includes('<script')).toBe(false);
  });

  it('does not contain any javascript: URI', () => {
    expect(/javascript\s*:/i.test(SAMPLE_EMAIL_HTML)).toBe(false);
  });

  it('does not contain inline on*= event handlers (onclick, onerror, onload, ...)', () => {
    // Look for " onX=" or tab/newline-onX= attribute patterns where X is letters.
    // Use a conservative regex that targets the attribute form only.
    const handlerRe = /\s(on[a-z]+)\s*=/gi;
    const matches = SAMPLE_EMAIL_HTML.match(handlerRe);
    expect(matches).toBeNull();
  });

  it('does not hotlink remote http(s) images', () => {
    // No <img src="http..." — phones home and is a privacy leak. Inline data URIs or no images.
    expect(/<img[^>]+src\s*=\s*["']https?:/i.test(SAMPLE_EMAIL_HTML)).toBe(false);
  });

  it('fits under a 32 KB size budget', () => {
    // Measured in UTF-8 bytes, not code units.
    const bytes = new TextEncoder().encode(SAMPLE_EMAIL_HTML).length;
    expect(bytes).toBeLessThan(32 * 1024);
  });
});
