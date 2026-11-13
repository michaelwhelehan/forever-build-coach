-- Loads the addon against a stand-in for the game's API and runs its events, the window, the arrow and /fr commands.
-- lua5.1 test/forever-route/ingame.lua <Data.lua>
local dataFile = arg[1]
-- Like the game's Lua: %d (and %x, %c) refuse a number with a fraction.
local rawFormat = string.format
string.format = function(fmt, ...)
  local args, i = { ... }, 0
  for spec in fmt:gmatch("%%[-+ #0]*%d*%.?%d*(%a)") do
    i = i + 1
    local v = args[i]
    if (spec == "d" or spec == "i" or spec == "x" or spec == "X" or spec == "c") and type(v) == "number" and v ~= math.floor(v) then
      error("bad argument #" .. (i + 1) .. " to 'format' (number has no integer representation)", 2)
    end
  end
  return rawFormat(fmt, ...)
end
local chatErrors = 0
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
    if k == "SetHeight" then return function(self, v) rawset(self, "_h", v) end end
    if k == "GetHeight" then return function(self) return rawget(self, "_h") or 20 end end
    if k == "SetSize" then return function(self, w, h) rawset(self, "_w", w); rawset(self, "_h", h) end end
    if k == "GetWidth" then return function(self) return rawget(self, "_w") or 140 end end
    if k == "GetCenter" then return function() return 500, 500 end end
    if k == "GetEffectiveScale" then return function() return 1 end end
    if k == "GetChecked" then return function() return true end end
    return function() end
  end })
end
CreateFrame = function(_, name) local f = mock(name); if name then _G[name] = f end; return f end
UIParent = mock("UIParent"); GameTooltip = mock("GameTooltip"); Minimap = mock("Minimap")
UISpecialFrames = {}; tinsert = table.insert; GetXPExhaustion = function() return 3000 end
GetCursorPosition = function() return 600, 400 end; GetUnitSpeed = function() return 7 end
DEFAULT_CHAT_FRAME = { AddMessage = function(_, m) if m:find("error in") then chatErrors = chatErrors + 1 end; print("CHAT", (m:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))) end }
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
local bind = "Undercity"
GetBindLocation = function() return bind end
GetItemCount = function() return 1 end
GetItemCooldown = function() return 0, 0 end
GetTaxiMapID = function() return 1414 end
C_TaxiMap = { GetAllTaxiNodes = function() return { { nodeID = 25, state = 0 }, { nodeID = 11, state = 1 }, { nodeID = 23, state = 1 }, { nodeID = 13, state = 2 } } end }
local mapNow = 1413
C_Map.GetBestMapForUnit = function() return mapNow end
GetTime = function() return os.clock() * 1000 end
SlashCmdList = {}

local ns = {}
for _, f in ipairs({ dataFile, "addon/ForeverRoute/Routing.lua", "addon/ForeverRoute/Planner.lua", "addon/ForeverRoute/Core.lua", "addon/ForeverRoute/UI.lua", "addon/ForeverRoute/Settings.lua" }) do
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
-- The window, settings and minimap button.
local function texts(f, out)
  out = out or {}
  for k, v in pairs(f) do if type(v) == "table" and rawget(v, "_text") then out[#out + 1] = plain(v._text) end end
  return out
end
function plain(s) return (s or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "") end
ns.UpdateUI()
local card = ForeverRouteFrame.card
print("card:", plain(card.kind._text), "|", plain(card.title._text), "|", plain(card.detail._text))
print("bar:", plain(ForeverRouteFrame.bar.text._text)); print("plan:", plain(ForeverRouteFrame.plan._text))
for i, r in ipairs(ForeverRouteFrame.rows) do if r._shown and (rawget(r.text, "_text") or rawget(r.sep, "_text")) then
  print("row", i, r.step and plain(r.text._text) or ("-- " .. plain(r.sep._text)), r.step and plain(r.right._text or "") or "") end end
print("height", ForeverRouteFrame:GetHeight())
ns.opts().collapsed = true; ns.UpdateUI(); print("collapsed height", ForeverRouteFrame:GetHeight()); ns.opts().collapsed = false
ns.Toast("Level 24: test"); flush()
-- Travel: learn flight paths at a flight master, then stand in Undercity with Barrens quests in the log.
fire("TAXIMAP_OPENED"); flush()
assert(ForeverRouteCharDB.taxi[25] and ForeverRouteCharDB.taxi[23] and not ForeverRouteCharDB.taxi[13], "flight paths learned")
mapNow, px, py = 1458, 0.66, 0.44
fire("ZONE_CHANGED_NEW_AREA"); flush()
print("in Undercity:"); show()
local rides = 0
for _, s in ipairs(ns.steps) do if s.kind == "ride" then rides = rides + 1; print("  ride:", plain(ns.StepText(s, true))) end end
ns.UpdateUI(); print("plan:", plain(ForeverRouteFrame.plan._text))
ForeverRouteArrow._scripts.OnUpdate(ForeverRouteArrow, 1)
fire("UNIT_SPELLCAST_SUCCEEDED", "player", "guid", 8690); flush()
assert(ForeverRouteCharDB.hearth and ForeverRouteCharDB.hearth.map == 1458, "hearth remembered")
mapNow, px, py = 1413, 0.517, 0.309
fire("ZONE_CHANGED_NEW_AREA"); flush()
SlashCmdList.FOREVERROUTE("options"); assert(ForeverRouteSettings, "settings window")
for _, child in pairs(ForeverRouteSettings) do end
ForeverRouteMinimapButton._scripts.OnEnter(ForeverRouteMinimapButton)
ForeverRouteMinimapButton._scripts.OnClick(ForeverRouteMinimapButton, "LeftButton")
ForeverRouteMinimapButton._scripts.OnDragStart(ForeverRouteMinimapButton); ForeverRouteMinimapButton._scripts.OnUpdate()
print("minimap angle", math.floor(ns.opts().minimapAngle))
px, py = 0.5185, 0.304 -- stand on the step
ForeverRouteArrow._scripts.OnUpdate(ForeverRouteArrow, 1); print("arrow near:", plain(ForeverRouteArrow.dist._text))
assert(chatErrors == 0, chatErrors .. " addon error(s) reported in chat")
print("ok")
