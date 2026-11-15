import type { D1Like } from "./gold.js";

/**
 * Recipes for the crafting profit tool.
 *
 * Built-in: the common alchemy recipes, reagents from Classic 1.12 except where ForeverDB's Forever
 * levelling route shows a different one (marked "forever"). Every item id was checked against
 * ForeverDB's item list and house 114's auction listings on 2026-11-15; several elixirs carry
 * Forever names (Catseye Draught, Elixir of Greater Strength...) and Forever may have changed their
 * reagents too, so a built-in recipe is a baseline, not a fact.
 *
 * Saved: recipes players add with the crafting_recipe tool (kept in D1, shared by everyone on this
 * server). A saved recipe for the same item replaces the built-in one, which is how Forever-only
 * recipes (the new dyes) and corrected reagents get in.
 */

export interface Reagent { itemId: number; name: string; qty: number }
export interface Recipe {
  itemId: number; name: string; profession: string; skill?: number;
  /** How many one craft makes (default 1). */
  makes?: number;
  reagents: Reagent[];
  /** classic = Classic 1.12 reagents, forever = seen in Forever data, player = saved by a player. */
  from: "classic" | "forever" | "player";
  note?: string; savedBy?: string; savedAt?: string;
}

/** Bought from vendors at a fixed price, in copper (Forever prices from ForeverDB's alchemy route). */
export const VENDOR: Record<number, { name: string; copper: number }> = {
  3371: { name: "Empty Vial", copper: 4 },
  3372: { name: "Leaded Vial", copper: 40 },
  8925: { name: "Crystal Vial", copper: 500 },
  // Tailoring (Forever prices from ForeverDB's tailoring route).
  2320: { name: "Coarse Thread", copper: 10 },
  2321: { name: "Fine Thread", copper: 100 },
  4291: { name: "Silken Thread", copper: 500 },
  8343: { name: "Heavy Silken Thread", copper: 2000 },
  14341: { name: "Rune Thread", copper: 5000 },
  2604: { name: "Red Dye", copper: 50 },
  6260: { name: "Blue Dye", copper: 50 },
  6261: { name: "Orange Dye", copper: 1000 },
  // Enchanting, mining and blacksmithing (Classic 1.12 vendor prices; Forever may differ).
  4470: { name: "Simple Wood", copper: 38 },
  11291: { name: "Star Wood", copper: 4500 },
  3857: { name: "Coal", copper: 500 },
};

const R = (itemId: number, name: string, qty = 1): Reagent => ({ itemId, name, qty });
const PEACE = R(2447, "Peacebloom"), SILVER = R(765, "Silverleaf"), EARTH = R(2449, "Earthroot"), MAGE = R(785, "Mageroyal");
const BRIAR = R(2450, "Briarthorn"), SWIFT = R(2452, "Swiftthistle"), BRUISE = R(2453, "Bruiseweed"), KELP = R(3820, "Stranglekelp");
const STEEL = R(3355, "Wild Steelbloom"), KINGS = R(3356, "Kingsblood"), LIFE = R(3357, "Liferoot"), FADE = R(3818, "Fadeleaf");
const GOLD = R(3821, "Goldthorn"), KHADGAR = R(3358, "Khadgar's Whisker"), SUN = R(8838, "Sungrass");
const EMPTY = R(3371, "Empty Vial"), LEADED = R(3372, "Leaded Vial"), CRYSTAL = R(8925, "Crystal Vial");
const x = (r: Reagent, qty: number): Reagent => ({ ...r, qty });

const A = (itemId: number, name: string, skill: number, reagents: Reagent[], from: Recipe["from"] = "classic", note?: string): Recipe =>
  ({ itemId, name, profession: "alchemy", skill, reagents, from, ...(note ? { note } : {}) });

export const BUILT_IN: Recipe[] = [
  A(118, "Minor Healing Potion", 1, [PEACE, SILVER, EMPTY]),
  A(5997, "Elixir of Minor Defense", 1, [SILVER, PEACE, EMPTY], "forever", "Forever recipe per ForeverDB's alchemy route (Classic used 2 Silverleaf)."),
  A(2454, "Elixir of Minor Strength", 1, [EARTH, SILVER, EMPTY], "classic", "Classic's Elixir of Lion's Strength, renamed in Forever."),
  A(2455, "Minor Mana Potion", 25, [MAGE, SILVER, EMPTY]),
  A(2458, "Elixir of Minor Fortitude", 50, [x(EARTH, 2), PEACE, EMPTY]),
  A(858, "Lesser Healing Potion", 55, [SILVER, BRIAR, EMPTY]),
  A(2457, "Elixir of Minor Agility", 50, [SWIFT, SILVER, EMPTY]),
  A(5631, "Rage Potion", 60, [R(5635, "Sharp Claw"), BRIAR, EMPTY], "forever"),
  A(6370, "Blackmouth Oil", 80, [x(R(6358, "Oily Blackmouth"), 2), EMPTY], "forever"),
  A(2459, "Swiftness Potion", 60, [SWIFT, BRIAR, EMPTY]),
  A(3383, "Elixir of Wisdom", 90, [MAGE, x(BRIAR, 2), EMPTY]),
  A(929, "Healing Potion", 110, [BRUISE, BRIAR, LEADED]),
  A(3385, "Lesser Mana Potion", 120, [MAGE, KELP, EMPTY]),
  A(6372, "Swim Speed Potion", 100, [SWIFT, R(6370, "Blackmouth Oil"), EMPTY], "forever"),
  A(6371, "Fire Oil", 130, [x(R(6359, "Firefin Snapper"), 2), EMPTY], "forever"),
  A(3391, "Elixir of Ogre Strength", 150, [EARTH, KINGS, LEADED]),
  A(5996, "Draught of Water Breathing", 90, [KELP, x(R(6370, "Blackmouth Oil"), 2), EMPTY], "classic", "Classic's Elixir of Water Breathing."),
  A(3825, "Elixir of Lesser Fortitude", 175, [STEEL, GOLD, LEADED], "classic", "Classic's Elixir of Fortitude."),
  A(1710, "Greater Healing Potion", 155, [LIFE, KINGS, LEADED]),
  A(3827, "Mana Potion", 160, [KELP, KINGS, LEADED]),
  A(6049, "Fire Protection Potion", 165, [R(4402, "Small Flame Sac"), R(6371, "Fire Oil"), LEADED], "forever"),
  A(8949, "Elixir of Agility", 185, [KELP, GOLD, LEADED]),
  A(10592, "Catseye Draught", 200, [GOLD, FADE, LEADED], "classic", "Classic's Catseye Elixir, renamed in Forever."),
  A(5634, "Free Action Potion", 150, [x(R(6370, "Blackmouth Oil"), 2), KELP, LEADED]),
  A(3824, "Shadow Oil", 165, [x(FADE, 4), x(R(3369, "Grave Moss"), 4), LEADED]),
  A(6149, "Greater Mana Potion", 205, [GOLD, KHADGAR, LEADED]),
  A(13423, "Stonescale Oil", 250, [R(13422, "Stonescale Eel"), LEADED], "forever"),
  A(3928, "Superior Healing Potion", 215, [SUN, KHADGAR, CRYSTAL]),
  A(13443, "Superior Mana Potion", 260, [x(SUN, 2), x(R(8839, "Blindweed"), 2), CRYSTAL]),
  A(13446, "Major Healing Potion", 275, [x(R(13464, "Golden Sansam"), 2), R(13465, "Mountain Silversage"), CRYSTAL]),
  A(13444, "Major Mana Potion", 295, [x(R(13463, "Dreamfoil"), 3), x(R(13467, "Icecap"), 2), CRYSTAL]),
  A(13452, "Elixir of the Mongoose", 280, [x(R(13465, "Mountain Silversage"), 2), x(R(13466, "Plaguebloom"), 2), CRYSTAL]),
  A(13454, "Greater Arcane Elixir", 285, [x(R(13463, "Dreamfoil"), 3), R(13465, "Mountain Silversage"), CRYSTAL]),
];

const LINEN = R(2589, "Linen Cloth"), WOOL = R(2592, "Wool Cloth"), SILK = R(4306, "Silk Cloth"), MAGEWEAVE = R(4338, "Mageweave Cloth"), RUNECLOTH = R(14047, "Runecloth");
const B_LINEN = R(2996, "Bolt of Linen Cloth"), B_WOOL = R(2997, "Bolt of Woolen Cloth"), B_SILK = R(4305, "Bolt of Silk Cloth"), B_MAGE = R(4339, "Bolt of Mageweave"), B_RUNE = R(14048, "Bolt of Runecloth");
const COARSE = R(2320, "Coarse Thread"), FINE = R(2321, "Fine Thread"), SILKEN = R(4291, "Silken Thread"), HEAVY_SILKEN = R(8343, "Heavy Silken Thread"), RUNE_THREAD = R(14341, "Rune Thread");
const RED_DYE = R(2604, "Red Dye"), BLUE_DYE = R(6260, "Blue Dye"), ORANGE_DYE = R(6261, "Orange Dye"), RUGGED = R(8170, "Rugged Leather");

const T = (itemId: number, name: string, skill: number, reagents: Reagent[], from: Recipe["from"] = "forever", note?: string): Recipe =>
  ({ itemId, name, profession: "tailoring", skill, reagents, from, ...(note ? { note } : {}) });

/**
 * Tailoring: the cloth bolts and every recipe on ForeverDB's Forever tailoring route (reagents from there,
 * bolt sizes worked out from its shopping list), plus the bags most people sell (Classic reagents).
 */
export const TAILORING: Recipe[] = [
  T(2996, "Bolt of Linen Cloth", 1, [x(LINEN, 2)]),
  T(2997, "Bolt of Woolen Cloth", 75, [x(WOOL, 3)]),
  T(4305, "Bolt of Silk Cloth", 125, [x(SILK, 4)]),
  T(4339, "Bolt of Mageweave", 175, [x(MAGEWEAVE, 5)]),
  T(14048, "Bolt of Runecloth", 250, [x(RUNECLOTH, 5)]),
  T(7026, "Linen Belt", 25, [B_LINEN, COARSE]),
  T(2580, "Reinforced Linen Cape", 60, [x(B_LINEN, 2), x(COARSE, 3)]),
  T(4238, "Linen Bag", 45, [x(B_LINEN, 3), x(COARSE, 3)], "classic"),
  T(2584, "Woolen Cape", 75, [B_WOOL, FINE]),
  T(4330, "Stylish Red Shirt", 110, [x(B_WOOL, 3), x(RED_DYE, 2), FINE]),
  T(7053, "Azure Silk Cloak", 140, [x(B_SILK, 3), x(BLUE_DYE, 2), x(FINE, 2)]),
  T(7058, "Crimson Silk Vest", 170, [x(B_SILK, 4), x(RED_DYE, 2), x(FINE, 2)]),
  T(7062, "Crimson Silk Pantaloons", 180, [x(B_SILK, 4), x(RED_DYE, 2), x(SILKEN, 2)]),
  T(10056, "Orange Mageweave Shirt", 185, [B_MAGE, ORANGE_DYE, HEAVY_SILKEN]),
  T(9999, "Black Mageweave Leggings", 185, [x(B_MAGE, 2), x(SILKEN, 3)]),
  T(10003, "Black Mageweave Gloves", 195, [x(B_MAGE, 2), x(HEAVY_SILKEN, 2)]),
  T(10027, "Black Mageweave Shoulders", 205, [x(B_MAGE, 3), x(HEAVY_SILKEN, 2)]),
  T(10050, "Mageweave Bag", 225, [x(B_MAGE, 4), x(HEAVY_SILKEN, 2)], "classic"),
  T(10030, "Admiral's Hat", 215, [x(B_MAGE, 3), x(R(4589, "Long Elegant Feather"), 6), x(HEAVY_SILKEN, 2)]),
  T(13856, "Runecloth Belt", 225, [x(B_RUNE, 3), RUNE_THREAD]),
  T(13863, "Runecloth Gloves", 245, [x(B_RUNE, 4), x(RUGGED, 4), RUNE_THREAD]),
  T(14046, "Runecloth Bag", 260, [x(B_RUNE, 5), x(RUGGED, 2), RUNE_THREAD], "classic"),
  T(13866, "Runecloth Headband", 265, [x(B_RUNE, 4), x(R(14227, "Ironweb Spider Silk"), 2), RUNE_THREAD]),
  T(14139, "Mooncloth Shoulders", 290, [x(B_RUNE, 5), x(R(14342, "Mooncloth"), 5), RUNE_THREAD]),
];

const ORE = { copper: R(2770, "Copper Ore"), tin: R(2771, "Tin Ore"), silver: R(2775, "Silver Ore"), iron: R(2772, "Iron Ore"), gold: R(2776, "Gold Ore"), mithril: R(3858, "Mithril Ore"), truesilver: R(7911, "Truesilver Ore"), thorium: R(10620, "Thorium Ore") };
const BAR = { copper: R(2840, "Copper Bar"), tin: R(3576, "Tin Bar"), bronze: R(2841, "Bronze Bar"), silver: R(2842, "Silver Bar"), iron: R(3575, "Iron Bar"), gold: R(3577, "Gold Bar"), steel: R(3859, "Steel Bar"), mithril: R(3860, "Mithril Bar"), truesilver: R(6037, "Truesilver Bar"), thorium: R(12359, "Thorium Bar") };
const STONE = { rough: R(2835, "Rough Stone"), coarse: R(2836, "Coarse Stone"), heavy: R(2838, "Heavy Stone"), solid: R(7912, "Solid Stone"), dense: R(12365, "Dense Stone") };
const GRIND = { rough: R(3470, "Rough Grinding Stone"), coarse: R(3478, "Coarse Grinding Stone"), heavy: R(3486, "Heavy Grinding Stone") };

const P = (profession: string) => (itemId: number, name: string, skill: number, reagents: Reagent[], makes?: number, note?: string): Recipe =>
  ({ itemId, name, profession, skill, reagents, from: "classic", ...(makes ? { makes } : {}), ...(note ? { note } : {}) });
const M = P("mining"), E = P("enchanting"), BS = P("blacksmithing");

/** Mining: smelting ore into bars (Classic 1.12; checked against house 114's listings on 2026-11-15). */
export const MINING: Recipe[] = [
  M(2840, "Copper Bar", 1, [ORE.copper]),
  M(3576, "Tin Bar", 65, [ORE.tin]),
  M(2841, "Bronze Bar", 65, [BAR.copper, BAR.tin], 2),
  M(2842, "Silver Bar", 75, [ORE.silver]),
  M(3575, "Iron Bar", 125, [ORE.iron]),
  M(3577, "Gold Bar", 155, [ORE.gold]),
  M(3859, "Steel Bar", 165, [BAR.iron, R(3857, "Coal")]),
  M(3860, "Mithril Bar", 175, [ORE.mithril]),
  M(6037, "Truesilver Bar", 230, [ORE.truesilver]),
  M(12359, "Thorium Bar", 250, [ORE.thorium]),
];

/**
 * Enchanting: what an enchanter can sell. Wands, and turning 3 lesser essences into 1 greater or back
 * (often the best flip in enchanting). Enchants themselves can't be listed, and runed rods are soulbound.
 */
const ESS: [number, string, number, string, number][] = [
  [10938, "Lesser Magic Essence", 10939, "Greater Magic Essence", 10],
  [10998, "Lesser Astral Essence", 11082, "Greater Astral Essence", 110],
  [11134, "Lesser Mystic Essence", 11135, "Greater Mystic Essence", 160],
  [11174, "Lesser Nether Essence", 11175, "Greater Nether Essence", 210],
  [16202, "Lesser Eternal Essence", 16203, "Greater Eternal Essence", 260],
];
export const ENCHANTING: Recipe[] = [
  ...ESS.flatMap(([lo, loName, hi, hiName, skill]) => [
    E(hi, hiName, skill, [R(lo, loName, 3)], undefined, `Made from 3 ${loName}.`),
    E(lo, loName, skill, [R(hi, hiName)], 3, `3 made by splitting 1 ${hiName}.`),
  ]),
  E(11287, "Lesser Magic Wand", 10, [R(4470, "Simple Wood"), R(10938, "Lesser Magic Essence")]),
  E(11288, "Greater Magic Wand", 70, [R(4470, "Simple Wood"), R(10939, "Greater Magic Essence")]),
  E(11289, "Greater Mystic Wand", 175, [R(11291, "Star Wood"), R(11135, "Greater Mystic Essence"), R(11137, "Vision Dust")]),
];

/** Blacksmithing: the stones every melee player buys, rods enchanters need, and a few parts (Classic 1.12). */
export const BLACKSMITHING: Recipe[] = [
  BS(2862, "Rough Sharpening Stone", 1, [STONE.rough]),
  BS(3239, "Rough Weightstone", 1, [STONE.rough, R(2589, "Linen Cloth")]),
  BS(3470, "Rough Grinding Stone", 25, [x(STONE.rough, 2)]),
  BS(2863, "Coarse Sharpening Stone", 65, [STONE.coarse]),
  BS(3240, "Coarse Weightstone", 65, [STONE.coarse, R(2592, "Wool Cloth")]),
  BS(3478, "Coarse Grinding Stone", 75, [x(STONE.coarse, 2)]),
  BS(2871, "Heavy Sharpening Stone", 125, [STONE.heavy]),
  BS(3241, "Heavy Weightstone", 125, [STONE.heavy, R(2592, "Wool Cloth")]),
  BS(3486, "Heavy Grinding Stone", 125, [x(STONE.heavy, 3)]),
  BS(7964, "Solid Sharpening Stone", 200, [STONE.solid]),
  BS(7965, "Solid Weightstone", 200, [STONE.solid, R(4306, "Silk Cloth")]),
  BS(7966, "Solid Grinding Stone", 200, [x(STONE.solid, 4)]),
  BS(12404, "Dense Sharpening Stone", 250, [STONE.dense]),
  BS(12643, "Dense Weightstone", 250, [STONE.dense, R(14047, "Runecloth")]),
  BS(12644, "Dense Grinding Stone", 250, [x(STONE.dense, 4)]),
  BS(6338, "Silver Rod", 100, [BAR.silver, x(GRIND.rough, 2)]),
  BS(11128, "Golden Rod", 150, [BAR.gold, x(GRIND.coarse, 2)]),
  BS(11144, "Truesilver Rod", 200, [BAR.truesilver, GRIND.heavy]),
  BS(7071, "Iron Buckle", 150, [BAR.iron]),
  BS(6042, "Iron Shield Spike", 150, [x(BAR.iron, 6)]),
];

/** Item ids that count as a "dye" or "potion" group, for filters. */
export const isPotionName = (n: string) => /potion|elixir|flask|draught|oil\b/i.test(n);
export const isDyeName = (n: string) => /\bdye\b/i.test(n);

const SCHEMA = "CREATE TABLE IF NOT EXISTS recipes (item_id INTEGER PRIMARY KEY, body TEXT NOT NULL, saved_at TEXT NOT NULL)";

/** Built-in recipes plus the ones players saved (D1). */
export class RecipeBook {
  private ready?: Promise<unknown>;
  constructor(private db?: D1Like) {}

  private init() {
    if (!this.db) return Promise.resolve();
    this.ready ??= this.db.prepare(SCHEMA).run();
    return this.ready;
  }

  get canSave() { return Boolean(this.db); }

  async saved(): Promise<Recipe[]> {
    if (!this.db) return [];
    await this.init();
    const { results } = await this.db.prepare("SELECT body FROM recipes").all<{ body: string }>();
    return results.map((r) => JSON.parse(r.body) as Recipe);
  }

  /** Every recipe, a saved one replacing the built-in one for the same item. */
  async all(): Promise<Recipe[]> {
    const saved = await this.saved();
    const ids = new Set(saved.map((r) => r.itemId));
    return [...saved, ...[...BUILT_IN, ...TAILORING, ...MINING, ...ENCHANTING, ...BLACKSMITHING].filter((r) => !ids.has(r.itemId))];
  }

  async save(r: Recipe): Promise<void> {
    if (!this.db) throw new Error("Saving recipes needs the D1 database (bound as DB).");
    await this.init();
    const at = new Date().toISOString();
    await this.db.prepare("INSERT INTO recipes (item_id, body, saved_at) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET body = excluded.body, saved_at = excluded.saved_at")
      .bind(r.itemId, JSON.stringify({ ...r, from: "player", savedAt: at }), at).run();
  }

  async remove(itemId: number): Promise<boolean> {
    if (!this.db) return false;
    await this.init();
    const had = await this.db.prepare("SELECT item_id FROM recipes WHERE item_id = ?").bind(itemId).first();
    await this.db.prepare("DELETE FROM recipes WHERE item_id = ?").bind(itemId).run();
    return Boolean(had);
  }
}

// ───────────────────────── Pure maths ─────────────────────────

export interface UnitPrice { copper: number; how: "vendor" | "auction" | "crafted" | "yours" }

export interface CostLine { itemId: number; name: string; qty: number; unit?: number; how?: UnitPrice["how"]; total?: number }

/**
 * What one craft's reagents cost. `price` gives the auction price of an item (undefined = not listed).
 * An intermediate (Blackmouth Oil, Fire Oil...) costs the cheaper of buying it and crafting it, one level deep.
 * Vendor reagents use the vendor price unless the auction house is cheaper.
 */
export function reagentCost(recipe: Recipe, price: (id: number) => number | undefined, book: Map<number, Recipe>, own: Record<number, number> = {}, depth = 0): { copper?: number; lines: CostLine[]; missing: string[] } {
  const lines: CostLine[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const r of recipe.reagents) {
    const u = unitPrice(r.itemId, price, book, own, depth, recipe.itemId);
    if (!u) { missing.push(r.name); lines.push({ itemId: r.itemId, name: r.name, qty: r.qty }); continue; }
    total += u.copper * r.qty;
    lines.push({ itemId: r.itemId, name: r.name, qty: r.qty, unit: Math.round(u.copper), how: u.how, total: Math.round(u.copper * r.qty) });
  }
  return { copper: missing.length ? undefined : Math.round(total / (recipe.makes ?? 1)), lines, missing };
}

/** `making` is the item this reagent goes into: a reagent made from that same item (essences split and joined) is never "crafted". */
export function unitPrice(id: number, price: (id: number) => number | undefined, book: Map<number, Recipe>, own: Record<number, number> = {}, depth = 0, making?: number): UnitPrice | undefined {
  if (own[id] !== undefined) return { copper: own[id], how: "yours" };
  const options: UnitPrice[] = [];
  const ah = price(id);
  if (ah !== undefined) options.push({ copper: ah, how: "auction" });
  if (VENDOR[id]) options.push({ copper: VENDOR[id].copper, how: "vendor" });
  const sub = depth < 1 ? book.get(id) : undefined;
  if (sub && making !== undefined && sub.reagents.some((g) => g.itemId === making)) return options.sort((a, b) => a.copper - b.copper)[0];
  if (sub) { const c = reagentCost(sub, price, book, own, depth + 1).copper; if (c !== undefined) options.push({ copper: c, how: "crafted" }); }
  return options.sort((a, b) => a.copper - b.copper)[0];
}

export interface ProfitRow {
  itemId: number; name: string; profession: string; skill?: number; recipeFrom: Recipe["from"];
  cost?: number; sellPrice?: number; sellPriceFrom?: "7-day typical" | "listed now" | "yours";
  netAfterCut?: number; profit?: number; marginPct?: number;
  soldPerDay?: number; profitPerDay?: number; listedNow?: number;
  missing?: string[];
}

/** Profit of one craft and per day, given what the output sells for and how many sell a day. */
export function profitRow(recipe: Recipe, cost: { copper?: number; missing: string[] }, sell: { copper?: number; from?: ProfitRow["sellPriceFrom"] }, soldPerDay: number | undefined, share: number, cut: number, listedNow?: number): ProfitRow {
  const net = sell.copper !== undefined ? Math.round(sell.copper * (1 - cut)) : undefined;
  const profit = net !== undefined && cost.copper !== undefined ? net - cost.copper : undefined;
  return {
    itemId: recipe.itemId, name: recipe.name, profession: recipe.profession, skill: recipe.skill, recipeFrom: recipe.from,
    cost: cost.copper, sellPrice: sell.copper, sellPriceFrom: sell.from, netAfterCut: net, profit,
    marginPct: profit !== undefined && cost.copper ? Math.round((profit / cost.copper) * 100) : undefined,
    soldPerDay, profitPerDay: profit !== undefined && soldPerDay !== undefined ? Math.round(profit * soldPerDay * share) : undefined,
    listedNow, ...(cost.missing.length ? { missing: cost.missing } : {}),
  };
}
