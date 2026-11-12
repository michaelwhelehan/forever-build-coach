-- Reads QuestieDB's Forever data (https://github.com/Questie/QuestieDB, GPL-3.0) as plain data, for the Forever Route
-- build. Every file runs in an empty sandbox: no io, os, require or loading, only the stand-ins its format expects.
-- Applies, in QuestieDB's order: raw Forever entities, the generated delta-base, players' traces, authored Forever fixes.
-- Returns { quests, npcs, objects, items, keys, areaToMap, races } (rows are QuestieDB's positional rows).

return function(root)
  local function sandbox(extra)
    local env = {
      pairs = pairs, ipairs = ipairs, next = next, type = type, tonumber = tonumber, tostring = tostring, select = select,
      unpack = unpack, error = error, assert = assert, pcall = pcall, setmetatable = setmetatable, getmetatable = getmetatable,
      rawget = rawget, rawset = rawset, math = math, string = string, table = table,
    }
    for k, v in pairs(extra or {}) do env[k] = v end
    return env
  end
  local function run(path, env, ...)
    local f, err = loadfile(path)
    if not f then return false, err end
    setfenv(f, env)
    return pcall(f, ...)
  end
  local function evalString(s)
    local f = assert(loadstring(s))
    setfenv(f, sandbox())
    return f()
  end

  -- Constants the correction files use (zone, race, class and sort symbols).
  local Lib = { Enum = {} }
  for _, n in ipairs({ "zones", "expansions", "quests" }) do
    run(root .. "/src/corrections/enum/" .. n .. ".lua", sandbox(), nil, Lib)
  end
  local E = Lib.Enum
  local flavor = E.byExpansion and E.byExpansion.Forever or {}
  local function lenient(t) -- unknown symbols read as 0 instead of failing a whole file
    return setmetatable(t or {}, { __index = function() return 0 end })
  end

  local QDB = {}
  local keys = {}
  local function makeLoader(modules)
    local loader = {}
    function loader:CreateModule(name) modules[name] = modules[name] or {}; return modules[name] end
    function loader:ImportModule(name)
      if name == "QuestieDB" then return QDB end
      if name == "ZoneDB" then return { zoneIDs = lenient(E.zoneIDs) } end
      modules[name] = modules[name] or setmetatable({}, { __index = function() return function() end end })
      return modules[name]
    end
    return loader
  end

  -- 1. Raw entities.
  local data = {}
  for _, t in ipairs({ { "quest", "Quest" }, { "npc", "Npc" }, { "object", "Object" }, { "item", "Item" } }) do
    local modules = {}
    local ok, err = run(root .. "/data/Forever/forever" .. t[2] .. "DB.lua", sandbox({ QuestieLoader = makeLoader(modules) }))
    assert(ok, err)
    keys[t[1]] = QDB[t[1] .. "Keys"]
    data[t[1]] = evalString(QDB[t[1] .. "Data"])
  end

  -- Authoring views: questKeys.name = 1, questKeys.finishedBy_add = an "add to field 3" marker.
  local ADD, REMOVE = {}, {}
  local function view(k)
    return setmetatable({}, { __index = function(_, name)
      if k[name] then return k[name] end
      local base, op = name:match("^(.-)_(%a+)$")
      if base and k[base] then return { op = op == "add" and ADD or REMOVE, field = k[base] } end
      return 0
    end })
  end
  QDB.questKeys, QDB.npcKeys, QDB.objectKeys, QDB.itemKeys = view(keys.quest), view(keys.npc), view(keys.object), view(keys.item)
  QDB.raceKeys, QDB.classKeys, QDB.sortKeys = lenient(flavor.raceKeys), lenient(flavor.classKeys), lenient(E.sortKeys)
  QDB.factionIDs = lenient({})
  QDB.zoneIDs = lenient(E.zoneIDs)

  local function copy(v)
    if type(v) ~= "table" then return v end
    local c = {}
    for k, x in pairs(v) do c[k] = copy(x) end
    return c
  end
  local function same(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b end
    for k, v in pairs(a) do if not same(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
  end
  -- Add rows to a list (or a map of lists, like spawns per zone), skipping ones already there.
  local function addTo(target, add)
    if type(target) ~= "table" then return copy(add) end
    if add[1] ~= nil and (target[1] ~= nil or next(target) == nil) then
      for _, v in ipairs(add) do
        local found = false
        for _, x in ipairs(target) do if same(x, v) then found = true break end end
        if not found then target[#target + 1] = copy(v) end
      end
    else
      for k, v in pairs(add) do
        if target[k] == nil then target[k] = copy(v)
        elseif type(v) == "table" then target[k] = addTo(target[k], v) end
      end
    end
    return target
  end
  local function apply(kind, patch)
    local rows = data[kind]
    for id, fields in pairs(patch or {}) do
      local row = rows[id]
      if not row then row = {}; rows[id] = row end
      for f, v in pairs(fields) do
        if type(f) == "number" then
          if type(v) == "table" and next(v) == nil then row[f] = nil else row[f] = copy(v) end
        elseif type(f) == "table" and f.op == ADD then
          row[f.field] = addTo(row[f.field], v)
        end -- removals are ignored: they only prune Classic links
      end
    end
  end

  -- 2-4. Corrections, in QuestieDB's order. A file that needs more than this stand-in offers is skipped and reported.
  local dir = root .. "/src/corrections/Forever/"
  local files = {
    { "quest", "generated/foreverBaseQuest.lua" }, { "npc", "generated/foreverBaseNpc.lua" },
    { "object", "generated/foreverBaseObject.lua" }, { "item", "generated/foreverBaseItem.lua" },
    { "quest", "traces/foreverQuestTraces.lua" }, { "quest", "traces/foreverQuestRelationTraces.lua" },
    { "npc", "traces/foreverNpcTraces.lua" }, { "object", "traces/foreverObjectTraces.lua" },
    { "item", "traces/foreverItemTraces.lua" },
    { "quest", "foreverQuestFixes.lua" }, { "npc", "foreverNPCFixes.lua" }, { "object", "foreverObjectFixes.lua" },
    { "item", "foreverItemFixes.lua" },
  }
  local report = {}
  for _, f in ipairs(files) do
    local modules = {}
    local env = sandbox({ QuestieLoader = makeLoader(modules), Questie = setmetatable({}, { __index = function() return function() end end }) })
    local ok, err = run(dir .. f[2], env)
    local applied = 0
    if ok then
      for _, m in pairs(modules) do
        for name, fn in pairs(m) do
          if type(fn) == "function" and (name == "Load" or name:match("^Load")) then
            local ok2, patch = pcall(fn, m)
            if ok2 and type(patch) == "table" then apply(f[1], patch); for _ in pairs(patch) do applied = applied + 1 end
            elseif not ok2 then err = patch end
          end
        end
      end
    end
    report[#report + 1] = string.format("%s: %s", f[2], applied > 0 and (applied .. " rows") or ("skipped (" .. tostring(err) .. ")"))
  end

  -- Questie spawns are keyed by AreaTable zone; map them to UiMap ids with QuestieDB's own conversion table.
  local areaToMap = {}
  local fh = io.open(root .. "/data/Forever/conversion.json")
  if fh then
    local s = fh:read("*a"); fh:close()
    -- Each transform lists "ui_map_id" and then its "area_id".
    for ui, area in s:gmatch("\"ui_map_id\":%s*(%d+),[^}]-\"area_id\":%s*(%d+)") do
      areaToMap[tonumber(area)] = areaToMap[tonumber(area)] or tonumber(ui)
    end
  end

  return { quests = data.quest, npcs = data.npc, objects = data.object, items = data.item, keys = keys,
    areaToMap = areaToMap, races = flavor.raceKeys or {}, report = report }
end
