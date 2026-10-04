-- Exercise the actual editor without starting the launcher or a Minecraft VM.
local file = assert(io.open("lua/cc-mcp.lua"))
local source = file:read("*a"); file:close()
local editor = assert(source:match("(local function readPrompt%(history%).-)\n%-%- The read coroutine"))
local function eq(actual, expected)
    assert(actual == expected, tostring(actual) .. " ~= " .. tostring(expected))
end
local function fixture(options)
    options = options or {}
    local width, height = options.width or 12, options.height or 3
    local x, y, blink, fg, bg = 3, options.row or 1, false, 1, 32768
    local rows = {}
    for i = 1, height do rows[i] = string.rep(" ", width) end
    rows[y] = "> " .. string.rep(" ", width - 2)
    local state = { ready = false }
    local term = {}
    function term.getSize() return width, height end
    function term.getCursorPos() return x, y end
    function term.setCursorPos(a, b) x, y = a, b end
    function term.setCursorBlink(value) blink = value end
    function term.getTextColor() return fg end
    function term.getBackgroundColor() return bg end
    function term.setTextColor(value) fg = value end
    function term.setBackgroundColor(value) bg = value end
    function term.write(text)
        for i = 1, #text do
            if x >= 1 and x <= width and y >= 1 and y <= height then
                rows[y] = rows[y]:sub(1, x - 1) .. text:sub(i, i) .. rows[y]:sub(x + 1)
            end
            x = x + 1
        end
    end
    local keys = setmetatable({}, { __index = function(_, key) return key end })
    local env = setmetatable({ term = term, keys = keys, colors = { white = 1, gray = 128 },
        shell = { complete = function(line) return (options.completions or {})[line] end },
        commandState = state, foregroundChanged = function() end,
        os = { pullEvent = coroutine.yield },
        print = function()
            x = 1
            if y == height then table.remove(rows, 1); rows[height] = string.rep(" ", width)
            else y = y + 1 end
        end,
    }, { __index = _G })
    local read = assert(load(editor .. "\nreturn readPrompt", "prompt", "t", env))()
    local co = coroutine.create(function() return read(options.history or {}) end)
    local result
    local function resume(...)
        local ok, value = coroutine.resume(co, ...)
        assert(ok, value)
        if coroutine.status(co) == "dead" then result = value end
    end
    resume()
    return {
        event = resume,
        key = function(key) resume("key", key) end,
        paste = function(text) resume("paste", text) end,
        row = function(n) return rows[n or y] end,
        cursor = function(a, b) eq(x, a); eq(y, b) end,
        ready = function(value) eq(state.ready, value) end,
        finish = function(expected, key)
            resume("key", key or "enter"); eq(result, expected); eq(blink, false)
        end,
        resize = function(size)
            width = size
            for i = 1, height do rows[i] = (rows[i] .. string.rep(" ", width)):sub(1, width) end
            resume("term_resize")
        end,
    }
end

local tests = {}
function tests.noop_end()
    local p = fixture({ completions = { a = { "bc", "xy" } } })
    p.event("char", "a"); p.key("down"); p.key("end"); p.key("tab"); p.finish("axy")
end
function tests.history_end()
    local p = fixture({ history = { "older", "a" }, completions = { a = { "bc", "xy" } } })
    p.key("up"); p.key("end"); p.key("up"); p.finish("older")
end
function tests.noop_zero()
    for _, key in ipairs({ "left", "home" }) do
        local p = fixture({ completions = { [""] = { "first", "second" } } })
        p.ready(true); p.key("down"); p.key(key); p.ready(true); p.key("tab")
        p.ready(false); p.finish("second")
    end
end
function tests.mouse_completion()
    for _, event in ipairs({ "mouse_click", "mouse_drag" }) do
        local p = fixture({ completions = { a = { "bc", "xy" } } })
        p.paste("a"); p.key("down"); p.event(event, 1, 4, 1)
        p.key("tab"); p.finish("axy")
        p = fixture({ completions = { a = { "bc", "xy" } } })
        p.paste("a"); p.event(event, 1, 3, 1)
        eq(p.row(), "> a         "); p.key("tab"); p.cursor(3, 1)
        p.event(event, 1, 4, 1); p.key("tab"); p.finish("abc")
    end
end
function tests.mouse_placement()
    for _, event in ipairs({ "mouse_click", "mouse_drag" }) do
        local p = fixture(); p.paste("abc")
        for _, button in ipairs({ 2, 3 }) do p.event(event, button, 3, 1); p.cursor(6, 1) end
        for _, point in ipairs({ { 2, 1 }, { 13, 1 }, { 3, 2 } }) do
            p.event(event, 1, point[1], point[2]); p.cursor(6, 1)
        end
        p.key("home"); p.event(event, 1, 11, 1); p.cursor(6, 1)
        p.event(event, 1, 4, 1); p.paste("XY"); p.finish("aXYbc")
    end
end
function tests.edits_and_history()
    local p = fixture(); p.key("backspace"); p.key("delete"); p.ready(true)
    p.paste("ac"); p.key("left"); p.event("char", "b"); p.paste("XY")
    p.key("backspace"); p.key("delete"); p.key("home"); p.key("backspace")
    p.key("end"); p.key("delete"); p.finish("abX")
    p = fixture({ history = { "older", "newer" } })
    p.key("up"); p.ready(false); p.key("up"); p.key("up"); p.finish("older")
    p = fixture({ history = { "older", "newer" } })
    p.key("up"); p.key("up"); p.key("down"); p.key("down"); p.ready(true); p.finish("")
end
function tests.long_resize()
    local p = fixture({ width = 8 }); p.paste("abcdefghij")
    eq(p.row(), "> fghij "); p.cursor(8, 1)
    p.key("home"); eq(p.row(), "> abcdef"); p.key("delete")
    p.key("end"); p.resize(6); eq(p.row(), "> hij "); p.cursor(6, 1)
    p.event("mouse_click", 1, 3, 1); p.event("char", "X")
    p.resize(12); p.key("home"); eq(p.row(), "> bcdefgXhij")
    p.finish("bcdefgXhij")
    p = fixture({ width = 8, completions = { a = { "bcdefgh" } } })
    p.paste("a"); p.key("backspace"); eq(p.row(), ">       "); p.ready(true)
end
function tests.submission()
    for _, key in ipairs({ "enter", "numPadEnter" }) do
        for _, middle in ipairs({ false, true }) do
            for _, suggestions in ipairs({ false, true }) do
                for _, row in ipairs({ 1, 3 }) do
                    local p = fixture({ row = row, completions = suggestions and { ab = { "cd" } } or {} })
                    p.paste("ab"); if middle then p.key("left") end
                    p.finish("ab", key); p.cursor(1, math.min(row + 1, 3))
                    eq(p.row(row == 3 and 2 or row), "> ab        "); eq(p.row(), "            ")
                end
            end
        end
    end
end
function tests.shrinking_input()
    local p = fixture({ width = 8 }); p.paste("abcdefghij")
    for i = 1, 10 do p.key("backspace"); p.ready(i == 10) end
    eq(p.row(), ">       "); p.cursor(3, 1)
    p.resize(12); eq(p.row(), ">           ")
    p.paste("abcdefghijklmnop"); p.event("mouse_drag", 1, 4, 1)
    p.event("char", "X"); p.finish("abcdefghXijklmnop")
end
function tests.readiness()
    local p = fixture()
    for _, key in ipairs({ "leftShift", "leftCtrl", "left", "right", "home", "end", "delete", "backspace" }) do
        p.key(key); p.ready(true)
    end
    p.paste(" "); p.ready(false); p.key("home"); p.ready(false)
    p.key("delete"); p.ready(true); p.paste("x"); p.key("backspace"); p.ready(true)
    p.finish("")
end
local failures, count = 0, 0
for name, test in pairs(tests) do
    count = count + 1
    local ok, err = pcall(test)
    if not ok then failures = failures + 1; io.stderr:write(name .. ": " .. tostring(err) .. "\n") end
end
assert(failures == 0, tostring(failures) .. " prompt tests failed")
print(count .. " prompt test groups passed")
