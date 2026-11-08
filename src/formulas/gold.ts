/** Auction house cut on a sale (Classic baseline). */
export const AH_CUT = 0.05;

export function netAfterCut(copper: number): number {
  return Math.floor(copper * (1 - AH_CUT));
}

/** 123456 copper -> "12g 34s 56c" */
export function formatCopper(copper: number | null | undefined): string {
  if (copper === null || copper === undefined || !Number.isFinite(copper)) return "unknown";
  const neg = copper < 0;
  let c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000); c -= g * 10000;
  const s = Math.floor(c / 100); c -= s * 100;
  const parts = [g ? `${g}g` : "", s ? `${s}s` : "", c || (!g && !s) ? `${c}c` : ""].filter(Boolean);
  return (neg ? "-" : "") + parts.join(" ");
}
