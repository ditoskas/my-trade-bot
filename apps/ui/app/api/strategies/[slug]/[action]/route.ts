const ALLOWED_ACTIONS = new Set(["pause", "resume", "kill", "unkill"]);

const ENGINE_CONTROL_API_URL = process.env.ENGINE_CONTROL_API_URL ?? "http://127.0.0.1:4001";
const ENGINE_CONTROL_API_TOKEN = process.env.ENGINE_CONTROL_API_TOKEN ?? "dev-only-insecure-token";

// The browser never talks to the Engine's control API directly — it calls
// this Next.js route, which is server-side code holding the shared secret.
// Keeps the engine's control port (and its token) off anything the browser
// could inspect, per CLAUDE.md: "UI... calls the Engine's internal
// authenticated API rather than touching Mongo/Binance directly."
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; action: string }> },
): Promise<Response> {
  const { slug, action } = await params;

  if (!ALLOWED_ACTIONS.has(action)) {
    return Response.json({ error: `unknown action "${action}"` }, { status: 400 });
  }

  try {
    const response = await fetch(`${ENGINE_CONTROL_API_URL}/strategies/${encodeURIComponent(slug)}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ENGINE_CONTROL_API_TOKEN}` },
    });
    const body: unknown = await response.json();
    return Response.json(body, { status: response.status });
  } catch (error) {
    return Response.json({ error: `couldn't reach the engine: ${(error as Error).message}` }, { status: 502 });
  }
}
