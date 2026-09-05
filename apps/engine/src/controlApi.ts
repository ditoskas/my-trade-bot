import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StrategyRegistry } from "./registry";

export interface ControlApiOptions {
  port: number;
  authToken: string;
  registry: StrategyRegistry;
}

// Minimal internal HTTP API — the UI's server-side routes and, later,
// chatops (Phase 5) call this rather than touching Mongo/Binance directly
// (see CLAUDE.md's non-negotiable policies). Bound to 127.0.0.1 only, and
// gated by a shared-secret bearer token — this is a control surface for a
// live trading engine, not a public API.
export function startControlApi(options: ControlApiOptions): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res, options).catch((error: unknown) => {
      console.error("[control-api] unhandled error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });

  // Without this, a port conflict (e.g. a previous engine process still
  // running — hit during Phase 4 verification) crashes the whole engine
  // via Node's default unhandled-'error'-event behavior, with a stack
  // trace that doesn't say what to actually do about it.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[control-api] port ${options.port} is already in use — is another engine instance already running? ` +
          `(find it with e.g. \`netstat -ano | findstr :${options.port}\` on Windows)`,
      );
    } else {
      console.error("[control-api] server error:", error);
    }
    process.exit(1);
  });

  server.listen(options.port, "127.0.0.1", () => {
    console.log(`[control-api] listening on http://127.0.0.1:${options.port}`);
  });

  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: ControlApiOptions): Promise<void> {
  if (req.headers.authorization !== `Bearer ${options.authToken}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const url = new URL(req.url ?? "/", "http://internal");
  const segments = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && segments[0] === "status") {
    const status = options.registry.list().map((entry) => ({
      slug: entry.doc.slug,
      name: entry.doc.name,
      lifecycleState: entry.doc.lifecycleState,
      killSwitchEngaged: entry.doc.killSwitchEngaged,
      symbols: entry.doc.symbols,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === "POST" && segments[0] === "strategies" && segments[1] && segments[2]) {
    const slug = segments[1];
    const action = segments[2];

    let ok = false;
    // "resume" always goes back to "paper" — every strategy in this system
    // is paper-only so far (Phase 5/6 add real promotion between lifecycle
    // states with an actual "previous state" concept; not needed yet).
    if (action === "pause") {
      ok = await options.registry.setLifecycleState(slug, "paused");
    } else if (action === "resume") {
      ok = await options.registry.setLifecycleState(slug, "paper");
    } else if (action === "kill") {
      ok = await options.registry.setKillSwitch(slug, true);
    } else if (action === "unkill") {
      ok = await options.registry.setKillSwitch(slug, false);
    }

    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}
