-- Forever Route travel: how long it takes to get from one spot to another, and how. Walking, flight paths you know,
-- zeppelins, boats and lifts (ForeverDB's travel data), and your hearthstone. Pure Lua, like the planner.

local _, ns = ...

local sqrt, huge, floor = math.sqrt, math.huge, math.floor
local WALK_DETOUR = 1.25  -- paths aren't straight lines
local TRANSFER_YARDS = 2500 -- walk between two travel points (a flight master and a zeppelin tower) up to this far
local NEAREST = 4          -- travel points tried at each end of a trip
local FLIGHT_OVERHEAD = 15 -- talking to the flight master and landing
local HEARTH_CAST = 15     -- casting and loading
local MIN_SAVING = 45      -- a ride or the hearthstone has to save at least this much over walking

-- Travel points: { c, X, Y, map, x, y, name, kind ("fm" or the transport kind) }
local function point(c, X, Y) return { c = c, X = X, Y = Y } end
local function dist(a, b)
  if a.c ~= b.c then return huge end
  local dx, dy = a.X - b.X, a.Y - b.Y
  return sqrt(dx * dx + dy * dy)
end

-- The zone map a world point is on, for showing where a travel point is. Zone maps overlap at their edges, so the
-- smallest map with the point well inside wins, else the one it's furthest inside.
local function mapAt(c, X, Y)
  local best, bestArea, edge, edgeMargin
  for m, d in pairs(ns.data and ns.data.maps or {}) do
    if d[1] == c and d[4] > 0 and d[5] > 0 then
      local x, y = (d[3] - Y) / d[5] * 100, (d[2] - X) / d[4] * 100
      local margin = math.min(x, 100 - x, y, 100 - y)
      if margin >= 0 then
        local area = d[4] * d[5]
        if margin >= 8 and (not bestArea or area < bestArea) then best, bestArea = m, area end
        if not edgeMargin or margin > edgeMargin then edge, edgeMargin = m, margin end
      end
    end
  end
  best = best or edge
  if not best then return nil end
  local d = ns.data.maps[best]
  return best, (d[3] - Y) / d[5] * 100, (d[2] - X) / d[4] * 100
end

--[[ opts: { known = { [flight node] = true } or nil (nil: all of them), run = yards per second, hearth = { map, x, y,
  name } or nil, flights = bool, hearthstone = bool }. Returns a router with :time(from, to, hearthReady) and
  :route(from, to, hearthReady). from and to are { map, x, y }. ]]
function ns.NewRouter(opts)
  local td = ns.data and ns.data.travel
  local run = opts.run or 7
  local R = { run = run }
  local pts, edges = {}, {}
  local function addPoint(p) pts[#pts + 1] = p; edges[#pts] = {}; return #pts end
  local function edge(i, j, sec, leg) edges[i][j] = (edges[i][j] and edges[i][j].sec <= sec) and edges[i][j] or { sec = sec, leg = leg } end

  if td and opts.flights ~= false then
    local nodeIdx = {}
    for id, n in pairs(td.nodes or {}) do
      if not opts.known or opts.known[id] then
        local p = point(n[1], n[2], n[3])
        p.map, p.x, p.y, p.name, p.kind, p.id = n[4], n[5], n[6], n[7], "fm", id
        nodeIdx[id] = addPoint(p)
      end
    end
    for a, b, sec in (td.flights or ""):gmatch("(%d+)>(%d+)>(%d+)") do
      local i, j = nodeIdx[tonumber(a)], nodeIdx[tonumber(b)]
      if i and j then edge(i, j, tonumber(sec) + FLIGHT_OVERHEAD, { mode = "fly" }) end
    end
    for _, l in ipairs(td.links or {}) do
      local a, b = point(l[1], l[2], l[3]), point(l[4], l[5], l[6])
      a.kind, b.kind, a.name, b.name = l[8], l[8], l[9], l[9]
      a.map, a.x, a.y = mapAt(a.c, a.X, a.Y)
      b.map, b.x, b.y = mapAt(b.c, b.X, b.Y)
      local i, j = addPoint(a), addPoint(b)
      edge(i, j, l[7], { mode = l[8], name = l[9] })
      edge(j, i, l[7], { mode = l[8], name = l[9] })
    end
    -- Short walks between travel points (from the Undercity flight master to the zeppelin tower).
    for i = 1, #pts do
      for j = 1, #pts do
        if i ~= j then
          local d = dist(pts[i], pts[j])
          if d <= TRANSFER_YARDS then edge(i, j, d * WALK_DETOUR / run, { mode = "walk" }) end
        end
      end
    end
  end

  -- Quickest time between every two travel points (Floyd-Warshall), with the next hop to rebuild the way.
  local n = #pts
  local D, NX = {}, {}
  for i = 1, n do
    D[i], NX[i] = {}, {}
    for j = 1, n do
      if i == j then D[i][j] = 0 elseif edges[i][j] then D[i][j], NX[i][j] = edges[i][j].sec, j else D[i][j] = huge end
    end
  end
  for k = 1, n do
    local Dk = D[k]
    for i = 1, n do
      local Di, dik = D[i], D[i][k]
      if dik < huge then
        local NXi = NX[i]
        for j = 1, n do
          local v = dik + Dk[j]
          if v < Di[j] then Di[j] = v; NXi[j] = NXi[k] end
        end
      end
    end
  end

  local worldCache = {}
  local function toWorld(p)
    if not p.map or not p.x or not p.y then return nil end
    local key = p.map * 1e6 + floor(p.x * 10) * 1000 + floor(p.y * 10)
    local w = worldCache[key]
    if w == nil then
      local c, X, Y = ns.world(p.map, p.x, p.y)
      w = c and point(c, X, Y) or false
      worldCache[key] = w
    end
    return w or nil
  end
  local nearCache = {}
  local function nearest(w)
    local key = w.c .. ":" .. floor(w.X / 20) .. ":" .. floor(w.Y / 20)
    local list = nearCache[key]
    if list then return list end
    list = {}
    for i = 1, n do
      local d = dist(w, pts[i])
      if d < huge then list[#list + 1] = { i = i, sec = d * WALK_DETOUR / run } end
    end
    table.sort(list, function(a, b) return a.sec < b.sec end)
    for k = NEAREST + 1, #list do list[k] = nil end
    nearCache[key] = list
    return list
  end

  local hearthW = opts.hearthstone ~= false and opts.hearth and opts.hearth.map and toWorld(opts.hearth) or nil

  -- Quickest way without the hearthstone: walking, or walk + rides + walk. Returns seconds, first and last point.
  local function plain(fw, tw)
    local walk = dist(fw, tw)
    local best = walk < huge and walk * WALK_DETOUR / run or huge
    local bi, bj
    if n > 0 then
      local A, B = nearest(fw), nearest(tw)
      for _, a in ipairs(A) do
        local Da = D[a.i]
        for _, b in ipairs(B) do
          local v = a.sec + Da[b.i] + b.sec
          if v + MIN_SAVING < best or (best == huge and v < huge) then best, bi, bj = v, a.i, b.i end
        end
      end
    end
    return best, bi, bj
  end

  -- Seconds from one spot to another, and whether the hearthstone is the way.
  function R:time(from, to, hearthReady)
    local fw, tw = from.map and toWorld(from), to.map and toWorld(to)
    if not fw or not tw then return 300, false end
    local t = plain(fw, tw)
    if hearthReady and hearthW then
      local h = HEARTH_CAST + plain(hearthW, tw)
      if h + MIN_SAVING < t then return h, true end
    end
    if t == huge then t = 1800 end -- no known way: say half an hour
    return t, false
  end

  -- The rides on the way, for the route's steps: { { mode, name, map, x, y (where to board), toMap, toName } }
  function R:route(from, to, hearthReady)
    local fw, tw = from.map and toWorld(from), to.map and toWorld(to)
    if not fw or not tw then return {} end
    local legs, start = {}, fw
    local t, hearth = self:time(from, to, hearthReady)
    if hearth then
      legs[1] = { mode = "hearth", name = opts.hearth.name, map = from.map, x = from.x, y = from.y, toMap = opts.hearth.map,
        toX = opts.hearth.x, toY = opts.hearth.y }
      start = hearthW
    end
    local _, i, j = plain(start, tw)
    if not i then return legs end
    while i and i ~= j do
      local nx = NX[i][j]
      if not nx then break end
      local e = edges[i][nx]
      if e and e.leg.mode ~= "walk" then
        local last = legs[#legs]
        if e.leg.mode == "fly" and last and last.mode == "fly" and last.toPoint == i then
          last.toPoint, last.toName, last.toMap, last.toX, last.toY = nx, pts[nx].name, pts[nx].map, pts[nx].x, pts[nx].y -- one flight, several hops
        else
          legs[#legs + 1] = { mode = e.leg.mode, name = e.leg.name or pts[i].name, map = pts[i].map, x = pts[i].x, y = pts[i].y,
            fromName = pts[i].name, toName = pts[nx].name, toMap = pts[nx].map, toX = pts[nx].x, toY = pts[nx].y, toPoint = nx }
        end
      end
      i = nx
    end
    return legs
  end

  R.points = n
  return R
end

-- Your capital's flight master, which every Horde character knows.
ns.HOME_NODES = { [2] = 23, [8] = 23, [6] = 22, [5] = 11 } -- race id -> flight node (Orgrimmar, Thunder Bluff, Undercity)
