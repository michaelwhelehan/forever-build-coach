-- Forever Route: reads your character (level, XP, quest log, completed quests, where you are), asks the planner for the
-- next steps and keeps them current. It plans again whenever something changes: a level up from a dungeon, a quest
-- accepted, finished or handed in, a new zone. Quests that went grey or give too little XP drop out by themselves.

local ADDON, ns = ...
_G.ForeverRoute = ns

local DEFAULT_OPTS = { minXpPct = 60, maxAbove = 3, steps = 40, dungeonQuests = false, groupQuests = false, arrow = true, mapPin = true }

ns.steps, ns.summary = {}, nil
local completed = {}
local lastPos = { map = nil, x = 50, y = 50 }
local lastPlanIds, lastLevel = nil, nil

local function msg(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff4fc3f7Forever Route|r: " .. text)
end
ns.msg = msg

local function bitOf(id) return id and id > 0 and 2 ^ (id - 1) or 0 end

-- Completed quests: the game's list, plus what we see handed in this session.
local function loadCompleted()
  completed = {}
  if C_QuestLog and C_QuestLog.GetAllCompletedQuestIDs then
    for _, id in ipairs(C_QuestLog.GetAllCompletedQuestIDs() or {}) do completed[id] = true end
  elseif GetQuestsCompleted then
    local t = GetQuestsCompleted() or {}
    for id in pairs(t) do completed[id] = true end
  end
end

local function isDone(id)
  if completed[id] then return true end
  if C_QuestLog and C_QuestLog.IsQuestFlaggedCompleted and C_QuestLog.IsQuestFlaggedCompleted(id) then
    completed[id] = true
    return true
  end
  return false
end

-- Your quest log: { [quest] = { complete = bool, index = log index } }
local function readLog()
  local log = {}
  local n = (C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetNumQuestLogEntries()) or (GetNumQuestLogEntries and GetNumQuestLogEntries()) or 0
  for i = 1, n do
    local id, header, complete
    if C_QuestLog and C_QuestLog.GetInfo then
      local info = C_QuestLog.GetInfo(i)
      if info then
        id, header = info.questID, info.isHeader
        complete = id and C_QuestLog.IsComplete and C_QuestLog.IsComplete(id)
      end
    else
      local _, _, _, isHeader, _, isComplete, _, questID = GetQuestLogTitle(i)
      id, header, complete = questID, isHeader, isComplete == 1
    end
    if id and id > 0 and not header then log[id] = { complete = complete and true or false, index = i } end
  end
  return log
end
ns.readLog = readLog

local function position()
  local map = C_Map and C_Map.GetBestMapForUnit and C_Map.GetBestMapForUnit("player")
  if map then
    local pos = C_Map.GetPlayerMapPosition(map, "player")
    if pos then
      local x, y = pos:GetXY()
      if x and x > 0 then lastPos = { map = map, x = x * 100, y = y * 100 } end
    end
  end
  return lastPos
end
ns.position = position

-- The game's objective lines for a quest in your log.
function ns.objectives(questID)
  local out = {}
  if C_QuestLog and C_QuestLog.GetQuestObjectives then
    for _, o in ipairs(C_QuestLog.GetQuestObjectives(questID) or {}) do
      if o.text and o.text ~= "" then out[#out + 1] = (o.finished and "|cff808080" or "|cffffffff") .. o.text .. "|r" end
    end
  end
  return out
end

function ns.opts()
  ForeverRouteDB = ForeverRouteDB or {}
  ForeverRouteDB.opts = ForeverRouteDB.opts or {}
  for k, v in pairs(DEFAULT_OPTS) do if ForeverRouteDB.opts[k] == nil then ForeverRouteDB.opts[k] = v end end
  return ForeverRouteDB.opts
end
function ns.skipList()
  ForeverRouteCharDB = ForeverRouteCharDB or {}
  ForeverRouteCharDB.skip = ForeverRouteCharDB.skip or {}
  return ForeverRouteCharDB.skip
end

function ns.Replan(reason)
  if not ns.data then return end
  local Q = ns.LoadQuests()
  local log = readLog()
  local done = {}
  -- Only the quests the planner knows about matter; check them against the game.
  for id in pairs(Q) do if isDone(id) then done[id] = true end end
  local pos = position()
  local opts = {}
  for k, v in pairs(ns.opts()) do opts[k] = v end
  opts.skip = ns.skipList()
  local level = UnitLevel("player")
  local state = {
    level = level, xp = UnitXP("player"), xpMax = UnitXPMax("player"),
    classBit = bitOf(select(3, UnitClass("player"))), raceBit = bitOf(select(3, UnitRace("player"))),
    map = pos.map, x = pos.x, y = pos.y, done = done, log = log, opts = opts,
  }
  local ok, steps, summary = pcall(ns.Plan, state)
  if not ok then
    msg("couldn't plan (" .. tostring(steps) .. ")")
    return
  end

  -- After a level up, say which planned quests dropped out (grey or too little XP now).
  local ids = {}
  for _, s in ipairs(steps) do if s.q then ids[s.q.id] = true end end
  if lastPlanIds and lastLevel and level > lastLevel then
    local dropped = {}
    for id in pairs(lastPlanIds) do
      local q = Q[id]
      if not ids[id] and not done[id] and not log[id] and q and not ns.worth(q, level, opts) then dropped[#dropped + 1] = q.title end
    end
    if #dropped > 0 then
      table.sort(dropped)
      msg(string.format("level %d: dropped %d quest%s that are too low now: %s", level, #dropped, #dropped == 1 and "" or "s",
        table.concat(dropped, ", ", 1, math.min(#dropped, 6)) .. (#dropped > 6 and ", ..." or "")))
    end
  end
  lastPlanIds, lastLevel = ids, level
  ns.steps, ns.summary, ns.log = steps, summary, log
  if ns.UpdateUI then ns.UpdateUI() end
end

-- Several events often come together: plan once, a moment later.
local pending = false
function ns.RequestReplan(reason)
  if pending then return end
  pending = true
  C_Timer.After(0.4, function()
    pending = false
    ns.Replan(reason)
  end)
end

local f = CreateFrame("Frame")
f:RegisterEvent("PLAYER_LOGIN")
f:RegisterEvent("PLAYER_ENTERING_WORLD")
f:RegisterEvent("PLAYER_LEVEL_UP")
f:RegisterEvent("QUEST_ACCEPTED")
f:RegisterEvent("QUEST_TURNED_IN")
f:RegisterEvent("QUEST_REMOVED")
f:RegisterEvent("QUEST_LOG_UPDATE")
f:RegisterEvent("ZONE_CHANGED_NEW_AREA")
local logThrottle = 0
f:SetScript("OnEvent", function(_, event, a1)
  if event == "PLAYER_LOGIN" then
    ns.opts(); ns.skipList()
    if not ns.data then
      msg("no quest data found. Build the addon with its data (see the README), or download the release zip.")
      return
    end
    loadCompleted()
    if ns.CreateUI then ns.CreateUI() end
    msg(string.format("%d Horde quests from ForeverDB.net (built %s). Type /fr to show or hide the route.", ns.data.quests or 0, ns.data.built or "?"))
  elseif event == "QUEST_TURNED_IN" then
    if a1 then completed[a1] = true end
    ns.RequestReplan(event)
  elseif event == "QUEST_LOG_UPDATE" then
    -- Fires often; objectives finishing matter, so check at most every 2 seconds.
    local now = GetTime()
    if now - logThrottle > 2 then logThrottle = now; ns.RequestReplan(event) end
  else
    ns.RequestReplan(event)
  end
end)

-- /fr commands
SLASH_FOREVERROUTE1, SLASH_FOREVERROUTE2 = "/fr", "/foreverroute"
SlashCmdList.FOREVERROUTE = function(input)
  local cmd, rest = (input or ""):lower():match("^%s*(%S*)%s*(.-)%s*$")
  local o = ns.opts()
  if cmd == "" or cmd == "show" or cmd == "hide" then
    if ns.ToggleUI then ns.ToggleUI(cmd) end
  elseif cmd == "skip" then
    local s = ns.steps[1]
    if s and s.q then ns.skipList()[s.q.id] = true; msg("skipping " .. s.q.title .. ". /fr unskip brings back everything you skipped.") end
    ns.Replan("skip")
  elseif cmd == "unskip" then
    ForeverRouteCharDB.skip = {}
    msg("skipped quests are back in the route.")
    ns.Replan("unskip")
  elseif cmd == "minxp" and tonumber(rest) then
    o.minXpPct = math.max(10, math.min(100, tonumber(rest)))
    msg("leaving out quests worth less than " .. o.minXpPct .. "% of their XP (100% = up to 5 levels below you).")
    ns.Replan("opts")
  elseif cmd == "above" and tonumber(rest) then
    o.maxAbove = math.max(0, math.min(6, tonumber(rest)))
    msg("taking quests up to " .. o.maxAbove .. " levels above you.")
    ns.Replan("opts")
  elseif cmd == "dungeons" or cmd == "group" or cmd == "arrow" or cmd == "pin" then
    local key = ({ dungeons = "dungeonQuests", group = "groupQuests", arrow = "arrow", pin = "mapPin" })[cmd]
    o[key] = not o[key]
    msg(cmd .. " " .. (o[key] and "on" or "off"))
    ns.Replan("opts")
  elseif cmd == "refresh" then
    loadCompleted(); ns.Replan("refresh")
  elseif cmd == "reset" then
    ForeverRouteDB = nil; ForeverRouteCharDB = nil
    ns.opts(); ns.skipList(); loadCompleted(); ns.Replan("reset")
    if ns.ResetUI then ns.ResetUI() end
    msg("settings reset.")
  else
    msg("/fr  show or hide | /fr skip  skip the current quest | /fr unskip | /fr minxp 60  lowest XP % worth doing |"
      .. " /fr above 3  levels above you | /fr dungeons | /fr group | /fr arrow | /fr pin | /fr refresh | /fr reset")
  end
end
