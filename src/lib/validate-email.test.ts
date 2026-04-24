import { describe, expect, it } from 'vitest';
import { isEmail } from './validate-email.js';

describe('isEmail', () => {
  it('accepts a plain address', () => {
    expect(isEmail('a@b.co')).toBe(true);
  });

  it('accepts addresses with dots and plus tags in the local part', () => {
    expect(isEmail('first.last+tag@example.com')).toBe(true);
  });

  it('accepts multi-label public-suffix domains', () => {
    expect(isEmail('user@mail.example.co.uk')).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isEmail('  a@b.co  ')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isEmail('')).toBe(false);
  });

  it('rejects whitespace-only input', () => {
    expect(isEmail('   ')).toBe(false);
  });

  it('rejects input missing the @ sign', () => {
    expect(isEmail('no-at-sign.example')).toBe(false);
  });

  it('rejects input missing a dotted domain', () => {
    expect(isEmail('user@nodot')).toBe(false);
  });

  it('rejects input with a space inside', () => {
    expect(isEmail('user name@example.com')).toBe(false);
  });

  it('rejects input with two @ signs', () => {
    expect(isEmail('a@@b.co')).toBe(false);
  });

  it('rejects input with whitespace next to the dot', () => {
    expect(isEmail('a@b .co')).toBe(false);
  });

  it('rejects input with a leading @', () => {
    expect(isEmail('@b.co')).toBe(false);
  });

  it('rejects input with a trailing @', () => {
    expect(isEmail('user@')).toBe(false);
  });

  it('rejects input that starts with a dot in the TLD position', () => {
    expect(isEmail('user@.co')).toBe(false);
  });

  it('rejects input that is only an @', () => {
    expect(isEmail('@')).toBe(false);
  });

  it('rejects input that is only whitespace around an @', () => {
    expect(isEmail(' @ ')).toBe(false);
  });

  it('rejects a tab character embedded in the local part', () => {
    expect(isEmail('us\ter@example.com')).toBe(false);
  });

  it('trims trailing whitespace (including newlines) before validating', () => {
    // trim() strips \n, so this resolves to a valid address after trim.
    expect(isEmail('a@b.co\n')).toBe(true);
  });

  it('rejects a newline embedded inside the address', () => {
    expect(isEmail('a@b\n.co')).toBe(false);
  });

  it('accepts a plausibly long but valid address (<=256 chars)', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(60)}.example.com`;
    expect(isEmail(`${local}@${domain}`)).toBe(true);
  });

  it('does not blow up on very long input (1000 chars, all `a`)', () => {
    const huge = 'a'.repeat(1000);
    // Regex runs linearly; this must return quickly without throwing.
    expect(() => isEmail(huge)).not.toThrow();
    expect(isEmail(huge)).toBe(false);
  });

  it('accepts a Unicode/IDN-ish domain (the regex is char-class based, not ASCII-only)', () => {
    // The regex forbids only @ and whitespace; non-ASCII letters pass through.
    // Flag: the backend (chunk 9.2) may stricter-reject this — this test
    // captures the current client-side behavior.
    expect(isEmail('a@ü.de')).toBe(true);
  });

  it('accepts a Unicode local part (same rationale as above)', () => {
    expect(isEmail('über@example.com')).toBe(true);
  });

  it('rejects internal whitespace within the domain between dots', () => {
    expect(isEmail('a@exa mple.com')).toBe(false);
  });

  it('rejects when a trailing whitespace sits between the @ and the dot', () => {
    expect(isEmail('a@b\t.co')).toBe(false);
  });

  it('does not throw when given an unusual but string-typed input', () => {
    // Cast simulates a sloppy caller passing non-standard input typed as string.
    const asAny = {
      toString(): string {
        return 'x@y.z';
      },
    } as unknown as string;
    // Our signature insists on string; using the value directly would go through
    // String.prototype.trim on the object (not the literal string) — guard that
    // the function still does not throw when the caller hands us something weird.
    expect(() => isEmail(String(asAny))).not.toThrow();
  });
});
