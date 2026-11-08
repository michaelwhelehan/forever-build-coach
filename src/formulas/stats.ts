import { kbYaml } from "../kb.js";

export const STAT_KEYS = ["str", "agi", "sta", "int", "spi", "ap", "rap", "sp", "heal", "crit", "hit", "spell_crit", "spell_hit", "mp5", "armor", "def", "dodge", "block", "weapon_dps"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Partial<Record<StatKey, number>>;

const ALIASES: Record<string, StatKey> = {
  str: "str", strength: "str",
  agi: "agi", agility: "agi",
  sta: "sta", stam: "sta", stamina: "sta",
  int: "int", intellect: "int",
  spi: "spi", spirit: "spi",
  ap: "ap", attackpower: "ap", attack_power: "ap",
  rap: "rap", rangedattackpower: "rap", ranged_attack_power: "rap",
  sp: "sp", spellpower: "sp", spell_power: "sp", spelldamage: "sp", spell_damage: "sp", damagedone: "sp", spelldamageandhealing: "sp",
  heal: "heal", healing: "heal", healingpower: "heal", bonushealing: "heal",
  crit: "crit", critrating: "crit", critchance: "crit", meleecrit: "crit", crit_rating: "crit", criticalstrike: "crit",
  hit: "hit", hitrating: "hit", hitchance: "hit", meleehit: "hit", hit_rating: "hit",
  spellcrit: "spell_crit", spell_crit: "spell_crit", spellcritical: "spell_crit",
  spellhit: "spell_hit", spell_hit: "spell_hit",
  mp5: "mp5", manaregen: "mp5", manapersecond5: "mp5", manaregeneration: "mp5",
  armor: "armor", armour: "armor",
  def: "def", defense: "def", defence: "def", defenseskill: "def",
  dodge: "dodge", dodgechance: "dodge",
  block: "block", blockchance: "block", blockvalue: "block",
  dps: "weapon_dps", weapondps: "weapon_dps", weapon_dps: "weapon_dps", damagepersecond: "weapon_dps",
  // School damage ("+10 Frost Damage Done") counts as spell power for a caster of that school; close enough for levelling.
  frostdamagedone: "sp", firedamagedone: "sp", arcanedamagedone: "sp", shadowdamagedone: "sp", naturedamagedone: "sp", holydamagedone: "sp",
  frostspelldamage: "sp", firespelldamage: "sp", arcanespelldamage: "sp", shadowspelldamage: "sp", naturespelldamage: "sp", holyspelldamage: "sp",
  defenserating: "def", dodgerating: "dodge", blockrating: "block", parryrating: "dodge", parry: "dodge",
};

export function statKey(raw: string): StatKey | undefined {
  return ALIASES[raw.toLowerCase().replace(/[^a-z_]/g, "").replace(/^_+|_+$/g, "")] ?? ALIASES[raw.toLowerCase().replace(/[^a-z]/g, "")];
}

/**
 * Turn any stats shape into our keys: { Strength: 5 }, [{ type: "STRENGTH", value: 5 }],
 * Blizzard's [{ type: { type: "STRENGTH" }, value: 5 }], or [{ stat: "str", amount: 5 }].
 */
export function normaliseStats(input: unknown): { stats: Stats; unknown: string[] } {
  const stats: Stats = {};
  const unknown: string[] = [];
  const add = (name: string, value: unknown) => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return;
    const key = statKey(name);
    if (key) stats[key] = (stats[key] ?? 0) + n;
    else unknown.push(name);
  };
  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const t = r.type ?? r.stat ?? r.name ?? r.key;
      const name = typeof t === "object" && t ? String((t as Record<string, unknown>).type ?? (t as Record<string, unknown>).name ?? "") : String(t ?? "");
      add(name, r.value ?? r.amount ?? r.val);
    }
  } else if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string") add(k, v);
    }
  }
  return { stats, unknown };
}

interface WeightsYaml { classes: Record<string, Record<string, Stats>> }

export function weightsFor(cls: string, spec: string): Stats | undefined {
  return kbYaml<WeightsYaml>("formulas/stat-weights.yaml").classes[cls.toLowerCase()]?.[spec.toLowerCase().replace(/[\s-]+/g, "_")];
}

export function specsFor(cls: string): string[] {
  return Object.keys(kbYaml<WeightsYaml>("formulas/stat-weights.yaml").classes[cls.toLowerCase()] ?? {});
}

export interface Scored { score: number; breakdown: { stat: StatKey; value: number; weight: number; points: number }[]; ignored: StatKey[] }

export function scoreStats(stats: Stats, weights: Stats): Scored {
  const breakdown: Scored["breakdown"] = [];
  const ignored: StatKey[] = [];
  let score = 0;
  for (const [k, v] of Object.entries(stats) as [StatKey, number][]) {
    const w = weights[k];
    if (w === undefined || w === 0) { if (v) ignored.push(k); continue; }
    const points = v * w;
    score += points;
    breakdown.push({ stat: k, value: v, weight: w, points: Math.round(points * 10) / 10 });
  }
  breakdown.sort((a, b) => b.points - a.points);
  return { score: Math.round(score * 10) / 10, breakdown, ignored };
}
