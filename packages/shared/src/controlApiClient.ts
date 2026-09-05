export interface EngineStatusEntry {
  slug: string;
  name: string;
  lifecycleState: string;
  killSwitchEngaged: boolean;
  symbols: string[];
}

export type ControlApiAction = "pause" | "resume" | "kill" | "unkill";

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

  async runAction(slug: string, action: ControlApiAction): Promise<boolean> {
    const response = await fetch(
      `${this.options.baseUrl}/strategies/${encodeURIComponent(slug)}/${action}`,
      { method: "POST", headers: { Authorization: `Bearer ${this.options.token}` } },
    );
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  }
}
