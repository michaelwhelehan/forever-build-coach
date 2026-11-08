# Evidence rules

These rules apply to every answer the server helps produce. The `kb_guide` tool returns this file, and
the server's instructions tell connected Claudes to follow it.

## 1. Cite every fact

Every number or claim about the game names where it came from: a tool result (Everloot, ForeverDB,
Blizzard API), a page in this knowledge base, or "user said". Tool results already carry a `sources`
list with URLs. Pass those through.

## 2. Say how sure you are

Each tool result carries a `confidence` block (`high`, `medium` or `low`, with a 0 to 1 score and the
reasons). Answers repeat the label for anything a decision depends on. The scoring is in
`formulas/confidence.md`.

- **high**: confirmed in play (3+ players agree), or an official Blizzard post or patch note.
- **medium**: read from the Forever game files but not yet confirmed in play, or a single trusted guide.
- **low**: a Classic 1.12 number assumed to carry over, a community guess, or thin data.

## 3. Forever is not Classic

WoW: Forever rebalanced talents, professions, dungeons and XP. A Classic 1.12 number (from memory,
old guides or the 2023 wiki) is a **baseline**, never a fact about Forever, until a Forever source agrees.
Say so when you use one.

## 4. Missing is not zero

"No data" from a source means nobody has reported it yet. Never present it as a measured zero (no drop,
no price, no XP).

## 5. Show the maths

When a recommendation rests on a formula (stat score, XP per hour, gold per hour, profession cost),
show the inputs and the formula name so a friend can check it. Weights and formulas live in
`kb/formulas/` and anyone can change them with a pull request.

## 6. Credit the data

- Everloot data is CC BY-SA 4.0: credit "Data from Everloot (https://everloot.app)".
- ForeverDB data must show "Data from ForeverDB.net" with a link to https://foreverdb.net.
- Blizzard game data belongs to Blizzard Entertainment.
