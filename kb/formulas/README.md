# Formulas

The server's own maths. Numbers live in the YAML files so anyone can change them without touching code.

## Confidence score (`src/formulas/confidence.ts`)

Each piece of evidence gets a base score from its tier:

| Tier | Base | Meaning |
|---|---|---|
| `official` | 0.95 | Blizzard post, patch note, or live Blizzard API data |
| `player_observed` | 0.65 + 0.05 per agreeing install above 3, up to 0.90 | Everloot fact confirmed by 3+ installs |
| `game_files` | 0.70 | Read from the Forever client, not yet confirmed in play |
| `user_provided` | 0.70 | The player typed it in |
| `community_guide` | 0.55 | One community guide |
| `classic_baseline` | 0.35 | Classic 1.12 number assumed to carry over |

Then:
- Data older than 30 days loses 10%. Older than 90 days loses 25%.
- Data marked `thin` (few reporters) loses 15%.
- When several sources **agree**, the score is the best one plus 0.05 per extra agreeing source (max 0.98).
- A **derived** result (our formula) takes the lowest input score times 0.95, because a chain is only as
  strong as its weakest link.

Labels: 0.80 and up is **high**, 0.60 to 0.79 is **medium**, below 0.60 is **low**.

## Item score (`compare_items`)

`score = Σ stat × weight` with weights from `stat-weights.yaml` for the class and spec (or ones you pass).
Stats are normalised first (for example "Strength", "STRENGTH" and "str" are the same). Weapon DPS only
counts for main-hand and two-hand weapons, and ranged weapons for hunters.

## XP (`xp_calculator`, `levelling_plan`)

From `xp.yaml`:
- Same-level mob: `level × 5 + 45`. Higher mob: +5% per level (up to 4). Lower mob:
  `× (1 − diff ÷ zero_difference)`, zero once grey. Elites × 2. **Classic baseline, low confidence.**
- Rested doubles kill XP until the pool is spent. Pool grows 5% of a level per 8 hours resting, capped at
  150% of a level (plus Well Rested ranks).
- Quests 6+ levels below you lose XP (80%, 60%, 40%, 20%, then 10%).
- XP per hour = total XP of an activity ÷ minutes × 60. Time to level = XP needed ÷ XP per hour.

## Gold (`market_price`, `farm_value`, `profession_cost`)

- Selling on the auction house: `net = price × (1 − 0.05)` (the 5% house cut, Classic baseline).
  The deposit is ignored unless you say the item often fails to sell.
- Gold per hour = Σ (items per hour × net price). Items with no recorded price count as unknown,
  never zero, and lower the confidence.
- Profession cost = Σ reagent count × price, taken from Everloot's agreed path, with our own pricing
  filled in from market data where the path has a gap.
