-- Forever Route window: the next steps, a summary of where the route takes you, and an arrow to the current step.

local _, ns = ...

local ROWS = 8
local frame, rows, header, sub, arrow
local currentKey

local KIND = {
  accept = "|cff33ff99Accept|r",
  ["do"] = "|cffffd100Do|r",
  turnin = "|cff4fc3f7Turn in|r",
  travel = "|cffff9f43Go to|r",
  abandon = "|cffff6b6bAbandon|r",
  grind = "|cffff9f43Grind|r",
}

local function coords(s)
  if not s.map or s.map == 0 then return "" end
  return string.format(" |cff9d9d9d(%s %.0f, %.0f)|r", ns.mapName(s.map), s.x, s.y)
end

function ns.StepText(s, long)
  local q = s.q
  if s.kind == "accept" then
    return string.format("%s %s |cff9d9d9d[%d]|r%s", KIND.accept, q.title, q.lv, long and (q.giver ~= "" and (" from " .. q.giver) or "") or "")
  elseif s.kind == "do" then
    return string.format("%s %s%s", KIND["do"], q.title, (q.om and q.om > 0) and "" or " |cff9d9d9d(spot unknown)|r")
  elseif s.kind == "turnin" then
    return string.format("%s %s%s |cff9d9d9d+%d XP|r", KIND.turnin, q.title, long and (q.ender ~= "" and (" to " .. q.ender) or "") or "", s.xp or 0)
  elseif s.kind == "travel" then
    return string.format("%s %s |cff9d9d9d(%d quests there)|r", KIND.travel, ns.mapName(s.map), s.count or 0)
  elseif s.kind == "abandon" then
    return string.format("%s %s |cff9d9d9d(too low now: %d XP)|r", KIND.abandon, q.title, s.xp or 0)
  elseif s.kind == "grind" then
    return string.format("%s or run a dungeon to level %d: no worthwhile quests left", KIND.grind, s.toLevel)
  end
  return "?"
end

local function tooltip(row)
  local s = row.step
  if not s then return end
  GameTooltip:SetOwner(row, "ANCHOR_LEFT")
  GameTooltip:AddLine(ns.StepText(s, true), 1, 1, 1, true)
  if s.q then
    local q = s.q
    GameTooltip:AddLine(string.format("Quest level %d (from level %d), %d XP at full value", q.lv, q.min, q.xp), 0.8, 0.8, 0.8)
    if s.kind == "do" and ns.log and ns.log[q.id] then
      for _, line in ipairs(ns.objectives(q.id)) do GameTooltip:AddLine(line) end
    end
    if q.flags:find("g") then GameTooltip:AddLine("Group quest", 1, 0.4, 0.4) end
  end
  if s.map and s.map > 0 then GameTooltip:AddLine((coords(s):gsub("^ ", "")), 0.6, 0.6, 0.6) end
  GameTooltip:AddLine(string.format("You'd be level %d by then (estimate)", s.level or 0), 0.5, 0.5, 0.5)
  if s.q then GameTooltip:AddLine("Right-click: skip this quest", 0.5, 0.8, 1) end
  GameTooltip:Show()
end

-- Map pin and TomTom for the current step (only when the step changes).
local function setWaypoint(s)
  local key = s and s.map and (s.kind .. (s.q and s.q.id or "") .. s.map .. s.x .. s.y)
  if key == currentKey then return end
  currentKey = key
  if not s or not s.map or s.map == 0 then return end
  local o = ns.opts()
  if o.mapPin and C_Map and C_Map.SetUserWaypoint and UiMapPoint and C_Map.CanSetUserWaypointOnMap and C_Map.CanSetUserWaypointOnMap(s.map) then
    pcall(function()
      C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(s.map, s.x / 100, s.y / 100))
      if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then C_SuperTrack.SetSuperTrackedUserWaypoint(true) end
    end)
  end
  if TomTom and TomTom.AddWaypoint then
    if ns.tomtom and TomTom.RemoveWaypoint then pcall(TomTom.RemoveWaypoint, TomTom, ns.tomtom) end
    local ok, uid = pcall(TomTom.AddWaypoint, TomTom, s.map, s.x / 100, s.y / 100, { title = "Forever Route: " .. ns.StepText(s):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""), persistent = false })
    ns.tomtom = ok and uid or nil
  end
end

function ns.UpdateUI()
  if not frame then return end
  local steps, sum = ns.steps or {}, ns.summary
  if sum then
    header:SetText(string.format("level %d to %d", sum.fromLevel, sum.toLevel))
    sub:SetText(string.format("next %d steps, about %d min of walking and objectives", #steps, sum.minutes))
  end
  for i = 1, ROWS do
    local r, s = rows[i], steps[i]
    r.step = s
    if s then
      r.text:SetText((i == 1 and "|cffffffff> |r" or "   ") .. ns.StepText(s, i == 1) .. (i == 1 and coords(s) or ""))
      r:Show()
    else
      r.text:SetText(i == 1 and "|cff9d9d9dNo steps: you may be past the quests the data knows.|r" or "")
    end
  end
  setWaypoint(steps[1])
end

local function makeButton(parent, label, w, onClick)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(w, 20)
  b:SetText(label)
  b:SetScript("OnClick", onClick)
  return b
end

local function createArrow()
  arrow = CreateFrame("Frame", "ForeverRouteArrow", UIParent)
  arrow:SetSize(64, 80)
  arrow:SetPoint("TOP", UIParent, "TOP", 0, -120)
  arrow:SetMovable(true); arrow:EnableMouse(true); arrow:RegisterForDrag("LeftButton")
  arrow:SetScript("OnDragStart", arrow.StartMoving)
  arrow:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local p, _, rp, x, y = self:GetPoint()
    ForeverRouteDB.arrowPos = { p, rp, x, y }
  end)
  arrow.tex = arrow:CreateTexture(nil, "ARTWORK")
  arrow.tex:SetTexture("Interface\\Minimap\\MinimapArrow")
  arrow.tex:SetSize(48, 48)
  arrow.tex:SetPoint("TOP")
  arrow.dist = arrow:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  arrow.dist:SetPoint("TOP", arrow.tex, "BOTTOM", 0, 2)
  local acc = 0
  arrow:SetScript("OnUpdate", function(self, elapsed)
    acc = acc + elapsed
    if acc < 0.05 then return end
    acc = 0
    local s = ns.steps and ns.steps[1]
    if not s or not s.map or s.map == 0 or not ns.opts().arrow then self.tex:Hide(); self.dist:SetText(""); return end
    local pos = ns.position()
    if not pos.map then self.tex:Hide(); return end
    local c1, px, py = ns.world(pos.map, pos.x, pos.y)
    local c2, tx, ty = ns.world(s.map, s.x, s.y)
    if not c1 or not c2 or c1 ~= c2 then
      self.tex:Hide()
      self.dist:SetText(ns.mapName(s.map))
      return
    end
    -- World X points north and world Y west; GetPlayerFacing is radians anticlockwise from north.
    local north, west = tx - px, ty - py
    local d = math.sqrt(north * north + west * west)
    local facing = GetPlayerFacing and GetPlayerFacing()
    if facing then
      self.tex:SetRotation(math.atan2(west, north) - facing)
      self.tex:Show()
    else
      self.tex:Hide()
    end
    if d < 12 then self.tex:SetVertexColor(0.3, 1, 0.3) else self.tex:SetVertexColor(1, 0.82, 0) end
    self.dist:SetText(string.format("%d yd", d))
  end)
  local p = ForeverRouteDB.arrowPos
  if p then arrow:ClearAllPoints(); arrow:SetPoint(p[1], UIParent, p[2], p[3], p[4]) end
end

function ns.CreateUI()
  if frame then return end
  frame = CreateFrame("Frame", "ForeverRouteFrame", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  frame:SetSize(400, 72 + ROWS * 18)
  frame:SetPoint("RIGHT", UIParent, "RIGHT", -60, 120)
  frame:SetFrameStrata("MEDIUM")
  frame:SetClampedToScreen(true)
  if frame.SetBackdrop then
    frame:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      tile = true, tileSize = 16, edgeSize = 14, insets = { left = 3, right = 3, top = 3, bottom = 3 } })
    frame:SetBackdropColor(0.05, 0.06, 0.08, 0.85)
    frame:SetBackdropBorderColor(0.3, 0.75, 0.97, 0.8)
  end
  frame:SetMovable(true); frame:EnableMouse(true); frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", frame.StartMoving)
  frame:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local p, _, rp, x, y = self:GetPoint()
    ForeverRouteDB.pos = { p, rp, x, y }
  end)

  local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOPLEFT", 10, -8)
  title:SetText("Forever Route")
  header = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  header:SetPoint("LEFT", title, "RIGHT", 10, 0)
  sub = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  sub:SetPoint("TOPLEFT", 10, -24)

  local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", 2, 2)
  close:SetScript("OnClick", function() ns.ToggleUI("hide") end)

  rows = {}
  for i = 1, ROWS do
    local r = CreateFrame("Button", nil, frame)
    r:SetSize(380, 18)
    r:SetPoint("TOPLEFT", 10, -40 - (i - 1) * 18)
    r.text = r:CreateFontString(nil, "OVERLAY", i == 1 and "GameFontHighlight" or "GameFontHighlightSmall")
    r.text:SetAllPoints()
    r.text:SetJustifyH("LEFT")
    r.text:SetWordWrap(false)
    r:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    r:SetScript("OnEnter", tooltip)
    r:SetScript("OnLeave", function() GameTooltip:Hide() end)
    r:SetScript("OnClick", function(self, button)
      if button == "RightButton" and self.step and self.step.q then
        ns.skipList()[self.step.q.id] = true
        ns.msg("skipping " .. self.step.q.title .. ". /fr unskip brings it back.")
        ns.Replan("skip")
      end
    end)
    rows[i] = r
  end

  local skip = makeButton(frame, "Skip", 60, function() SlashCmdList.FOREVERROUTE("skip") end)
  skip:SetPoint("BOTTOMLEFT", 8, 8)
  local refresh = makeButton(frame, "Refresh", 70, function() SlashCmdList.FOREVERROUTE("refresh") end)
  refresh:SetPoint("LEFT", skip, "RIGHT", 4, 0)
  local credit = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  credit:SetPoint("BOTTOMRIGHT", -10, 12)
  credit:SetText("Data from ForeverDB.net")

  local p = ForeverRouteDB.pos
  if p then frame:ClearAllPoints(); frame:SetPoint(p[1], UIParent, p[2], p[3], p[4]) end
  createArrow()
  if ForeverRouteDB.hidden then frame:Hide(); arrow:Hide() end
  ns.RequestReplan("login")
end

function ns.ToggleUI(cmd)
  if not frame then return end
  local show = cmd == "show" or (cmd ~= "hide" and not frame:IsShown())
  frame:SetShown(show)
  arrow:SetShown(show)
  ForeverRouteDB.hidden = not show
  if show then ns.Replan("show") end
end

function ns.ResetUI()
  if not frame then return end
  frame:ClearAllPoints(); frame:SetPoint("RIGHT", UIParent, "RIGHT", -60, 120)
  arrow:ClearAllPoints(); arrow:SetPoint("TOP", UIParent, "TOP", 0, -120)
  frame:Show(); arrow:Show()
end
