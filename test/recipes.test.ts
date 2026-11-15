import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BUILT_IN, RecipeBook, reagentCost, profitRow, VENDOR, type Recipe } from "../src/sources/recipes.js";
import { PriceHistory, historyKind, matchesCategory } from "../src/sources/price-history.js";
import { createServer, type Deps } from "../src/server.js";
import type { D1Like, D1Stmt } from "../src/sources/gold.js";
import type { HouseSnapshot } from "../src/sources/auctions.js";

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

const book = new Map(BUILT_IN.map((r) => [r.itemId, r] as [number, Recipe]));

describe("recipe maths", () => {
  it("built-in recipes have unique outputs and only positive quantities", () => {
    expect(new Set(BUILT_IN.map((r) => r.itemId)).size).toBe(BUILT_IN.length);
    for (const r of BUILT_IN) for (const g of r.reagents) expect(g.qty).toBeGreaterThan(0);
  });

  it("prices vendor vials at the vendor price unless the auction house is cheaper", () => {
    const catseye = book.get(10592)!;
    const prices: Record<number, number> = { 3821: 399, 3818: 395, 3372: 52 };
    const c = reagentCost(catseye, (id) => prices[id], book);
    expect(c.copper).toBe(399 + 395 + VENDOR[3372].copper);
    expect(c.lines.find((l) => l.itemId === 3372)?.how).toBe("vendor");
  });

  it("crafts an intermediate when that's cheaper than buying it", () => {
    const swim = book.get(6372)!; // Swiftthistle + Blackmouth Oil + Empty Vial
    const prices: Record<number, number> = { 2452: 268, 6370: 115, 6358: 20 };
    const c = reagentCost(swim, (id) => prices[id], book);
    const oil = c.lines.find((l) => l.itemId === 6370)!;
    expect(oil.how).toBe("crafted");
    expect(oil.unit).toBe(2 * 20 + 4);
  });

  it("uses your own reagent prices and reports missing ones", () => {
    const catseye = book.get(10592)!;
    expect(reagentCost(catseye, () => undefined, book, { 3821: 0, 3818: 0 }).copper).toBe(40);
    expect(reagentCost(catseye, () => undefined, book).missing).toEqual(["Goldthorn", "Fadeleaf"]);
  });

  it("works out profit per craft and per day", () => {
    const r = profitRow(book.get(10592)!, { copper: 834, missing: [] }, { copper: 1000, from: "listed now" }, 40, 0.25, 0.05);
    expect(r.netAfterCut).toBe(950);
    expect(r.profit).toBe(116);
    expect(r.profitPerDay).toBe(116 * 10);
  });
});

describe("which items get price history", () => {
  it("keeps trade goods and potion-type consumables", () => {
    expect(historyKind({ n: "Cerulean Dye", c: 7, sc: 11 })).toBe("Other");
    expect(historyKind({ n: "Catseye Draught", c: 0, sc: 2 })).toBe("Elixir");
    expect(historyKind({ n: "Major Healing Potion", c: 0, sc: 0 })).toBe("Potion");
    expect(historyKind({ n: "Hearthstone", c: 0, sc: 0 })).toBeUndefined();
    expect(historyKind({ n: "Woolen Boots", c: 4, sc: 1 })).toBeUndefined();
  });

  it("matches 'potions' to every potion kind and other words to names", () => {
    expect(matchesCategory("potions", "Elixir", "Catseye Draught")).toBe(true);
    expect(matchesCategory("potions", "Herb", "Peacebloom")).toBe(false);
    expect(matchesCategory("dyes", "Other", "Cerulean Dye")).toBe(true);
    expect(matchesCategory("Herb", "Herb", "Peacebloom")).toBe(true);
  });
});

describe("history fallback", () => {
  it("reads the gold finder's 4-hourly copy for items without hourly rows", async () => {
    const db = fakeD1();
    const now = Date.parse("2026-11-15T08:00:00Z");
    db.sql.exec("CREATE TABLE prices (house_id INTEGER, item_id INTEGER, at INTEGER, min INTEGER, market INTEGER, units INTEGER)");
    db.sql.prepare("INSERT INTO prices VALUES (114, 10592, ?, 1000, 1080, 900)").run(Math.floor(now / 1000) - 3600);
    const h = new PriceHistory(db, [114]);
    const pts = await h.points(114, 10592, 7, now);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ lowest: 1000, market: 1080, units: 900 });
  });
});

describe("saved recipes", () => {
  it("replace the built-in one for the same item and can be removed", async () => {
    const db = fakeD1();
    const rb = new RecipeBook(db);
    await rb.save({ itemId: 10592, name: "Catseye Draught", profession: "alchemy", reagents: [{ itemId: 3818, name: "Fadeleaf", qty: 2 }], from: "player" });
    const all = await rb.all();
    expect(all.filter((r) => r.itemId === 10592)).toHaveLength(1);
    expect(all.find((r) => r.itemId === 10592)?.from).toBe("player");
    expect(await rb.remove(10592)).toBe(true);
    expect((await rb.all()).find((r) => r.itemId === 10592)?.from).toBe("classic");
  });
});

describe("crafting_profit tool", () => {
  it("ranks recipes with live prices, a saved dye and sales", async () => {
    const db = fakeD1();
    const now = Date.now();
    const items: Record<number, { n: string; c: number; sc: number }> = { 10592: { n: "Catseye Draught", c: 0, sc: 2 }, 249409: { n: "Cerulean Dye", c: 7, sc: 11 }, 2452: { n: "Swiftthistle", c: 7, sc: 9 }, 3818: { n: "Fadeleaf", c: 7, sc: 9 }, 3821: { n: "Goldthorn", c: 7, sc: 9 } };
    const snap: HouseSnapshot = { region: "eu", houseId: 114, name: "Horde", scannedAt: new Date(now).toISOString(), listings: 5, items: { 10592: [1000, 1080, 1008, 59], 3821: [399, 399, 500, 50], 3818: [395, 395, 700, 90], 249409: [5890, 5922, 449, 107], 2452: [210, 268, 1200, 170] } };
    const history = new PriceHistory(db, [114], async (id) => items[id]);
    await history.sales(114, 1); // creates tables
    db.sql.prepare("INSERT INTO sales (house_id, day, body) VALUES (?, ?, ?)").run(114, new Date(now).toISOString().slice(0, 10), JSON.stringify({ _hours: 24, 10592: [40, 10, 2, 12, 40000] }));
    const recipes = new RecipeBook(db);
    const deps = {
      auctions: { enabled: true, snapshot: async () => snap },
      history, recipes,
      catalog: { get: async (id: number) => (items[id] ? { id, ...items[id] } : undefined) },
    } as unknown as Deps;
    const server = createServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text);

    const saved = await call("crafting_recipe", { itemId: 249409, reagents: [{ itemId: 2452, qty: 2 }] });
    expect(saved.saved.name).toBe("Cerulean Dye");

    const dyes = await call("crafting_profit", { category: "dyes" });
    expect(dyes.recipes).toHaveLength(1);
    expect(dyes.recipes[0]).toMatchObject({ itemId: 249409, profitCopper: Math.round(5890 * 0.95) - 2 * 268, recipeFrom: "player" });

    const potions = await call("crafting_profit", { itemIds: [10592] });
    const cat = potions.recipes[0];
    expect(cat.profitCopper).toBe(950 - (399 + 395 + 40));
    expect(cat.soldPerDay).toBe(40);
    expect(cat.profitPerDayCopper).toBe(Math.round(cat.profitCopper * 40 * 0.25));
    await c.close();
  });
});
