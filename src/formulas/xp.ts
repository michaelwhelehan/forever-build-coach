import { kbYaml } from "../kb.js";

interface XpYaml {
  xp_to_next_level: { values: number[] };
  level_cap: number;
  mob_xp: { base_per_level: number; base_constant: number; higher_bonus_per_level: number; higher_bonus_max_levels: number; zero_difference: [number, number][]; elite_multiplier: number };
  rested: { kill_multiplier: number; accrual_per_8h: number; cap_share_of_level: number; well_rested_per_rank: number };
  quest_level_penalty: { multipliers_by_levels_below: Record<string, number> };
  group: { bonus_by_size: Record<string, number> };
  buffs: { well_fed_kill_xp: number; cozy_sleeping_bag_per_stack: number; cozy_sleeping_bag_max_stacks: number };
}
const cfg = () => kbYaml<XpYaml>("formulas/xp.yaml");

export const levelCap = () => cfg().level_cap;

export function xpToNext(level: number): number {
  if (level >= cfg().level_cap) return 0;
  const v = cfg().xp_to_next_level.values[level - 1];
  if (v === undefined) throw new Error(`No XP value for level ${level}`);
  return v;
}

/** XP from the start of `from` (plus xpIntoLevel) to the start of `to`. */
export function xpBetween(from: number, to: number, xpIntoLevel = 0): number {
  let total = 0;
  for (let l = from; l < to; l++) total += xpToNext(l);
  return Math.max(0, total - xpIntoLevel);
}

export function zeroDifference(level: number): number {
  let zd = 5;
  for (const [from, value] of cfg().mob_xp.zero_difference) if (level >= from) zd = value;
  return zd;
}

/** Highest mob level that is grey (gives no XP) for this character level. Classic rule. */
export function greyLevel(level: number): number {
  if (level <= 5) return 0;
  if (level <= 39) return level - Math.floor(level / 10) - 5;
  if (level <= 59) return level - Math.floor(level / 5) - 1;
  return level - 9;
}

export interface MobXpOptions { elite?: boolean; rested?: boolean; groupSize?: number; groupLevels?: number[]; wellFed?: boolean; sleepingBagStacks?: number }

export function mobXp(charLevel: number, mobLevel: number, o: MobXpOptions = {}): number {
  const m = cfg().mob_xp;
  if (mobLevel <= greyLevel(charLevel)) return 0;
  let xp = charLevel * m.base_per_level + m.base_constant;
  if (mobLevel > charLevel) {
    xp *= 1 + m.higher_bonus_per_level * Math.min(mobLevel - charLevel, m.higher_bonus_max_levels);
  } else if (mobLevel < charLevel) {
    xp *= 1 - (charLevel - mobLevel) / zeroDifference(charLevel);
  }
  if (o.elite) xp *= m.elite_multiplier;
  // Group: bonus for size, then split by level share.
  const size = Math.max(1, Math.min(5, o.groupSize ?? o.groupLevels?.length ?? 1));
  if (size > 1) {
    const bonus = cfg().group.bonus_by_size[String(size)] ?? 1;
    const levels = o.groupLevels && o.groupLevels.length === size ? o.groupLevels : Array(size).fill(charLevel);
    const sum = levels.reduce((a, b) => a + b, 0);
    xp = xp * bonus * (charLevel / sum);
  }
  let mult = 1;
  if (o.wellFed) mult += cfg().buffs.well_fed_kill_xp;
  if (o.sleepingBagStacks) mult += cfg().buffs.cozy_sleeping_bag_per_stack * Math.min(o.sleepingBagStacks, cfg().buffs.cozy_sleeping_bag_max_stacks);
  xp *= mult;
  if (o.rested) xp *= cfg().rested.kill_multiplier;
  return Math.max(0, Math.round(xp));
}

export function questXpMultiplier(charLevel: number, questLevel: number): number {
  const below = charLevel - questLevel;
  if (below <= 5) return 1;
  const table = cfg().quest_level_penalty.multipliers_by_levels_below;
  return table[String(Math.min(below, 10))] ?? 0.1;
}

export function restedPool(level: number, hoursResting: number, wellRestedRanks = 0): { xp: number; cap: number; bubbles: number } {
  const r = cfg().rested;
  const perLevel = xpToNext(level);
  const boost = 1 + r.well_rested_per_rank * wellRestedRanks;
  const cap = perLevel * r.cap_share_of_level * boost;
  const xp = Math.min(cap, (hoursResting / 8) * r.accrual_per_8h * perLevel * boost);
  return { xp: Math.round(xp), cap: Math.round(cap), bubbles: Math.round((xp / perLevel) * 20 * 10) / 10 };
}
