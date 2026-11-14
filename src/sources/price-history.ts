import type { KvLike } from "../cache.js";
import type { HouseSnapshot, RawAuction } from "./auctions.js";
import type { D1Like, D1Stmt } from "./gold.js";

/**
 * Price history for the watched auction houses, finer than the gold finder's 4-hourly copy:
 *
 * - Trade goods (cloth, leather, herbs, ore, ...) every time the house is read, about hourly, kept 60 days.
 *   One row per item per UTC day holds that day's hours as JSON ({"13": [lowest, market, units, listings]}),
 *   so an hourly save writes one row per item and the daily clean-up deletes one row per item.
 * - Sales estimated for every item by comparing each read's auctions with the read before: an auction that
 *   vanished while it still had hours left was most likely bought (it could have been cancelled). One row
 *   per house per day holds the day's counts for every item.
 *
 * The maths that turns these into "typical price by hour", "below usual" and "sells N a day" is in the
 * pure functions at the bottom, so tests and the dashboard tool share it.
 */

export const KEEP_DAYS = 60;
/**
 * Reads further apart than this can't tell sold from expired, so they only reset the comparison.
 * An auction counts as bought when it vanishes with LONG (2h+) left, so the gap must stay under 2 hours.
 */
const MAX_GAP_MS = 110 * 60_000;
/** Sales numbers are shown only once this many hours of reads have been compared. */
export const MIN_SALES_HOURS = 12;
const PREV_TTL_S = 6 * 3600;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hourly (house_id INTEGER NOT NULL, item_id INTEGER NOT NULL, day TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (house_id, item_id, day)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS sales (house_id INTEGER NOT NULL, day TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (house_id, day)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS history_runs (house_id INTEGER PRIMARY KEY, last_prune TEXT NOT NULL DEFAULT '')",
];

/** Classic 1.12 trade goods subclasses (item class 7); ForeverDB uses the same numbers. */
export const TRADE_GOODS: Record<number, string> = {
  0: "Trade Goods", 1: "Parts", 2: "Explosives", 3: "Devices", 4: "Jewelcrafting", 5: "Cloth", 6: "Leather",
  7: "Metal & Stone", 8: "Meat", 9: "Herb", 10: "Elemental", 11: "Other", 12: "Enchanting",
};

/** One auction as Blizzard lists it; `id` and `time_left` are what sales tracking needs. */
export type { RawAuction } from "./auctions.js";

/**
 * Per item per day: [units sold, auctions sold, auctions ended near expiry (sold or expired), auctions posted, copper sold].
 * Each day's row also has "_hours": how many hours of reads were compared, so partial days count as partial.
 */
export type SaleRow = [number, number, number, number, number];

export type ItemClass = (id: number) => Promise<{ n: string; c: number; sc: number } | undefined>;

/** A compact copy of one read's auctions: [auction id, item id, quantity, unit price, hours-left code]. */
export type Prev = { at: number; a: [number, number, number, number, number][] };
const TIME_LEFT: Record<string, number> = { SHORT: 0, MEDIUM: 1, LONG: 2, VERY_LONG: 3 };

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export class PriceHistory {
  private ready?: Promise<void>;
  constructor(private db: D1Like, private houseIds: number[], private itemClass?: ItemClass, private kv?: KvLike) {}

  watches(houseId: number) { return this.houseIds.includes(houseId); }
  get watched() { return this.houseIds; }

  private init() {
    this.ready ??= (async () => { for (const sql of SCHEMA) await this.db.prepare(sql).run(); })();
    return this.ready;
  }

  /** Called after each read of a house (about hourly from the cron). Never throws. */
  async record(snap: HouseSnapshot, raw: RawAuction[]): Promise<void> {
    if (!this.watches(snap.houseId)) return;
    try {
      await this.init();
      await this.saveHourly(snap);
      await this.trackSales(snap, raw);
      await this.prune(snap.houseId, Date.parse(snap.scannedAt));
    } catch (e) {
      console.error(`price history ${snap.houseId}:`, e);
    }
  }

  /** Is this item a trade good, and which kind. */
  async tradeGood(id: number): Promise<string | undefined> {
    const info = await this.itemClass?.(id).catch(() => undefined);
    return info && info.c === 7 ? (TRADE_GOODS[info.sc] ?? "Trade Goods") : undefined;
  }

  async saveHourly(snap: HouseSnapshot) {
    await this.init();
    if (!this.itemClass) return;
    const t = Date.parse(snap.scannedAt);
    const day = utcDay(t), hour = String(new Date(t).getUTCHours());
    const entries = Object.entries(snap.items);
    const kinds = await Promise.all(entries.map(([id]) => this.tradeGood(Number(id))));
    const rows: [number, string][] = entries.flatMap(([id, row], i) => (kinds[i] ? [[Number(id), JSON.stringify({ [hour]: row })] as [number, string]] : []));
    // D1 allows 100 bound values per statement: 4 columns, 25 rows each.
    const stmts: D1Stmt[] = [];
    for (let i = 0; i < rows.length; i += 25) {
      const chunk = rows.slice(i, i + 25);
      const sql = `INSERT INTO hourly (house_id, item_id, day, h) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")} ON CONFLICT (house_id, item_id, day) DO UPDATE SET h = json_patch(hourly.h, excluded.h)`;
      stmts.push(this.db.prepare(sql).bind(...chunk.flatMap(([id, h]) => [snap.houseId, id, day, h])));
    }
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
  }

  /** Compares this read's auctions with the last one and adds what sold to today's counts. */
  async trackSales(snap: HouseSnapshot, raw: RawAuction[]) {
    await this.init();
    if (!this.kv) return;
    const t = Date.parse(snap.scannedAt);
    const now: Prev = { at: t, a: [] };
    for (const a of raw) {
      const item = a.item?.id, qty = Math.max(1, a.quantity ?? 1);
      const unit = a.unit_price ?? (a.buyout ? a.buyout / qty : undefined);
      if (!a.id || !item || !unit) continue;
      now.a.push([a.id, item, qty, Math.round(unit), TIME_LEFT[a.time_left ?? ""] ?? -1]);
    }
    if (!now.a.length) return; // this API gives no auction ids: sales can't be tracked
    const key = `ah-prev:${snap.region}:${snap.houseId}`;
    const prev = (await this.kv.get(key, "json").catch(() => null)) as Prev | null;
    await this.kv.put(key, JSON.stringify(now), { expirationTtl: PREV_TTL_S });
    if (!prev || t <= prev.at || t - prev.at > MAX_GAP_MS) return;
    const counts = diffAuctions(prev, now);
    const day = utcDay(t);
    const row = await this.db.prepare("SELECT body FROM sales WHERE house_id = ? AND day = ?").bind(snap.houseId, day).first<{ body: string }>();
    const body = row ? (JSON.parse(row.body) as Record<string, SaleRow | number>) : {};
    body._hours = Math.round(((Number(body._hours) || 0) + (t - prev.at) / 3600_000) * 100) / 100;
    for (const [id, c] of Object.entries(counts)) {
      const b = (body[id] as SaleRow | undefined) ?? [0, 0, 0, 0, 0];
      body[id] = b.map((v, i) => v + c[i]) as SaleRow;
    }
    await this.db.prepare("INSERT INTO sales (house_id, day, body) VALUES (?, ?, ?) ON CONFLICT (house_id, day) DO UPDATE SET body = excluded.body").bind(snap.houseId, day, JSON.stringify(body)).run();
  }

  /** Once a day: drop rows older than KEEP_DAYS. */
  async prune(houseId: number, now: number) {
    const today = utcDay(now);
    const run = await this.db.prepare("SELECT last_prune FROM history_runs WHERE house_id = ?").bind(houseId).first<{ last_prune: string }>();
    if (run?.last_prune === today) return;
    const cutoff = utcDay(now - KEEP_DAYS * 86400_000);
    await this.db.batch([
      this.db.prepare("DELETE FROM hourly WHERE house_id = ? AND day < ?").bind(houseId, cutoff),
      this.db.prepare("DELETE FROM sales WHERE house_id = ? AND day < ?").bind(houseId, cutoff),
      this.db.prepare("INSERT INTO history_runs (house_id, last_prune) VALUES (?, ?) ON CONFLICT (house_id) DO UPDATE SET last_prune = excluded.last_prune").bind(houseId, today),
    ]);
  }

  /** Every saved hour of one item, oldest first. */
  async points(houseId: number, itemId: number, days: number, now = Date.now()): Promise<Point[]> {
    await this.init();
    const { results } = await this.db.prepare("SELECT day, h FROM hourly WHERE house_id = ? AND item_id = ? AND day >= ? ORDER BY day").bind(houseId, itemId, utcDay(now - days * 86400_000)).all<{ day: string; h: string }>();
    return results.flatMap((r) => toPoints(r.day, r.h)).sort((a, b) => a.at - b.at);
  }

  /** Every tracked trade good's saved hours, grouped by item. */
  async allPoints(houseId: number, days: number, now = Date.now()): Promise<Map<number, Point[]>> {
    await this.init();
    const { results } = await this.db.prepare("SELECT item_id, day, h FROM hourly WHERE house_id = ? AND day >= ?").bind(houseId, utcDay(now - days * 86400_000)).all<{ item_id: number; day: string; h: string }>();
    const out = new Map<number, Point[]>();
    for (const r of results) {
      let arr = out.get(r.item_id);
      if (!arr) out.set(r.item_id, (arr = []));
      arr.push(...toPoints(r.day, r.h));
    }
    for (const arr of out.values()) arr.sort((a, b) => a.at - b.at);
    return out;
  }

  /**
   * Sales counts per item over the last `days` days (today included), only the items asked for or all.
   * `days` in the answer is the hours of reads actually compared, divided by 24.
   */
  async sales(houseId: number, days: number, itemIds?: number[], now = Date.now()): Promise<{ days: number; byItem: Map<number, SaleRow> }> {
    await this.init();
    const since = utcDay(now - (days - 1) * 86400_000);
    const byItem = new Map<number, SaleRow>();
    let hours = 0;
    if (itemIds && !itemIds.length) return { days: 0, byItem };
    if (itemIds && itemIds.length <= 50) {
      const keys = itemIds.map((id) => `'$."${id}"'`);
      const { results } = await this.db.prepare(`SELECT json_extract(body, '$._hours') AS hours, ${keys.map((k, i) => `json_extract(body, ${k}) AS i${i}`).join(", ")} FROM sales WHERE house_id = ? AND day >= ?`).bind(houseId, since).all<Record<string, string | number | null>>();
      for (const r of results) {
        hours += Number(r.hours) || 0;
        itemIds.forEach((id, i) => { const v = r[`i${i}`]; if (typeof v === "string") add(byItem, id, JSON.parse(v) as SaleRow); });
      }
    } else {
      const { results } = await this.db.prepare("SELECT body FROM sales WHERE house_id = ? AND day >= ?").bind(houseId, since).all<{ body: string }>();
      for (const r of results) {
        for (const [id, v] of Object.entries(JSON.parse(r.body) as Record<string, SaleRow | number>)) {
          if (id === "_hours") hours += Number(v) || 0;
          else if (!itemIds || itemIds.includes(Number(id))) add(byItem, Number(id), v as SaleRow);
        }
      }
    }
    return { days: Math.round((hours / 24) * 100) / 100, byItem };
  }

  /** First and last saved day, and how many days have sales counts. */
  async coverage(houseId: number): Promise<{ firstDay?: string; lastDay?: string; items: number; salesDays: number }> {
    await this.init();
    const h = await this.db.prepare("SELECT MIN(day) AS first, MAX(day) AS last, COUNT(DISTINCT item_id) AS items FROM hourly WHERE house_id = ?").bind(houseId).first<{ first: string | null; last: string | null; items: number }>();
    const s = await this.db.prepare("SELECT COUNT(*) AS n FROM sales WHERE house_id = ?").bind(houseId).first<{ n: number }>();
    return { firstDay: h?.first ?? undefined, lastDay: h?.last ?? undefined, items: h?.items ?? 0, salesDays: s?.n ?? 0 };
  }
}

function add(m: Map<number, SaleRow>, id: number, v: SaleRow) {
  const b = m.get(id) ?? [0, 0, 0, 0, 0];
  m.set(id, b.map((x, i) => x + (v[i] ?? 0)) as SaleRow);
}

// ───────────────────────── Pure maths ─────────────────────────

export interface Point { at: number; lowest: number; market: number; units: number; listings: number }

export function toPoints(day: string, h: string): Point[] {
  const base = Date.parse(`${day}T00:00:00Z`);
  return Object.entries(JSON.parse(h) as Record<string, number[]>).map(([hour, [lowest, market, units, listings]]) => ({ at: base + Number(hour) * 3600_000, lowest, market, units, listings }));
}

/**
 * What vanished between two reads. Gone with 2+ hours left (LONG / VERY_LONG) = bought (or cancelled);
 * gone with under 2 hours left = ended near expiry, sold or not. New ids = posted.
 */
export function diffAuctions(prev: Prev, now: Prev): Record<string, SaleRow> {
  const still = new Map(now.a.map((a) => [a[0], a[2]]));
  const before = new Set(prev.a.map((a) => a[0]));
  const out: Record<string, SaleRow> = {};
  const row = (item: number) => (out[item] ??= [0, 0, 0, 0, 0]);
  for (const [id, item, qty, unit, left] of prev.a) {
    const qtyNow = still.get(id);
    if (qtyNow !== undefined) {
      // A stack that got smaller was partly bought.
      if (qtyNow < qty) { const r = row(item); r[0] += qty - qtyNow; r[4] += (qty - qtyNow) * unit; }
      continue;
    }
    const r = row(item);
    if (left >= 2) { r[0] += qty; r[1] += 1; r[4] += qty * unit; } else r[2] += 1;
  }
  for (const [id, item] of now.a) if (!before.has(id)) row(item)[3] += 1;
  return out;
}

export const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface Profile {
  /** Median market price over every saved hour. */
  typical?: number;
  /** Median market price at each UTC hour that has data. */
  byHourUtc: { hour: number; market: number; samples: number }[];
  /** Median market price on each UTC weekday that has data (0 = Monday). */
  byWeekdayUtc: { weekday: number; day: string; market: number; samples: number }[];
  cheapestHourUtc?: number; dearestHourUtc?: number;
  /** How much dearer the dearest hour is than the cheapest, in percent. */
  swingPct?: number;
  samples: number; days: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Typical price by hour of day and by weekday. A slot needs at least 2 samples to count. */
export function profile(points: Point[]): Profile {
  const byHour = new Map<number, number[]>(), byDay = new Map<number, number[]>();
  for (const p of points) {
    const d = new Date(p.at);
    (byHour.get(d.getUTCHours()) ?? byHour.set(d.getUTCHours(), []).get(d.getUTCHours())!).push(p.market);
    const wd = (d.getUTCDay() + 6) % 7;
    (byDay.get(wd) ?? byDay.set(wd, []).get(wd)!).push(p.market);
  }
  const byHourUtc = [...byHour].filter(([, v]) => v.length >= 2).map(([hour, v]) => ({ hour, market: Math.round(median(v)!), samples: v.length })).sort((a, b) => a.hour - b.hour);
  const byWeekdayUtc = [...byDay].map(([weekday, v]) => ({ weekday, day: WEEKDAYS[weekday], market: Math.round(median(v)!), samples: v.length })).sort((a, b) => a.weekday - b.weekday);
  const lo = byHourUtc.reduce<typeof byHourUtc[number] | undefined>((m, x) => (!m || x.market < m.market ? x : m), undefined);
  const hi = byHourUtc.reduce<typeof byHourUtc[number] | undefined>((m, x) => (!m || x.market > m.market ? x : m), undefined);
  const days = new Set(points.map((p) => Math.floor(p.at / 86400_000))).size;
  return {
    typical: points.length ? Math.round(median(points.map((p) => p.market))!) : undefined,
    byHourUtc, byWeekdayUtc,
    cheapestHourUtc: byHourUtc.length > 1 ? lo?.hour : undefined, dearestHourUtc: byHourUtc.length > 1 ? hi?.hour : undefined,
    swingPct: byHourUtc.length > 1 && lo && hi && lo.market > 0 ? Math.round((hi.market / lo.market - 1) * 100) : undefined,
    samples: points.length, days,
  };
}

/** The lowest listing now against the median market price of the last 7 days, in percent (70 = 30% under). */
export function belowUsual(points: Point[], lowestNow: number, now: number): { usual?: number; pctOfUsual?: number } {
  const usual = median(points.filter((p) => p.at >= now - 7 * 86400_000).map((p) => p.market));
  return usual ? { usual: Math.round(usual), pctOfUsual: Math.round((lowestNow / usual) * 100) } : {};
}

export interface SellThrough {
  /** Days with sales counts behind these numbers. */
  days: number;
  soldUnitsPerDay?: number;
  soldAuctionsPerDay?: number;
  postedAuctionsPerDay?: number;
  /** Share of ended auctions that were bought: sold / (sold + ended near expiry). */
  sellRatePct?: number;
  /** Average price paid per unit, from the auctions that sold. */
  avgSoldPrice?: number;
}

export function sellThrough(row: SaleRow | undefined, days: number): SellThrough {
  if (!days) return { days: 0 };
  const [units, sold, ended, posted, value] = row ?? [0, 0, 0, 0, 0];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    days,
    soldUnitsPerDay: r1(units / days), soldAuctionsPerDay: r1(sold / days), postedAuctionsPerDay: r1(posted / days),
    sellRatePct: sold + ended ? Math.round((sold / (sold + ended)) * 100) : undefined,
    avgSoldPrice: units ? Math.round(value / units) : undefined,
  };
}
