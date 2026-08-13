import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLab, type AskErrorCode } from './ask';

/**
 * The SSE reader's terminal-event contract (R4). Every branch here is about
 * the same property: `askLab` must always leave the caller in a settled
 * state. The component's `status` only moves off `asking` when one of these
 * callbacks fires, so a path that returns without calling any of them shows
 * a reader a spinner and a disabled button, permanently — and it does that
 * silently, which is why it is worth a test rather than a careful read.
 */

type Calls = { deltas: string[]; done: number; refused: number; errors: AskErrorCode[] };

function collect(): { calls: Calls; callbacks: Parameters<typeof askLab>[1] } {
  const calls: Calls = { deltas: [], done: 0, refused: 0, errors: [] };
  return {
    calls,
    callbacks: {
      onDelta: (t) => calls.deltas.push(t),
      onDone: () => { calls.done += 1; },
      onRefused: () => { calls.refused += 1; },
      onError: (code) => calls.errors.push(code),
    },
  };
}

/** A `fetch` returning `frames` as an SSE body, then closing cleanly. */
function stubFetch(frames: string[]): void {
  globalThis.fetch = (async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
  })) as unknown as typeof fetch;
}

const ask = (cb: Parameters<typeof askLab>[1], signal?: AbortSignal) =>
  askLab({ question: 'q', locale: 'en' }, cb, signal);

test('a stream that ends without a terminal frame is reported as a network failure, never silence', async () => {
  // The exact shape of a mid-answer disconnect: Nginx's proxy_read_timeout,
  // an API restart, a laptop closing. Deltas arrived, then nothing — and
  // without this the reader waits on a disabled button forever.
  stubFetch(['event: delta\ndata: {"text":"Half an ans"}\n\n']);
  const { calls, callbacks } = collect();

  await ask(callbacks);

  assert.deepEqual(calls.deltas, ['Half an ans']);
  assert.equal(calls.done, 0);
  assert.deepEqual(calls.errors, ['NETWORK']);
});

test('a stream that terminates properly reports no failure', async () => {
  stubFetch([
    'event: delta\ndata: {"text":"An answer."}\n\n',
    'event: done\ndata: {"text":"An answer.","citations":[],"truncated":false,"stopReason":"end_turn"}\n\n',
  ]);
  const { calls, callbacks } = collect();

  await ask(callbacks);

  assert.equal(calls.done, 1);
  assert.deepEqual(calls.errors, [], 'a clean close after a done frame is not a failure');
});

test('an error frame settles the stream — the clean close behind it adds nothing', async () => {
  stubFetch(['event: error\ndata: {"code":"UPSTREAM_FAILED"}\n\n']);
  const { calls, callbacks } = collect();

  await ask(callbacks);

  assert.deepEqual(calls.errors, ['UPSTREAM_FAILED'], 'exactly one error, not a second NETWORK behind it');
});

test('a refusal settles the stream too', async () => {
  stubFetch(['event: refused\ndata: {}\n\n']);
  const { calls, callbacks } = collect();

  await ask(callbacks);

  assert.equal(calls.refused, 1);
  assert.deepEqual(calls.errors, []);
});

test('the caller aborting is not a failure to report', async () => {
  // The component aborts any in-flight question when a new one is asked and
  // on unmount. Surfacing that as NETWORK would flash an error over the
  // answer that is replacing it.
  const controller = new AbortController();
  controller.abort();
  stubFetch(['event: delta\ndata: {"text":"partial"}\n\n']);
  const { calls, callbacks } = collect();

  await ask(callbacks, controller.signal);

  assert.deepEqual(calls.errors, [], 'an aborted read belongs to the caller, not to the network');
});
