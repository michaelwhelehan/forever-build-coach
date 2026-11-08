export type Tier = "official" | "player_observed" | "game_files" | "user_provided" | "community_guide" | "classic_baseline";

export interface Evidence {
  tier: Tier;
  /** Agreeing installs or reporters, for player_observed. */
  reporters?: number;
  /** Age of the data in days. */
  ageDays?: number;
  /** Few reporters or a thin market. */
  thin?: boolean;
  note?: string;
}

export interface Confidence { label: "high" | "medium" | "low"; score: number; reasons: string[] }

const BASE: Record<Tier, number> = {
  official: 0.95,
  player_observed: 0.65,
  game_files: 0.7,
  user_provided: 0.7,
  community_guide: 0.55,
  classic_baseline: 0.35,
};

const TIER_WORDS: Record<Tier, string> = {
  official: "official Blizzard data",
  player_observed: "confirmed in play by players",
  game_files: "from the Forever game files, not yet confirmed in play",
  user_provided: "provided by the player",
  community_guide: "from a single community guide",
  classic_baseline: "Classic 1.12 baseline, assumed to carry over to Forever",
};

export function scoreOne(e: Evidence): { score: number; reasons: string[] } {
  let score = BASE[e.tier];
  const reasons = [TIER_WORDS[e.tier]];
  if (e.tier === "player_observed" && e.reporters !== undefined) {
    score = Math.min(0.9, 0.65 + 0.05 * Math.max(0, e.reporters - 3));
    reasons[0] += ` (${e.reporters} reporters)`;
  }
  if (e.ageDays !== undefined) {
    if (e.ageDays > 90) { score *= 0.75; reasons.push(`data is ${Math.round(e.ageDays)} days old`); }
    else if (e.ageDays > 30) { score *= 0.9; reasons.push(`data is ${Math.round(e.ageDays)} days old`); }
  }
  if (e.thin) { score *= 0.85; reasons.push("thin data (few reports)"); }
  if (e.note) reasons.push(e.note);
  return { score, reasons };
}

export function label(score: number): Confidence["label"] {
  return score >= 0.8 ? "high" : score >= 0.6 ? "medium" : "low";
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Several sources saying the same thing: best one, plus a little for each extra agreeing source. */
export function agree(evidence: Evidence[]): Confidence {
  if (evidence.length === 0) return { label: "low", score: 0, reasons: ["no evidence"] };
  const scored = evidence.map(scoreOne).sort((a, b) => b.score - a.score);
  const score = Math.min(0.98, scored[0].score + 0.05 * (scored.length - 1));
  return { label: label(score), score: round(score), reasons: scored.flatMap((s) => s.reasons) };
}

/** A result computed from several inputs: as strong as its weakest input. */
export function derived(inputs: Evidence[], note = "computed by this server's formula"): Confidence {
  if (inputs.length === 0) return { label: "low", score: 0, reasons: ["no inputs"] };
  const scored = inputs.map(scoreOne).sort((a, b) => a.score - b.score);
  const score = scored[0].score * 0.95;
  const reasons = [note, ...new Set(scored.flatMap((s) => s.reasons))];
  return { label: label(score), score: round(score), reasons };
}

export function single(e: Evidence): Confidence {
  const s = scoreOne(e);
  return { label: label(s.score), score: round(s.score), reasons: s.reasons };
}
