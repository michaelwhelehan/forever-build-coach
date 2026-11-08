import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, VERSION, type Deps } from "./server.js";
import { Everloot, EVERLOOT_URL } from "./sources/everloot.js";
import { ForeverDb } from "./sources/foreverdb.js";
import { Blizzard } from "./sources/blizzard.js";
import type { KvLike } from "./cache.js";

export interface Env {
  /** Shared secret friends put in the connector URL: https://<worker>/mcp/<ACCESS_TOKEN> */
  ACCESS_TOKEN?: string;
  FOREVERDB_API_KEY?: string;
  BLIZZARD_CLIENT_ID?: string;
  BLIZZARD_CLIENT_SECRET?: string;
  EVERLOOT_URL?: string;
  FOREVERDB_BASE?: string;
  EVERLOOT_HOURLY_BUDGET?: string;
  /** Optional Cloudflare Browser Rendering binding: reads gear from the armory page without a Battle.net key. */
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
  /** Optional Workers KV namespace that shares cached answers between Worker instances. */
  CACHE?: KvLike;
}

// Built once per Worker instance and reused across requests, so the in-memory cache survives between calls.
let cached: { key: string; deps: Deps } | undefined;
export function depsFor(env: Env): Deps {
  const key = [env.EVERLOOT_URL, env.FOREVERDB_API_KEY, env.FOREVERDB_BASE, env.BLIZZARD_CLIENT_ID, env.EVERLOOT_HOURLY_BUDGET, Boolean(env.CACHE), Boolean(env.BROWSER)].join("|");
  if (cached?.key !== key) {
    cached = {
      key,
      deps: {
        everloot: new Everloot(env.EVERLOOT_URL || EVERLOOT_URL, env.CACHE, Number(env.EVERLOOT_HOURLY_BUDGET || 180)),
        foreverdb: new ForeverDb(env.FOREVERDB_API_KEY || undefined, env.FOREVERDB_BASE || undefined, env.CACHE),
        blizzard: new Blizzard(env.BLIZZARD_CLIENT_ID || undefined, env.BLIZZARD_CLIENT_SECRET || undefined),
        browser: env.BROWSER,
      },
    };
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const deps = depsFor(env);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: VERSION, everlootCallsLeftThisInstance: deps.everloot.budget.remaining(), sharedCache: Boolean(env.CACHE), foreverdb: deps.foreverdb.enabled, blizzard: deps.blizzard.enabled, browserRendering: Boolean(env.BROWSER), accessTokenRequired: Boolean(env.ACCESS_TOKEN) });
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
