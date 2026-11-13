-- Forever Route planner: turns ForeverDB's quest data and your character's state into the next steps of a route.
-- Pure Lua (no game API), so it runs in the tests too. Core.lua gathers the state and calls ns.Plan.

local _, ns = ...

local floor, sqrt, huge = math.floor, math.sqrt, math.huge

-- Classic's XP to the next level (1..59). WoW Forever may differ: the game's own number is used for your current level.
local XP_TO_LEVEL = {
  400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600, 8800, 10100, 11400, 12900, 14400, 16000, 17700, 19400, 21300,
  23200, 25200, 27300, 29400, 31700, 34000, 36400, 38900, 41400, 44300, 47400, 50800, 54500, 58600, 62800, 67100, 71600,
  76100, 80800, 85700, 90700, 95800, 101000, 106300, 111800, 117500, 123200, 129100, 135100, 141200, 147500, 153900,
  160400, 167100, 173900, 180800, 187900, 195000, 202300, 209800,
}
ns.XP_TO_LEVEL = XP_TO_LEVEL
local MAX_LEVEL = 60
local LOG_SIZE = 20
local HUB_YARDS = 45 -- stops this close together count as one place
local NEAR_YARDS = 1600 -- quests to pick up without counting a zone change
local LOCAL_SECONDS = 150 -- closer than this (travel time) counts as where you are
local ZONE_SWITCH = 1.15 -- another zone has to be this much better per second to leave
local HEARTH_COOLDOWN = 3600

-- ForeverDB's quest XP reduction for a quest d levels below you: d<=5 100%, 6 80%, 7 60%, 8 40%, 9 20%, 10+ 10%.
local function xpRatio(playerLevel, questLevel)
  local d = playerLevel - questLevel
  if d <= 5 then return 1 end
  if d >= 10 then return 0.1 end
  return 1 - (d - 5) * 0.2
end
ns.xpRatio = xpRatio

-- Classic's grey level: quests this many levels or more below you are grey.
function ns.greyBelow(level)
  if level <= 5 then return level end
  if level <= 39 then return level - floor(level / 10) - 5 end
  return level - floor(level / 5) - 1
end

local function words(s)
  local t = {}
  for w in (s or ""):gmatch("%d+") do t[#t + 1] = tonumber(w) end
  return t
end

-- Parse Data.lua's quest strings once.
function ns.LoadQuests()
  if ns.Q then return ns.Q end
  local Q, excl = {}, {}
  for id, s in pairs(ns.data and ns.data.q or {}) do
    local f, i = {}, 0
    for p in (s .. "|"):gmatch("(.-)|") do i = i + 1; f[i] = p end
    local q = {
      id = id, title = f[1], lv = tonumber(f[2]), min = tonumber(f[3]), cls = tonumber(f[4]), races = tonumber(f[5]),
      pre = words(f[6]), any = words(f[7]), excl = tonumber(f[8]),
      sm = tonumber(f[9]), sx = tonumber(f[10]), sy = tonumber(f[11]),
      em = tonumber(f[12]), ex = tonumber(f[13]), ey = tonumber(f[14]),
      om = tonumber(f[15]), ox = tonumber(f[16]), oy = tonumber(f[17]),
      xp = tonumber(f[18]) or 0, effort = tonumber(f[19]) or 0, flags = f[20] or "", kind = f[21] or "",
      giver = f[22] or "", ender = f[23] or "", exclTo = words(f[24]), via = f[25] or "",
      skill = tonumber((f[26] or ""):match("^(%d+)")), skillMin = tonumber((f[26] or ""):match(":(%d+)")) or 1,
    }
    Q[id] = q
    if q.excl and q.excl > 0 then
      excl[q.excl] = excl[q.excl] or {}
      table.insert(excl[q.excl], id)
    end
  end
  ns.Q, ns.exclGroups = Q, excl
  return Q
end

local function hasBit(mask, b)
  return mask == 0 or floor(mask / b) % 2 == 1
end

-- World position (yards) of a point on a map, from ForeverDB's map edges. nil when the map isn't known.
local function world(m, x, y)
  local d = ns.data and ns.data.maps and ns.data.maps[m]
  if not d or d[1] < 0 then return nil end
  return d[1], d[2] - y / 100 * d[4], d[3] - x / 100 * d[5]
end
ns.world = world

-- Yards between two points, or a big number between continents.
local function yards(m1, x1, y1, m2, x2, y2)
  if not m1 or not m2 or m1 == 0 or m2 == 0 then return 2000 end
  if m1 == m2 then
    local d = ns.data.maps[m1]
    if d then
      local dx, dy = (x2 - x1) / 100 * d[5], (y2 - y1) / 100 * d[4]
      return sqrt(dx * dx + dy * dy)
    end
  end
  local c1, a1, b1 = world(m1, x1, y1)
  local c2, a2, b2 = world(m2, x2, y2)
  if not c1 or not c2 then return 2500 end
  if c1 ~= c2 then return 6000 end -- a zeppelin ride and the walks to and from it
  local da, db = a2 - a1, b2 - b1
  return sqrt(da * da + db * db)
end
ns.yards = yards

local function mapName(m)
  local d = ns.data and ns.data.maps and ns.data.maps[m]
  return (d and d[6] ~= "" and d[6]) or ("map " .. tostring(m))
end
ns.mapName = mapName

local function pace(level)
  local p = ns.data and ns.data.pace or {}
  return p[floor(level / 5)] or p[0] or { c = 30, i = 20, o = 20, r = 7 }
end

-- Classic's XP for killing a mob of your level (WoW Forever may differ).
local function killXp(level) return 45 + 5 * level end

local function xpToLevel(sim)
  if sim.level == sim.realLevel and sim.realXpMax and sim.realXpMax > 0 then return sim.realXpMax end
  return XP_TO_LEVEL[sim.level] or huge
end

-- Can the character take quest q now (ignoring whether it's worth it)?
local function available(q, sim, opts)
  if sim.done[q.id] or sim.log[q.id] or opts.skip[q.id] then return false end
  if q.kind == "i" then return false end -- starts from an item you loot
  if q.min > sim.level then return false end
  -- Needs a profession you don't have (Root Samples: Herbalism). Without the game's skill list, assume you have it.
  if q.skill and sim.skills and (sim.skills[q.skill] or 0) < q.skillMin then return false end
  if not hasBit(q.cls, sim.classBit) then return false end
  if q.races ~= 0 and q.races % 256 ~= 255 and not hasBit(q.races, sim.raceBit) then return false end
  if q.flags:find("[dr]") and not opts.dungeonQuests then return false end
  if q.flags:find("g") and not opts.groupQuests then return false end
  for _, p in ipairs(q.pre) do if not sim.done[p] then return false end end
  if #q.any > 0 then
    local ok = false
    for _, p in ipairs(q.any) do if sim.done[p] then ok = true break end end
    if not ok then return false end
  end
  for _, o in ipairs(q.exclTo) do if sim.done[o] or sim.log[o] then return false end end
  if q.excl and q.excl > 0 then
    for _, o in ipairs(ns.exclGroups[q.excl] or {}) do
      if o ~= q.id and (sim.done[o] or sim.log[o]) then return false end
    end
  end
  return true
end
ns.available = available

-- Is it worth doing at this level? (Not grey, enough XP left, not too far above you.)
local function worth(q, level, opts)
  if q.lv > level + opts.maxAbove then return false end
  if q.lv < ns.greyBelow(level) and not opts.greyQuests then return false end
  return xpRatio(level, q.lv) * 100 >= opts.minXpPct
end
ns.worth = worth

local function objectiveSpot(q)
  if q.om and q.om > 0 then return q.om, q.ox, q.oy end
  if q.effort > 0 then return q.em, q.ex, q.ey end
  return nil
end

local function copySet(t)
  local c = {}
  for k, v in pairs(t) do c[k] = v end
  return c
end

local DEFAULTS = { minXpPct = 60, maxAbove = 3, steps = 40, dungeonQuests = false, groupQuests = false, greyQuests = false }

--[[ state = {
  level, xp, xpMax, classBit, raceBit, map, x, y,
  done = { [quest] = true }, log = { [quest] = { complete = bool } }, opts = { see DEFAULTS, skip = { [quest] = true } } }
  Returns steps: { kind = accept|do|turnin|travel|abandon|grind, q = quest table, map, x, y, level, xp, text } and a summary. ]]
function ns.Plan(state)
  local Q = ns.LoadQuests()
  local opts = {}
  for k, v in pairs(DEFAULTS) do opts[k] = v end
  for k, v in pairs(state.opts or {}) do opts[k] = v end
  opts.skip = opts.skip or {}

  local sim = {
    level = state.level, realLevel = state.level, xp = state.xp or 0, realXpMax = state.xpMax,
    classBit = state.classBit or 0, raceBit = state.raceBit or 0,
    map = state.map, x = state.x or 50, y = state.y or 50, time = 0,
    done = copySet(state.done or {}), log = {}, logCount = 0,
    skills = state.skills,
  }
  for id, e in pairs(state.log or {}) do
    -- A quest with a stop on the way (flag v) isn't done until you've talked to them, whatever the game says.
    local viaLeft = Q[id] and Q[id].flags:find("v") and not (state.viaDone or {})[id]
    if Q[id] then sim.log[id] = { complete = e.complete and not viaLeft }; sim.logCount = sim.logCount + 1 end
  end

  local steps, startLevel, startXp, grinds, travels = {}, sim.level, sim.xp, 0, 0
  local function gain(xp)
    sim.xp = sim.xp + xp
    while sim.level < MAX_LEVEL and sim.xp >= xpToLevel(sim) do
      sim.xp = sim.xp - xpToLevel(sim)
      sim.level = sim.level + 1
    end
  end
  local function add(step)
    step.level = sim.level
    step.time = sim.time
    step.levelPct = floor(sim.xp / math.max(1, xpToLevel(sim)) * 100)
    steps[#steps + 1] = step
  end
  -- Travel: the router knows your flight paths, the zeppelins, boats and lifts, and your hearthstone.
  local router = state.router or ns.NewRouter({ run = pace(sim.level).r or 7, known = state.knownNodes, hearth = state.hearth,
    flights = opts.flights, hearthstone = opts.hearthstone })
  sim.hearthAt = state.hearthCooldown or huge -- seconds until it's ready; nil when you have no hearthstone
  local function hearthReady() return opts.hearthstone ~= false and state.hearth ~= nil and sim.time >= sim.hearthAt end
  local function here() return { map = sim.map, x = sim.x, y = sim.y } end
  local function spot(m, x, y) return { map = m, x = x, y = y } end
  local function travelTime(m, x, y)
    if not sim.map or not m or m == 0 then return 120, false end
    if m == sim.map and yards(sim.map, sim.x, sim.y, m, x, y) <= HUB_YARDS then return 0, false end
    return router:time(here(), spot(m, x, y), hearthReady())
  end
  -- Time between two spots of a quest (its start, objectives and end), without the hearthstone.
  local legCache = {}
  local function between(m1, x1, y1, m2, x2, y2)
    if not m1 or not m2 or m1 == 0 or m2 == 0 then return 60 end
    local key = m1 .. ":" .. x1 .. ":" .. y1 .. ">" .. m2 .. ":" .. x2 .. ":" .. y2
    local t = legCache[key]
    if not t then t = router:time(spot(m1, x1, y1), spot(m2, x2, y2), false); legCache[key] = t end
    return t
  end
  -- Goes there, with a step for each ride on the way (a flight, a zeppelin or boat, your hearthstone).
  local function go(m, x, y)
    if not m or m == 0 then return end
    local t, hearth = travelTime(m, x, y)
    if t > 60 and sim.map then
      for _, leg in ipairs(router:route(here(), spot(m, x, y), hearthReady())) do
        add({ kind = "ride", mode = leg.mode, name = leg.name, fromName = leg.fromName, toName = leg.toName, toMap = leg.toMap,
          toX = leg.toX, toY = leg.toY, map = leg.map, x = leg.x, y = leg.y })
      end
    end
    if hearth then sim.hearthAt = sim.time + HEARTH_COOLDOWN end
    sim.time = sim.time + t
    sim.map, sim.x, sim.y = m, x, y
  end

  -- XP per second of an action: the quest's XP (and the mobs on the way) over the time to get there and finish it.
  local function questXp(q)
    return q.xp * xpRatio(sim.level, q.lv) + (q.effort / (pace(sim.level).c or 30)) * killXp(sim.level) * 0.6
  end
  local function rateOf(kind, q, t)
    if kind == "turnin" then return q.xp * xpRatio(sim.level, q.lv) / (t + 5) end
    local om, ox, oy = objectiveSpot(q)
    local toEnd = om and between(om, ox, oy, q.em, q.ex, q.ey) or 0
    if kind == "do" then return questXp(q) / (t + q.effort + toEnd + 5) end
    local toObj = om and between(q.sm, q.sx, q.sy, om, ox, oy) or between(q.sm, q.sx, q.sy, q.em, q.ex, q.ey)
    return questXp(q) / (t + 5 + toObj + q.effort + toEnd + 5)
  end

  -- Quests in the log that went grey or give too little XP now: suggest abandoning them (once each).
  local function abandonStale()
    for id, e in pairs(sim.log) do
      local q = Q[id]
      if not e.complete and not e.abandonNoted and not opts.skip[id] and xpRatio(sim.level, q.lv) * 100 < opts.minXpPct then
        e.abandonNoted = true
        sim.log[id] = nil
        sim.logCount = sim.logCount - 1
        add({ kind = "abandon", q = q, xp = floor(q.xp * xpRatio(sim.level, q.lv)) })
      end
    end
  end


  -- The best other zone to go to: XP of its worthwhile quests (new ones, and ones in your log that end or have objectives
  -- there) per second, counting the trip there. Returns the map, its busiest quest giver spot, the quest count and the rate.
  local function bestZone()
    local byMap = {}
    local function entry(m)
      local z = byMap[m] or { xp = 0, n = 0, t = 0, quests = {} }
      byMap[m] = z
      return z
    end
    for _, q in pairs(Q) do
      if q.sm and q.sm > 0 and available(q, sim, opts) and worth(q, sim.level, opts) then
        local z = entry(q.sm)
        z.xp, z.n, z.t = z.xp + questXp(q), z.n + 1, z.t + q.effort + 60
        z.quests[#z.quests + 1] = q
      end
    end
    for id, e in pairs(sim.log) do
      local q = Q[id]
      local m = e.complete and q.em or (objectiveSpot(q))
      if m and byMap[m] and not opts.skip[id] then
        local z = byMap[m]
        z.xp, z.t = z.xp + q.xp * xpRatio(sim.level, q.lv), z.t + (e.complete and 10 or q.effort + 30)
      end
    end
    local best, bestRate, bx, by
    for m, z in pairs(byMap) do
      if z.n >= 2 then
        local t = travelTime(m, z.quests[1].sx, z.quests[1].sy)
        local rate = z.xp / (t + z.t)
        if not bestRate or rate > bestRate then best, bestRate = m, rate end
      end
    end
    if not best then return nil end
    local qs, hub, hubN = byMap[best].quests, nil, -1
    for _, a in ipairs(qs) do
      local n = 0
      for _, b in ipairs(qs) do if yards(best, a.sx, a.sy, best, b.sx, b.sy) <= HUB_YARDS * 3 then n = n + 1 end end
      if n > hubN then hub, hubN = a, n end
    end
    return best, hub.sx, hub.sy, hubN, bestRate
  end

  local guard = 0
  while #steps < opts.steps and guard < opts.steps * 4 do
    guard = guard + 1
    abandonStale()

    -- Every action you could take next and how long it takes to get there (walking, flights, zeppelins).
    local best, bestCost, bestT
    local function consider(kind, q, m, x, y, bias)
      if not m or m == 0 then return end
      local t = travelTime(m, x, y)
      local cost = t * (bias or 1)
      if not bestCost or cost < bestCost or (cost == bestCost and q.id < best.q.id) then
        best, bestCost, bestT = { kind = kind, q = q, map = m, x = x, y = y }, cost, t
      end
    end
    local pending = 0
    for id, e in pairs(sim.log) do if not e.complete then pending = pending + 1 end end
    for id, e in pairs(sim.log) do
      local q = Q[id]
      if opts.skip[id] then
        -- skipped: you deal with it yourself
      elseif e.complete then
        -- Handing in when you still have objectives to do nearby costs a little more, so you finish them first.
        -- A finished quest that's worth little now is only handed in when you pass by (same zone).
        if xpRatio(sim.level, q.lv) * 100 >= opts.minXpPct or q.em == sim.map then
          consider("turnin", q, q.em, q.ex, q.ey, pending > 0 and 1.25 or 1)
        end
      else
        local m, x, y = objectiveSpot(q)
        if m then consider("do", q, m, x, y) else e.complete = true; consider("turnin", q, q.em, q.ex, q.ey) end
      end
    end
    if sim.logCount < LOG_SIZE then
      for _, q in pairs(Q) do
        if q.sm and q.sm > 0 and available(q, sim, opts) and worth(q, sim.level, opts)
          and (q.sm == sim.map or yards(sim.map, sim.x, sim.y, q.sm, q.sx, q.sy) <= NEAR_YARDS) then
          consider("accept", q, q.sm, q.sx, q.sy)
        end
      end
    end

    -- When the nearest thing left is far away (a quest in your log across the world), is a zone worth more per second?
    -- Then the far quest waits until the route passes by.
    local zm, zx, zy, zn, zRate
    if (not best or bestT > LOCAL_SECONDS) and sim.logCount < LOG_SIZE then
      zm, zx, zy, zn, zRate = bestZone()
      if zm and best and (zm == best.map or zRate < rateOf(best.kind, best.q, bestT) * ZONE_SWITCH) then zm = nil end
    end

    if zm and travels < 6 then
      travels = travels + 1
      local fromMap = sim.map
      go(zm, zx, zy)
      add({ kind = "travel", map = zm, x = zx, y = zy, count = zn, fromMap = fromMap })
    elseif best then
      local q = best.q
      go(best.map, best.x, best.y)
      if best.kind == "accept" then
        sim.log[q.id] = { complete = (q.effort == 0 and not (q.om and q.om > 0)) }
        sim.logCount = sim.logCount + 1
        sim.time = sim.time + 5
      elseif best.kind == "do" then
        sim.log[q.id].complete = true
        sim.time = sim.time + q.effort
        local kills = q.effort / (pace(sim.level).c or 30)
        best.killXp = floor(kills * killXp(sim.level) * 0.6)
        gain(best.killXp)
      else
        best.xp = floor(q.xp * xpRatio(sim.level, q.lv))
        sim.log[q.id] = nil
        sim.logCount = sim.logCount - 1
        sim.done[q.id] = true
        sim.time = sim.time + 5
        gain(best.xp)
      end
      add(best)
    elseif grinds < 1 and sim.level < MAX_LEVEL then
      grinds = grinds + 1
      add({ kind = "grind", toLevel = sim.level + 1 })
      sim.level, sim.xp = sim.level + 1, 0
    else
      break
    end
  end

  -- Quests in your log the route doesn't reach yet: parked until you're nearby.
  local inPlan, parked = {}, {}
  for _, s in ipairs(steps) do if s.q then inPlan[s.q.id] = true end end
  for id in pairs(state.log or {}) do
    if Q[id] and not inPlan[id] and not opts.skip[id] then parked[#parked + 1] = Q[id] end
  end
  table.sort(parked, function(a, b) return a.title < b.title end)

  local summary = {
    fromLevel = startLevel, toLevel = sim.level, xp = sim.xp, minutes = floor(sim.time / 60 + 0.5),
    startXp = startXp, parked = parked,
  }
  return steps, summary
end
