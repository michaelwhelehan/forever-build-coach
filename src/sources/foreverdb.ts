import { TtlCache, HOUR } from "../cache.js";

export const FOREVERDB_BASE = process.env.FOREVERDB_BASE ?? "https://foreverdb.net/api/v1";
export const FOREVERDB_CREDIT = "Data from ForeverDB.net (https://foreverdb.net)";

/** Paths we allow through the raw tool: read-only endpoints from ForeverDB's developer page. */
export const FOREVERDB_PATHS = [
  "meta", "items", "items/{id}", "spells", "spells/{id}", "quests", "quests/{id}", "vendors", "vendors/{id}",
  "poisons", "disenchant", "dungeons", "dungeons/{id}", "zones", "classes", "classes/{name}", "itemsets", "itemsets/{id}",
  "professions", "professions/{slug}", "gathering/{slug}", "battlegrounds", "changes-seen", "builds", "builds/{build}",
  "buffs-nerfs", "merchants-favor", "articles", "articles/{slug}", "posts",
];
const PATH_RE = new RegExp(`^(${FOREVERDB_PATHS.map((p) => p.replace(/\{[a-z]+\}/g, "[A-Za-z0-9._-]+")).join("|")})$`);

export class ForeverDbError extends Error {}

export class ForeverDb {
  private cache = new TtlCache();
  constructor(private key = process.env.FOREVERDB_API_KEY, private base = FOREVERDB_BASE) {}

  get enabled() { return Boolean(this.key); }

  async get(path: string, params: Record<string, string | number | boolean | undefined> = {}, ttl = 6 * HOUR): Promise<{ data: unknown; meta?: Record<string, unknown> }> {
    if (!this.key) throw new ForeverDbError("ForeverDB is not set up on this server (no FOREVERDB_API_KEY). Request a key at https://foreverdb.net/developers.");
    const clean = path.replace(/^\/+|\/+$/g, "").replace(/^api\/v1\//, "");
    if (!PATH_RE.test(clean)) throw new ForeverDbError(`Not an allowed ForeverDB path: ${clean}`);
    const url = new URL(`${this.base}/${clean}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return this.cache.get(url.toString(), ttl, async () => {
      const res = await fetch(url, { headers: { "X-API-Key": this.key!, accept: "application/json", "user-agent": "forever-build-coach/0.1" } });
      if (res.status === 429) throw new ForeverDbError(`ForeverDB rate limit hit; retry after ${res.headers.get("retry-after") ?? "a minute"} seconds.`);
      if (res.status === 404) throw new ForeverDbError(`ForeverDB has nothing at ${clean}.`);
      if (!res.ok) throw new ForeverDbError(`ForeverDB answered ${res.status} for ${clean}.`);
      return (await res.json()) as { data: unknown; meta?: Record<string, unknown> };
    });
  }
}
