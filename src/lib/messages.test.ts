import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './messages.js';

describe('parseExtensionMessage', () => {
  it('parses a valid input_tick message', () => {
    const parsed = parseExtensionMessage({ type: 'input_tick', ts: 1_700_000_000_000 });
    expect(parsed).toEqual({ type: 'input_tick', ts: 1_700_000_000_000 });
  });

  it('returns undefined for unknown type', () => {
    expect(parseExtensionMessage({ type: 'garbage', ts: 1 })).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    expect(parseExtensionMessage({ type: 'input_tick' })).toBeUndefined();
    expect(parseExtensionMessage(null)).toBeUndefined();
    expect(parseExtensionMessage('input_tick')).toBeUndefined();
  });
});
