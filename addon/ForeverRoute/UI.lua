-- Forever Route window: a card for the step you're on (with its objectives from your quest log), the steps after it
-- grouped by zone, your XP bar with where the route takes you, an arrow to the current step and a minimap button.

local _, ns = ...

local W = 340            -- window width
local ROW_H = 20
local MAX_ROWS = 12
local C = {              -- colours
  bg = { 0.035, 0.04, 0.055 }, card = { 0.09, 0.1, 0.13 }, line = { 0.18, 0.2, 0.25 },
  accent = { 0.31, 0.76, 0.97 }, gold = { 1, 0.82, 0 }, dim = { 0.55, 0.58, 0.63 },
}
local KIND = {
  accept  = { label = "Accept",  icon = "Interface\\GossipFrame\\AvailableQuestIcon", color = { 1, 0.82, 0 } },
  ["do"]  = { label = "Do",      icon = "Interface\\Icons\\Ability_DualWield",       color = { 0.95, 0.45, 0.3 } },
  turnin  = { label = "Turn in", icon = "Interface\\GossipFrame\\ActiveQuestIcon",    color = { 0.35, 0.85, 0.45 } },
  travel  = { label = "Go to",   icon = "Interface\\Icons\\INV_Misc_Map_01",          color = { 0.31, 0.76, 0.97 } },
  abandon = { label = "Abandon", icon = "Interface\\Buttons\\UI-GroupLoot-Pass-Up",   color = { 1, 0.35, 0.35 } },
  grind   = { label = "Grind",   icon = "Interface\\Icons\\Ability_Warrior_BattleShout", color = { 0.75, 0.55, 1 } },
}
local DONE_ICON = "Interface\\RaidFrame\\ReadyCheck-Ready"
local ARROW_TEX = "Interface\\Minimap\\MinimapArrow"

local frame, arrow, minimapButton, toast
local currentKey

local function hex(c) return string.format("|cff%02x%02x%02x", c[1] * 255, c[2] * 255, c[3] * 255) end
local function plain(s) return (s or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "") end

-- Quest difficulty colour, like the quest log's.
local function questColor(qlv)
  local lv = UnitLevel("player") or 1
  if GetQuestDifficultyColor then
    local c = GetQuestDifficultyColor(qlv)
    if c then return { c.r, c.g, c.b } end
  end
  local d = qlv - lv
  if d >= 5 then return { 1, 0.1, 0.1 } elseif d >= 3 then return { 1, 0.5, 0.25 } elseif d >= -2 then return { 1, 0.82, 0 }
  elseif qlv >= ns.greyBelow(lv) then return { 0.25, 0.75, 0.25 } end
  return { 0.5, 0.5, 0.5 }
end

local function fmtTime(sec)
  sec = math.max(0, sec or 0)
  if sec < 60 then return string.format("%ds", sec) end
  if sec < 3600 then return string.format("%d min", math.floor(sec / 60 + 0.5)) end
  return string.format("%dh %02dm", math.floor(sec / 3600), math.floor(sec % 3600 / 60))
end

local function stepTitle(s)
  if s.q then return s.q.title end
  if s.kind == "travel" then return ns.mapName(s.map) end
  if s.kind == "grind" then return "Grind or run a dungeon" end
  return "?"
end

local function stepDetail(s)
  local q = s.q
  if s.kind == "accept" then return q.giver ~= "" and ("from " .. q.giver) or "" end
  if s.kind == "turnin" then return q.ender ~= "" and ("to " .. q.ender) or "" end
  if s.kind == "do" then return (q.om and q.om > 0) and "objectives" or "objectives (the data has no spot for them: see your quest log)" end
  if s.kind == "travel" then return string.format("%d worthwhile quests start there", s.count or 0) end
  if s.kind == "abandon" then return string.format("too low now: %d XP left in it", s.xp or 0) end
  if s.kind == "grind" then return string.format("no worthwhile quests left until level %d", s.toLevel or 0) end
  return ""
end

-- Kept for Core's messages and the tests: one line of text for a step.
function ns.StepText(s, long)
  local k = KIND[s.kind] or KIND.grind
  local text = hex(k.color) .. k.label .. "|r " .. stepTitle(s)
  if s.q and s.kind ~= "abandon" then text = text .. " |cff9d9d9d[" .. s.q.lv .. "]|r" end
  if s.kind == "turnin" and s.xp then text = text .. " |cff9d9d9d+" .. s.xp .. " XP|r" end
  if long then local d = stepDetail(s); if d ~= "" then text = text .. " |cff9d9d9d" .. d .. "|r" end end
  return text
end

local function coords(s)
  if not s.map or s.map == 0 then return "" end
  return string.format("%s  %.0f, %.0f", ns.mapName(s.map), s.x, s.y)
end

-- ---------------------------------------------------------------- building blocks

local function fill(parent, layer, c, a)
  local t = parent:CreateTexture(nil, layer or "BACKGROUND")
  t:SetColorTexture(c[1], c[2], c[3], a or 1)
  return t
end

local function iconButton(parent, texture, size, tip, onClick)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(size, size)
  b.icon = b:CreateTexture(nil, "ARTWORK")
  b.icon:SetAllPoints()
  b.icon:SetTexture(texture)
  b.icon:SetVertexColor(0.75, 0.78, 0.82)
  b:SetScript("OnEnter", function(self)
    self.icon:SetVertexColor(1, 1, 1)
    GameTooltip:SetOwner(self, "ANCHOR_TOP"); GameTooltip:AddLine(tip, 1, 1, 1); GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function(self) self.icon:SetVertexColor(0.75, 0.78, 0.82); GameTooltip:Hide() end)
  b:SetScript("OnClick", onClick)
  return b
end

local function textButton(parent, label, w, onClick)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(w, 18)
  b.bg = fill(b, "BACKGROUND", C.line, 1)
  b.bg:SetAllPoints()
  b.text = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  b.text:SetPoint("CENTER")
  b.text:SetText(label)
  b:SetScript("OnEnter", function(self) self.bg:SetColorTexture(C.accent[1] * 0.55, C.accent[2] * 0.55, C.accent[3] * 0.55, 1) end)
  b:SetScript("OnLeave", function(self) self.bg:SetColorTexture(C.line[1], C.line[2], C.line[3], 1) end)
  b:SetScript("OnClick", onClick)
  return b
end

-- ---------------------------------------------------------------- tooltip and waypoint

local function showTooltip(owner, s)
  if not s then return end
  GameTooltip:SetOwner(owner, "ANCHOR_LEFT")
  local k = KIND[s.kind] or KIND.grind
  GameTooltip:AddLine(hex(k.color) .. k.label .. "|r " .. stepTitle(s), 1, 1, 1, true)
  local d = stepDetail(s)
  if d ~= "" then GameTooltip:AddLine(d, 0.8, 0.8, 0.8, true) end
  if s.q then
    local q, c = s.q, questColor(s.q.lv)
    GameTooltip:AddDoubleLine("Quest level", q.lv .. "  (from " .. q.min .. ")", 0.6, 0.6, 0.6, c[1], c[2], c[3])
    GameTooltip:AddDoubleLine("XP", (s.xp and (s.xp .. " now") or (q.xp .. " at full value")), 0.6, 0.6, 0.6, 1, 1, 1)
    if q.flags:find("g") then GameTooltip:AddLine("Group quest", 1, 0.4, 0.4) end
    if ns.log and ns.log[q.id] then
      for _, o in ipairs(ns.objectives(q.id)) do
        GameTooltip:AddLine((o.finished and "|cff808080" or "|cffffffff") .. "- " .. o.text .. "|r")
      end
    end
  end
  if s.map and s.map > 0 then GameTooltip:AddDoubleLine("Where", coords(s), 0.6, 0.6, 0.6, 1, 1, 1) end
  if s.level then GameTooltip:AddDoubleLine("By then", "level " .. s.level .. " (estimate)", 0.6, 0.6, 0.6, 0.8, 0.8, 0.8) end
  if s.q then GameTooltip:AddLine("Right-click to skip this quest", 0.31, 0.76, 0.97) end
  GameTooltip:Show()
end

-- A "do" step whose objective spot the data doesn't know: no arrow or pin, rather than pointing at the quest giver.
local function spotUnknown(s)
  return s and s.kind == "do" and s.q and not (s.q.om and s.q.om > 0)
end

local function setWaypoint(s)
  local key = s and s.map and (s.kind .. (s.q and s.q.id or "") .. s.map .. s.x .. s.y)
  if key == currentKey then return end
  currentKey = key
  if not s or not s.map or s.map == 0 or spotUnknown(s) then return end
  local o = ns.opts()
  if o.mapPin and C_Map and C_Map.SetUserWaypoint and UiMapPoint and C_Map.CanSetUserWaypointOnMap and C_Map.CanSetUserWaypointOnMap(s.map) then
    pcall(function()
      C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(s.map, s.x / 100, s.y / 100))
      if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then C_SuperTrack.SetSuperTrackedUserWaypoint(true) end
    end)
  end
  if TomTom and TomTom.AddWaypoint then
    if ns.tomtom and TomTom.RemoveWaypoint then pcall(TomTom.RemoveWaypoint, TomTom, ns.tomtom) end
    local ok, uid = pcall(TomTom.AddWaypoint, TomTom, s.map, s.x / 100, s.y / 100, { title = "Forever Route: " .. plain(ns.StepText(s)), persistent = false })
    ns.tomtom = ok and uid or nil
  end
end

local function skipStep(s)
  if s and s.q then
    ns.skipList()[s.q.id] = true
    ns.msg("skipping " .. s.q.title .. ". /fr unskip brings it back.")
    ns.Replan("skip")
  end
end

-- ---------------------------------------------------------------- the window

local function makeRow(parent)
  local r = CreateFrame("Button", nil, parent)
  r:SetHeight(ROW_H)
  r.hl = fill(r, "BACKGROUND", C.accent, 0)
  r.hl:SetAllPoints()
  r.icon = r:CreateTexture(nil, "ARTWORK")
  r.icon:SetSize(14, 14)
  r.icon:SetPoint("LEFT", 8, 0)
  r.text = r:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  r.text:SetPoint("LEFT", r.icon, "RIGHT", 6, 0)
  r.text:SetPoint("RIGHT", -64, 0)
  r.text:SetJustifyH("LEFT")
  r.text:SetWordWrap(false)
  r.right = r:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  r.right:SetPoint("RIGHT", -8, 0)
  r.right:SetJustifyH("RIGHT")
  r.sep = r:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  r.sep:SetPoint("LEFT", 8, -2)
  r.sepLine = fill(r, "ARTWORK", C.line, 1)
  r.sepLine:SetHeight(1)
  r.sepLine:SetPoint("LEFT", r.sep, "RIGHT", 6, 0)
  r.sepLine:SetPoint("RIGHT", -8, -2)
  r:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  r:SetScript("OnEnter", function(self) if self.step then self.hl:SetAlpha(0.12); showTooltip(self, self.step) end end)
  r:SetScript("OnLeave", function(self) self.hl:SetAlpha(0); GameTooltip:Hide() end)
  r:SetScript("OnClick", function(self, button) if button == "RightButton" then skipStep(self.step) end end)
  return r
end

local function setRowStep(r, s, i)
  r.step = s
  r.sep:Hide(); r.sepLine:Hide()
  r.icon:Show(); r.text:Show(); r.right:Show()
  local k = KIND[s.kind] or KIND.grind
  r.icon:SetTexture(k.icon)
  r.icon:SetVertexColor(1, 1, 1)
  local lv = ""
  if s.q and s.kind ~= "abandon" then lv = " " .. hex(questColor(s.q.lv)) .. "[" .. s.q.lv .. "]|r" end
  r.text:SetText(hex(k.color) .. k.label .. "|r  " .. stepTitle(s) .. lv)
  if s.kind == "turnin" and s.xp then r.right:SetText("|cff7fd88a+" .. s.xp .. "|r")
  elseif s.kind == "travel" then r.right:SetText(fmtTime(s.time and ns.steps[i - 1] and (s.time - (ns.steps[i - 1].time or 0)) or 0))
  else r.right:SetText("") end
end

local function setRowSeparator(r, label)
  r.step = nil
  r.icon:Hide(); r.text:Hide(); r.right:Hide()
  r.sep:SetText(label); r.sep:Show(); r.sepLine:Show()
end

local function createWindow()
  frame = CreateFrame("Frame", "ForeverRouteFrame", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  frame:SetSize(W, 200)
  frame:SetPoint("RIGHT", UIParent, "RIGHT", -60, 120)
  frame:SetFrameStrata("MEDIUM")
  frame:SetClampedToScreen(true)
  if frame.SetBackdrop then
    frame:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8X8", edgeFile = "Interface\\Buttons\\WHITE8X8", edgeSize = 1 })
    frame:SetBackdropBorderColor(0, 0, 0, 1)
  end
  frame:SetMovable(true); frame:EnableMouse(true); frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", function(self) if not ns.opts().locked then self:StartMoving() end end)
  frame:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local p, _, rp, x, y = self:GetPoint()
    ForeverRouteDB.pos = { p, rp, x, y }
  end)

  -- Header: title, zone, buttons.
  local head = CreateFrame("Frame", nil, frame)
  head:SetPoint("TOPLEFT", 1, -1); head:SetPoint("TOPRIGHT", -1, -1); head:SetHeight(24)
  local hb = fill(head, "BACKGROUND", C.card, 1); hb:SetAllPoints()
  local stripe = fill(head, "ARTWORK", C.accent, 1)
  stripe:SetPoint("BOTTOMLEFT"); stripe:SetPoint("BOTTOMRIGHT"); stripe:SetHeight(1)
  local logo = head:CreateTexture(nil, "ARTWORK")
  logo:SetSize(16, 16); logo:SetPoint("LEFT", 6, 0)
  logo:SetTexture("Interface\\Icons\\INV_Misc_Map_01"); logo:SetTexCoord(0.08, 0.92, 0.08, 0.92)
  local title = head:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("LEFT", logo, "RIGHT", 6, 0)
  title:SetText("Forever Route")
  frame.zone = head:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  frame.zone:SetPoint("LEFT", title, "RIGHT", 8, 0)
  local close = iconButton(head, "Interface\\Buttons\\UI-StopButton", 14, "Hide (/fr)", function() ns.ToggleUI("hide") end)
  close:SetPoint("RIGHT", -6, 0)
  local cog = iconButton(head, "Interface\\Buttons\\UI-OptionsButton", 14, "Settings", function() if ns.ToggleSettings then ns.ToggleSettings() end end)
  cog:SetPoint("RIGHT", close, "LEFT", -6, 0)
  frame.collapse = iconButton(head, "Interface\\Buttons\\UI-MinusButton-Up", 14, "Show only the current step", function()
    local o = ns.opts(); o.collapsed = not o.collapsed; ns.UpdateUI()
  end)
  frame.collapse:SetPoint("RIGHT", cog, "LEFT", -6, 0)

  -- XP bar: your XP now and rested; the text says where the route takes you.
  local bar = CreateFrame("StatusBar", nil, frame)
  bar:SetPoint("TOPLEFT", head, "BOTTOMLEFT", 8, -8); bar:SetPoint("TOPRIGHT", head, "BOTTOMRIGHT", -8, -8)
  bar:SetHeight(14)
  bar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
  bar:SetStatusBarColor(0.58, 0.0, 0.55)
  bar:SetMinMaxValues(0, 1)
  local bbg = fill(bar, "BACKGROUND", { 0, 0, 0 }, 0.6); bbg:SetAllPoints()
  bar.rested = bar:CreateTexture(nil, "BORDER")
  bar.rested:SetTexture("Interface\\TargetingFrame\\UI-StatusBar")
  bar.rested:SetVertexColor(0.0, 0.39, 0.88, 0.6)
  bar.rested:SetPoint("TOPLEFT"); bar.rested:SetPoint("BOTTOMLEFT")
  bar.text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  bar.text:SetPoint("CENTER", 0, 0)
  frame.bar = bar
  frame.plan = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  frame.plan:SetPoint("TOPLEFT", bar, "BOTTOMLEFT", 0, -4)
  frame.plan:SetPoint("TOPRIGHT", bar, "BOTTOMRIGHT", 0, -4)
  frame.plan:SetJustifyH("LEFT")

  -- Card for the current step.
  local card = CreateFrame("Button", nil, frame)
  card:SetPoint("TOPLEFT", frame.plan, "BOTTOMLEFT", 0, -6)
  card:SetPoint("TOPRIGHT", frame.plan, "BOTTOMRIGHT", 0, -6)
  card:SetHeight(64)
  card.bg = fill(card, "BACKGROUND", C.card, 1); card.bg:SetAllPoints()
  card.stripe = card:CreateTexture(nil, "ARTWORK")
  card.stripe:SetPoint("TOPLEFT"); card.stripe:SetPoint("BOTTOMLEFT"); card.stripe:SetWidth(3)
  card.icon = card:CreateTexture(nil, "ARTWORK")
  card.icon:SetSize(30, 30); card.icon:SetPoint("TOPLEFT", 10, -8)
  card.kind = card:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  card.kind:SetPoint("TOPLEFT", card.icon, "TOPRIGHT", 8, 1)
  card.dist = card:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  card.dist:SetPoint("TOPRIGHT", -8, -7)
  card.title = card:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  card.title:SetPoint("TOPLEFT", card.kind, "BOTTOMLEFT", 0, -2)
  card.title:SetPoint("RIGHT", -8, 0)
  card.title:SetJustifyH("LEFT"); card.title:SetWordWrap(false)
  card.detail = card:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  card.detail:SetPoint("TOPLEFT", card.title, "BOTTOMLEFT", 0, -2)
  card.detail:SetPoint("RIGHT", -8, 0)
  card.detail:SetJustifyH("LEFT"); card.detail:SetWordWrap(false)
  card.obj = {}
  for i = 1, 4 do
    local t = card:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    t:SetPoint("TOPLEFT", i == 1 and card.detail or card.obj[i - 1], "BOTTOMLEFT", 0, -3)
    t:SetPoint("RIGHT", -8, 0)
    t:SetJustifyH("LEFT"); t:SetWordWrap(false)
    card.obj[i] = t
  end
  card:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  card:SetScript("OnEnter", function(self) showTooltip(self, ns.steps and ns.steps[1]) end)
  card:SetScript("OnLeave", function() GameTooltip:Hide() end)
  card:SetScript("OnClick", function(_, button) if button == "RightButton" then skipStep(ns.steps and ns.steps[1]) end end)
  frame.card = card

  -- The banner for level ups that dropped quests.
  toast = CreateFrame("Frame", nil, frame)
  toast:SetPoint("BOTTOMLEFT", frame, "TOPLEFT", 0, 4); toast:SetPoint("BOTTOMRIGHT", frame, "TOPRIGHT", 0, 4)
  toast:SetHeight(22)
  local tb = fill(toast, "BACKGROUND", { 0.12, 0.09, 0.02 }, 0.95); tb:SetAllPoints()
  local tl = fill(toast, "ARTWORK", C.gold, 1); tl:SetPoint("TOPLEFT"); tl:SetPoint("BOTTOMLEFT"); tl:SetWidth(3)
  toast.text = toast:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  toast.text:SetPoint("LEFT", 10, 0); toast.text:SetPoint("RIGHT", -8, 0); toast.text:SetJustifyH("LEFT")
  toast:Hide()

  frame.nextLabel = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  frame.nextLabel:SetPoint("TOPLEFT", card, "BOTTOMLEFT", 0, -8)
  frame.nextLabel:SetText("NEXT")
  frame.rows = {}
  for i = 1, MAX_ROWS + 4 do
    local r = makeRow(frame)
    r:SetPoint("LEFT", frame, "LEFT", 1, 0); r:SetPoint("RIGHT", frame, "RIGHT", -1, 0)
    frame.rows[i] = r
  end

  -- Footer.
  local skip = textButton(frame, "Skip quest", 74, function() skipStep(ns.steps and ns.steps[1]) end)
  skip:SetPoint("BOTTOMLEFT", 8, 8)
  local refresh = textButton(frame, "Refresh", 60, function() SlashCmdList.FOREVERROUTE("refresh") end)
  refresh:SetPoint("LEFT", skip, "RIGHT", 4, 0)
  frame.footer = { skip, refresh }
  frame.credit = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  frame.credit:SetPoint("BOTTOMRIGHT", -8, 11)
  frame.credit:SetText("Data from ForeverDB.net and QuestieDB")

  local p = ForeverRouteDB.pos
  if p then frame:ClearAllPoints(); frame:SetPoint(p[1], UIParent, p[2], p[3], p[4]) end
end

function ns.Toast(text)
  if not toast then return end
  toast.text:SetText(text)
  toast:Show()
  toast.until_ = GetTime() + 8
  C_Timer.After(8.2, function() if toast.until_ and GetTime() >= toast.until_ then toast:Hide() end end)
end

local function updateBar()
  local bar = frame.bar
  local xp, max = UnitXP("player") or 0, UnitXPMax("player") or 1
  if max <= 0 then max = 1 end
  bar:SetValue(xp / max)
  local rested = GetXPExhaustion and GetXPExhaustion() or 0
  local w = bar:GetWidth() or (W - 18)
  if rested and rested > 0 and w > 0 then
    bar.rested:SetWidth(math.max(1, math.min(1, (xp + rested) / max) * w)); bar.rested:Show()
  else
    bar.rested:Hide()
  end
  bar.text:SetText(string.format("Level %d   %d / %d   %d%%%s", UnitLevel("player") or 0, xp, max, math.floor(xp / max * 100),
    (rested and rested > 0) and ("   |cff6fb7ffrested " .. rested .. "|r") or ""))
end

local function updateCard(s)
  local card = frame.card
  if not s then
    card.stripe:SetColorTexture(C.dim[1], C.dim[2], C.dim[3], 1)
    card.icon:SetTexture(DONE_ICON)
    card.kind:SetText("|cff9d9d9dNOTHING TO DO|r")
    card.title:SetText("No worthwhile quests the data knows")
    card.detail:SetText("Try /fr minxp 40, /fr dungeons, or grind a level")
    card.dist:SetText("")
    for _, t in ipairs(card.obj) do t:SetText("") end
    card:SetHeight(58)
    return
  end
  local k = KIND[s.kind] or KIND.grind
  card.stripe:SetColorTexture(k.color[1], k.color[2], k.color[3], 1)
  card.icon:SetTexture(k.icon)
  local lv = s.q and s.kind ~= "abandon" and ("  " .. hex(questColor(s.q.lv)) .. "level " .. s.q.lv .. "|r") or ""
  local xp = (s.kind == "turnin" and s.xp) and ("  |cff7fd88a+" .. s.xp .. " XP|r") or ""
  card.kind:SetText(hex(k.color) .. k.label:upper() .. "|r" .. lv .. xp)
  card.title:SetText(stepTitle(s))
  local detail = stepDetail(s)
  local where = spotUnknown(s) and "" or coords(s)
  card.detail:SetText(detail ~= "" and where ~= "" and (detail .. "  -  " .. where) or (detail .. where))
  local lines = {}
  if s.q and ns.log and ns.log[s.q.id] and (s.kind == "do" or s.kind == "turnin") then
    for _, o in ipairs(ns.objectives(s.q.id)) do
      lines[#lines + 1] = (o.finished and "|cff7fd88a" .. "+ " or "|cffffffff- ") .. o.text .. "|r"
    end
  end
  local n = math.min(#lines, #card.obj)
  for i, t in ipairs(card.obj) do t:SetText(lines[i] or "") end
  card:SetHeight(58 + n * 14)
end

function ns.UpdateUI()
  if not frame then return end
  local o = ns.opts()
  frame:SetScale(o.scale or 1)
  if frame.SetBackdropColor then frame:SetBackdropColor(C.bg[1], C.bg[2], C.bg[3], o.alpha or 0.92) end
  local steps, sum = ns.steps or {}, ns.summary
  local pos = ns.position()
  frame.zone:SetText(pos.map and ns.mapName(pos.map) or "")
  updateBar()
  if sum then
    local last = steps[#steps]
    frame.plan:SetText(string.format("Route: level %d%s in about %s, %d steps planned", sum.toLevel,
      (sum.toLevel > sum.fromLevel and last and last.levelPct) and (" (" .. last.levelPct .. "%)") or "", fmtTime(last and last.time or 0), #steps))
  else
    frame.plan:SetText("")
  end
  updateCard(steps[1])
  frame.collapse.icon:SetTexture(o.collapsed and "Interface\\Buttons\\UI-PlusButton-Up" or "Interface\\Buttons\\UI-MinusButton-Up")

  -- Upcoming steps, with a line where the route changes zone.
  local used, y = 0, 0
  local rows = frame.rows
  local want = o.collapsed and 0 or math.min(o.rows or 6, MAX_ROWS)
  frame.nextLabel:SetShown(want > 0 and #steps > 1)
  local function nextRow()
    used = used + 1
    local r = rows[used]
    r:ClearAllPoints()
    r:SetPoint("TOPLEFT", frame.nextLabel, "BOTTOMLEFT", -8, -4 - y)
    r:SetPoint("RIGHT", frame, "RIGHT", -1, 0)
    r:Show()
    y = y + ROW_H
    return r
  end
  local prevMap = steps[1] and steps[1].map
  local shown = 0
  for i = 2, #steps do
    if shown >= want or used >= #rows - 1 then break end
    local s = steps[i]
    if s.map and prevMap and s.map ~= prevMap and s.kind ~= "travel" then
      setRowSeparator(nextRow(), ns.mapName(s.map):upper())
    end
    setRowStep(nextRow(), s, i)
    shown = shown + 1
    if s.map then prevMap = s.map end
  end
  for i = used + 1, #rows do rows[i]:Hide(); rows[i].step = nil end

  local h = 24 + 8 + 14 + 4 + 12 + 6 + frame.card:GetHeight() + 8
  if used > 0 then h = h + 14 + y end
  h = h + 36
  frame:SetHeight(h)
  setWaypoint(steps[1])
end

-- ---------------------------------------------------------------- the arrow

local function createArrow()
  arrow = CreateFrame("Frame", "ForeverRouteArrow", UIParent)
  arrow:SetSize(120, 92)
  arrow:SetPoint("TOP", UIParent, "TOP", 0, -110)
  arrow:SetMovable(true); arrow:EnableMouse(true); arrow:RegisterForDrag("LeftButton")
  arrow:SetScript("OnDragStart", function(self) if not ns.opts().locked then self:StartMoving() end end)
  arrow:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local p, _, rp, x, y = self:GetPoint()
    ForeverRouteDB.arrowPos = { p, rp, x, y }
  end)
  arrow:SetScript("OnEnter", function(self) showTooltip(self, ns.steps and ns.steps[1]) end)
  arrow:SetScript("OnLeave", function() GameTooltip:Hide() end)
  arrow.glow = arrow:CreateTexture(nil, "BACKGROUND")
  arrow.glow:SetTexture("Interface\\Cooldown\\star4")
  arrow.glow:SetBlendMode("ADD")
  arrow.glow:SetSize(70, 70); arrow.glow:SetPoint("TOP", 0, 8); arrow.glow:SetAlpha(0)
  arrow.tex = arrow:CreateTexture(nil, "ARTWORK")
  arrow.tex:SetTexture(ARROW_TEX)
  arrow.tex:SetSize(52, 52)
  arrow.tex:SetPoint("TOP")
  arrow.title = arrow:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  arrow.title:SetPoint("TOP", arrow.tex, "BOTTOM", 0, 0)
  arrow.title:SetWidth(220); arrow.title:SetWordWrap(false)
  arrow.dist = arrow:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  arrow.dist:SetPoint("TOP", arrow.title, "BOTTOM", 0, -2)
  local acc, t = 0, 0
  arrow:SetScript("OnUpdate", function(self, elapsed)
    acc, t = acc + elapsed, t + elapsed
    if acc < 0.04 then return end
    acc = 0
    local s = ns.steps and ns.steps[1]
    if spotUnknown(s) and ns.opts().arrow then
      self.tex:Hide(); self.glow:SetAlpha(0)
      self.title:SetText("|cffffd100Do|r " .. stepTitle(s))
      self.dist:SetText("|cff9d9d9dspot unknown: see your quest log|r")
      return
    end
    if not s or not s.map or s.map == 0 or not ns.opts().arrow then
      self.tex:Hide(); self.glow:SetAlpha(0); self.title:SetText(""); self.dist:SetText(""); return
    end
    local k = KIND[s.kind] or KIND.grind
    self.title:SetText(hex(k.color) .. k.label .. "|r " .. stepTitle(s))
    local pos = ns.position()
    local c1, px, py
    if pos.map then c1, px, py = ns.world(pos.map, pos.x, pos.y) end
    local c2, tx, ty = ns.world(s.map, s.x, s.y)
    if not c1 or not c2 or c1 ~= c2 then
      self.tex:Hide(); self.glow:SetAlpha(0)
      self.dist:SetText("|cff9d9d9d" .. ns.mapName(s.map) .. "|r")
      return
    end
    -- World X points north and world Y west; GetPlayerFacing is radians anticlockwise from north.
    local north, west = tx - px, ty - py
    local d = math.sqrt(north * north + west * west)
    if d < 12 then
      self.tex:SetTexture(DONE_ICON); self.tex:SetRotation(0); self.tex:SetVertexColor(1, 1, 1); self.tex:Show()
      self.glow:SetAlpha(0.35 + 0.25 * math.sin(t * 4))
      self.dist:SetText("|cff7fd88ahere|r")
      return
    end
    self.tex:SetTexture(ARROW_TEX)
    self.glow:SetAlpha(0)
    local facing = GetPlayerFacing and GetPlayerFacing()
    if facing then
      local angle = math.atan2(west, north) - facing
      self.tex:SetRotation(angle)
      -- Green when you're heading straight for it, gold to red as you turn away.
      local off = math.abs((angle + math.pi) % (2 * math.pi) - math.pi) / math.pi
      if off < 0.1 then self.tex:SetVertexColor(0.3, 1, 0.35)
      else self.tex:SetVertexColor(1, 0.82 - 0.6 * off, 0.1) end
      self.tex:Show()
    else
      self.tex:Hide()
    end
    local speed = (GetUnitSpeed and GetUnitSpeed("player")) or 0
    if speed < 1 then speed = 7 end
    self.dist:SetText(string.format("%d yd  |cff9d9d9d~%s|r", d, fmtTime(d / speed)))
  end)
  local p = ForeverRouteDB.arrowPos
  if p then arrow:ClearAllPoints(); arrow:SetPoint(p[1], UIParent, p[2], p[3], p[4]) end
end

-- ---------------------------------------------------------------- minimap button

local function createMinimapButton()
  if not Minimap then return end
  local b = CreateFrame("Button", "ForeverRouteMinimapButton", Minimap)
  b:SetSize(31, 31)
  b:SetFrameStrata("MEDIUM")
  b:SetFrameLevel(8)
  b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  b:RegisterForDrag("LeftButton")
  local icon = b:CreateTexture(nil, "BACKGROUND")
  icon:SetSize(20, 20); icon:SetPoint("CENTER", 0, 1)
  icon:SetTexture("Interface\\Icons\\INV_Misc_Map_01")
  icon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
  local border = b:CreateTexture(nil, "OVERLAY")
  border:SetSize(53, 53); border:SetPoint("TOPLEFT")
  border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
  local function place()
    local a = math.rad(ns.opts().minimapAngle or 215)
    local r = (Minimap:GetWidth() or 140) / 2 + 5
    b:ClearAllPoints()
    b:SetPoint("CENTER", Minimap, "CENTER", math.cos(a) * r, math.sin(a) * r)
  end
  b:SetScript("OnDragStart", function(self)
    self:SetScript("OnUpdate", function()
      local mx, my = Minimap:GetCenter()
      local cx, cy = GetCursorPosition()
      local s = Minimap:GetEffectiveScale()
      ns.opts().minimapAngle = math.deg(math.atan2(cy / s - my, cx / s - mx))
      place()
    end)
  end)
  b:SetScript("OnDragStop", function(self) self:SetScript("OnUpdate", nil) end)
  b:SetScript("OnClick", function(_, button)
    if button == "RightButton" then if ns.ToggleSettings then ns.ToggleSettings() end else ns.ToggleUI() end
  end)
  b:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    GameTooltip:AddLine("Forever Route", 0.31, 0.76, 0.97)
    local s = ns.steps and ns.steps[1]
    if s then GameTooltip:AddLine(plain(ns.StepText(s)), 1, 1, 1, true) end
    GameTooltip:AddLine("Left-click: show or hide   Right-click: settings   Drag: move", 0.6, 0.6, 0.6, true)
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() GameTooltip:Hide() end)
  place()
  minimapButton = b
  ns.UpdateMinimapButton()
end

function ns.UpdateMinimapButton()
  if minimapButton then minimapButton:SetShown(ns.opts().minimap ~= false) end
end

-- ---------------------------------------------------------------- show, hide, reset

function ns.CreateUI()
  if frame then return end
  createWindow()
  createArrow()
  createMinimapButton()
  if ForeverRouteDB.hidden then frame:Hide(); arrow:Hide() end
  -- Keep the XP bar and zone name current between plans.
  local tick = CreateFrame("Frame")
  tick:RegisterEvent("PLAYER_XP_UPDATE")
  tick:RegisterEvent("UPDATE_EXHAUSTION")
  tick:SetScript("OnEvent", function() if frame:IsShown() then updateBar() end end)
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
  arrow:ClearAllPoints(); arrow:SetPoint("TOP", UIParent, "TOP", 0, -110)
  frame:Show(); arrow:Show()
  ns.UpdateMinimapButton()
  ns.UpdateUI()
end
