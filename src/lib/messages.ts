import { z } from 'zod';

// Discriminated union of every runtime message sent from content scripts (and,
// eventually, UI surfaces) into the service worker. Content scripts send plain
// objects; the SW parses via `extensionMessageSchema` before acting.

const inputTickMessageSchema = z.object({
  type: z.literal('input_tick'),
  ts: z.number().int().nonnegative(),
});

// The options page mutates privacy/blocklist state in its own frame and
// pings the service worker to drop its in-memory gate caches. The SW's
// onMessage handler parses via `parseExtensionMessage` and branches on the
// `type` tag rather than reading the raw payload.
const gatesInvalidateMessageSchema = z.object({
  type: z.literal('gates:invalidate'),
});

const extensionMessageSchema = z.discriminatedUnion('type', [
  inputTickMessageSchema,
  gatesInvalidateMessageSchema,
]);
export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;

export function parseExtensionMessage(raw: unknown): ExtensionMessage | undefined {
  const result = extensionMessageSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
