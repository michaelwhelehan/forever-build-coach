-- Plays the route in a loop without the game: plan, do the first step, plan again.
-- lua5.1 test/forever-route/simulate.lua <Data.lua> [start level] [steps] [map x y]
-- Time is counted with Routing.lua's travel model (walking, flights, zeppelins), whatever the planner does.
local dataFile, startLevel, maxSteps = arg[1], tonumber(arg[2] or 1), tonumber(arg[3] or 150)
local ns = {}
assert(loadfile(dataFile))("ForeverRoute", ns)
assert(loadfile("addon/ForeverRoute/Routing.lua"))("ForeverRoute", ns)
assert(loadfile("addon/ForeverRoute/Planner.lua"))("ForeverRoute", ns)
ns.LoadQuests()
local router = ns.NewRouter({ run = 7 })

local state = {
  level = startLevel, xp = 0, xpMax = ns.XP_TO_LEVEL[startLevel], classBit = 128, raceBit = 16, -- Undead Mage
  map = tonumber(arg[4] or 1420), x = tonumber(arg[5] or 30.9), y = tonumber(arg[6] or 66.1),
  done = {}, log = {}, opts = { skip = {} },
}
-- SIM_LOG="id,id": quests already in your log; SIM_DONE="id,id": quests done.
for id in (os.getenv("SIM_LOG") or ""):gmatch("%d+") do state.log[tonumber(id)] = { complete = false } end
for id in (os.getenv("SIM_DONE") or ""):gmatch("%d+") do state.done[tonumber(id)] = true end
local function gain(xp)
  state.xp = state.xp + xp
  while state.xp >= ns.XP_TO_LEVEL[state.level] do state.xp = state.xp - ns.XP_TO_LEVEL[state.level]; state.level = state.level + 1 end
  state.xpMax = ns.XP_TO_LEVEL[state.level]
end
local errors, minutes = 0, 0
local stopMinutes = tonumber(os.getenv("SIM_MINUTES") or "")
for i = 1, maxSteps do
  if stopMinutes and minutes >= stopMinutes then break end
  local steps, sum = ns.Plan(state)
  local s = steps[1]
  if not s then print("no steps left"); break end
  local q = s.q
  local where = s.map and string.format("%s %.1f,%.1f", ns.mapName(s.map), s.x, s.y) or ""
  local d = s.map and ns.yards(state.map, state.x, state.y, s.map, s.x, s.y) or 0
  if s.map then minutes = minutes + router:time({ map = state.map, x = state.x, y = state.y }, s, false) / 60 end
  print(string.format("%3d L%-2d %-7s %-40s %-28s %5dyd %s", i, state.level, s.kind, q and (q.title .. " (" .. q.lv .. ")") or (s.toLevel and ("to level " .. s.toLevel) or ""), where, d, s.xp and ("+" .. s.xp) or ""))
  if s.map then state.map, state.x, state.y = s.map, s.x, s.y end
  if s.kind == "ride" then
    local t = router:time(s, { map = s.toMap, x = s.toX, y = s.toY }, s.mode == "hearth")
    minutes = minutes + (s.mode == "hearth" and 15 or t) / 60
    if s.toMap and s.toX then state.map, state.x, state.y = s.toMap, s.toX, s.toY end
    if s.mode == "hearth" then state.hearthCooldown = 3600 end
    print(string.format("      %s %s -> %s", s.mode, tostring(s.fromName or s.name), ns.mapName(s.toMap)))
  elseif s.kind == "accept" then
    state.log[q.id] = { complete = (q.effort == 0 and not (q.om and q.om > 0)) }
  elseif s.kind == "do" then
    state.log[q.id].complete = true; minutes = minutes + q.effort / 60
    gain(math.floor(q.effort / 30 * (45 + 5 * state.level) * 0.6))
  elseif s.kind == "turnin" then
    if not state.log[q.id] then errors = errors + 1; print("   !! turn in without quest") end
    state.log[q.id] = nil; state.done[q.id] = true; gain(s.xp)
  elseif s.kind == "abandon" then
    state.log[q.id] = nil
  elseif s.kind == "grind" then
    state.level = s.toLevel; state.xp = 0; state.xpMax = ns.XP_TO_LEVEL[state.level]
  end
end
local n = 0 for _ in pairs(state.log) do n = n + 1 end
print(string.format("xp/hour %d (level %d + %d xp)", (function() local t = 0 for l = startLevel, state.level - 1 do t = t + ns.XP_TO_LEVEL[l] end return (t + state.xp) / math.max(minutes, 1) * 60 end)(), state.level, state.xp))
print(string.format("end: level %d, %d quests done in log %d, ~%d min travel+objectives, errors %d", state.level, (function() local c=0 for _ in pairs(state.done) do c=c+1 end return c end)(), n, minutes, errors))
