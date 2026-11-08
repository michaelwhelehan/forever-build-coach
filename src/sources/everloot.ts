import { TtlCache, HourlyBudget, HOUR, type KvLike } from "../cache.js";

export const EVERLOOT_URL = "https://everloot.app/mcp/public";
export const EVERLOOT_CREDIT = "Data from Everloot (https://everloot.app), CC BY-SA 4.0";

/** How long each Everloot tool's answers are cached. Game-file data changes only with a patch. */
const TTL: Record<string, number> = {
  talent_tree: 12 * HOUR, class_races: 12 * HOUR, item_categories: 12 * HOUR, talent_plan: 12 * HOUR,
  item_page: 2 * HOUR, npc_page: 2 * HOUR, quest_page: 2 * HOUR, vendor_page: 2 * HOUR, object_page: 2 * HOUR,
  entity_relations: 2 * HOUR, profession_path: 2 * HOUR, recipe_thresholds: 2 * HOUR,
  search_knowledge: 2 * HOUR, get_by_name: 2 * HOUR, get_entity: 6 * HOUR, answer_sources: 2 * HOUR,
  market_value: 0.5 * HOUR, auction_history: 1 * HOUR, recent_changes: 0.5 * HOUR, population: 2 * HOUR,
};

export interface EverlootResult { text: string; structured?: Record<string, unknown>; isError?: boolean; cached?: boolean }

export class EverlootError extends Error {}

/**
 * Everloot's public MCP keeps no session, so each tool call is one plain JSON-RPC POST:
 * no handshake, which matters because the handshake counts against its 200 calls an hour.
 */
export class Everloot {
  private cache: TtlCache;
  readonly budget: HourlyBudget;
  private nextId = 1;

  constructor(private url = EVERLOOT_URL, kv?: KvLike, hourlyBudget = 180) {
    this.cache = new TtlCache(kv, "everloot:");
    this.budget = new HourlyBudget(hourlyBudget);
  }

  private overBudget() {
    return new EverlootError(`This server has used its share of Everloot's hourly limit. Try again in about ${this.budget.resetInMinutes()} minutes, or ask about something already looked up (answers are cached).`);
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<EverlootResult> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const key = `${tool}:${JSON.stringify(clean, Object.keys(clean).sort())}`;
    let fresh = false;
    const result = await this.cache.get(key, TTL[tool] ?? HOUR, async () => {
      fresh = true;
      const res = await this.rpc("tools/call", { name: tool, arguments: clean }) as { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
      const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (res.isError) throw new EverlootError(`Everloot ${tool} failed: ${text}`);
      return { text, structured: res.structuredContent } as EverlootResult;
    });
    return fresh ? result : { ...result, cached: true };
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    return this.cache.get("__tools", 12 * HOUR, async () => {
      const res = await this.rpc("tools/list", {}) as { tools: { name: string; description?: string }[] };
      return res.tools.map((t) => ({ name: t.name, description: t.description }));
    });
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.budget.take(1)) throw this.overBudget();
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "user-agent": "forever-build-coach/0.2" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      });
    } catch (err) {
      throw new EverlootError(`Could not reach Everloot (${(err as Error).message}).`);
    }
    if (res.status === 429) throw new EverlootError(`Everloot's rate limit was hit; retry after ${res.headers.get("retry-after") ?? "a few minutes"}.`);
    if (!res.ok) throw new EverlootError(`Everloot answered ${res.status}.`);
    const body = await res.text();
    const message = parseRpcBody(body, res.headers.get("content-type") ?? "");
    if (message.error) throw new EverlootError(`Everloot: ${message.error.message}`);
    return message.result;
  }
}

/** The answer comes back as JSON or as server-sent events; take the JSON-RPC message either way. */
export function parseRpcBody(body: string, contentType: string): { result?: unknown; error?: { message: string } } {
  if (contentType.includes("text/event-stream")) {
    const data = body.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    for (const d of data.reverse()) {
      try { const m = JSON.parse(d); if ("result" in m || "error" in m) return m; } catch { /* keep looking */ }
    }
    throw new EverlootError("Everloot sent an answer this server could not read.");
  }
  return JSON.parse(body);
}
