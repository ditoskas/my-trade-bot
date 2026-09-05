import { createSubscriber, STRATEGY_EVENTS_CHANNEL } from "@/lib/redis";

// Server-Sent Events bridge: one Redis subscriber per connected browser,
// forwarding every strategy-events message straight through as an SSE
// `data:` frame. Chosen over a separate WebSocket/Socket.io server because
// a Next.js Route Handler can stream a response natively — no extra
// process to run alongside the UI (see CLAUDE.md's Engine/UI split).
export async function GET(): Promise<Response> {
  const subscriber = await createSubscriber();
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));

      void subscriber.subscribe(STRATEGY_EVENTS_CHANNEL, (message) => {
        controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      });

      // Redis pub/sub has no built-in "keep this connection open forever"
      // signal — a periodic comment frame keeps intermediary proxies and
      // browsers from timing out an idle SSE connection.
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 20_000);
    },
    async cancel() {
      clearInterval(keepAlive);
      await subscriber.unsubscribe(STRATEGY_EVENTS_CHANNEL).catch(() => undefined);
      await subscriber.quit().catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
