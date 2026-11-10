import Anthropic from "@anthropic-ai/sdk";
import type { Region } from "./blizzard.js";
import type { AuctionPrices, HouseSnapshot } from "./auctions.js";

/**
 * Gold finder: keeps a price history for one or two auction houses in D1, picks likely money makers
 * with plain maths (dips, spikes, cheap greens to disenchant), then asks Claude Haiku to rank them
 * into a short list with advice. A daily dollar cap stops the AI part once it's spent.
 */

/** The bits of Cloudflare D1 used here, so tests can pass a SQLite stand-in. */
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown>;
}

/** The part of the Anthropic client used here. */
export interface ClaudeLike {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export const MODEL = "claude-haiku-5-5";
/** Claude Haiku 5.5 list price, US dollars per million tokens, for prompts up to 100K tokens. */
const USD_PER_M_IN = 0.10;
const USD_PER_M_OUT = 0.50;
const MAX_OUTPUT_TOKENS = 6000;
const HISTORY_DAYS = 7;
const KEEP_DAYS = 8;
const MAX_CANDIDATES = 60;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS prices (house_id INTEGER NOT NULL, item_id INTEGER NOT NULL, at INTEGER NOT NULL, min INTEGER NOT NULL, market INTEGER NOT NULL, units INTEGER NOT NULL, PRIMARY KEY (house_id, item_id, at)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS gold_runs (house_id INTEGER PRIMARY KEY, last_history INTEGER NOT NULL DEFAULT 0, last_analysis INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS ai_spend (day TEXT PRIMARY KEY, usd REAL NOT NULL, calls INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS opportunities (house_id INTEGER NOT NULL, at INTEGER NOT NULL, model TEXT, cost_usd REAL, body TEXT NOT NULL, PRIMARY KEY (house_id, at))",
];

export interface GoldSettings {
  region: Region;
  houseIds: number[];
  /** Most the AI part may spend per UTC day, in US dollars. */
  dailyBudgetUsd: number;
  /** Hours between history saves and AI reviews. */
  everyHours: number;
  /** A line about the player, e.g. "Horde level 20 mage with Tailoring 100 and Enchanting 60". */
  player: string;
  /** Profit in copper an opportunity needs before it can be flagged as noteworthy. */
  noteworthyCopper: number;
}

/** Item names and quality, from ForeverDB's item list. */
export type ItemInfo = (id: number) => Promise<{ n: string; q: number; il: number; c: number } | undefined>;

export interface Candidate {
  itemId: number;
  name?: string;
  kind: "dip" | "spike" | "disenchant";
  lowestNow: number;
  marketNow: number;
  avg7d?: number;
  unitsNow: number;
  samples?: number;
  /** For disenchant: expected value of the materials at today's prices. */
  disenchantValue?: number;
  enchantingSkill?: number;
  /** Rough copper profit per unit after the 5% cut, before the AI's judgement. */
  roughProfit: number;
}

export interface Opportunity {
  itemId: number;
  item: string;
  action: "buy_and_relist" | "buy_to_disenchant" | "sell_now" | "farm_or_craft" | "avoid";
  buyAtMostCopper: number;
  sellAtCopper: number;
  expectedProfitCopper: number;
  why: string;
  risk: "low" | "medium" | "high";
  /** The AI thinks it stands out, and the profit is over the noteworthy line. */
  noteworthy: boolean;
}

export interface Analysis {
  houseId: number;
  at: string;
  model: string;
  costUsd: number;
  summary: string;
  opportunities: Opportunity[];
  candidates: number;
  /** Set when the AI was skipped (no key, over budget, error): the maths-only list is returned instead. */
  skipped?: string;
}

const AH_KEEP = 0.95;

/**
 * Classic 1.12 disenchant table for green (uncommon) armour, as a baseline for Forever.
 * [max item level, enchanting skill needed, [[item id, chance, average count], ...]]
 */
const DE_TABLE: [number, number, [number, number, number][]][] = [
  [15, 1, [[10940, 0.8, 1.5], [10938, 0.2, 1.5]]], // Strange Dust, Lesser Magic Essence
  [20, 1, [[10940, 0.75, 2.5], [10939, 0.2, 1.5], [10978, 0.05, 1]]], // Greater Magic Essence, Small Glimmering Shard
  [25, 25, [[10940, 0.75, 5], [10998, 0.15, 1.5], [10978, 0.1, 1]]], // Lesser Astral Essence
  [30, 50, [[11083, 0.75, 1.5], [11082, 0.2, 1.5], [11084, 0.05, 1]]], // Soul Dust, Greater Astral Essence, Large Glimmering Shard
  [35, 75, [[11083, 0.75, 3.5], [11134, 0.2, 1.5], [11084, 0.05, 1]]], // Lesser Mystic Essence
  [40, 100, [[11137, 0.75, 1.5], [11135, 0.2, 1.5], [11138, 0.05, 1]]], // Vision Dust, Greater Mystic Essence, Small Glowing Shard
];

export function disenchantValue(itemLevel: number, prices: HouseSnapshot["items"]): { value: number; skill: number } | undefined {
  const row = DE_TABLE.find(([max]) => itemLevel <= max);
  if (!row || itemLevel < 5) return undefined;
  let value = 0;
  for (const [id, chance, count] of row[2]) {
    const p = prices[String(id)];
    if (!p) return undefined; // a material nobody sells: value unknown
    value += chance * count * p[1];
  }
  return { value: Math.round(value), skill: row[1] };
}

export const costUsd = (inputTokens: number, outputTokens: number) => (inputTokens * USD_PER_M_IN + outputTokens * USD_PER_M_OUT) / 1e6;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export class GoldFinder {
  private ready?: Promise<void>;
  constructor(private db: D1Like, private settings: GoldSettings, private claude?: ClaudeLike, private itemInfo?: ItemInfo) {}

  get houseIds() { return this.settings.houseIds; }
  get settingsView() { return { region: this.settings.region, houseIds: this.settings.houseIds, dailyBudgetUsd: this.settings.dailyBudgetUsd, everyHours: this.settings.everyHours, ai: Boolean(this.claude) }; }

  private init() {
    this.ready ??= (async () => { for (const sql of SCHEMA) await this.db.prepare(sql).run(); })();
    return this.ready;
  }

  /** Cron: for each watched house whose turn has come, save its prices and look for opportunities. */
  async maybeRun(auctions: AuctionPrices, now = Date.now()): Promise<Analysis[]> {
    await this.init();
    const out: Analysis[] = [];
    for (const houseId of this.settings.houseIds) {
      const run = await this.db.prepare("SELECT last_history, last_analysis FROM gold_runs WHERE house_id = ?").bind(houseId).first<{ last_history: number; last_analysis: number }>();
      if (run && now - run.last_history < this.settings.everyHours * 3600_000 - 5 * 60_000) continue;
      try {
        const snap = await auctions.snapshot(this.settings.region, houseId);
        await this.saveHistory(houseId, snap, now);
        out.push(await this.analyse(houseId, snap, now));
      } catch (e) {
        console.error(`gold finder ${houseId}:`, e);
      }
    }
    return out;
  }

  async saveHistory(houseId: number, snap: HouseSnapshot, now = Date.now()) {
    await this.init();
    const at = Math.floor(Date.parse(snap.scannedAt) / 1000);
    const rows = Object.entries(snap.items);
    // D1 allows 100 bound values per statement: 6 columns, 16 rows each.
    const stmts: D1Stmt[] = [];
    for (let i = 0; i < rows.length; i += 16) {
      const chunk = rows.slice(i, i + 16);
      const sql = `INSERT OR REPLACE INTO prices (house_id, item_id, at, min, market, units) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`;
      stmts.push(this.db.prepare(sql).bind(...chunk.flatMap(([id, [min, market, units]]) => [houseId, Number(id), at, min, market, units])));
    }
    stmts.push(this.db.prepare("DELETE FROM prices WHERE house_id = ? AND at < ?").bind(houseId, Math.floor(now / 1000) - KEEP_DAYS * 86400));
    stmts.push(this.db.prepare("INSERT INTO gold_runs (house_id, last_history) VALUES (?, ?) ON CONFLICT (house_id) DO UPDATE SET last_history = excluded.last_history").bind(houseId, now));
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
  }

  /** The maths part: items well under their weekly average, well over it, and greens worth more as enchanting mats. */
  async candidates(houseId: number, snap: HouseSnapshot, now = Date.now()): Promise<Candidate[]> {
    await this.init();
    const since = Math.floor(now / 1000) - HISTORY_DAYS * 86400;
    const { results } = await this.db.prepare("SELECT item_id, AVG(market) AS avg, COUNT(*) AS n FROM prices WHERE house_id = ? AND at >= ? GROUP BY item_id").bind(houseId, since).all<{ item_id: number; avg: number; n: number }>();
    const history = new Map(results.map((r) => [r.item_id, r]));
    const out: Candidate[] = [];
    for (const [key, [min, market, units]] of Object.entries(snap.items)) {
      const id = Number(key);
      const h = history.get(id);
      if (h && h.n >= 3) {
        const avg = Math.round(h.avg);
        if (avg >= 50 && min < avg * 0.6) out.push({ itemId: id, kind: "dip", lowestNow: min, marketNow: market, avg7d: avg, unitsNow: units, samples: h.n, roughProfit: Math.round(avg * AH_KEEP - min) });
        else if (avg >= 50 && market > avg * 1.4) out.push({ itemId: id, kind: "spike", lowestNow: min, marketNow: market, avg7d: avg, unitsNow: units, samples: h.n, roughProfit: Math.round(market * AH_KEEP - avg) });
      }
    }
    if (this.itemInfo) {
      for (const [key, [min, market, units]] of Object.entries(snap.items)) {
        const info = await this.itemInfo(Number(key)).catch(() => undefined);
        if (!info || info.q !== 2 || (info.c !== 2 && info.c !== 4)) continue;
        const de = disenchantValue(info.il, snap.items);
        if (de && de.value * AH_KEEP > min * 1.15) out.push({ itemId: Number(key), kind: "disenchant", lowestNow: min, marketNow: market, unitsNow: units, disenchantValue: de.value, enchantingSkill: de.skill, roughProfit: Math.round(de.value * AH_KEEP - min) });
      }
      for (const c of out) c.name ??= (await this.itemInfo(c.itemId).catch(() => undefined))?.n;
    }
    return out.sort((a, b) => b.roughProfit - a.roughProfit).slice(0, MAX_CANDIDATES);
  }

  async spentToday(now = Date.now()): Promise<{ day: string; usd: number; calls: number }> {
    await this.init();
    const day = utcDay(now);
    const row = await this.db.prepare("SELECT usd, calls FROM ai_spend WHERE day = ?").bind(day).first<{ usd: number; calls: number }>();
    return { day, usd: row?.usd ?? 0, calls: row?.calls ?? 0 };
  }

  async analyse(houseId: number, snap: HouseSnapshot, now = Date.now()): Promise<Analysis> {
    const cands = await this.candidates(houseId, snap, now);
    const base = { houseId, at: new Date(now).toISOString(), candidates: cands.length };
    const mathsOnly = (skipped: string): Analysis => ({
      ...base, model: "none", costUsd: 0, skipped,
      summary: "Maths-only list: biggest rough profits first. No AI review this time.",
      opportunities: cands.slice(0, 10).map((c) => ({
        itemId: c.itemId, item: c.name ?? `Item ${c.itemId}`,
        action: c.kind === "dip" ? "buy_and_relist" : c.kind === "disenchant" ? "buy_to_disenchant" : "sell_now",
        buyAtMostCopper: c.kind === "spike" ? 0 : c.lowestNow, sellAtCopper: c.kind === "spike" ? c.marketNow : (c.avg7d ?? c.disenchantValue ?? 0),
        expectedProfitCopper: c.roughProfit, why: c.kind, risk: "high", noteworthy: false,
      })),
    });
    let result: Analysis;
    if (!cands.length) result = { ...base, model: "none", costUsd: 0, summary: "Nothing stands out right now.", opportunities: [], skipped: "no candidates" };
    else if (!this.claude) result = mathsOnly("no ANTHROPIC_API_KEY on the server");
    else {
      const prompt = this.prompt(snap, cands);
      const spent = await this.spentToday(now);
      const worst = costUsd(Math.ceil(prompt.length / 2.5), MAX_OUTPUT_TOKENS);
      if (spent.usd + worst > this.settings.dailyBudgetUsd) result = mathsOnly(`daily AI budget reached ($${spent.usd.toFixed(3)} of $${this.settings.dailyBudgetUsd.toFixed(2)} spent today)`);
      else result = await this.askClaude(base, prompt, now).catch((e) => mathsOnly(`AI review failed: ${e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : (e as Error).message}`));
    }
    await this.db.batch([
      this.db.prepare("INSERT OR REPLACE INTO opportunities (house_id, at, model, cost_usd, body) VALUES (?, ?, ?, ?, ?)").bind(houseId, now, result.model, result.costUsd, JSON.stringify(result)),
      this.db.prepare("DELETE FROM opportunities WHERE house_id = ? AND at < ?").bind(houseId, now - KEEP_DAYS * 86400_000),
      this.db.prepare("INSERT INTO gold_runs (house_id, last_analysis) VALUES (?, ?) ON CONFLICT (house_id) DO UPDATE SET last_analysis = excluded.last_analysis").bind(houseId, now),
    ]);
    return result;
  }

  private prompt(snap: HouseSnapshot, cands: Candidate[]): string {
    return [
      `Auction house: ${snap.name} (id ${snap.houseId}), WoW: Forever, prices read ${snap.scannedAt}. All prices in copper (100 copper = 1 silver, 100 silver = 1 gold). The auction house keeps 5% of each sale.`,
      `Player: ${this.settings.player}`,
      "Candidates found by simple rules:",
      "- dip: lowest listing is under 60% of its 7-day average market price (buy and relist).",
      "- spike: market price is over 140% of its 7-day average (sell any you have, or farm or craft it now).",
      "- disenchant: a green item listed for less than its expected enchanting materials, using the Classic 1.12 disenchant table (a baseline, Forever may differ). enchantingSkill is the skill needed.",
      "",
      JSON.stringify(cands),
      "",
      "Pick up to 10 opportunities worth the player's time and rank them, best first. Be sceptical: a dip with few units may be one lucky listing, a spike may be one silly listing with nothing behind it, and very cheap items rarely pay for the time. Use action \"avoid\" for a tempting trap worth warning about. Keep each \"why\" to one or two plain sentences and mention item counts and prices. Write the summary as two or three sentences on what to do first.",
      `Set noteworthy to true only for an opportunity that is clearly worth logging in for right now: solid evidence (several units or samples), low or medium risk and an expected profit of at least ${this.settings.noteworthyCopper} copper. Most runs should have none.`,
    ].join("\n");
  }

  private async askClaude(base: { houseId: number; at: string; candidates: number }, prompt: string, now: number): Promise<Analysis> {
    const res = await this.claude!.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: "You are a careful World of Warcraft auction house trader helping a friend make gold. You only work from the data you are given and never invent prices.",
      messages: [{ role: "user", content: prompt }],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "opportunities"],
            properties: {
              summary: { type: "string" },
              opportunities: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["itemId", "item", "action", "buyAtMostCopper", "sellAtCopper", "expectedProfitCopper", "why", "risk", "noteworthy"],
                  properties: {
                    itemId: { type: "integer" },
                    item: { type: "string" },
                    action: { type: "string", enum: ["buy_and_relist", "buy_to_disenchant", "sell_now", "farm_or_craft", "avoid"] },
                    buyAtMostCopper: { type: "integer" },
                    sellAtCopper: { type: "integer" },
                    expectedProfitCopper: { type: "integer" },
                    why: { type: "string" },
                    risk: { type: "string", enum: ["low", "medium", "high"] },
                    noteworthy: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const u = res.usage;
    const inTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const cost = costUsd(inTokens, u.output_tokens);
    await this.db.prepare("INSERT INTO ai_spend (day, usd, calls) VALUES (?, ?, 1) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1").bind(utcDay(now), cost).run();
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error(`answer stopped early (${res.stop_reason})`);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = JSON.parse(text) as { summary: string; opportunities: Opportunity[] };
    return { ...base, model: MODEL, costUsd: Math.round(cost * 1e5) / 1e5, summary: parsed.summary, opportunities: parsed.opportunities.slice(0, 10).map((o) => ({ ...o, noteworthy: Boolean(o.noteworthy) && o.risk !== "high" && o.action !== "avoid" && o.expectedProfitCopper >= this.settings.noteworthyCopper })) };
  }

  /** Noteworthy finds saved after `since` (ms), newest first, for a check-in that pings the player. */
  async noteworthySince(houseId: number, since: number): Promise<(Opportunity & { foundAt: string })[]> {
    await this.init();
    const { results } = await this.db.prepare("SELECT at, body FROM opportunities WHERE house_id = ? AND at > ? ORDER BY at DESC LIMIT 50").bind(houseId, since).all<{ at: number; body: string }>();
    const seen = new Set<number>();
    const out: (Opportunity & { foundAt: string })[] = [];
    for (const r of results) {
      for (const o of (JSON.parse(r.body) as Analysis).opportunities) {
        if (o.noteworthy && !seen.has(o.itemId)) { seen.add(o.itemId); out.push({ ...o, foundAt: new Date(r.at).toISOString() }); }
      }
    }
    return out;
  }

  /** The newest saved list for a house. */
  async latest(houseId: number): Promise<Analysis | undefined> {
    await this.init();
    const row = await this.db.prepare("SELECT body FROM opportunities WHERE house_id = ? ORDER BY at DESC LIMIT 1").bind(houseId).first<{ body: string }>();
    return row ? (JSON.parse(row.body) as Analysis) : undefined;
  }
}

export function goldSettingsFrom(env: { GOLD_REGION?: string; GOLD_HOUSE_IDS?: string; GOLD_DAILY_BUDGET_USD?: string; GOLD_EVERY_HOURS?: string; GOLD_PLAYER?: string; GOLD_NOTEWORTHY_COPPER?: string }): GoldSettings | undefined {
  const houseIds = (env.GOLD_HOUSE_IDS ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!houseIds.length) return undefined;
  const region = (env.GOLD_REGION || "eu").toLowerCase() as Region;
  const budget = Number(env.GOLD_DAILY_BUDGET_USD ?? 0.2);
  return {
    region,
    houseIds: houseIds.slice(0, 2),
    dailyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? Math.min(budget, 5) : 0.2,
    everyHours: Math.max(1, Number(env.GOLD_EVERY_HOURS || 4)),
    noteworthyCopper: Math.max(0, Number(env.GOLD_NOTEWORTHY_COPPER || 5000)),
    player: env.GOLD_PLAYER || "Horde character with Tailoring and Enchanting, levelling (around level 20).",
  };
}
