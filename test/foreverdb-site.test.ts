import { describe, it, expect } from "vitest";
import { parseItemPage, parseItemList } from "../src/sources/foreverdb-site.js";

// Shaped like ForeverDB's item pages as read on 2026-11-08 (Azure Silk Pants, Lesser Magic Wand).
const PANTS = `<html><head><meta property="og:title" content="Azure Silk Pants - ForeverDB"></head><body>
<h1>Azure Silk Pants</h1><p>Uncommon Cloth Legs armor piece (item level 28, requires level 23)</p>
<ul><li>Item level 28</li><li>Binds when equipped</li><li>Slot: Legs (Cloth)</li><li>36 Armor</li>
<li>+6 Intellect</li><li>+10 Frost Damage Done</li><li>+5 Fire Resistance</li><li>Requires level 23</li><li>Sells to vendors for 14s 94c</li></ul>
<p>Data from build 1.60.1.70862, extracted 2026-11-08.</p></body></html>`;

const WAND = `<h1>Lesser Magic Wand</h1><p>Uncommon Ranged Wand (item level 15, requires level 5)</p><ul>
<li>Item level 15</li><li>Slot: Ranged (Wand)</li><li>12 - 22 Arcane damage, speed 1.50</li><li>11.3 damage per second</li>
<li>+1 Spell Power</li><li>Requires level 5</li></ul><p>Crafted with Enchanting (Forever client).</p>`;

describe("ForeverDB public pages", () => {
  it("reads an armour item", () => {
    const it = parseItemPage(PANTS, 7046, "https://foreverdb.net/item/7046");
    expect(it).toMatchObject({
      name: "Azure Silk Pants", quality: "Uncommon", itemLevel: 28, requiredLevel: 23, slot: "Legs", armorType: "Cloth",
      stats: { armor: 36, int: 6, sp: 10 }, otherLines: ["+5 Fire Resistance"], build: "1.60.1.70862",
    });
  });

  it("reads a weapon", () => {
    const it = parseItemPage(WAND, 11287, "u");
    expect(it).toMatchObject({
      name: "Lesser Magic Wand", quality: "Uncommon", itemLevel: 15, requiredLevel: 5, slot: "Ranged", armorType: "Wand",
      damage: { min: 12, max: 22, school: "Arcane", speed: 1.5 }, stats: { weapon_dps: 11.3, sp: 1 },
      source: "Crafted with Enchanting (Forever client).",
    });
  });

  it("reads the item list", () => {
    const html = `<ul><li><a href="https://foreverdb.net/item/11287">Lesser Magic Wand</a> (item level 15)</li>
<li><a href="/item/7046"><span>Azure Silk Pants</span></a> (item level 28)</li><li><a href="/item/7046">dup</a></li></ul>`;
    expect(parseItemList(html)).toEqual([
      { itemId: 11287, name: "Lesser Magic Wand", itemLevel: 15 },
      { itemId: 7046, name: "Azure Silk Pants", itemLevel: 28 },
    ]);
  });
});
