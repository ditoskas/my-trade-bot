export interface EngineStatusEntry {
  slug: string;
  name: string;
  lifecycleState: string;
  killSwitchEngaged: boolean;
  symbols: string[];
  // Whether the engine currently has this strategy's runner/market-data
  // connections running at all — distinct from lifecycleState (capital-
  // promotion stage) and killSwitchEngaged (blocks new entries while still
  // running). A disabled strategy still appears here as a row read
  // straight from Mongo (see app/page.tsx), just with enabled: false and
  // no live engine state to overlay on top of it.
  enabled: boolean;
}

export type ControlApiAction = "pause" | "resume" | "kill" | "unkill" | "enable" | "disable";

export interface ControlApiActionResult {
  ok: boolean;
  error?: string;
}

export interface ControlApiClientOptions {
  baseUrl: string;
  token: string;
}

// Thin client for the Engine's internal control API (see CLAUDE.md's
// Engine section) — used by both apps/ui (server-side proxy routes) and
// apps/chatops (Telegram commands), so it lives here once rather than
// being duplicated in each. Never call this from browser code: the token
// is a secret meant to stay server-side.
export class ControlApiClient {
  constructor(private readonly options: ControlApiClientOptions) {}

  async getStatus(): Promise<EngineStatusEntry[]> {
    const response = await fetch(`${this.options.baseUrl}/status`, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });
    if (!response.ok) {
      throw new Error(`engine status request failed: ${response.status}`);
    }
    return (await response.json()) as EngineStatusEntry[];
  }

  async runAction(slug: string, action: ControlApiAction): Promise<ControlApiActionResult> {
    const response = await fetch(
      `${this.options.baseUrl}/strategies/${encodeURIComponent(slug)}/${action}`,
      { method: "POST", headers: { Authorization: `Bearer ${this.options.token}` } },
    );
    const body = (await response.json()) as { ok?: boolean; error?: string };
    return { ok: body.ok === true, error: body.error };
  }
}
