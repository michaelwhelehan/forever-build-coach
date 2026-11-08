/**
 * The text the Forever Build Coach addon shows in game, e.g.
 *   FBC1:MAGE:15:Uzal:HEAD=0;BACK=2580;MAINHAND=4566;RANGED=11288
 * Version, class token, level, character name, then slot=itemId pairs (0 = empty slot).
 */
export interface GearExport { class: string; level: number; name?: string; slots: Record<string, number> }

export const EXPORT_SLOTS = ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "WRIST", "HANDS", "WAIST", "LEGS", "FEET", "FINGER0", "FINGER1", "TRINKET0", "TRINKET1", "MAINHAND", "OFFHAND", "RANGED"] as const;

/** Export slot to the slot names find_items understands. */
export const SLOT_FOR_SEARCH: Record<string, string> = {
  HEAD: "head", NECK: "neck", SHOULDER: "shoulder", BACK: "back", CHEST: "chest", WRIST: "wrist", HANDS: "hands", WAIST: "waist",
  LEGS: "legs", FEET: "feet", FINGER0: "finger", FINGER1: "finger", TRINKET0: "trinket", TRINKET1: "trinket",
  MAINHAND: "main_hand", OFFHAND: "off_hand", RANGED: "ranged",
};

export function parseExport(text: string): GearExport {
  const m = text.trim().match(/FBC1:([A-Z]+):(\d{1,2}):([^:]*):([A-Z0-9=;,\s]*)/i);
  if (!m) throw new Error("That isn't a Forever Build Coach export. In game, type /fbc and copy the whole line (it starts with FBC1:).");
  const slots: Record<string, number> = {};
  for (const pair of m[4].split(/[;,]/)) {
    const [k, v] = pair.split("=").map((x) => x?.trim());
    if (k && (EXPORT_SLOTS as readonly string[]).includes(k.toUpperCase())) slots[k.toUpperCase()] = Number(v) || 0;
  }
  return { class: m[1].toLowerCase(), level: Number(m[2]), name: m[3] || undefined, slots };
}
