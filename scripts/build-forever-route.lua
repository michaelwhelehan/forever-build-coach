-- Builds addon/ForeverRoute/Data.lua from ForeverDB.net's published addon data files.
-- Usage: lua5.1 scripts/build-forever-route.lua <folder with ForeverDB's Data/*.lua> <output Data.lua> [QuestieDB checkout]
-- The folder needs QuestClassic, QuestForever, QuestXP, Zones, RouteMaps and Travel (scripts/fetch-foreverdb-data.sh gets them).
-- ForeverDB's data is GPL-3.0 with a credit term (section 7(b)): "Data from ForeverDB.net". Data.lua carries it, and
-- is not committed: the Forever Route workflow builds it into the release zip.

local src, out, questieRoot = arg[1], arg[2], arg[3]
assert(src and out, "usage: lua5.1 build-forever-route.lua <data folder> <out file> [QuestieDB checkout]")
local here = (arg[0]:match("^(.*)[/\\]") or ".")
-- QuestieDB (GPL-3.0) fills what ForeverDB lacks: objective spots, givers, faction, Forever quests' objectives.
local qdb = questieRoot and dofile(here .. "/questiedb-read.lua")(questieRoot)
if qdb then for _, r in ipairs(qdb.report) do io.stderr:write("QuestieDB ", r, "\n") end end

local ns = {}
local function load(name)
  local chunk = assert(loadfile(src .. "/" .. name .. ".lua"))
  chunk("ForeverDB", ns)
end
for _, n in ipairs({ "QuestClassic", "QuestForever", "QuestXP", "Zones", "RouteMaps" }) do load(n) end
if io.open(src .. "/Travel.lua") then load("Travel") end

local function split(s, sep)
  local t = {}
  for p in (s .. sep):gmatch("(.-)" .. (sep == "|" and "%|" or sep)) do t[#t + 1] = p end
  return t
end
local function words(s)
  local t = {}
  for w in (s or ""):gmatch("%S+") do t[#t + 1] = w end
  return t
end

-- "ncbcbm" (base 36) = map*1e6 + round(x*10)*1000 + round(y*10)
local function spot(code)
  local n = tonumber(code, 36)
  if not n then return nil end
  local map = math.floor(n / 1e6)
  local r = n % 1e6
  return map, math.floor(r / 1000) / 10, (r % 1000) / 10
end
local function spots(s)
  local t = {}
  for _, w in ipairs(words(s)) do
    local m, x, y = spot(w)
    if m and m > 0 then t[#t + 1] = { m, x, y } end
  end
  return t
end

-- The busiest point of a set of spots: the spot on the commonest map with the most others within 4% of it.
local function centre(list)
  if #list == 0 then return nil end
  local byMap = {}
  for _, p in ipairs(list) do byMap[p[1]] = (byMap[p[1]] or 0) + 1 end
  local best, bestN = nil, -1
  for m, n in pairs(byMap) do if n > bestN or (n == bestN and m < best) then best, bestN = m, n end end
  local pts = {}
  for _, p in ipairs(list) do if p[1] == best then pts[#pts + 1] = p end end
  if #pts > 80 then -- thin big spawn lists evenly
    local thin, step = {}, #pts / 80
    for i = 1, 80 do thin[i] = pts[math.floor((i - 1) * step) + 1] end
    pts = thin
  end
  local bp, bn = pts[1], -1
  for _, a in ipairs(pts) do
    local n = 0
    for _, b in ipairs(pts) do
      local dx, dy = a[2] - b[2], a[3] - b[3]
      if dx * dx + dy * dy <= 16 then n = n + 1 end
    end
    if n > bn then bp, bn = a, n end
  end
  return bp
end

-- Quests with a stop the game doesn't count as an objective: it calls them complete while you still have to talk to
-- someone first. The stop becomes the quest's objective spot, and the addon waits until you've been there.
local VIA = {
  [6981] = 3442, -- The Glowing Shard: Sputtervalve in Ratchet, then Falla Sagewind
}

local npcNames = ns.qfNpcNames or {}
local function npcSpots(id)
  local t = {}
  if ns.qfNpcSpots and ns.qfNpcSpots[id] then t = spots(ns.qfNpcSpots[id]) end -- seen in Forever first
  if #t == 0 and ns.qcNpc and ns.qcNpc[id] then t = spots(ns.qcNpc[id]:match("|(.*)$") or "") end
  return t
end
local function objSpots(id)
  if ns.qcObj and ns.qcObj[id] then return spots(ns.qcObj[id]:match("|(.*)$") or "") end
  return {}
end
-- Where a quest's starter or ender ("n197", "o112877", "i2874"; several separated by spaces) stands.
local function whoSpots(field)
  local t = {}
  for _, w in ipairs(words(field)) do
    local kind, id = w:sub(1, 1), tonumber(w:sub(2))
    if id then
      local s = kind == "n" and npcSpots(id) or kind == "o" and objSpots(id) or {}
      for _, p in ipairs(s) do t[#t + 1] = p end
    end
  end
  return t
end
local function whoName(field)
  local w = words(field)[1]
  if not w then return "" end
  local kind, id = w:sub(1, 1), tonumber(w:sub(2))
  if kind == "n" then
    return npcNames[id] or (ns.qcNpc and ns.qcNpc[id] and ns.qcNpc[id]:match("^([^|]*)")) or ""
  elseif kind == "o" then
    return ns.qcObj and ns.qcObj[id] and ns.qcObj[id]:match("^([^|]*)") or ""
  end
  return ""
end

-- Objective spots from Classic objectives "c6:10;i723:8;o1234:3" and the effort (seconds) at that level's pace.
local function pace(level, kind)
  local p = ns.pace and (ns.pace[math.floor(level / 5)] or ns.pace[0]) or {}
  return p[kind] or (kind == "c" and 30 or 20)
end
local function classicObjectives(objs, level)
  local list, effort = {}, 0
  for _, o in ipairs(split(objs or "", ";")) do
    local kind, id, count = o:match("^(%a)(%d+):(%d+)")
    id, count = tonumber(id), tonumber(count)
    if kind == "c" then
      for _, p in ipairs(npcSpots(id)) do list[#list + 1] = p end
      effort = effort + count * pace(level, "c")
    elseif kind == "o" then
      for _, p in ipairs(objSpots(id)) do list[#list + 1] = p end
      effort = effort + count * pace(level, "o")
    elseif kind == "i" then
      local from = ns.qcItem and ns.qcItem[id]
      local chance = 0
      for _, w in ipairs(words(from)) do
        local k, sid, pct = w:match("^(%a)(%d+):([%d.]+)")
        sid, pct = tonumber(sid), tonumber(pct)
        if k == "n" then for _, p in ipairs(npcSpots(sid)) do list[#list + 1] = p end
        elseif k == "o" then for _, p in ipairs(objSpots(sid)) do list[#list + 1] = p end end
        if pct and pct > chance then chance = pct end
      end
      local drops = ns.qdrop and ns.qdrop[id]
      if drops then for _, pct in pairs(drops) do if pct > chance then chance = pct end end end
      local per = (chance > 0 and chance < 100) and math.min(pace(level, "c") * 100 / chance, 240) or pace(level, "i")
      effort = effort + count * per
    elseif kind == "a" then
      effort = effort + 30
    end
  end
  return list, effort
end
local function foreverEffort(q, level)
  local s, effort = ns.qobj and ns.qobj[q], 0
  if not s then return nil end
  for kind, count in s:gmatch("(%a):(%d+)") do
    effort = effort + tonumber(count) * pace(level, kind == "x" and "c" or kind)
  end
  return effort
end

-- Map names (RouteMaps.lua's line comments) and Horde-friendly zones.
local mapNames = {}
do
  local f = assert(io.open(src .. "/RouteMaps.lua"))
  for id, name in f:read("*a"):gmatch("ns%.routeMaps%[(%d+)%][^\n]*%-%-%s*([^\n]+)") do mapNames[tonumber(id)] = name:gsub("%s+$", "") end
  f:close()
end
local zones = {}
for map, s in pairs(ns.zoneData or {}) do
  local f = split(s, "|")
  local lo, hi = f[4]:match("(%d+)%-(%d+)")
  zones[map] = { side = f[2], lo = tonumber(lo) or 0, hi = tonumber(hi) or 0 }
end

local function hordeRaces(mask) -- Orc 2, Undead 16, Tauren 32, Troll 128
  for _, b in ipairs({ 2, 16, 32, 128 }) do if math.floor(mask / b) % 2 == 1 then return true end end
  return false
end
local qc, qf = ns.qcQuests or {}, ns.qfQuests or {}
local Qq = qdb and qdb.quests or {}
local ids = {}
for id in pairs(qc) do ids[id] = true end
for id in pairs(qf) do ids[id] = true end
-- QuestieDB's raw Forever data comes from the game's files, which hold quests that aren't in the live game (the Duskwood
-- Missions: their quest giver isn't there). Keep a quest from it only if ForeverDB knows it or players' traces or
-- Forever's own fixes mention it.
local filesOnly = 0
for id in pairs(Qq) do
  if qc[id] or qf[id] or (qdb and qdb.seen and qdb.seen[id]) then ids[id] = true else filesOnly = filesOnly + 1 end
end
io.stderr:write("left out ", filesOnly, " quests that are only in the game's files (not seen on Forever)\n")

-- QuestieDB helpers: spawns as {uiMap, x, y}.
local unmapped = false -- set when a spawn is only inside an instance or another map we can't place
local function qSpawns(kind, id)
  local t = {}
  if not qdb or not id then return t end
  local row = kind == "npc" and qdb.npcs[id] or kind == "object" and qdb.objects[id]
  local sp = row and row[kind == "npc" and 7 or 4]
  for zone, list in pairs(sp or {}) do
    local map = qdb.areaToMap[zone]
    if map then for _, p in ipairs(list) do if p[1] and p[1] >= 0 then t[#t + 1] = { map, p[1], p[2] } end end
    elseif #list > 0 then unmapped = true end
  end
  return t
end
local function addAll(t, list) for _, p in ipairs(list) do t[#t + 1] = p end return t end
local function qWho(field) -- startedBy / finishedBy: { {npcs}, {objects}, {items} }
  local t = {}
  for _, id in ipairs(field and field[1] or {}) do addAll(t, qSpawns("npc", id)) end
  for _, id in ipairs(field and field[2] or {}) do addAll(t, qSpawns("object", id)) end
  return t
end
local function qWhoName(field)
  local n = field and field[1] and field[1][1]
  if n and qdb.npcs[n] then return qdb.npcs[n][1] or "" end
  local o = field and field[2] and field[2][1]
  if o and qdb.objects[o] then return qdb.objects[o][1] or "" end
  return ""
end
-- Objective spots and a rough effort (seconds) from QuestieDB's objectives.
local function qObjectives(row, level)
  local t, effort = {}, 0
  local o = row and row[10]
  if o then
    for _, c in ipairs(o[1] or {}) do addAll(t, qSpawns("npc", c[1])); effort = effort + 8 * pace(level, "c") end
    for _, c in ipairs(o[2] or {}) do addAll(t, qSpawns("object", c[1])); effort = effort + 5 * pace(level, "o") end
    for _, c in ipairs(o[3] or {}) do
      local item = qdb.items[c[1]]
      if item then
        for _, n in ipairs(item[2] or {}) do addAll(t, qSpawns("npc", n)) end
        for _, n in ipairs(item[3] or {}) do addAll(t, qSpawns("object", n)) end
      end
      effort = effort + 8 * pace(level, "c")
    end
    for _, k in ipairs(o[5] or {}) do
      for _, n in ipairs(k[1] or {}) do addAll(t, qSpawns("npc", n)) end
      effort = effort + 8 * pace(level, "c")
    end
  end
  local trig = row and row[9]
  if trig and type(trig[2]) == "table" then
    for zone, list in pairs(trig[2]) do
      local map = qdb.areaToMap[zone]
      if map then for _, p in ipairs(list) do t[#t + 1] = { map, p[1], p[2] } end end
    end
    effort = effort + 20
  end
  return t, effort
end
local ALLIANCE_RACES = { 1, 4, 8, 64 }
local function questieSide(mask)
  if not mask or mask == 0 then return "" end
  local h, a = hordeRaces(mask), false
  for _, b in ipairs(ALLIANCE_RACES) do if math.floor(mask / b) % 2 == 1 then a = true end end
  if h and not a then return "h" elseif a and not h then return "a" end
  return ""
end
local function list(t) local o = {} for _, v in ipairs(t or {}) do o[#o + 1] = tostring(v) end return table.concat(o, " ") end

local rows, kept, skipped, withObj, noObj, objSource = {}, 0, {}, 0, 0, 0
local movedFromEnder = 0
local function skip(why) skipped[why] = (skipped[why] or 0) + 1 end
local function clean(s) return ((s or ""):gsub("[|\n\r]", " "):gsub("\\", "/"):gsub('"', "''")) end
local function num(s) return tonumber(s) or 0 end

local sorted = {}
for id in pairs(ids) do sorted[#sorted + 1] = id end
table.sort(sorted)

for _, id in ipairs(sorted) do
  local c = qc[id] and split(qc[id], "|")
  local f = qf[id] and split(qf[id], "|")
  local Q = Qq[id]
  local title = (f and f[1] ~= "" and f[1]) or (c and c[1]) or (Q and Q[1]) or ""
  local level = (f and num(f[2]) > 0 and num(f[2])) or (c and num(c[2]) > 0 and num(c[2])) or (Q and num(Q[5])) or 0
  local minLv = (f and num(f[3]) > 0 and num(f[3])) or (c and num(c[3]) > 0 and num(c[3])) or (Q and num(Q[4])) or 0
  local side = (c and c[4] ~= "" and c[4]) or (f and f[11] ~= "" and f[11]) or (Q and questieSide(Q[6])) or ""
  local races = (c and num(c[6]) > 0 and num(c[6])) or (Q and num(Q[6])) or 0
  local classes = (c and num(c[5]) > 0 and num(c[5])) or (Q and num(Q[7])) or 0
  local flags = c and c[14] or ""
  if Q and Q[24] and Q[24] % 2 == 1 and not flags:find("p") then flags = flags .. "p" end
  local exclTo = Q and list(Q[16]) or ""
  -- A profession it needs ("182:1" = Herbalism 1): the game only offers it if you have it.
  local skill = (c and c[13] ~= "" and c[13]) or ""
  if skill == "" and Q and type(Q[18]) == "table" and Q[18][1] then skill = Q[18][1] .. ":" .. (Q[18][2] or 1) end
  local starts = (f and f[5] ~= "" and f[5]) or (c and c[10]) or ""
  local ends = (f and f[6] ~= "" and f[6]) or (c and c[11]) or ""
  local pre = (c and c[7]) or (Q and list(Q[12])) or ""
  if pre == "" and not c and Q then pre = list(Q[12]) end
  if f and num(f[9]) > 0 and not (" " .. pre .. " "):find(" " .. f[9] .. " ", 1, true) then pre = (pre .. " " .. f[9]):gsub("^ ", "") end
  local preAny = (c and c[8]) or (Q and list(Q[13])) or ""
  local excl = c and num(c[9]) or 0

  local poi, seen = ns.qfPoi and ns.qfPoi[id], ns.qfSeen and ns.qfSeen[id]
  local s = (poi and poi.s and spots(poi.s)) or (seen and seen.s and spots(seen.s)) or whoSpots(starts)
  if #s == 0 then s = whoSpots(starts) end
  local e = (poi and poi.e and spots(poi.e)) or (seen and seen.e and spots(seen.e)) or whoSpots(ends)
  if #e == 0 then e = whoSpots(ends) end
  if #s == 0 and Q then s = qWho(Q[2]) end
  if #e == 0 and Q then e = qWho(Q[3]) end
  local sp, ep = centre(s), centre(e)
  local giver, ender = whoName(starts), whoName(ends)
  if giver == "" and Q then giver = qWhoName(Q[2]) end
  if ender == "" and Q then ender = qWhoName(Q[3]) end
  if starts == "" and Q and Q[2] and Q[2][3] and Q[2][3][1] then starts = "i" .. Q[2][3][1] end

  local olist, effort = {}, nil
  local groups = {} -- spots per objective, to find where the work is
  -- (not ipairs: poi is often nil, which would end the loop before players' sightings)
  for _, src2 in pairs({ poi or false, seen or false }) do
    if src2 and src2.o and #olist == 0 then
      for _, v in pairs(src2.o) do
        local g = spots(v)
        for _, p in ipairs(g) do olist[#olist + 1] = p end
        if #g > 0 then groups[#groups + 1] = g end
      end
    end
  end
  local cl, ce = classicObjectives(c and c[12], level)
  if #olist == 0 then olist = cl end
  if c and c[12] ~= "" then effort = ce else effort = foreverEffort(id, level) or ce end
  if Q then
    unmapped = false
    local ql, qe = qObjectives(Q, level)
    if #olist == 0 then olist = ql; if #ql > 0 then objSource = (objSource or 0) + 1 end end
    if (not effort or effort == 0) and not (c and c[12] ~= "") and not foreverEffort(id, level) then effort = qe end
    local o = Q[10]
    local noObjectives = (not o or next(o) == nil) and not Q[9]
    if #olist == 0 and noObjectives then
      effort = 0 -- a talk or delivery quest: QuestieDB lists nothing to do but hand it in (the item comes with the quest)
    elseif #olist == 0 and unmapped and not flags:find("[dr]") then
      flags = flags .. "d" -- everything it needs is inside an instance
    end
  end
  local op = centre(olist)
  -- Objectives that are partly "pick this up from the quest giver" (a crate, a manual) would put the spot next to the
  -- ender, and the route would think you're done on arrival. Use the busiest objective away from the ender instead.
  local function near(a, b) return a and b and a[1] == b[1] and (a[2] - b[2]) ^ 2 + (a[3] - b[3]) ^ 2 <= 25 end
  if op and ep and near(op, ep) and #groups > 1 then
    local best, bestN
    for _, g in ipairs(groups) do
      local c = centre(g)
      if c and not near(c, ep) and (not bestN or #g > bestN) then best, bestN = c, #g end
    end
    if best then op = best; movedFromEnder = (movedFromEnder or 0) + 1 end
  end
  -- A dungeon quest whose only spot is at the quest giver (Blueleaf Tubers: the crate is in Ratchet, the tubers in
  -- Razorfen Kraul): the data doesn't know where the work is, so say so rather than point at the giver.
  if op and ep and near(op, ep) and (flags:find("d") or (c and (c[14] or ""):find("d"))) then op = nil; movedFromEnder = movedFromEnder + 1 end
  local via = ""
  if VIA[id] then
    local vp = centre(npcSpots(VIA[id]))
    if vp then op, via, flags = vp, npcNames[VIA[id]] or whoName("n" .. VIA[id]), flags .. "v"; effort = math.max(effort or 0, 20) end
  end

  local xp = ns.qxp and ns.qxp.q and ns.qxp.q[id]
  if not xp and level > 0 and ns.qxp and ns.qxp.curve then
    xp = ns.qxp.curve[math.min(level, 60)] or 0
    if flags:find("[dr]") then xp = math.floor(xp * (ns.qxp.dmul or 1)) end
  end

  local startKind = words(starts)[1] and words(starts)[1]:sub(1, 1) or ""
  local smap = sp and sp[1] or 0
  local zone = zones[smap]
  if side == "a" then skip("alliance")
  elseif races > 0 and races % 256 ~= 0 and not hordeRaces(races) then skip("races not horde")
  -- No faction anywhere: QuestieDB listing it for every race means it's neutral; otherwise only trust Horde zones.
  elseif side == "" and races == 0 and not Q and (not zone or zone.side ~= "H") then skip("unknown side")
  elseif side == "" and races == 0 and Q and zone and zone.side == "A" then skip("neutral quest in an Alliance zone")
  elseif ns.qcGone and ns.qcGone[id] then skip("not offered in Forever")
  elseif flags:find("p") then skip("repeatable")
  elseif level <= 0 then skip("no level")
  elseif not sp and startKind ~= "i" then skip("no start location")
  elseif not ep then skip("no end location")
  else
    kept = kept + 1
    local function xy(p) return p and string.format("%d|%.1f|%.1f", p[1], p[2], p[3]) or "0|0|0" end
    rows[#rows + 1] = string.format('[%d]="%s|%d|%d|%.0f|%.0f|%s|%s|%d|%s|%s|%s|%d|%d|%s|%s|%s|%s|%s|%s|%s"', id,
      clean(title), level, minLv, classes, races, pre, preAny, excl,
      xy(sp), xy(ep), xy(op), xp or 0, math.floor((effort or 0) + 0.5), flags, startKind,
      clean(giver), clean(ender), exclTo, clean(via), skill)
    if op then withObj = withObj + 1 elseif (effort or 0) > 0 and not flags:find("[dr]") then noObj = noObj + 1 end
  end
end

local mapRows = {}
for id, m in pairs(ns.routeMaps or {}) do
  local z = zones[id]
  mapRows[#mapRows + 1] = string.format('[%d]={%d,%.2f,%.2f,%.2f,%.2f,"%s","%s",%d,%d}', id, m.c or -1, m.t, m.l, m.h, m.w,
    clean(mapNames[id] or ""), z and z.side or "", z and z.lo or 0, z and z.hi or 0)
end
table.sort(mapRows)

local paceRows = {}
for band, p in pairs(ns.pace or {}) do
  paceRows[#paceRows + 1] = string.format("[%d]={c=%s,i=%s,o=%s,r=%s}", band, p.c or 30, p.i or 20, p.o or 20, p.r or 7)
end
table.sort(paceRows)

-- Travel: Horde and neutral flight masters, flight times (players' measured times when there are some, otherwise the
-- path length at flying speed), and the zeppelins, boats and lifts Horde can use.
local travelOut = ""
local td = ns.travelData
if td then
  local nodeRows, flightRows, linkRows, keep = {}, {}, {}, {}
  for id, n in pairs(td.nodes or {}) do
    if n[7] == "h" or n[7] == "n" then
      keep[id] = true
      nodeRows[#nodeRows + 1] = string.format('[%d]={%d,%d,%d,%d,%.1f,%.1f,"%s"}', id, n[1], n[2], n[3], n[4] or 0, n[5] or 0, n[6] or 0, clean(n[9] or ""))
    end
  end
  table.sort(nodeRows)
  local measured = {}
  for a, b, sec, n in (td.measured or ""):gmatch("(%d+)>(%d+)>(%d+)>(%d+)") do measured[a .. ">" .. b] = tonumber(sec) end
  local fly = (td.speeds and td.speeds.fly) or 32
  for a, b, yd in (td.flights or ""):gmatch("(%d+)>(%d+)>(%d+)>%d+") do
    if keep[tonumber(a)] and keep[tonumber(b)] then
      flightRows[#flightRows + 1] = a .. ">" .. b .. ">" .. (measured[a .. ">" .. b] or math.floor(tonumber(yd) / fly + 0.5))
    end
  end
  for _, l in ipairs(ns.routeLinks or {}) do
    if l.side == "" or l.side == "H" then
      linkRows[#linkRows + 1] = string.format('{%d,%d,%d,%d,%d,%d,%d,"%s","%s"}', l.a.c, l.a.x, l.a.y, l.b.c, l.b.x, l.b.y,
        math.floor((l.wait or 0) / 2 + (l.ride or 0) + 0.5), l.kind, clean(l.name))
    end
  end
  travelOut = "travel = {\nnodes = {" .. table.concat(nodeRows, ",") .. "},\nflights = \"" .. table.concat(flightRows, " ")
    .. "\",\nlinks = {" .. table.concat(linkRows, ",\n") .. "},\n},\n"
  io.stderr:write(string.format("travel: %d flight masters, %d flights, %d transports\n", #nodeRows, #flightRows, #linkRows))
end

local fh = assert(io.open(out, "w"))
fh:write("-- Data from ForeverDB.net (https://foreverdb.net), built ", os.date("!%Y-%m-%d"), " from ForeverDB's addon data.\n")
fh:write("-- GPL-3.0 (CMaNGOS classic-db and ForeverDB). Reuse requires this credit: \"Data from ForeverDB.net\". Do not edit:\n")
if qdb then fh:write("-- Gaps filled from QuestieDB (https://github.com/Questie/QuestieDB, GPL-3.0).\n") end
fh:write("-- scripts/build-forever-route.lua makes it.\n")
fh:write("-- q[quest] = \"title|level|min level|classes mask|races mask|needs all|needs one of|exclusive group|start map|x|y|\n")
fh:write("--   end map|x|y|objective map|x|y|xp|effort seconds|flags (g group, d dungeon, r raid)|start kind (n/o/i)|giver|ender|\n")
fh:write("--   quests you can't take once you've done one of these|who to talk to on the way (flag v)|profession:skill it needs\"\n")
fh:write("-- maps[uiMap] = {continent, world X at top, world Y at left, height, width (yards), name, side, lo, hi}\n")
fh:write("local _, ns = ...\n")
fh:write(string.format('ns.data = { built = "%s", quests = %d,\n', os.date("!%Y-%m-%d"), kept))
fh:write("q = {\n", table.concat(rows, ",\n"), "\n},\n")
fh:write("maps = {\n", table.concat(mapRows, ",\n"), "\n},\n")
fh:write("pace = {", table.concat(paceRows, ","), "},\n")
fh:write(travelOut)
fh:write("}\n")
fh:close()

io.stderr:write(string.format("objective spot moved off the quest ender (or dropped, for dungeon quests) for %d quests\n", movedFromEnder or 0))
io.stderr:write(string.format("Forever Route data: %d quests kept, %d with an objective spot, %d with objectives but no spot (%d spots from QuestieDB)\n", kept, withObj, noObj, objSource))
for why, n in pairs(skipped) do io.stderr:write(string.format("  skipped %d: %s\n", n, why)) end
