import { describe, it, expect } from "vitest";
import { ItemCatalog, rowToItem, validateRows, type Row } from "../src/sources/foreverdb-data.js";
import { weightsFor } from "../src/formulas/stats.js";

// Rows copied from ForeverDB's items.json (2026-11-08).
const ROWS: Row[] = [
  { id: 2583, n: "Woolen Boots", q: 2, il: 19, rl: 14, c: 4, sc: 1, inv: 8, st: [[5, 2], [6, 2], [45, 2]], ar: 22, chg: { st: [[3, 2]] } },
  { id: 2569, n: "Linen Boots", q: 2, il: 13, rl: 8, c: 4, sc: 1, inv: 8, st: [[7, 2]], ar: 17 },
  { id: 4312, n: "Soft-soled Linen Boots", q: 2, il: 16, rl: 11, c: 4, sc: 1, inv: 8, st: [[7, 2], [45, 2]], ar: 20 },
  { id: 9999, n: "Plate Sabatons", q: 2, il: 16, rl: 11, c: 4, sc: 4, inv: 8, st: [[4, 9]], ar: 200 },
  { id: 7046, n: "Azure Silk Pants", q: 2, il: 28, rl: 23, c: 4, sc: 1, inv: 7, st: [[5, 6], [87, 10]], ar: 36 },
  { id: 4566, n: "Sturdy Quarterstaff", q: 2, il: 13, rl: 8, c: 2, sc: 10, inv: 17, dmg: [20, 30, 0], spd: 2800 },
  { id: 11287, n: "Lesser Magic Wand", q: 2, il: 15, rl: 5, c: 2, sc: 19, inv: 26, st: [[45, 1]], dmg: [12, 22, 6], spd: 1500 },
  { id: 41, n: "OLDRecruit's Belt", q: 1, il: 1, rl: 1, c: 4, sc: 0, inv: 6, spec: ["old"] },
];

describe("ForeverDB item list", () => {
  it("turns a row into an item with our stat keys", () => {
    expect(rowToItem(ROWS[4])).toMatchObject({ name: "Azure Silk Pants", quality: "Uncommon", slot: "Legs", type: "Cloth", requiredLevel: 23, stats: { int: 6, sp: 10, armor: 36 }, statLines: ["+6 Intellect", "+10 Frost Damage"] });
    expect(rowToItem(ROWS[6])).toMatchObject({ slot: "Ranged", type: "Wand", stats: { sp: 1, weapon_dps: 11.3 }, damage: { min: 12, max: 22, speed: 1.5 } });
    expect(rowToItem(ROWS[0]).changedFromClassic).toBe(true);
  });

  it("finds upgrades a frost mage can wear, best first, from memory", async () => {
    const cat = new ItemCatalog();
    await cat.save(ROWS);
    const r = await cat.find({ slot: "feet", maxLevel: 15, forClass: "mage", spec: "frost", weights: weightsFor("mage", "frost") });
    expect(r!.items.map((i) => i.name)).toEqual(["Woolen Boots", "Soft-soled Linen Boots", "Linen Boots"]); // no plate
    expect((await cat.find({ name: "boots" }))!.total).toBe(3);
    expect((await cat.find({ name: "recruit" }))!.total).toBe(0); // OLD items hidden
    expect((await cat.find({ slot: "main_hand", forClass: "mage" }))!.items[0].name).toBe("Sturdy Quarterstaff");
  });

  it("only counts the spec's own school", async () => {
    const cat = new ItemCatalog();
    await cat.save(ROWS);
    const frost = await cat.find({ slot: "legs", forClass: "mage", spec: "frost", weights: { int: 1, sp: 1 } });
    const fire = await cat.find({ slot: "legs", forClass: "mage", spec: "fire", weights: { int: 1, sp: 1 } });
    expect([frost!.items[0].score, fire!.items[0].score]).toEqual([16, 6]);
  });

  it("rejects a file that isn't the full list", () => {
    expect(() => validateRows({})).toThrow(/array/);
    expect(() => validateRows(ROWS)).toThrow(/expected/);
  });
});
