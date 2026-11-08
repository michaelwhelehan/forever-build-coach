import { describe, it, expect } from "vitest";
import { parseArmoryPage, parseDescription, armoryUrl, gearFromJson, shapeOf, urlsIn } from "../src/sources/armory.js";

// The head of the real page for Uzal Muzal, 2026-11-08 (its body loads in the browser).
const REAL_HEAD = `<html><head><title>Uzal Muzal - Character</title>
<meta name="description" content="Uzal - 15 Undead character.class, 7 ilvl">
<meta property="og:title" content="Uzal Muzal - Character - WoW"></head><body><div id="app"></div></body></html>`;

describe("armory page", () => {
  it("builds the Forever armory URL", () => {
    expect(armoryUrl("eu", "Uzal", "Muzal")).toBe("https://worldofwarcraft.blizzard.com/en-us/forever/eu/armory/character/uzal-muzal");
  });

  it("reads level, race and item level from the meta description", () => {
    const c = parseArmoryPage(REAL_HEAD, "u");
    expect(c).toMatchObject({ title: "Uzal Muzal", level: 15, race: "Undead", averageItemLevel: 7, equipped: [] });
    expect(c.class).toBeUndefined(); // the page leaves "character.class" unfilled
    expect(parseDescription("Thrall - 42 Night Elf Druid, 38 ilvl")).toEqual({ level: 42, race: "Night Elf", class: "Druid", averageItemLevel: 38 });
  });

  it("reads gear from embedded page state when there is some", () => {
    const state = {
      character: { name: "Uzal", class: { name: "Warrior" } },
      equipment: { items: [
        { slot: { type: "MAIN_HAND", name: "Main Hand" }, item: { id: 1, name: "Sturdy Axe" }, quality: { name: "Uncommon" }, level: { value: 14 },
          stats: [{ type: { type: "STRENGTH" }, value: 4 }], weapon: { dps: { value: 9.5 } } },
        { slot: { type: "CHEST" }, item: { id: 2 }, name: "Ragged Vest", armor: { value: 30 }, stats: [{ type: { type: "STAMINA" }, value: 2 }] },
      ] },
    };
    const html = REAL_HEAD.replace("<div id=\"app\"></div>", `<script>var characterProfileInitialState = ${JSON.stringify(state)};</script>`);
    const c = parseArmoryPage(html, "u");
    expect(c.class).toBe("Warrior");
    expect(c.equipped).toEqual([
      { slot: "Main Hand", itemId: 1, name: "Sturdy Axe", quality: "Uncommon", level: 14, stats: { str: 4, weapon_dps: 9.5 } },
      { slot: "CHEST", itemId: 2, name: "Ragged Vest", quality: undefined, level: undefined, stats: { sta: 2, armor: 30 } },
    ]);
    expect(c.gearSource).toBe("embedded page data");
  });

  it("reads gear from a JSON response the page fetched", () => {
    const res = { equipped_items: [{ slot: { type: "HEAD", name: "Head" }, item: { id: 10 }, name: "Leather Cap", stats: [{ type: { type: "AGILITY", name: "Agility" }, value: 3 }] }], character_class: { name: "Rogue" } };
    expect(gearFromJson(res)).toEqual({ class: "Rogue", lists: [1], equipped: [{ slot: "Head", itemId: 10, name: "Leather Cap", quality: undefined, level: undefined, stats: { agi: 3 } }] });
    expect(gearFromJson({ unrelated: [1, 2, 3] }).equipped).toEqual([]);
  });

  it("reads gear kept as an object keyed by slot", () => {
    const state = { profile: { equipment: { HEAD: { itemId: 5, itemName: "Cowl", quality: "Common" }, MAIN_HAND: { item: { id: 6, name: "Staff" }, item_level: 12 }, notes: "x" } } };
    expect(gearFromJson(state).equipped).toEqual([
      { slot: "HEAD", itemId: 5, name: "Cowl", quality: "Common", level: undefined, stats: {} },
      { slot: "MAIN_HAND", itemId: 6, name: "Staff", quality: undefined, level: 12, stats: {} },
    ]);
  });

  it("outlines page data and finds URLs in it, for debugging", () => {
    const state = { character: { name: "Uzal", links: { equipment: "/en-us/forever/eu/armory/character/uzal-muzal/equipment.json", icon: "https://x/y.png" } }, list: [{ a: 1 }, { a: 2 }] };
    expect(shapeOf(state)).toEqual({ character: { name: "Uzal", links: { equipment: "/en-us/forever/eu/armory/character/uzal-muzal/equipment.json", icon: "https://x/y.png" } }, list: ["2 ×", { a: 1 }] });
    expect([...urlsIn(state)]).toEqual(["/en-us/forever/eu/armory/character/uzal-muzal/equipment.json"]);
  });
});

describe("gear split across lists", () => {
  it("joins columns and a separate weapons list, one item per slot", () => {
    const state = {
      left: [{ slot: { type: "BACK", name: "Back" }, item: { id: 2580 }, name: "Cape" }, { slot: { type: "CHEST", name: "Chest" }, item: { id: 2578 }, name: "Vest" }],
      weapons: [{ slot: { type: "MAIN_HAND", name: "Main Hand" }, item: { id: 35 }, name: "Bent Staff" }, { slot: { type: "RANGED", name: "Ranged" }, item: { id: 11288 }, name: "Wand" }],
      again: [{ slot: { type: "CHEST", name: "Chest" }, item: { id: 2578 }, name: "Vest" }],
    };
    const g = gearFromJson(state);
    expect(g.equipped.map((e) => e.name)).toEqual(["Cape", "Vest", "Bent Staff", "Wand"]);
    expect(g.lists).toEqual([2, 2, 1]);
  });
});
