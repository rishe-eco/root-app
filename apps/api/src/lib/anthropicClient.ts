/**
 * The one place this app constructs an Anthropic client (R4).
 *
 * Mirrors `lib/mail.ts`'s shape for a provider the founder may not have
 * wired up: no `ANTHROPIC_API_KEY` in development is not an error — `env.ts`
 * only requires the key in production — it just means `getAnthropicClient()`
 * returns null and the Ask surface reports itself unavailable, so the rest
 * of the app still runs for someone working on R2's reader.
 *
 * `ANTHROPIC_E2E_STUB` (checked first, below) swaps in a canned client for
 * the e2e suite — see the doc comment on `buildE2EStubClient`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

/**
 * A deterministic, in-process stand-in for the real API — `ANTHROPIC_E2E_STUB`
 * only (see env.ts). Answers every question the same way, with one citation
 * at `document_index: 0`: the e2e spec always asks "Ask this paper" pinned to
 * a single seeded entry, so index 0 is always that entry's own document
 * block, and the spec can assert on a real citation link without a live API
 * or a hand-rolled SSE server.
 */
function buildE2EStubClient(): Anthropic {
  const answerText = 'Root (ریشه) is a bilingual research library, this stub answer confirms it.';
  const stream = () => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
        return this;
      },
      async finalMessage() {
        for (const cb of listeners.text ?? []) cb(answerText, answerText);
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: answerText,
              citations: [
                {
                  type: 'char_location',
                  cited_text: 'a bilingual research library',
                  document_index: 0,
                  document_title: null,
                  start_char_index: 0,
                  end_char_index: 29,
                  file_id: null,
                },
              ],
            },
          ],
          usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    };
  };

  return {
    beta: {
      files: { upload: async () => ({ id: 'e2e-stub-file' }) },
      messages: {
        countTokens: async () => ({ input_tokens: 500 }),
        stream,
      },
    },
  } as unknown as Anthropic;
}

let client: Anthropic | null = env.ANTHROPIC_E2E_STUB
  ? buildE2EStubClient()
  : env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    : null;

export function getAnthropicClient(): Anthropic | null {
  return client;
}

/**
 * Test-only seam — the same reasoning as `storage.ts`'s
 * `__makeKeyForTests`/`__resolveKeyForTests`: the integration suite stubs
 * the live API here rather than spending real money to prove the rights
 * boundary and the refusal paths.
 */
export function __setAnthropicClientForTests(fake: Anthropic | null): void {
  client = fake;
}
