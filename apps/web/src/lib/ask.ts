import type { Locale } from '@/i18n';

/**
 * The client half of "Ask the Lab" / "Ask this paper" (R4). Hand-rolled SSE
 * over a `fetch` `POST`, not the browser `EventSource` API — `EventSource`
 * is GET-only, and a GET would put the question in a URL that ends up in
 * Nginx's access log next to the visitor's IP (routes/ask.ts carries the
 * same reasoning).
 */

export type AskCitation = { citedText: string; entrySlug: string; entryTitle: string; entryUrl: string };

export type AskDoneEvent = {
  text: string;
  citations: AskCitation[];
  truncated: boolean;
  stopReason: string;
};

/** Every string a reader sees is owned by the client (house rule 6) — the
 *  server sends codes only, never composed prose. */
export type AskErrorCode =
  | 'BAD_REQUEST'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'RESTING'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'UPSTREAM_FAILED'
  | 'INTERNAL'
  | 'NETWORK';

export type AskCallbacks = {
  onDelta: (text: string) => void;
  onDone: (event: AskDoneEvent) => void;
  onRefused: () => void;
  onError: (code: AskErrorCode) => void;
};

function isAskErrorCode(value: unknown): value is AskErrorCode {
  return (
    typeof value === 'string' &&
    (
      [
        'BAD_REQUEST',
        'UNAVAILABLE',
        'RATE_LIMITED',
        'RESTING',
        'NOT_FOUND',
        'TOO_LARGE',
        'UPSTREAM_FAILED',
        'INTERNAL',
      ] as const
    ).includes(value as never)
  );
}

/** Splits one SSE frame ("event: x\ndata: y\n\n", already separated from
 *  the rest of the buffer) into its event name and parsed JSON payload. */
function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  let dataLine = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLine += line.slice('data:'.length).trim();
  }
  if (!dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

export async function askLab(
  params: { question: string; locale: Locale; entrySlug?: string },
  callbacks: AskCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
  } catch {
    callbacks.onError('NETWORK');
    return;
  }

  if (!res.ok || !res.body) {
    let code: unknown;
    try {
      code = (await res.json()).error;
    } catch {
      /* no JSON body to read */
    }
    callbacks.onError(isAskErrorCode(code) ? code : 'INTERNAL');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (!parsed) continue;

      switch (parsed.event) {
        case 'delta':
          callbacks.onDelta((parsed.data as { text: string }).text);
          break;
        case 'done':
          callbacks.onDone(parsed.data as AskDoneEvent);
          break;
        case 'refused':
          callbacks.onRefused();
          break;
        case 'error': {
          const code = (parsed.data as { code?: unknown }).code;
          callbacks.onError(isAskErrorCode(code) ? code : 'INTERNAL');
          break;
        }
      }
    }
  }
}
