/**
 * Server-Sent Events response helper shared by the harness proxy (/api/event)
 * and the control stream (/api/notnative/events).
 * Frame format: optional `id:`, `event:`, `data:` lines terminated by blank line.
 */
export type SseFrame = { event?: string; data: string; id?: string };

export function sseResponse(
  onOpen: (send: (frame: SseFrame) => void) => () => void,
  signal?: AbortSignal,
): Response {
  let cleanup: (() => void) | null = null;
  let closed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: SseFrame) => {
        if (closed) return;
        let out = '';
        if (frame.id) out += `id: ${frame.id}\n`;
        if (frame.event) out += `event: ${frame.event}\n`;
        out += `data: ${frame.data}\n\n`;
        try {
          controller.enqueue(encoder.encode(out));
        } catch {
          closed = true;
        }
      };
      // initial flush so proxies open the stream immediately
      controller.enqueue(encoder.encode(': open\n\n'));
      cleanup = onOpen(send);
      signal?.addEventListener('abort', () => {
        closed = true;
        try {
          cleanup?.();
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

export type SseSender = (frame: SseFrame) => void;
