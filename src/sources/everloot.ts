import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TtlCache, HourlyBudget, HOUR } from "../cache.js";

export const EVERLOOT_URL = process.env.EVERLOOT_URL ?? "https://everloot.app/mcp/public";
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

export class Everloot {
  private client?: Client;
  private connecting?: Promise<Client>;
  private cache = new TtlCache();
  /** Everloot allows 200 calls an hour per IP. Keep a margin for reconnects. */
  readonly budget = new HourlyBudget(Number(process.env.EVERLOOT_HOURLY_BUDGET ?? 180));

  constructor(private url = EVERLOOT_URL) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        if (!this.budget.take(1)) throw this.overBudget();
        const client = new Client({ name: "forever-build-coach", version: "0.1.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
        this.client = client;
        return client;
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  private overBudget() {
    return new EverlootError(`Everloot's shared hourly limit is used up on this server. Try again in about ${this.budget.resetInMinutes()} minutes, or ask about something already looked up (answers are cached).`);
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<EverlootResult> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const key = `${tool}:${JSON.stringify(clean, Object.keys(clean).sort())}`;
    let fresh = false;
    const result = await this.cache.get(key, TTL[tool] ?? HOUR, async () => {
      fresh = true;
      return this.callUncached(tool, clean);
    });
    return fresh ? result : { ...result, cached: true };
  }

  private async callUncached(tool: string, args: Record<string, unknown>, retry = true): Promise<EverlootResult> {
    const client = await this.connect();
    if (!this.budget.take(1)) throw this.overBudget();
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      const content = (res.content ?? []) as { type: string; text?: string }[];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (res.isError) throw new EverlootError(`Everloot ${tool} failed: ${text}`);
      return { text, structured: res.structuredContent as Record<string, unknown> | undefined };
    } catch (err) {
      if (err instanceof EverlootError) throw err;
      // The connection may have dropped: reconnect once.
      this.client = undefined;
      if (retry) return this.callUncached(tool, args, false);
      throw new EverlootError(`Could not reach Everloot (${(err as Error).message}).`);
    }
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    return this.cache.get("__tools", 12 * HOUR, async () => {
      const client = await this.connect();
      if (!this.budget.take(1)) throw this.overBudget();
      const res = await client.listTools();
      return res.tools.map((t) => ({ name: t.name, description: t.description }));
    });
  }
}
