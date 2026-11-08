-- Forever Build Coach: shows your class, level and equipped item ids as one line to copy.
-- Paste it to your Claude (with the Forever Build Coach connector) and ask for upgrades.
-- WoW addons can't go online, so the line is the bridge: nothing leaves the game by itself.

local ADDON = "ForeverBuildCoach"

-- Export slot names (what the server reads) and the game's inventory slot names.
local SLOTS = {
  { "HEAD", "HeadSlot" }, { "NECK", "NeckSlot" }, { "SHOULDER", "ShoulderSlot" }, { "BACK", "BackSlot" },
  { "CHEST", "ChestSlot" }, { "WRIST", "WristSlot" }, { "HANDS", "HandsSlot" }, { "WAIST", "WaistSlot" },
  { "LEGS", "LegsSlot" }, { "FEET", "FeetSlot" }, { "FINGER0", "Finger0Slot" }, { "FINGER1", "Finger1Slot" },
  { "TRINKET0", "Trinket0Slot" }, { "TRINKET1", "Trinket1Slot" }, { "MAINHAND", "MainHandSlot" },
  { "OFFHAND", "SecondaryHandSlot" }, { "RANGED", "RangedSlot" },
}

local function equippedId(slotName)
  local ok, slotId = pcall(GetInventorySlotInfo, slotName)
  if not ok or not slotId then return nil end -- slot doesn't exist in this client
  local id = GetInventoryItemID and GetInventoryItemID("player", slotId)
  if not id then
    local link = GetInventoryItemLink("player", slotId)
    id = link and tonumber(link:match("item:(%d+)"))
  end
  return id or 0
end

local function exportLine()
  local _, classToken = UnitClass("player")
  local name = (UnitName("player") or ""):gsub("[:;=]", "")
  local parts = {}
  for _, s in ipairs(SLOTS) do
    local id = equippedId(s[2])
    if id then parts[#parts + 1] = s[1] .. "=" .. id end
  end
  return string.format("FBC1:%s:%d:%s:%s", classToken or "UNKNOWN", UnitLevel("player") or 0, name, table.concat(parts, ";"))
end

local frame
local function build()
  frame = CreateFrame("Frame", "ForeverBuildCoachFrame", UIParent, "BasicFrameTemplateWithInset")
  frame:SetSize(520, 150)
  frame:SetPoint("CENTER")
  frame:SetFrameStrata("DIALOG")
  frame:SetMovable(true)
  frame:EnableMouse(true)
  frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", frame.StartMoving)
  frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
  tinsert(UISpecialFrames, "ForeverBuildCoachFrame") -- Escape closes it

  local title = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  title:SetPoint("TOP", 0, -6)
  title:SetText("Forever Build Coach")

  local help = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  help:SetPoint("TOPLEFT", 16, -34)
  help:SetPoint("RIGHT", -16, 0)
  help:SetJustifyH("LEFT")
  help:SetText("Press Ctrl+C to copy, then paste it to your Claude and ask:\n\"Find upgrades for this gear, I'm <spec>.\"")

  local box = CreateFrame("EditBox", nil, frame, "InputBoxTemplate")
  box:SetPoint("TOPLEFT", 22, -78)
  box:SetPoint("RIGHT", -18, 0)
  box:SetHeight(24)
  box:SetAutoFocus(true)
  box:SetScript("OnEscapePressed", function() frame:Hide() end)
  -- Keep the text as the export even if a key is pressed, and keep it selected for copying.
  box:SetScript("OnTextChanged", function(self, userInput) if userInput then self:SetText(frame.line or "") self:HighlightText() end end)
  box:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
  box:SetScript("OnKeyUp", function(self, key) if IsControlKeyDown() and key == "C" then
    print("|cff66ccffForever Build Coach:|r copied. Paste it to your Claude.") frame:Hide() end end)
  frame.box = box

  local note = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  note:SetPoint("BOTTOMLEFT", 16, 12)
  note:SetText("Updates when you change gear. /fbc to open again.")
end

local function show()
  if not frame then build() end
  frame.line = exportLine()
  frame.box:SetText(frame.line)
  frame:Show()
  frame.box:SetFocus()
  frame.box:HighlightText()
end

function ForeverBuildCoach_OnAddonCompartmentClick() show() end

local events = CreateFrame("Frame")
events:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
events:SetScript("OnEvent", function()
  if frame and frame:IsShown() then frame.line = exportLine() frame.box:SetText(frame.line) frame.box:HighlightText() end
end)

SLASH_FOREVERBUILDCOACH1 = "/fbc"
SLASH_FOREVERBUILDCOACH2 = "/buildcoach"
SlashCmdList.FOREVERBUILDCOACH = function(msg)
  if msg and msg:lower():match("print") then print(exportLine()) else show() end
end
