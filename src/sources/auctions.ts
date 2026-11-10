import type { KvLike } from "../cache.js";
import type { Blizzard, Region } from "./blizzard.js";

/**
 * WoW: Forever auction house prices from Blizzard's Game Data API.
 *
 * Forever has no realms. Blizzard lists the houses under a ruleset (any ruleset id returns the same
 * list), in groups of three: Alliance, Horde and Blackwater (neutral). Each house dump can be ~9 MB,
 * so the Worker boils it down to one price row per item and keeps that in KV.
 * Endpoints mapped by players, not documented by Blizzard yet:
 * https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334
 */

export type Faction = "alliance" | "horde" | "neutral";

export interface HouseInfo { id: number; name: string; faction?: Faction; group: number }

/** Per item: [lowest unit price, market price, units listed, listings] in copper. */
export type PriceRow = [number, number, number, number];

export interface HouseSnapshot {
  region: Region;
  houseId: number;
  name: string;
  scannedAt: string;
  listings: number;
  items: Record<string, PriceRow>;
}

/** Any ruleset id works for listing houses (Normal). */
const LIST_RULESET = 2;
/** A snapshot older than this is refreshed when someone asks for it. */
export const STALE_MS = 75 * 60_000;
const KV_TTL_S = 6 * 3600;

export function factionOf(name: string): Faction | undefined {
  const n = name.toLowerCase();
  if (n.includes("alliance")) return "alliance";
  if (n.includes("horde")) return "horde";
  if (n.includes("blackwater") || n.includes("neutral")) return "neutral";
  return undefined;
}

/**
 * Which ruleset each group of houses serves isn't in the API. Fill this in once it's known
 * (group number, counted from 1 by house id). Until then tools show every group.
 */
export const GROUP_RULESETS: Partial<Record<Region, Record<number, string>>> = {};

export function groupHouses(list: { id: number; name: string }[]): HouseInfo[] {
  const sorted = [...list].sort((a, b) => a.id - b.id);
  return sorted.map((h, i) => ({ id: h.id, name: h.name, faction: factionOf(h.name), group: Math.floor(i / 3) + 1 }));
}

type RawAuction = { item?: { id?: number }; buyout?: number; unit_price?: number; quantity?: number };

/**
 * Boils a house's auctions and commodities down to one row per item.
 * Market price = quantity-weighted average of the cheapest 15% of units (at least the cheapest one),
 * which ignores silly high listings the way TSM's and Forever Mastery's market values do.
 */
export function summarise(auctions: RawAuction[]): { items: Record<string, PriceRow>; listings: number } {
  const byItem = new Map<number, [number, number][]>();
  let listings = 0;
  for (const a of auctions) {
    const id = a.item?.id;
    const qty = Math.max(1, a.quantity ?? 1);
    const unit = a.unit_price ?? (a.buyout ? a.buyout / qty : undefined);
    if (!id || !unit || unit <= 0) continue; // bid-only
    listings++;
    let arr = byItem.get(id);
    if (!arr) byItem.set(id, (arr = []));
    arr.push([unit, qty]);
  }
  const items: Record<string, PriceRow> = {};
  for (const [id, arr] of byItem) {
    arr.sort((x, y) => x[0] - y[0]);
    const units = arr.reduce((s, [, q]) => s + q, 0);
    const want = Math.max(1, Math.ceil(units * 0.15));
    let took = 0, sum = 0;
    for (const [u, q] of arr) {
      const n = Math.min(q, want - took);
      sum += u * n; took += n;
      if (took >= want) break;
    }
    items[id] = [Math.round(arr[0][0]), Math.round(sum / took), units, arr.length];
  }
  return { items, listings };
}

export class AuctionPrices {
  private mem = new Map<string, HouseSnapshot>();
  private houseList = new Map<Region, { at: number; houses: HouseInfo[] }>();
  constructor(private blizzard: Blizzard, private kv?: KvLike) {}

  get enabled() { return this.blizzard.enabled; }

  async houses(region: Region): Promise<HouseInfo[]> {
    const hit = this.houseList.get(region);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.houses;
    const kvKey = `ah:${region}:houses`;
    const shared = (await this.kv?.get(kvKey, "json").catch(() => null)) as { at: number; houses: HouseInfo[] } | null;
    if (shared && Date.now() - shared.at < 6 * 3600_000) { this.houseList.set(region, shared); return shared.houses; }
    const idx = await this.blizzard.raw(region, `/data/wow/ruleset/${LIST_RULESET}/auctions/`, "dynamic");
    const list = ((idx.auctions ?? []) as { id: number; name: string }[]).map((h) => ({ id: h.id, name: h.name }));
    const entry = { at: Date.now(), houses: groupHouses(list) };
    this.houseList.set(region, entry);
    await this.kv?.put(kvKey, JSON.stringify(entry), { expirationTtl: KV_TTL_S }).catch(() => undefined);
    return entry.houses;
  }

  /** Downloads one house and stores its summary. */
  async refresh(region: Region, houseId: number): Promise<HouseSnapshot> {
    const base = `/data/wow/ruleset/${LIST_RULESET}/auctions/${houseId}`;
    const house = await this.blizzard.raw(region, base, "dynamic");
    let all = (house.auctions ?? []) as RawAuction[];
    const embedded = house.commodities;
    if (Array.isArray(embedded)) all = all.concat(embedded as RawAuction[]);
    else {
      // Commodities may sit behind their own link instead of inside the house.
      const c = await this.blizzard.raw(region, `${base}/commodities`, "dynamic").catch(() => undefined);
      if (c && Array.isArray(c.auctions)) all = all.concat(c.auctions as RawAuction[]);
    }
    const { items, listings } = summarise(all);
    const snap: HouseSnapshot = { region, houseId, name: String(house.name ?? `House ${houseId}`), scannedAt: new Date().toISOString(), listings, items };
    this.mem.set(`${region}:${houseId}`, snap);
    await this.kv?.put(`ah:${region}:${houseId}`, JSON.stringify(snap), { expirationTtl: KV_TTL_S }).catch(() => undefined);
    return snap;
  }

  /** The stored summary, refreshed first when it's missing or over an hour old. */
  async snapshot(region: Region, houseId: number): Promise<HouseSnapshot> {
    const key = `${region}:${houseId}`;
    let snap = this.mem.get(key);
    if (!snap) snap = ((await this.kv?.get(`ah:${key}`, "json").catch(() => null)) as HouseSnapshot | null) ?? undefined;
    if (snap && Date.now() - Date.parse(snap.scannedAt) < STALE_MS) { this.mem.set(key, snap); return snap; }
    try { return await this.refresh(region, houseId); } catch (e) { if (snap) return snap; throw e; }
  }

  /** Age of each stored snapshot, without downloading anything. */
  async storedAt(region: Region, houseId: number): Promise<string | undefined> {
    const mem = this.mem.get(`${region}:${houseId}`);
    if (mem) return mem.scannedAt;
    const snap = (await this.kv?.get(`ah:${region}:${houseId}`, "json").catch(() => null)) as HouseSnapshot | null;
    return snap?.scannedAt;
  }

  /** Cron: refresh the houses whose data is oldest, a few per run to keep each run small. */
  async refreshStalest(region: Region, count: number): Promise<number[]> {
    const houses = await this.houses(region);
    const ages = await Promise.all(houses.map(async (h) => ({ id: h.id, at: Date.parse((await this.storedAt(region, h.id)) ?? "1970-01-01") })));
    const due = ages.filter((a) => Date.now() - a.at > 50 * 60_000).sort((a, b) => a.at - b.at).slice(0, count);
    const done: number[] = [];
    for (const d of due) {
      try { await this.refresh(region, d.id); done.push(d.id); } catch (e) { console.error(`auction refresh ${region} ${d.id} failed:`, e); }
    }
    return done;
  }
}
