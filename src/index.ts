import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION, type Deps } from "./server.js";
import { Everloot } from "./sources/everloot.js";
import { ForeverDb } from "./sources/foreverdb.js";
import { Blizzard } from "./sources/blizzard.js";

export function createApp(deps: Deps, accessToken = process.env.ACCESS_TOKEN) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const tokenOk = (given: string | undefined) => {
    if (!accessToken) return true;
    if (!given) return false;
    const a = Buffer.from(given), b = Buffer.from(accessToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // Friends connect with either https://host/mcp/<token> (easiest in Claude's connector screen)
  // or https://host/mcp with "Authorization: Bearer <token>".
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const fromPath = typeof req.params.token === "string" ? req.params.token : undefined;
    if (tokenOk(fromPath ?? bearer)) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: wrong or missing access token." }, id: null });
  };

  const handle = async (req: Request, res: Response) => {
    // Stateless: a fresh server and transport per request, sharing the cached data sources.
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  };

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: POST only." }, id: null });
  };

  for (const path of ["/mcp", "/mcp/:token"]) {
    app.post(path, auth, handle);
    app.get(path, auth, notAllowed);
    app.delete(path, auth, notAllowed);
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION, everlootCallsLeftThisHour: deps.everloot.budget.remaining(), foreverdb: deps.foreverdb.enabled, blizzard: deps.blizzard.enabled });
  });
  app.get("/", (_req, res) => {
    res.type("text/plain").send(`Forever Build Coach ${VERSION}\nMCP endpoint: POST /mcp${accessToken ? "/<access-token>" : ""}\nHealth: /health\n`);
  });
  return app;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const deps: Deps = { everloot: new Everloot(), foreverdb: new ForeverDb(), blizzard: new Blizzard() };
  const port = Number(process.env.PORT ?? 3000);
  createApp(deps).listen(port, "0.0.0.0", () => {
    console.log(`Forever Build Coach ${VERSION} listening on :${port}`);
    console.log(`  ForeverDB: ${deps.foreverdb.enabled ? "on" : "off (set FOREVERDB_API_KEY)"}`);
    console.log(`  Blizzard API: ${deps.blizzard.enabled ? "on" : "off (set BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET)"}`);
    console.log(`  Access token: ${process.env.ACCESS_TOKEN ? "required" : "NOT SET - anyone with the URL can use this server"}`);
  });
}
