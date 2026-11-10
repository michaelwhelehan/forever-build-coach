import { describe, it, expect } from "vitest";
import { AuctionPrices, groupHouses, summarise, factionOf } from "../src/sources/auctions.js";
import type { Blizzard } from "../src/sources/blizzard.js";
import type { KvLike } from "../src/cache.js";

class MemoryKv implements KvLike {
  data = new Map<string, string>();
  async get(key: string) { const v = this.data.get(key); return v === undefined ? null : JSON.parse(v); }
  async put(key: string, value: string) { this.data.set(key, value); }
}

const INDEX = { auctions: [110, 111, 112, 113, 114, 115].map((id) => ({ id, name: ["Alliance Auction House", "Horde Auction House", "Blackwater Auction House"][(id - 110) % 3], key: {} })) };

function fakeBlizzard(calls: string[]): Blizzard {
  return {
    enabled: true,
    async raw(_region: string, path: string) {
      calls.push(path);
      if (path.endsWith("/auctions/")) return INDEX;
      if (path.endsWith("/commodities")) return { auctions: [{ item: { id: 2589 }, quantity: 20, unit_price: 19 }, { item: { id: 2589 }, quantity: 100, unit_price: 25 }] };
      const id = Number(path.split("/").pop());
      return { id, name: "Horde Auction House", auctions: [{ item: { id: 4307 }, buyout: 5000, quantity: 1 }, { item: { id: 4307 }, bid: 100, quantity: 1 }] };
    },
  } as unknown as Blizzard;
}

describe("auction summaries", () => {
  it("prices by unit, skips bid-only listings and averages the cheapest 15% of units", () => {
    const { items, listings } = summarise([
      { item: { id: 1 }, buyout: 1000, quantity: 10 }, // 100 each
      { item: { id: 1 }, unit_price: 200, quantity: 90 },
      { item: { id: 1 } }, // bid only
      { item: { id: 2 }, buyout: 999999, quantity: 1 },
    ]);
    expect(listings).toBe(3);
    // 15% of 100 units = 15: 10 at 100 + 5 at 200 -> 133
    expect(items["1"]).toEqual([100, 133, 100, 2]);
    expect(items["2"]).toEqual([999999, 999999, 1, 1]);
  });

  it("groups houses in threes by id and reads the faction from the name", () => {
    const g = groupHouses(INDEX.auctions);
    expect(g.map((h) => h.group)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(g[1]).toMatchObject({ id: 111, faction: "horde" });
    expect(factionOf("Blackwater Auction House")).toBe("neutral");
  });
});

describe("AuctionPrices", () => {
  it("downloads a house once, adds its commodities and serves the stored copy after", async () => {
    const calls: string[] = [];
    const kv = new MemoryKv();
    const ah = new AuctionPrices(fakeBlizzard(calls), kv);
    const snap = await ah.snapshot("eu", 111);
    expect(snap.items["4307"]).toEqual([5000, 5000, 1, 1]);
    expect(snap.items["2589"][0]).toBe(19);
    await ah.snapshot("eu", 111);
    expect(calls.filter((c) => c.endsWith("/111")).length).toBe(1);
    // A fresh instance (another Worker) reads it from KV instead of Blizzard.
    const other = new AuctionPrices(fakeBlizzard(calls), kv);
    await other.snapshot("eu", 111);
    expect(calls.filter((c) => c.endsWith("/111")).length).toBe(1);
  });

  it("cron refreshes only the stalest houses, a few per run", async () => {
    const calls: string[] = [];
    const ah = new AuctionPrices(fakeBlizzard(calls), new MemoryKv());
    expect(await ah.refreshStalest("eu", 4)).toEqual([110, 111, 112, 113]);
    expect(await ah.refreshStalest("eu", 4)).toEqual([114, 115]);
    expect(await ah.refreshStalest("eu", 4)).toEqual([]);
  });
});
