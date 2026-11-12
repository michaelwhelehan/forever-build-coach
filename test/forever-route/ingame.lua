-- Loads the addon against a stand-in for the game's API and runs its events, the window, the arrow and /fr commands.
-- lua5.1 test/forever-route/ingame.lua <Data.lua>
local dataFile = arg[1]
local timers, scripts, frames = {}, {}, {}
local function mock(name)
  local o = { _scripts = {}, _shown = true, _name = name }
  return setmetatable(o, { __index = function(t, k)
    if k == "CreateFontString" or k == "CreateTexture" then return function() return mock(k) end end
    if k == "SetScript" then return function(self, ev, fn) self._scripts[ev] = fn end end
    if k == "GetScript" then return function(self, ev) return self._scripts[ev] end end
    if k == "RegisterEvent" then return function(self, ev) if not rawget(self, "_reg") then rawset(self, "_reg", true); frames[#frames + 1] = self end end end
    if k == "GetPoint" then return function() return "CENTER", nil, "CENTER", 0, 0 end end
    if k == "IsShown" then return function(self) return self._shown end end
    if k == "SetShown" then return function(self, v) self._shown = v end end
    if k == "Show" then return function(self) self._shown = true end end
    if k == "Hide" then return function(self) self._shown = false end end
    if k == "SetText" then return function(self, v) self._text = v end end
    return function() end
  end })
end
CreateFrame = function(_, name) local f = mock(name); if name then _G[name] = f end; return f end
UIParent = mock("UIParent"); GameTooltip = mock("GameTooltip")
DEFAULT_CHAT_FRAME = { AddMessage = function(_, m) print("CHAT", (m:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))) end }
C_Timer = { After = function(_, fn) timers[#timers + 1] = fn end }
local level, xp = 20, 1000
local px, py = 0.517, 0.309
C_Map = {
  GetBestMapForUnit = function() return 1413 end,
  GetPlayerMapPosition = function() return { GetXY = function() return px, py end } end,
  CanSetUserWaypointOnMap = function() return true end,
  SetUserWaypoint = function(p) end,
}
UiMapPoint = { CreateFromCoordinates = function(m, x, y) return { m, x, y } end }
C_SuperTrack = { SetSuperTrackedUserWaypoint = function() end }
local log = { { id = 871, complete = false }, { id = 869, complete = true } }
C_QuestLog = {
  GetAllCompletedQuestIDs = function() return { 840, 842, 4641, 788, 790 } end,
  IsQuestFlaggedCompleted = function() return false end,
  GetNumQuestLogEntries = function() return #log end,
  GetInfo = function(i) return log[i] and { questID = log[i].id, isHeader = false } end,
  IsComplete = function(id) for _, e in ipairs(log) do if e.id == id then return e.complete end end end,
  GetQuestObjectives = function() return { { text = "Raptor Head: 3/12", finished = false } } end,
}
UnitLevel = function() return level end
UnitXP = function() return xp end
UnitXPMax = function() return 25200 end
UnitClass = function() return "Mage", "MAGE", 8 end
UnitRace = function() return "Undead", "Scourge", 5 end
GetPlayerFacing = function() return 1.0 end
GetTime = function() return os.clock() * 1000 end
SlashCmdList = {}

local ns = {}
for _, f in ipairs({ dataFile, "addon/ForeverRoute/Planner.lua", "addon/ForeverRoute/Core.lua", "addon/ForeverRoute/UI.lua" }) do
  assert(loadfile(f))("ForeverRoute", ns)
end
local function fire(ev, ...) for _, fr in ipairs(frames) do local fn = fr._scripts.OnEvent if fn then fn(fr, ev, ...) end end end
local function flush() while #timers > 0 do local t = table.remove(timers, 1); t() end end
local function show()
  for i, s in ipairs(ns.steps) do if i > 6 then break end print(string.format("  %d %s", i, (ns.StepText(s, i == 1):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")))) end
end

print("frames", #frames); fire("PLAYER_LOGIN"); fire("PLAYER_ENTERING_WORLD"); print("timers", #timers); flush()
print("after login:", #ns.steps, "steps, level", ns.summary.fromLevel, "->", ns.summary.toLevel); show()
ForeverRouteArrow._scripts.OnUpdate(ForeverRouteArrow, 1)
print("arrow:", ForeverRouteArrow.dist._text)
ForeverRouteFrame._scripts.OnDragStop(ForeverRouteFrame)

-- A dungeon run: four levels at once. The route should drop what went too low.
level = 24
fire("PLAYER_LEVEL_UP", 24); flush()
print("after dungeons at 24:"); show()
SlashCmdList.FOREVERROUTE("skip"); flush()
ForeverRouteArrow._scripts.OnUpdate(ForeverRouteArrow, 1)
print("arrow after skip:", ForeverRouteArrow.dist._text, ns.StepText(ns.steps[1]))
assert(ForeverRouteArrow.dist._text and ForeverRouteArrow.dist._text:find("yd"), "arrow shows a distance")
SlashCmdList.FOREVERROUTE("minxp 80"); SlashCmdList.FOREVERROUTE("dungeons"); SlashCmdList.FOREVERROUTE("help")
SlashCmdList.FOREVERROUTE(""); SlashCmdList.FOREVERROUTE("show")
fire("QUEST_TURNED_IN", 869, 500, 0); fire("QUEST_LOG_UPDATE"); fire("ZONE_CHANGED_NEW_AREA"); flush()
SlashCmdList.FOREVERROUTE("reset"); flush()
print("ok")
