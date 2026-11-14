import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PriceHistory, diffAuctions, profile, belowUsual, sellThrough, type Point } from "../src/sources/price-history.js";
import { GoldFinder, type D1Like, type D1Stmt, type GoldSettings } from "../src/sources/gold.js";
import type { HouseSnapshot, RawAuction } from "../src/sources/auctions.js";
import type { KvLike } from "../src/cache.js";

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
function fakeKv(): KvLike {
  const m = new Map<string, string>();
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k, v) => { m.set(k, v); } };
}

const HOUR = 3600_000;
const T0 = Date.parse("2026-11-10T00:00:00Z"); // a Tuesday
const CLASS: Record<number, { n: string; c: number; sc: number }> = {
  2447: { n: "Peacebloom", c: 7, sc: 9 },
  2589: { n: "Linen Cloth", c: 7, sc: 5 },
  833: { n: "Lifestone", c: 4, sc: 0 },
};
const itemClass = async (id: number) => CLASS[id];
const snap = (at: number, items: HouseSnapshot["items"], houseId = 114): HouseSnapshot => ({ region: "eu", houseId, name: "Horde", scannedAt: new Date(at).toISOString(), listings: 1, items });
const auction = (id: number, item: number, quantity: number, unit: number, time_left = "VERY_LONG"): RawAuction => ({ id, item: { id: item }, quantity, unit_price: unit, time_left });

describe("hourly trade goods prices", () => {
  it("saves only trade goods, one row per item per day with every hour in it", async () => {
    const db = fakeD1();
    const h = new PriceHistory(db, [114], itemClass);
    await h.record(snap(T0 + 13 * HOUR, { 2447: [20, 22, 500, 10], 2589: [10, 11, 900, 20], 833: [15000, 16000, 3, 3] }), []);
    await h.record(snap(T0 + 14 * HOUR, { 2447: [30, 33, 400, 9] }), []);
    await h.record(snap(T0 + 14 * HOUR, { 2447: [30, 33, 400, 9] }, 999), []); // not watched
    const rows = db.sql.prepare("SELECT item_id, day FROM hourly ORDER BY item_id").all();
    expect(rows).toEqual([{ item_id: 2447, day: "2026-11-10" }, { item_id: 2589, day: "2026-11-10" }]);
    const pts = await h.points(114, 2447, 7, T0 + 15 * HOUR);
    expect(pts.map((p) => [new Date(p.at).getUTCHours(), p.market])).toEqual([[13, 22], [14, 33]]);
    expect(await h.tradeGood(2447)).toBe("Herb");
    expect((await h.allPoints(114, 7, T0 + 15 * HOUR)).get(2589)).toHaveLength(1);
  });

  it("drops rows older than 60 days once a day", async () => {
    const db = fakeD1();
    const h = new PriceHistory(db, [114], itemClass);
    await h.record(snap(T0, { 2447: [20, 22, 500, 10] }), []);
    await h.record(snap(T0 + 61 * 24 * HOUR, { 2447: [20, 22, 500, 10] }), []);
    expect(db.sql.prepare("SELECT day FROM hourly").all()).toEqual([{ day: "2027-01-10" }]);
  });
});

describe("sales from vanished auctions", () => {
  it("counts auctions gone with hours left as sold, near-expiry ones as ended, new ones as posted", () => {
    const prev = { at: 0, a: [[1, 2447, 20, 25, 3], [2, 2447, 10, 30, 2], [3, 2447, 5, 40, 0], [4, 833, 1, 15000, 3]] as [number, number, number, number, number][] };
    const now = { at: HOUR, a: [[4, 833, 1, 15000, 3], [5, 2447, 20, 24, 3]] as [number, number, number, number, number][] };
    expect(diffAuctions(prev, now)).toEqual({ 2447: [30, 2, 1, 1, 20 * 25 + 10 * 30] });
  });

  it("adds each read's sales to the day and reports them per day", async () => {
    const db = fakeD1();
    const h = new PriceHistory(db, [114], itemClass, fakeKv());
    const s = snap(T0 + 10 * HOUR, {});
    await h.record(s, [auction(1, 833, 1, 15000), auction(2, 833, 1, 16000), auction(3, 2447, 20, 25, "SHORT")]);
    await h.record(snap(T0 + 11 * HOUR, {}), [auction(2, 833, 1, 16000), auction(4, 833, 1, 17000)]);
    await h.record(snap(T0 + 12 * HOUR, {}), [auction(4, 833, 1, 17000)]);
    const { days, byItem } = await h.sales(114, 7, [833, 2447], T0 + 12 * HOUR);
    expect(days).toBe(1);
    expect(byItem.get(833)).toEqual([2, 2, 0, 1, 31000]);
    expect(byItem.get(2447)).toEqual([0, 0, 1, 0, 0]);
    expect(sellThrough(byItem.get(833), days)).toMatchObject({ soldUnitsPerDay: 2, sellRatePct: 100, avgSoldPrice: 15500 });
    expect(sellThrough(byItem.get(2447), days)).toMatchObject({ soldUnitsPerDay: 0, sellRatePct: 0 });
    expect((await h.sales(114, 7, undefined, T0 + 12 * HOUR)).byItem.size).toBe(2);
  });

  it("doesn't guess across a long gap between reads", async () => {
    const db = fakeD1();
    const h = new PriceHistory(db, [114], itemClass, fakeKv());
    await h.record(snap(T0, {}), [auction(1, 833, 1, 15000)]);
    await h.record(snap(T0 + 5 * HOUR, {}), [auction(2, 833, 1, 15000)]);
    expect((await h.sales(114, 7, [833], T0 + 5 * HOUR)).days).toBe(0);
  });
});

describe("price profile maths", () => {
  const pts: Point[] = [];
  // Three days: cheap at 02:00 (20c), dear at 18:00 (40c), 30c otherwise.
  for (let d = 0; d < 3; d++) for (const hr of [2, 10, 18]) pts.push({ at: T0 + d * 24 * HOUR + hr * HOUR, lowest: 0, market: hr === 2 ? 20 : hr === 18 ? 40 : 30, units: 100, listings: 5 });

  it("finds the cheapest and dearest hour and the swing", () => {
    const p = profile(pts);
    expect(p).toMatchObject({ typical: 30, cheapestHourUtc: 2, dearestHourUtc: 18, swingPct: 100, samples: 9, days: 3 });
    expect(p.byWeekdayUtc.map((d) => d.day)).toEqual(["Tue", "Wed", "Thu"]);
  });

  it("compares the lowest listing now with the 7-day median", () => {
    expect(belowUsual(pts, 15, T0 + 3 * 24 * HOUR)).toEqual({ usual: 30, pctOfUsual: 50 });
    expect(belowUsual([], 15, T0)).toEqual({});
  });
});

describe("gold finder with price history", () => {
  const settings: GoldSettings = { region: "eu", houseIds: [114], dailyBudgetUsd: 0.2, everyHours: 4, player: "test", noteworthyCopper: 5000 };

  it("measures dips against the median, so one silly listing doesn't make a dip, and adds sales", async () => {
    const db = fakeD1();
    const h = new PriceHistory(db, [114], itemClass, fakeKv());
    const g = new GoldFinder(db, settings, undefined, undefined, h);
    // Lifestone usually 10g; one scan had a silly 100g listing as its market price, dragging the average to 32.5g.
    for (const [i, m] of [100000, 10000, 10000, 10000].entries()) await g.saveHistory(114, snap(T0 + i * 4 * HOUR, { 833: [m, m, 3, 3] }), T0 + i * 4 * HOUR);
    await h.record(snap(T0 + 14 * HOUR, {}), [auction(1, 833, 1, 10000), auction(2, 833, 1, 10500)]);
    await h.record(snap(T0 + 15 * HOUR, {}), [auction(2, 833, 1, 10500)]);
    // 8g is under 60% of the 32.5g average, but only 80% of the 10g median: not a dip.
    expect(await g.candidates(114, snap(T0 + 16 * HOUR, { 833: [8000, 9000, 3, 3] }), T0 + 16 * HOUR)).toEqual([]);
    const c = await g.candidates(114, snap(T0 + 16 * HOUR, { 833: [4000, 9000, 3, 3] }), T0 + 16 * HOUR);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "dip", median7d: 10000, avg7d: 32500, roughProfit: 5500, sales: { days: 1, soldUnitsPerDay: 1, sellRatePct: 100, avgSoldPrice: 10000 } });
  });
});
