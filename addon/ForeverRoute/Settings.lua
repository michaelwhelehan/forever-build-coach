-- Forever Route settings window (/fr options, the cog in the route window, or right-click the minimap button).

local _, ns = ...

local panel
local C = { bg = { 0.035, 0.04, 0.055 }, card = { 0.09, 0.1, 0.13 }, line = { 0.18, 0.2, 0.25 }, accent = { 0.31, 0.76, 0.97 } }

local function fill(parent, layer, c, a)
  local t = parent:CreateTexture(nil, layer or "BACKGROUND")
  t:SetColorTexture(c[1], c[2], c[3], a or 1)
  return t
end

local function changed(replan)
  if replan then ns.Replan("settings") elseif ns.UpdateUI then ns.UpdateUI() end
  if ns.UpdateMinimapButton then ns.UpdateMinimapButton() end
end

local function checkbox(parent, label, help, key, replan)
  local b = CreateFrame("CheckButton", nil, parent, "UICheckButtonTemplate")
  b:SetSize(22, 22)
  b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  b.label:SetPoint("LEFT", b, "RIGHT", 2, 0)
  b.label:SetText(label)
  b:SetScript("OnShow", function(self) self:SetChecked(ns.opts()[key] and true or false) end)
  b:SetScript("OnClick", function(self)
    ns.opts()[key] = self:GetChecked() and true or false
    changed(replan)
  end)
  b:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT"); GameTooltip:AddLine(label, 1, 1, 1); GameTooltip:AddLine(help, 0.8, 0.8, 0.8, true); GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() GameTooltip:Hide() end)
  return b
end

-- A slider built from plain textures, so it doesn't depend on templates that differ between clients.
local function slider(parent, label, help, key, lo, hi, step, fmt, replan)
  local f = CreateFrame("Frame", nil, parent)
  f:SetSize(250, 34)
  f.label = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  f.label:SetPoint("TOPLEFT")
  f.value = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  f.value:SetPoint("TOPRIGHT")
  local s = CreateFrame("Slider", nil, f)
  s:SetOrientation("HORIZONTAL")
  s:SetPoint("BOTTOMLEFT", 0, 4); s:SetPoint("BOTTOMRIGHT", 0, 4)
  s:SetHeight(14)
  local track = fill(s, "BACKGROUND", C.line, 1)
  track:SetPoint("LEFT"); track:SetPoint("RIGHT"); track:SetHeight(4)
  s:SetThumbTexture("Interface\\Buttons\\UI-SliderBar-Button-Horizontal")
  s:SetMinMaxValues(lo, hi)
  s:SetValueStep(step)
  if s.SetObeyStepOnDrag then s:SetObeyStepOnDrag(true) end
  local function show(v) f.value:SetText(string.format(fmt, v)) end
  f.label:SetText(label)
  s:SetScript("OnValueChanged", function(_, v, user)
    v = math.floor(v / step + 0.5) * step
    show(v)
    if ns.opts()[key] ~= v then
      ns.opts()[key] = v
      if replan then
        -- Plan when the dragging stops, not on every pixel.
        f.pending = true
        C_Timer.After(0.5, function() if f.pending then f.pending = false; changed(true) end end)
      else
        changed(false)
      end
    end
  end)
  f:SetScript("OnShow", function() local v = ns.opts()[key] or lo; s:SetValue(v); show(v) end)
  s:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT"); GameTooltip:AddLine(label, 1, 1, 1); GameTooltip:AddLine(help, 0.8, 0.8, 0.8, true); GameTooltip:Show()
  end)
  s:SetScript("OnLeave", function() GameTooltip:Hide() end)
  f.slider = s
  return f
end

local function section(parent, text, anchor, y)
  local t = parent:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  t:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, y)
  t:SetText(text)
  local l = fill(parent, "ARTWORK", C.line, 1)
  l:SetHeight(1)
  l:SetPoint("LEFT", t, "RIGHT", 8, 0)
  l:SetPoint("RIGHT", parent, "RIGHT", -14, 0)
  return t
end

local function create()
  panel = CreateFrame("Frame", "ForeverRouteSettings", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  panel:SetSize(300, 520)
  panel:SetPoint("CENTER")
  panel:SetFrameStrata("DIALOG")
  panel:SetClampedToScreen(true)
  if panel.SetBackdrop then
    panel:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8X8", edgeFile = "Interface\\Buttons\\WHITE8X8", edgeSize = 1 })
    panel:SetBackdropColor(C.bg[1], C.bg[2], C.bg[3], 0.97)
    panel:SetBackdropBorderColor(0, 0, 0, 1)
  end
  panel:SetMovable(true); panel:EnableMouse(true); panel:RegisterForDrag("LeftButton")
  panel:SetScript("OnDragStart", panel.StartMoving)
  panel:SetScript("OnDragStop", panel.StopMovingOrSizing)
  tinsert(UISpecialFrames, "ForeverRouteSettings") -- Escape closes it

  local head = CreateFrame("Frame", nil, panel)
  head:SetPoint("TOPLEFT", 1, -1); head:SetPoint("TOPRIGHT", -1, -1); head:SetHeight(26)
  local hb = fill(head, "BACKGROUND", C.card, 1); hb:SetAllPoints()
  local stripe = fill(head, "ARTWORK", C.accent, 1)
  stripe:SetPoint("BOTTOMLEFT"); stripe:SetPoint("BOTTOMRIGHT"); stripe:SetHeight(1)
  local title = head:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("LEFT", 10, 0)
  title:SetText("Forever Route settings")
  local close = CreateFrame("Button", nil, head, "UIPanelCloseButton")
  close:SetPoint("RIGHT", 2, 0)
  close:SetScale(0.8)

  local s1 = section(panel, "Route", head, -12)
  s1:SetPoint("TOPLEFT", head, "BOTTOMLEFT", 14, -12)
  local minxp = slider(panel, "Lowest XP worth doing", "Leave out quests worth less than this share of their XP. 100% is up to 5 levels below you, then 80, 60, 40, 20, 10% (ForeverDB's rule). 60% keeps quests up to 7 levels below you.", "minXpPct", 20, 100, 20, "%d%%", true)
  minxp:SetPoint("TOPLEFT", s1, "BOTTOMLEFT", 0, -8)
  local above = slider(panel, "Levels above you", "Take quests up to this many levels above your level.", "maxAbove", 0, 6, 1, "+%d", true)
  above:SetPoint("TOPLEFT", minxp, "BOTTOMLEFT", 0, -8)
  local dungeons = checkbox(panel, "Dungeon quests", "Plan dungeon quests too (you'll need a group).", "dungeonQuests", true)
  dungeons:SetPoint("TOPLEFT", above, "BOTTOMLEFT", -4, -8)
  local group = checkbox(panel, "Group (elite) quests", "Plan quests marked for a group.", "groupQuests", true)
  group:SetPoint("TOPLEFT", dungeons, "BOTTOMLEFT", 0, -2)
  local flights = checkbox(panel, "Flight paths, zeppelins and boats", "Plan trips with the flight paths you know (open a flight master's map once so it learns them) and the zeppelins and boats.", "flights", true)
  flights:SetPoint("TOPLEFT", group, "BOTTOMLEFT", 0, -2)
  local hearth = checkbox(panel, "Hearthstone", "Use your hearthstone when it's ready and saves time.", "hearthstone", true)
  hearth:SetPoint("TOPLEFT", flights, "BOTTOMLEFT", 0, -2)

  local s2 = section(panel, "Window", hearth, -12)
  s2:SetPoint("TOPLEFT", hearth, "BOTTOMLEFT", 4, -12)
  local rows = slider(panel, "Upcoming steps shown", "How many steps after the current one the window lists.", "rows", 0, 12, 1, "%d", false)
  rows:SetPoint("TOPLEFT", s2, "BOTTOMLEFT", 0, -8)
  local scale = slider(panel, "Scale", "Size of the route window.", "scale", 0.7, 1.5, 0.05, "%.2f", false)
  scale:SetPoint("TOPLEFT", rows, "BOTTOMLEFT", 0, -8)
  local alpha = slider(panel, "Background opacity", "How see-through the route window's background is.", "alpha", 0.2, 1, 0.05, "%.2f", false)
  alpha:SetPoint("TOPLEFT", scale, "BOTTOMLEFT", 0, -8)
  local locked = checkbox(panel, "Lock window and arrow", "Stop them moving when you drag.", "locked", false)
  locked:SetPoint("TOPLEFT", alpha, "BOTTOMLEFT", -4, -8)

  local s3 = section(panel, "Navigation", locked, -12)
  s3:SetPoint("TOPLEFT", locked, "BOTTOMLEFT", 4, -12)
  local arrowCb = checkbox(panel, "Arrow", "The arrow that points to the current step.", "arrow", false)
  arrowCb:SetPoint("TOPLEFT", s3, "BOTTOMLEFT", -4, -6)
  local pin = checkbox(panel, "Map pin", "Put a pin on the world map at the current step (and a TomTom waypoint if you use TomTom).", "mapPin", false)
  pin:SetPoint("LEFT", arrowCb, "RIGHT", 120, 0)
  local mm = checkbox(panel, "Minimap button", "The button by the minimap. /fr still works without it.", "minimap", false)
  mm:SetPoint("TOPLEFT", arrowCb, "BOTTOMLEFT", 0, -2)

  local unskip = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
  unskip:SetSize(120, 20)
  unskip:SetPoint("BOTTOMLEFT", 12, 12)
  unskip:SetText("Unskip quests")
  unskip:SetScript("OnClick", function() SlashCmdList.FOREVERROUTE("unskip") end)
  local reset = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
  reset:SetSize(120, 20)
  reset:SetPoint("BOTTOMRIGHT", -12, 12)
  reset:SetText("Reset all")
  reset:SetScript("OnClick", function()
    SlashCmdList.FOREVERROUTE("reset")
    panel:Hide(); panel:Show() -- re-read the defaults
  end)
  panel:Hide()
end

function ns.ToggleSettings()
  if not panel then create() end
  panel:SetShown(not panel:IsShown())
end
