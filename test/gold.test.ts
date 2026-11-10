import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { GoldFinder, disenchantValue, costUsd, goldSettingsFrom, type D1Like, type D1Stmt, type ClaudeLike, type GoldSettings } from "../src/sources/gold.js";
import type { AuctionPrices, HouseSnapshot } from "../src/sources/auctions.js";

/** Just enough of D1 on top of Node's SQLite. */
function fakeD1(): D1Like & { sql: DatabaseSync } {
  const sql = new DatabaseSync(":memory:");
  const stmt = (q: string, args: unknown[] = []): D1Stmt => ({
    bind: (...v: unknown[]) => stmt(q, v),
    run: async () => sql.prepare(q).run(...(args as never[])),
    all: async <T>() => ({ results: sql.prepare(q).all(...(args as never[])) as T[] }),
    first: async <T>() => (sql.prepare(q).get(...(args as never[])) as T | undefined) ?? null,
  });
  return { sql, prepare: (q) => stmt(q), batch: async (s) => { for (const x of s) await x.run(); return []; } };
}

const HOUR = 3600_000;
const T0 = Date.parse("2026-11-10T00:00:00Z");
const snap = (at: number, items: HouseSnapshot["items"]): HouseSnapshot => ({ region: "eu", houseId: 113, name: "Horde Auction House", scannedAt: new Date(at).toISOString(), listings: 1, items });
const settings: GoldSettings = { region: "eu", houseIds: [113], dailyBudgetUsd: 0.2, everyHours: 4, player: "test", noteworthyCopper: 5000 };

const ITEMS: Record<number, { n: string; q: number; il: number; c: number }> = {
  4306: { n: "Silk Cloth", q: 1, il: 23, c: 7 },
  2589: { n: "Linen Cloth", q: 1, il: 5, c: 7 },
  9999: { n: "Green Boots", q: 2, il: 18, c: 4 },
};
const info = async (id: number) => ITEMS[id];
// Enchanting mats for item level 16-20 greens.
const MATS: HouseSnapshot["items"] = { 10940: [100, 100, 50, 5], 10939: [1000, 1000, 10, 2], 10978: [300, 300, 10, 2] };

function fakeClaude(calls: Anthropic.MessageCreateParamsNonStreaming[]): ClaudeLike {
  return {
    messages: {
      async create(params) {
        calls.push(params);
        const body = { summary: "Buy the silk.", opportunities: [
          { itemId: 4306, item: "Silk Cloth", action: "buy_and_relist", buyAtMostCopper: 100, sellAtCopper: 200, expectedProfitCopper: 9000, why: "Cheap.", risk: "low", noteworthy: true },
          { itemId: 9999, item: "Green Boots", action: "buy_to_disenchant", buyAtMostCopper: 50, sellAtCopper: 700, expectedProfitCopper: 600, why: "Mats.", risk: "medium", noteworthy: true },
        ] };
        return { content: [{ type: "text", text: JSON.stringify(body) }], stop_reason: "end_turn", usage: { input_tokens: 4000, output_tokens: 1000 } } as unknown as Anthropic.Message;
      },
    },
  };
}

async function seeded(claude?: ClaudeLike, s = settings) {
  const db = fakeD1();
  const g = new GoldFinder(db, s, claude, info);
  // Three earlier scans with silk at 2s, then a dip to 1s.
  for (const h of [0, 4, 8]) await g.saveHistory(113, snap(T0 + h * HOUR, { 4306: [200, 200, 40, 10], 2589: [20, 20, 400, 30], ...MATS }), T0 + h * HOUR);
  const now = snap(T0 + 12 * HOUR, { 4306: [100, 180, 40, 10], 2589: [19, 20, 400, 30], 9999: [50, 50, 1, 1], ...MATS });
  return { db, g, now };
}

describe("gold finder maths", () => {
  it("values a green by the Classic disenchant table at today's prices", () => {
    // 0.75 x 2.5 x 100 + 0.2 x 1.5 x 1000 + 0.05 x 1 x 300 = 187.5 + 300 + 15
    expect(disenchantValue(18, MATS)).toEqual({ value: 503, skill: 1 });
    expect(disenchantValue(18, { 10940: [100, 100, 1, 1] })).toBeUndefined();
    expect(costUsd(1_000_000, 1_000_000)).toBeCloseTo(0.6);
  });

  it("finds dips against the 7-day average and greens worth disenchanting", async () => {
    const { g, now } = await seeded();
    const c = await g.candidates(113, now, T0 + 12 * HOUR);
    expect(c.map((x) => [x.itemId, x.kind])).toEqual([[9999, "disenchant"], [4306, "dip"]]);
    expect(c.find((x) => x.itemId === 4306)).toMatchObject({ name: "Silk Cloth", avg7d: 200, roughProfit: 90 });
  });

  it("reads settings from the environment and stays off without house ids", () => {
    expect(goldSettingsFrom({})).toBeUndefined();
    expect(goldSettingsFrom({ GOLD_HOUSE_IDS: "113, 114, 115", GOLD_DAILY_BUDGET_USD: "999" })).toMatchObject({ houseIds: [113, 114], dailyBudgetUsd: 5, everyHours: 4 });
  });
});

describe("gold finder with Claude", () => {
  it("asks Haiku once, records the spend and keeps the list", async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const { g, now } = await seeded(fakeClaude(calls));
    const a = await g.analyse(113, now, T0 + 12 * HOUR);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("claude-haiku-5-5");
    expect(calls[0].output_config?.format?.type).toBe("json_schema");
    expect(a.costUsd).toBeCloseTo(costUsd(4000, 1000));
    expect(await g.spentToday(T0 + 12 * HOUR)).toMatchObject({ calls: 1 });
    expect((await g.latest(113))?.summary).toBe("Buy the silk.");
    // Only the find over the 50s line stays noteworthy.
    expect(a.opportunities.map((o) => o.noteworthy)).toEqual([true, false]);
    expect((await g.noteworthySince(113, T0)).map((o) => o.itemId)).toEqual([4306]);
    expect(await g.noteworthySince(113, T0 + 13 * HOUR)).toEqual([]);
  });

  it("skips the AI once the daily budget is spent and falls back to the maths list", async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const { db, g, now } = await seeded(fakeClaude(calls), { ...settings, dailyBudgetUsd: 0.01 });
    db.sql.prepare("INSERT INTO ai_spend (day, usd, calls) VALUES ('2026-11-10', 0.0095, 3)").run();
    const a = await g.analyse(113, now, T0 + 12 * HOUR);
    expect(calls).toHaveLength(0);
    expect(a.skipped).toMatch(/budget/);
    expect(a.opportunities[0]).toMatchObject({ itemId: 9999, action: "buy_to_disenchant", noteworthy: false });
  });

  it("cron saves and reviews a house only every few hours", async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const { g, now } = await seeded(fakeClaude(calls));
    const ah = { snapshot: async () => now } as unknown as AuctionPrices;
    expect(await g.maybeRun(ah, T0 + 12 * HOUR)).toHaveLength(1);
    expect(await g.maybeRun(ah, T0 + 13 * HOUR)).toHaveLength(0);
    expect(await g.maybeRun(ah, T0 + 16 * HOUR)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
