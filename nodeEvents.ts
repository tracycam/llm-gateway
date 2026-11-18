import { Cluster } from './cluster';

const KEEPALIVE_MS = 15_000;

/** The console's event stream: the node list first, then every cluster event. */
export function openNodeEvents(req: Request, cluster: Cluster, keepaliveMs = KEEPALIVE_MS): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // After this nothing writes to the stream: the client is gone.
  const end = () => {
    unsubscribe?.();
    clearInterval(timer);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      write(`data: ${JSON.stringify({ type: 'cluster', data: { nodes: cluster.list() } })}\n\n`);
      unsubscribe = cluster.subscribe((event) => write(`data: ${JSON.stringify(event)}\n\n`));
      timer = setInterval(() => write(': keepalive\n\n'), keepaliveMs);
      req.signal.addEventListener('abort', end, { once: true });
      if (req.signal.aborted) end();
    },
    cancel: end,
  });
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}
