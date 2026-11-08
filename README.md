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
| `character_lookup` | Read a character's level, specs and equipped gear | Blizzard key |
| `talent_tree` | A class's Forever talent trees and starter builds | |
| `talent_points_by_level` | Points available at a level (with the Legacy "Talented" perk) | |
| `class_races` | Which races can be a class, with racials | |
| `patch_changes` | Recent buffs, nerfs, hotfixes and blue posts | ForeverDB key for buffs/nerfs |
| `xp_calculator` | XP to level, XP per kill, kills to level, rested pool, quest penalties | |
| `levelling_plan` | Compare questing, grinding and dungeons by XP/hour and gold/hour | |
| `market_price` | Auction prices on your ruleset, and what you'd net | |
| `farm_value` | Gold per hour from a farm | |
| `profession_cost` | Cheapest known path to level a profession, with total cost | |
| `confidence_score` | Score a claim with the shared rules | |
| `everloot`, `foreverdb` | Call any other endpoint of those sources | |

There is also a prompt, **Review my build** (`optimize_build`), that walks through all of it.

## Connect your Claude

Ask whoever hosts the server for the URL. It looks like `https://<host>/mcp/<access-token>`.

- **Claude.ai / desktop / mobile:** Settings → Connectors → Add custom connector → paste the URL.
- **Claude Code:** `claude mcp add --transport http forever https://<host>/mcp/<access-token>`

Then just ask, for example: *"I'm a level 24 fury warrior, Thrall Stormborn on EU. What should I upgrade
first?"* or *"Is grinding or questing faster for me from 30 to 32?"*

## Host it

It is a small stateless Node server, so the free tiers of most hosts are enough.

**Render (easiest):** New → Blueprint → pick this repo. `render.yaml` sets it up and generates an
`ACCESS_TOKEN`. Add the optional keys in the dashboard.

**Fly.io:** `fly launch --copy-config --no-deploy`, then `fly secrets set ACCESS_TOKEN=$(openssl rand -hex 16)`,
then `fly deploy`.

**Anywhere with Docker:** `docker build -t forever-coach . && docker run -p 3000:3000 -e ACCESS_TOKEN=... forever-coach`

**Locally:** `npm install && npm run build && ACCESS_TOKEN=... npm start`

### Settings

| Variable | Why |
|---|---|
| `ACCESS_TOKEN` | Shared secret in the connector URL. Without it anyone with the URL can use your server. |
| `FOREVERDB_API_KEY` | Full item stats, class abilities, recipes, buffs and nerfs. Request at https://foreverdb.net/developers (log in with Battle.net). |
| `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` | Read characters' equipped gear. Free at https://develop.battle.net/access/clients. |
| `EVERLOOT_HOURLY_BUDGET` | Default 180. Everloot allows 200 calls an hour per IP, shared by everyone on this server. Answers are cached (talent trees 12 h, items 2 h, prices 30 min). |

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
npm test          # unit tests + an end-to-end test against fake Everloot and ForeverDB servers
npm run dev       # watch mode on :3000
```
