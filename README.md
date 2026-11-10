# Forever Build Coach

An MCP server you and your friends connect your Claudes to, for optimising **World of Warcraft: Forever**
characters while levelling: which gear is an upgrade, where talent points go, the fastest way to the next
level, which profession to take and what it costs, and how to make gold.

Every answer cites its sources and carries a confidence label, because Forever is new and a lot of what
people "know" is really Classic 1.12 carried over.

```
 ┌────────────── kb/ (this repo) ──────────────┐
 │ rules.md · sources.yaml · formulas/*.yaml   │
 └──────────────────────┬──────────────────────┘
        ┌───────────────┼────────────────┬──────────────────┐
   Everloot MCP     ForeverDB API    Blizzard API      Our formulas
   (public, no key) (key, optional)  (key, optional)   stat score, XP, gold,
   drops, talents,  full item stats, your character's  profession cost,
   prices, paths    abilities, nerfs equipped gear     confidence
        └───────────────┴────────────────┴──────────────────┘
                                 │
              Claude answer: lookups + maths + sources + confidence
```

## Tools

| Tool | What it does | Needs |
|---|---|---|
| `kb_guide` | Evidence rules, source register, formulas, server status | |
| `search_game` | Find items, quests, NPCs, zones, spells by name | |
| `item_lookup` | One item's stats and drops, merged from all sources | |
| `compare_items` | Rank gear for your class and spec with stat weights, showing the maths | |
| `find_items` | Every Forever item by slot, type, level and quality, ranked for your class and spec, with the gain over what you wear | |
| `gear_upgrades` | Upgrades for every slot from the in-game addon's export line (or a list of item ids), biggest gain first, with ForeverDB links | |
| `levelling_guide` | Answers "what next?" and "which talent next?" from Icy Veins' Forever levelling guide for your class and spec | |
| `profession_guide` | What to craft next to level a profession, with reagents and a shopping list, from ForeverDB's route | |
| `gold_guide` | ForeverDB's money guides: the auction house, what sells at low levels, best professions by class | |
| `character_lookup` | Read a character's level, specs and equipped gear from the armory | |
| `talent_tree` | A class's Forever talent trees and starter builds | |
| `talent_points_by_level` | Points available at a level (with the Legacy "Talented" perk) | |
| `class_races` | Which races can be a class, with racials | |
| `patch_changes` | Recent buffs, nerfs, hotfixes and blue posts | ForeverDB key for buffs/nerfs |
| `xp_calculator` | XP to level, XP per kill, kills to level, rested pool, quest penalties | |
| `levelling_plan` | Compare questing, grinding and dungeons by XP/hour and gold/hour | |
| `market_price` | Live auction prices (Blizzard API, read hourly) for your faction's house, and what you'd net | Battle.net key |
| `auction_houses` | Every Forever auction house, its faction and group, and one item's price across all of them | Battle.net key |
| `gold_opportunities` | Money makers found on your house a few times a day: dips under the 7-day average, price spikes, greens worth disenchanting, ranked by Claude Haiku under a daily spending cap | Battle.net key, D1, optional Anthropic key |
| `farm_value` | Gold per hour from a farm | |
| `profession_cost` | Cheapest known path to level a profession, with total cost | |
| `confidence_score` | Score a claim with the shared rules | |
| `everloot`, `foreverdb` | Call any other endpoint of those sources | |

Every item in an answer carries a `url` to its ForeverDB page, so Claude can give clickable links.

There is also a prompt, **Review my build** (`optimize_build`), that walks through all of it.

## In-game addon

WoW addons can't go online, so the addon in [`addon/`](addon/) shows your class, level and equipped
items as one line. Copy it into Claude and ask for upgrades; it skips the armory and is always current.

1. Copy `addon/ForeverBuildCoach` into your game's `Interface/AddOns/` folder and `/reload`.
2. Type `/fbc`, press Ctrl+C, and paste the line to Claude: *"Find upgrades for this gear, I'm frost."*

## Connect your Claude

Ask whoever hosts the server for the URL. It looks like `https://<host>/mcp/<access-token>`.

- **Claude.ai / desktop / mobile:** Settings → Connectors → Add custom connector → paste the URL.
- **Claude Code:** `claude mcp add --transport http forever https://<host>/mcp/<access-token>`

Then just ask, for example: *"I'm a level 24 fury warrior, Thrall Stormborn on EU. What should I upgrade
first?"* or *"Is grinding or questing faster for me from 30 to 32?"*

## Host it on Cloudflare Workers

It is a small stateless Worker, so the free plan is plenty for a group of friends.

**Option A: deploy from GitHub (no command line).**
1. In the Cloudflare dashboard go to Workers & Pages → Create → Import a repository, and pick this repo.
   Leave the build settings as they are (it runs `npx wrangler deploy`, which bundles `kb/` first).
2. In the Worker's Settings → Variables and Secrets, add `ACCESS_TOKEN` as a secret (any long random string).
   Add the optional keys below if you have them.
3. Every merge to `main` now redeploys automatically.

**Option B: from your computer.**
```
npm install
npx wrangler login
npx wrangler secret put ACCESS_TOKEN
npm run deploy
```

**Recommended: a shared cache.** Run `npx wrangler kv namespace create CACHE`, paste the id into the
commented block in `wrangler.toml`, and redeploy. Without it each Worker instance caches on its own,
so Everloot gets asked the same thing more often.

Your connector URL is then `https://forever-build-coach.<your-subdomain>.workers.dev/mcp/<ACCESS_TOKEN>`.
Check `https://…workers.dev/health` to see which data sources are switched on.

### Settings (Worker secrets)

| Name | Why |
|---|---|
| `ACCESS_TOKEN` | Shared secret in the connector URL. Without it anyone with the URL can use your server. |
| `FOREVERDB_API_KEY` | Class abilities, recipes, buffs and nerfs. Request at https://foreverdb.net/developers (log in with Battle.net). Without it, item names and stats are read from ForeverDB's public item pages. |
| `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` | Read characters' equipped gear. Free at https://develop.battle.net/access/clients. Without them, character lookups read the public armory page instead, opened with Cloudflare Browser Rendering (the `BROWSER` binding in `wrangler.toml`). |
| `EVERLOOT_HOURLY_BUDGET` | Optional, default 180 per Worker instance. Everloot allows 200 calls an hour per IP. Answers are cached (talent trees 12 h, items 2 h, prices 30 min). |

## The knowledge base

`kb/` is the shared brain, and the bit worth improving together:

- `kb/rules.md`: how answers cite and flag uncertainty.
- `kb/sources.yaml`: every source, its limits, licence and trust tier.
- `kb/formulas/stat-weights.yaml`: levelling stat weights per spec. **These are Classic-derived starting
  points.** If your testing says otherwise, change them in a pull request.
- `kb/formulas/xp.yaml`: XP table (from a Forever guide), rested rules and the Classic mob XP formula.
- `kb/formulas/README.md`: how confidence, item scores, XP and gold are worked out.

## Data and credit

- Game data from [Everloot](https://everloot.app) is CC BY-SA 4.0. This project is not affiliated with Everloot.
- Data from [ForeverDB.net](https://foreverdb.net) must be credited when shown.
- World of Warcraft and Blizzard data belong to Blizzard Entertainment. This is a fan project.

## Develop

```
npm install
npm test          # unit tests + an end-to-end test of the Worker against fake Everloot and ForeverDB
npm run dev       # local Worker on :8787 (copy .dev.vars.example to .dev.vars first)
npm run check     # what CI runs: typecheck, tests, Wrangler dry-run build
```

## Gold finder (optional)

Every few hours the cron saves your auction house's prices to a D1 database, picks candidates with
simple maths (items under 60% of their 7-day average, prices over 140% of it, greens worth more as
enchanting materials) and asks Claude Haiku to rank the best ten. `gold_opportunities` returns the
latest list. Without an Anthropic key you still get the maths-only list.

1. `npx wrangler d1 create forever-build-coach`, then uncomment the `[[d1_databases]]` block in
   `wrangler.toml` and paste the id.
2. In the Worker's settings, add the variable `GOLD_HOUSE_IDS` (your house id from `auction_houses`, e.g. `113`).
3. Optional: `npx wrangler secret put ANTHROPIC_API_KEY` for the AI review.

Other settings: `GOLD_DAILY_BUDGET_USD` (default 0.20, the most the AI may spend per UTC day; spend is
tracked from each answer's token usage), `GOLD_EVERY_HOURS` (default 4), `GOLD_PLAYER` (a line
about your character for the AI), `GOLD_NOTEWORTHY_COPPER` (default 5000: profit a find needs before
it's flagged noteworthy). One house stays well inside D1's free limits; two is the most allowed.
