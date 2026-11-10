import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, VERSION, type Deps } from "./server.js";
import { Everloot, EVERLOOT_URL } from "./sources/everloot.js";
import { ForeverDb } from "./sources/foreverdb.js";
import { ForeverDbSite } from "./sources/foreverdb-site.js";
import { ItemCatalog } from "./sources/foreverdb-data.js";
import { Guides } from "./sources/guides.js";
import { Blizzard, type Region } from "./sources/blizzard.js";
import { AuctionPrices } from "./sources/auctions.js";
import { GoldFinder, goldSettingsFrom, type D1Like } from "./sources/gold.js";
import Anthropic from "@anthropic-ai/sdk";
import type { KvLike } from "./cache.js";

export interface Env {
  /** Shared secret friends put in the connector URL: https://<worker>/mcp/<ACCESS_TOKEN> */
  ACCESS_TOKEN?: string;
  FOREVERDB_API_KEY?: string;
  BLIZZARD_CLIENT_ID?: string;
  BLIZZARD_CLIENT_SECRET?: string;
  EVERLOOT_URL?: string;
  FOREVERDB_BASE?: string;
  FOREVERDB_SITE?: string;
  /** ForeverDB's public item list; default https://foreverdb.net/data/items.json. Set to "off" to disable. */
  FOREVERDB_ITEMS_URL?: string;
  EVERLOOT_HOURLY_BUDGET?: string;
  /** Optional Cloudflare Browser Rendering binding: reads gear from the armory page without a Battle.net key. */
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
  /** Optional Workers KV namespace that shares cached answers between Worker instances. */
  CACHE?: KvLike;
  /** Regions whose auction houses the cron keeps fresh, comma separated; default "eu". "off" stops it. */
  AUCTION_REGIONS?: string;
  /** Auction houses refreshed per cron run (each download is up to ~9 MB); default 4. */
  AUCTION_HOUSES_PER_RUN?: string;
  /** Optional D1 database for price history and the gold finder. */
  DB?: D1Like;
  /** Optional: lets Claude Haiku review the gold finder's picks. Without it the list is maths only. */
  ANTHROPIC_API_KEY?: string;
  /** Auction house ids the gold finder watches, comma separated (at most 2), e.g. "113". Unset = off. */
  GOLD_HOUSE_IDS?: string;
  GOLD_REGION?: string;
  /** Most the AI review may spend per UTC day, US dollars; default 0.20. */
  GOLD_DAILY_BUDGET_USD?: string;
  /** Hours between history saves and reviews; default 4. */
  GOLD_EVERY_HOURS?: string;
  /** One line about the player, given to the AI. */
  GOLD_PLAYER?: string;
  /** Profit (copper) an opportunity needs before it's flagged noteworthy; default 5000 (50 silver). */
  GOLD_NOTEWORTHY_COPPER?: string;
}

// Built once per Worker instance and reused across requests, so the in-memory cache survives between calls.
let cached: { key: string; deps: Deps } | undefined;
export function depsFor(env: Env): Deps {
  const key = [env.EVERLOOT_URL, env.FOREVERDB_API_KEY, env.FOREVERDB_BASE, env.FOREVERDB_SITE, env.FOREVERDB_ITEMS_URL, env.BLIZZARD_CLIENT_ID, env.EVERLOOT_HOURLY_BUDGET, Boolean(env.CACHE), Boolean(env.BROWSER), Boolean(env.DB), Boolean(env.ANTHROPIC_API_KEY), env.GOLD_HOUSE_IDS, env.GOLD_REGION, env.GOLD_DAILY_BUDGET_USD, env.GOLD_EVERY_HOURS, env.GOLD_PLAYER, env.GOLD_NOTEWORTHY_COPPER].join("|");
  if (cached?.key !== key) {
    cached = {
      key,
      deps: {
        everloot: new Everloot(env.EVERLOOT_URL || EVERLOOT_URL, env.CACHE, Number(env.EVERLOOT_HOURLY_BUDGET || 180)),
        foreverdb: new ForeverDb(env.FOREVERDB_API_KEY || undefined, env.FOREVERDB_BASE || undefined, env.CACHE),
        foreverdbSite: new ForeverDbSite(env.FOREVERDB_SITE || undefined, env.CACHE),
        catalog: env.FOREVERDB_ITEMS_URL === "off" ? undefined : new ItemCatalog(env.CACHE, env.FOREVERDB_ITEMS_URL || "https://foreverdb.net/data/items.json"),
        guides: new Guides(env.CACHE, env.BROWSER),
        blizzard: new Blizzard(env.BLIZZARD_CLIENT_ID || undefined, env.BLIZZARD_CLIENT_SECRET || undefined),
        browser: env.BROWSER,
      },
    };
    cached.deps.auctions = new AuctionPrices(cached.deps.blizzard, env.CACHE);
    const gold = goldSettingsFrom(env);
    if (env.DB && gold) {
      const catalog = cached.deps.catalog;
      cached.deps.gold = new GoldFinder(
        env.DB, gold,
        env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 }) : undefined,
        catalog ? (id) => catalog.get(id) : undefined,
      );
    }
  }
  return cached.deps;
}

/** Constant-time string comparison. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });

export default {
  /** Cron (see wrangler.toml): keeps auction house prices about an hour fresh, a few houses per run. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const deps = depsFor(env);
    if (!deps.auctions?.enabled || env.AUCTION_REGIONS === "off") return;
    const regions = (env.AUCTION_REGIONS || "eu").split(",").map((r) => r.trim().toLowerCase()).filter((r): r is Region => ["us", "eu", "kr", "tw"].includes(r));
    const perRun = Number(env.AUCTION_HOUSES_PER_RUN || 4);
    ctx.waitUntil(Promise.all(regions.map(async (r) => {
      const done = await deps.auctions!.refreshStalest(r, perRun).catch((e) => { console.error(`auction cron ${r}:`, e); return []; });
      console.log(`auction cron ${r}: refreshed ${done.join(", ") || "nothing"}`);
    })).then(async () => {
      if (!deps.gold) return;
      const runs = await deps.gold.maybeRun(deps.auctions!).catch((e) => { console.error("gold finder:", e); return []; });
      for (const a of runs) console.log(`gold finder ${a.houseId}: ${a.opportunities.length} picks, $${a.costUsd}${a.skipped ? ` (${a.skipped})` : ""}`);
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const deps = depsFor(env);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: VERSION, everlootCallsLeftThisInstance: deps.everloot.budget.remaining(), sharedCache: Boolean(env.CACHE), foreverdb: deps.foreverdb.enabled, foreverdbPages: Boolean(deps.foreverdbSite), blizzard: deps.blizzard.enabled, browserRendering: Boolean(env.BROWSER), accessTokenRequired: Boolean(env.ACCESS_TOKEN) });
    }
    if (url.pathname === "/" ) {
      return new Response(`Forever Build Coach ${VERSION}\nMCP endpoint: POST /mcp${env.ACCESS_TOKEN ? "/<access-token>" : ""}\nHealth: /health\n`, { headers: { "content-type": "text/plain" } });
    }

    // Friends connect with https://<worker>/mcp/<token> (easiest in Claude's connector screen)
    // or https://<worker>/mcp with "Authorization: Bearer <token>".
    const match = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!match) return new Response("Not found", { status: 404 });
    if (env.ACCESS_TOKEN) {
      const given = match[1] ? decodeURIComponent(match[1]) : request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!given || !sameSecret(given, env.ACCESS_TOKEN)) return rpcError(401, -32001, "Unauthorized: wrong or missing access token.");
    }
    if (request.method !== "POST") return rpcError(405, -32000, "Method not allowed. This server is stateless: POST only.", { allow: "POST" });

    // Stateless: a fresh MCP server and transport per request, sharing the cached data sources.
    const server = createServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } catch (err) {
      console.error("MCP request failed:", err);
      return rpcError(500, -32603, "Internal server error");
    }
  },
};
