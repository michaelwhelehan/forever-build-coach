# Forever Route

An adaptive Horde questing route for WoW: Forever, planned in the game from ForeverDB.net's quest data.
It shows the next steps (accept, do, turn in, go to a zone), an arrow to the current step and a map pin.

It plans again whenever something changes: you level up (a dungeon run included), accept, finish or hand in a quest,
or change zone. Quests that went grey or give too little XP drop out of the route, along with the follow-ups they
unlock, and quests already in your log that aren't worth it any more show up as **Abandon** steps.

## Install
1. Download `ForeverRoute.zip` from the repository's **Forever Route (latest)** release
   (rebuilt daily with ForeverDB's latest data), or from the *Forever Route addon* workflow run.
2. Unzip it into `World of Warcraft/_forever_/Interface/AddOns/`, so you get `AddOns/ForeverRoute/ForeverRoute.toc`.
3. Restart the game or `/reload`.

## Use
- `/fr` or the map button by the minimap shows or hides the window and the arrow. Drag either to move it.
- The window has a card for the step you're on (with its objectives and progress from your quest log), your XP bar
  with how far the route takes you, and the next steps grouped by zone. The minus button shrinks it to the card.
- The arrow turns green when you're heading straight for the step, shows the distance and time to get there,
  and a tick when you've arrived.
- The cog, a right-click on the minimap button or `/fr options` opens the settings: XP threshold, levels above you,
  dungeon and group quests, steps shown, scale, opacity, lock, arrow, map pin, minimap button.
- Hover a step for details (quest level, XP, objectives from your log). Right-click a step, or press **Skip**,
  to leave a quest out (`/fr unskip` brings them all back).
- `/fr minxp 60`: leave out quests worth less than this % of their XP. ForeverDB's rule: 100% up to 5 levels
  below you, then 80, 60, 40, 20, 10%. 60 means quests up to 7 levels below you.
- `/fr above 3`: take quests up to this many levels above you.
- `/fr dungeons`, `/fr group`: include dungeon or group (elite) quests (off by default).
- `/fr arrow`, `/fr pin`: arrow and map pin on or off. TomTom is used too when it's installed.
- `/fr refresh`, `/fr reset`.

## How the route is made
For each step it looks at every action you could take: hand in a finished quest, do the objectives of one in your
log, or pick up a quest you can take and that's worth it at your level. It takes the quickest to reach (stops within
45 yards count as one), simulates the XP, and repeats for 40 steps.

Travel time counts walking, the flight paths you know, the zeppelins, boats and lifts, and your hearthstone when it's
ready (ForeverDB's travel data, with players' measured flight times). When the route needs a ride it adds a step for it:
"Fly to Tarren Mill", "Zeppelin to Durotar", "Hearth to Undercity". Open any flight master's map once so the addon
learns which flight paths you have; it learns where your hearthstone goes when you bind at an inn or use it.

When the nearest thing left is far away, for example quests in your log on another continent after a dungeon, it
compares that trip with every zone's worthwhile quests in XP per second, counting the travel. If a zone pays better,
the route goes there, and the far quests are parked until the route passes by (the plan line shows how many; the
minimap button's tooltip lists them). With no quests left for your level it says to grind or run a dungeon.

Where ForeverDB has no objective spot, giver or faction for a quest, the build fills it from QuestieDB's Forever data
(Questie's database, with spawns converted to Forever's maps and what Questie players recorded). Quests whose objectives
are all inside an instance count as dungeon quests. Limits: about 370 quests still have no objective spot, mostly level
51-60 crafted or raid items (those steps say "spot unknown" and point at the quest's ender); XP to level after your current one is Classic's table; walking is a straight line
with a detour allowance, not a path over the terrain. Quests that start from an item you loot aren't planned, but are followed once
they're in your log.

## Build it yourself
Needs Lua 5.1 and curl:

    scripts/fetch-foreverdb-data.sh .foreverdb-data
    git clone --depth 1 --filter=blob:none --sparse https://github.com/Questie/QuestieDB.git .questiedb
    git -C .questiedb sparse-checkout set data/Forever src/corrections/Forever src/corrections/enum
    lua5.1 scripts/build-forever-route.lua .foreverdb-data addon/ForeverRoute/Data.lua .questiedb
    lua5.1 test/forever-route/ingame.lua addon/ForeverRoute/Data.lua
    lua5.1 test/forever-route/simulate.lua addon/ForeverRoute/Data.lua 1 200

`Data.lua` isn't committed: it's generated from ForeverDB's files.

## Licence and credit
Data from [ForeverDB.net](https://foreverdb.net), including Classic data from CMaNGOS classic-db, and from
[QuestieDB](https://github.com/Questie/QuestieDB). That data is GPL-3.0
with a credit term, so this addon is GPL-3.0 too (the release zip has the licence text), and the window shows
"Data from ForeverDB.net". The rest of this repository stays MIT.
