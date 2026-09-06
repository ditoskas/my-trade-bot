import { ControlApiClient, type ControlApiAction } from "@trade-bot/shared";

const ALLOWED_ACTIONS = new Set<ControlApiAction>(["pause", "resume", "kill", "unkill", "enable", "disable"]);

const client = new ControlApiClient({
  baseUrl: process.env.ENGINE_CONTROL_API_URL ?? "http://127.0.0.1:4001",
  token: process.env.ENGINE_CONTROL_API_TOKEN ?? "dev-only-insecure-token",
});

// The browser never talks to the Engine's control API directly — it calls
// this Next.js route, which is server-side code holding the shared secret.
// Keeps the engine's control port (and its token) off anything the browser
// could inspect, per CLAUDE.md: "UI... calls the Engine's internal
// authenticated API rather than touching Mongo/Binance directly." Uses the
// same ControlApiClient apps/chatops uses, rather than a second
// hand-rolled fetch wrapper.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; action: string }> },
): Promise<Response> {
  const { slug, action } = await params;

  if (!ALLOWED_ACTIONS.has(action as ControlApiAction)) {
    return Response.json({ error: `unknown action "${action}"` }, { status: 400 });
  }

  try {
    const result = await client.runAction(slug, action as ControlApiAction);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: `couldn't reach the engine: ${(error as Error).message}` }, { status: 502 });
  }
}
