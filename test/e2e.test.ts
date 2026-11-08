import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker, { type Env } from "../src/worker.js";
import type { KvLike } from "../src/cache.js";

// A stand-in for Everloot's public MCP, answering in the shapes of its published schemas.
const calls: string[] = [];
const FAKE: Record<string, (a: Record<string, unknown>) => Record<string, unknown>> = {
  search_knowledge: (a) => ({ hits: [{ id: 1, extId: 19019, kind: "item", name: `Result for ${a.query}`, licence: "CC BY-SA 4.0" }] }),
  item_page: (a) => ({
    connected: true, dataAsOf: new Date().toISOString(), url: `https://everloot.app/item/${a.itemId}`,
    page: {
      itemId: a.itemId, name: a.itemId === 1 ? "Sturdy Axe" : "Rusty Sword", drops: [],
      reported: { shown: a.itemId === 1
        ? [{ fact: "strength", value: 8, reporters: 5, build: "1.60.1", lastSeen: null }, { fact: "damage_per_second", value: 14, reporters: 5, build: "1.60.1", lastSeen: null }]
        : [{ fact: "stamina", value: 6, reporters: 4, build: "1.60.1", lastSeen: null }, { fact: "damage_per_second", value: 11, reporters: 4, build: "1.60.1", lastSeen: null }],
        contested: [] },
    },
  }),
  talent_tree: (a) => ({ label: "x", build: "1.60.1.70862", class: a.class, points: { firstPointLevel: 10, maxLevel: 60, total: 51, pointLevels: Array.from({ length: 51 }, (_, i) => i + 10) }, trees: [], nodes: [] }),
  market_value: (a) => ({ connected: true, dataAsOf: null, page: { realm: a.realm, itemId: a.itemId, value: a.itemId === 2589 ? { itemId: 2589, market: 1250, min: 1000, historical: 1300, quantity: 40, day: "2026-11-07", ageDays: 1, reporters: 6, thin: false } : null } }),
  profession_path: () => ({ connected: true, dataAsOf: null, page: { profession: "tailoring", fromSkill: 1, toSkill: 50, steps: [{ recipe: "Bolt of Linen Cloth", fromSkill: 1, toSkill: 50, crafts: 50, points: 49, reagents: [{ item: "Linen Cloth", count: 100 }], copper: 12000, reporters: 4 }], gaps: [], reagents: [], copper: 12000 } }),
  recent_changes: () => ({ posts: [] }),
};

async function fakeEverloot(req: Request): Promise<Response> {
  const server = new Server({ name: "fake-everloot", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.keys(FAKE).map((name) => ({ name, inputSchema: { type: "object" as const } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    calls.push(r.params.name);
    const f = FAKE[r.params.name];
    if (!f) return { content: [{ type: "text", text: "unknown tool" }], isError: true };
    const structured = f((r.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
  });
  // Like the real one: stateless, answers as server-sent events.
  const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(t);
  return t.handleRequest(req);
}

function fakeForeverDb(req: Request): Response {
  const id = new URL(req.url).pathname.split("/").pop();
  if (req.headers.get("x-api-key") !== "fdb_test") return new Response(null, { status: 401 });
  return Response.json({ data: { id: Number(id), name: "Sturdy Axe", stats: [{ type: "Strength", value: 8 }, { type: "Stamina", value: 3 }], dps: 14 }, meta: { build: "1.60.1.70862" } });
}

class MemoryKv implements KvLike {
  data = new Map<string, string>();
  async get(key: string) { const v = this.data.get(key); return v === undefined ? null : JSON.parse(v); }
  async put(key: string, value: string) { this.data.set(key, value); }
}

const kv = new MemoryKv();
const env: Env = {
  ACCESS_TOKEN: "secret-token",
  EVERLOOT_URL: "https://everloot.test/mcp/public",
  FOREVERDB_API_KEY: "fdb_test",
  FOREVERDB_BASE: "https://foreverdb.test/api/v1",
  CACHE: kv,
};
const base = "https://coach.test";
const realFetch = globalThis.fetch;

beforeAll(() => {
  // Outgoing calls from the Worker go to the fakes.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith("https://everloot.test/")) return fakeEverloot(req);
    if (req.url.startsWith("https://foreverdb.test/")) return fakeForeverDb(req);
    if (req.url === "https://foreverdb-site.test/items") return new Response('<ul><li><a href="/item/11287">Lesser Magic Wand</a> (item level 15)</li><li><a href="/item/11288">Greater Magic Wand</a> (item level 21)</li><li><a href="/item/2589">Linen Cloth</a> (item level 5)</li></ul>', { headers: { "content-type": "text/html" } });
    if (req.url === "https://foreverdb-site.test/item/11287") return new Response('<h1>Lesser Magic Wand</h1><p>Uncommon Ranged Wand (item level 15, requires level 5)</p><ul><li>Slot: Ranged (Wand)</li><li>12 - 22 Arcane damage, speed 1.50</li><li>11.3 damage per second</li><li>+1 Spell Power</li></ul>', { headers: { "content-type": "text/html" } });
    if (req.url.startsWith("https://worldofwarcraft.blizzard.com/")) {
      return req.url.endsWith("/uzal-muzal")
        ? new Response('<html><head><meta name="description" content="Uzal - 15 Undead character.class, 7 ilvl"><meta property="og:title" content="Uzal Muzal - Character - WoW"></head><body></body></html>', { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    }
    return realFetch(req);
  });
});
afterAll(() => vi.unstubAllGlobals());

const callWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env);

async function connect(path: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + path), { fetch: callWorker }));
  return c;
}
const json = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

describe("end to end", () => {
  it("rejects a wrong token", async () => {
    await expect(connect("/mcp/wrong")).rejects.toThrow();
  });

  it("lists the tools and prompt", async () => {
    const c = await connect("/mcp/secret-token");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["kb_guide", "search_game", "item_lookup", "compare_items", "talent_tree", "xp_calculator", "levelling_plan", "market_price", "farm_value", "profession_cost", "character_lookup", "everloot", "foreverdb"]));
    const { prompts } = await c.listPrompts();
    expect(prompts[0].name).toBe("optimize_build");
    await c.close();
  });

  it("merges ForeverDB and Everloot item data with confidence", async () => {
    const c = await connect("/mcp/secret-token");
    const r = json(await c.callTool({ name: "item_lookup", arguments: { itemId: 1 } }));
    expect(r.name).toBe("Sturdy Axe");
    expect(r.stats).toMatchObject({ str: 8, sta: 3, weapon_dps: 14 });
    expect(r.statsFrom).toBe("both");
    expect(r.confidence.label).toBe("high");
    expect(r.sources.map((s: { id: string }) => s.id)).toEqual(["foreverdb", "everloot"]);
    await c.close();
  });

  it("compares items for a spec", async () => {
    const c = await connect("/mcp/secret-token");
    const r = json(await c.callTool({ name: "compare_items", arguments: { class: "warrior", spec: "arms", items: [{ itemId: 2, slot: "two_hand" }, { itemId: 1, slot: "two_hand" }] } }));
    expect(r.ranking[0].name).toBe("Sturdy Axe");
    expect(r.ranking[0].vsFirstListed.startsWith("+")).toBe(true);
    expect(r.confidence.label).toBe("low"); // starter weights are a Classic baseline
    await c.close();
  });

  it("shares cached answers through KV", async () => {
    expect([...kv.data.keys()].some((k) => k.startsWith("everloot:item_page"))).toBe(true);
  });

  it("caches Everloot calls", async () => {
    const c = await connect("/mcp/secret-token");
    const before = calls.filter((x) => x === "talent_tree").length;
    await c.callTool({ name: "talent_tree", arguments: { class: "mage" } });
    await c.callTool({ name: "talent_tree", arguments: { class: "mage" } });
    expect(calls.filter((x) => x === "talent_tree").length - before).toBe(1);
    const p = json(await c.callTool({ name: "talent_points_by_level", arguments: { class: "mage", level: 25, talentedRanks: 2 } }));
    expect(p.pointsAvailable).toBe(16);
    await c.close();
  });

  it("prices farms and professions, treating missing prices as unknown", async () => {
    const c = await connect("/mcp/secret-token");
    const f = json(await c.callTool({ name: "farm_value", arguments: { realm: "Normal", perHour: [{ itemId: 2589, count: 100 }, { itemId: 999, count: 10 }] } }));
    expect(f.goldPerHourCopper).toBe(1187 * 100);
    expect(f.itemsWithoutPrice).toBe(1);
    const p = json(await c.callTool({ name: "profession_cost", arguments: { profession: "Tailoring", toSkill: 50 } }));
    expect(p.totalCost).toBe("1g 20s");
    await c.close();
  });

  it("runs the levelling maths", async () => {
    const c = await connect("/mcp/secret-token");
    const r = json(await c.callTool({ name: "levelling_plan", arguments: { level: 20, targetLevel: 21, activities: [{ name: "quest hub", xp: 6000, minutes: 30, killXpShare: 0.4 }, { name: "grind", xp: 4000, minutes: 30, killXpShare: 1 }] } }));
    expect(r.best).toBe("quest hub");
    expect(r.activities[0].hoursToTarget).toBe(1.9);
    const x = json(await c.callTool({ name: "xp_calculator", arguments: { level: 20, mobLevel: 21, rested: true } }));
    expect(x.xpPerKill).toBe(Math.round(145 * 1.05 * 2));
    expect(x.confidence.label).toBe("low");
    await c.close();
  });

  it("falls back to the armory page without Blizzard keys", async () => {
    const c = await connect("/mcp/secret-token");
    const r = json(await c.callTool({ name: "character_lookup", arguments: { name: "Uzal", surname: "Muzal" } }));
    expect(r.character).toMatchObject({ level: 15, race: "Undead", class: null, averageItemLevel: 7 });
    expect(r.notes.join(" ")).toMatch(/ask the player/);
    const missing = await c.callTool({ name: "character_lookup", arguments: { name: "Nobody", surname: "Here" } });
    expect(missing.isError).toBe(true);
    expect(json(missing).error).toMatch(/level 10/);
    await c.close();
  });

  it("reads ForeverDB's public pages when there is no API key", async () => {
    const keyless: Env = { ...env, FOREVERDB_API_KEY: undefined, FOREVERDB_SITE: "https://foreverdb-site.test" };
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/secret-token"), { fetch: (i, init) => worker.fetch(new Request(i, init), keyless) }));
    const s = json(await c.callTool({ name: "search_game", arguments: { query: "magic wand", kind: "item" } }));
    expect(s.foreverdbItems.map((r: { name: string }) => r.name)).toEqual(["Lesser Magic Wand", "Greater Magic Wand"]);
    const it = json(await c.callTool({ name: "item_lookup", arguments: { itemId: 11287 } }));
    expect(it).toMatchObject({ name: "Lesser Magic Wand", requiredLevel: 5, slot: "Ranged", stats: { sp: 1 }, statsFrom: "both" }); // the fake Everloot reports dps 11, and player reports win
    expect(it.sources[0]).toMatchObject({ id: "foreverdb", url: "https://foreverdb-site.test/item/11287" });
    await c.close();
  });

  it("serves health without a token", async () => {
    const res = await callWorker(`${base}/health`);
    expect(await res.json()).toMatchObject({ ok: true, sharedCache: true, foreverdb: true, blizzard: false });
  });

  it("accepts a bearer token too", async () => {
    const res = await callWorker(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer secret-token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_guide", arguments: { topic: "status" } } }) });
    expect(res.status).toBe(200);
  });
});
