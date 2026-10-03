-- CC-MCP enhanced remote launcher, protocol version 1.
-- Usage: /cc-mcp.lua <token> [ws[s]://relay/] [--reconnect]
-- Keeps upstream terminal behavior, extending capability negotiation and reads.
local token, relay, reconnectOption = ...
local autoReconnect = reconnectOption == "--reconnect"
relay = relay or "wss://remote.craftos-pc.cc/"
assert(type(token) == "string" and #token <= 128 and token:match("^[%w_-]+$"), "Expected a session token")
assert(relay:match("^wss?://") and not relay:find("[%s?#]"), "Expected a WebSocket relay base URL")
if relay:sub(-1) ~= "/" then relay = relay .. "/" end
local signature, capability = "CCMCP/1\0", 0x8000
local commandCapability = 0x4000
local outputCapability = 0x2000
local foregroundCapability = 0x1000
local interruptCapability = 0x0800
local safeWriteCapability = 0x0400
local syncFilesCapability = 0x0200
local resumeCapability = 0x0100
local debugEventCapability = 0x0080
local identityCapability = 0x0040
local maxFile, maxChunk = 1024 * 1024, 4096
local commandState = { ready = false, phase = "unknown" }
local resumeState = { enabled = false, commands = {}, order = {}, logs = {}, first = 1, sequence = 0, bytes = 0 }
resumeState.epoch = ("%08x%08x%08x%08x"):format(os.epoch("utc") % 0x100000000, math.random(0, 0x7fffffff), math.random(0, 0x7fffffff), math.random(0, 0x7fffffff))
local transport = { stopped = false, serial = 0 }

-- Keep the upstream terminal and foreground coroutines alive while replacing
-- only their WebSocket. Responses/input are never queued for later delivery.
local function persistentDelegate(url, headers)
    transport.url, transport.headers = url, headers
    os.queueEvent("cc_mcp_transport_start")
    return {
        send = function(_, message)
            if transport.socket then
                local ok = pcall(transport.socket.send, message)
                if not ok then
                    pcall(transport.socket.close)
                    transport.socket, resumeState.client = nil, nil
                    os.queueEvent("cc_mcp_transport_lost")
                end
            end
        end,
        receive = function()
            while not transport.stopped do
                local ev, serial, message = os.pullEventRaw()
                if ev == "cc_mcp_transport_message" and serial == transport.serial and transport.socket then return message end
            end
        end,
        close = function()
            transport.stopped = true
            if transport.socket then pcall(transport.socket.close) end
            transport.socket = nil
        end,
    }
end

local function reconnectTransport()
    local backoff = 1
    while not transport.stopped do
        if not transport.url then os.pullEventRaw() else
            local ok, socket = pcall(http.websocket, transport.url, transport.headers)
            if ok and socket then
                transport.socket = socket
                transport.serial = transport.serial + 1
                resumeState.client = nil
                local connectedAt = os.epoch("utc")
                while transport.socket and not transport.stopped do
                    local ev, url, message = os.pullEventRaw()
                    if ev == "websocket_message" and url == transport.url then
                        os.queueEvent("cc_mcp_transport_message", transport.serial, message)
                    elseif ev == "websocket_closed" and url == transport.url then
                        transport.socket, resumeState.client = nil, nil
                    end
                end
                pcall(socket.close)
                if os.epoch("utc") - connectedAt >= 10000 then backoff = 1 end
            end
            if not transport.stopped then
                local timer = os.startTimer(backoff)
                repeat local ev, id = os.pullEventRaw() until ev == "timer" and id == timer
                backoff = math.min(backoff * 2, 30)
            end
        end
    end
end
local function foregroundChanged()
    if commandState.foreground then commandState.foreground() end
end

local function runObserved(line)
    local program = coroutine.create(function() return shell.run(line) end)
    local result = table.pack(coroutine.resume(program))
    while result[1] and coroutine.status(program) ~= "dead" do
        -- Observe the shell API's current stack at yield boundaries. A program
        -- creating its own shell/API or parallel tasks may hide deeper state.
        commandState.program = shell.getRunningProgram()
        foregroundChanged()
        local filter = result[2]
        local ev
        repeat
            ev = table.pack(os.pullEventRaw())
            if ev[1] == "cc_mcp_debug_event" then
                local request = commandState.debugEvent
                if request and request.nonce == ev[2] then
                    commandState.debugEvent = nil
                    if request.invocation == commandState.invocation and request.client == resumeState.client then ev = request.event
                    else ev = { n = 0 } end
                else ev = { n = 0 } end
            end
        until ev[1] and (not filter or ev[1] == filter or ev[1] == "terminate" or ev[1] == "cc_mcp_interrupt")
        if ev[1] == "cc_mcp_interrupt" and commandState.interrupt then
            local request = commandState.interrupt
            commandState.interrupt = nil
            commandState.interrupted = request.mode
            if request.mode == "force" then
                commandState.interruptCompleted = request
                return false
            end
            result = table.pack(coroutine.resume(program, "terminate"))
            if not result[1] or coroutine.status(program) == "dead" then
                commandState.interruptCompleted = request
            else
                commandState.interrupted = nil
                commandState.interruptReply(request, "running")
            end
        else
        result = table.pack(coroutine.resume(program, table.unpack(ev, 1, ev.n)))
        end
    end
    if not result[1] then error(result[2], 0) end
    return table.unpack(result, 2, result.n)
end

-- A single foreground shell owns tracked execution. Programs still run through
-- CraftOS's shell.run API, retaining its path resolution, aliases and Lua API.
-- Own the prompt buffer: the public read() API does not expose edits, and
-- completion callbacks alone miss history selection and edits mid-line.
-- Keep this editor local to our shell; programs still use the normal read().
local function readPrompt(history)
    local line, pos, scroll, historyPos = "", 0, 0, nil
    local completions, completion
    local sx = term.getCursorPos()
    local function recomplete()
        completions = pos == #line and shell.complete(line) or nil
        completion = completions and #completions > 0 and 1 or nil
    end
    local function redraw()
        local width = term.getSize()
        if sx + pos - scroll >= width then scroll = sx + pos - width
        elseif pos < scroll then scroll = pos end
        local _, y = term.getCursorPos()
        term.setCursorPos(sx, y)
        term.write(string.rep(" ", math.max(0, width - sx + 1)))
        term.setCursorPos(sx, y)
        term.write(line:sub(scroll + 1))
        if completion then
            local fg, bg = term.getTextColor(), term.getBackgroundColor()
            term.setTextColor(colors.white)
            term.setBackgroundColor(colors.gray)
            term.write(completions[completion])
            term.setTextColor(fg)
            term.setBackgroundColor(bg)
        end
        term.setCursorPos(sx + pos - scroll, y)
        term.setCursorBlink(true)
        local ready = #line == 0
        if commandState.ready ~= ready then
            commandState.ready = ready
            foregroundChanged()
        end
    end
    local function acceptCompletion()
        if completion then
            line = line .. completions[completion]
            pos = #line
            recomplete()
        end
    end
    recomplete()
    redraw()
    while true do
        local event, value, x, y = os.pullEvent()
        if event == "char" or event == "paste" then
            line = line:sub(1, pos) .. value .. line:sub(pos + 1)
            pos = pos + #value
            recomplete()
        elseif event == "key" then
            if value == keys.enter or value == keys.numPadEnter then
                completions, completion = nil, nil
                redraw()
                term.setCursorBlink(false)
                print()
                return line
            elseif value == keys.left then
                pos = math.max(0, pos - 1)
                recomplete()
            elseif value == keys.right then
                if pos < #line then pos = pos + 1; recomplete()
                else acceptCompletion() end
            elseif value == keys.home then
                pos = 0
                recomplete()
            elseif value == keys["end"] then
                pos = #line
                recomplete()
            elseif value == keys.backspace then
                if pos > 0 then
                    line = line:sub(1, pos - 1) .. line:sub(pos + 1)
                    pos = pos - 1
                    if scroll > 0 then scroll = scroll - 1 end
                    recomplete()
                end
            elseif value == keys.delete then
                if pos < #line then
                    line = line:sub(1, pos) .. line:sub(pos + 2)
                    recomplete()
                end
            elseif value == keys.tab then
                acceptCompletion()
            elseif value == keys.up or value == keys.down then
                if completion then
                    completion = (completion - 1 + (value == keys.up and -1 or 1)) % #completions + 1
                else
                    if value == keys.up then
                        if not historyPos then
                            if #history > 0 then historyPos = #history end
                        else historyPos = math.max(1, historyPos - 1) end
                    elseif historyPos == #history then historyPos = nil
                    elseif historyPos then historyPos = historyPos + 1 end
                    line = historyPos and history[historyPos] or ""
                    pos, scroll = #line, 0
                    completions, completion = nil, nil
                end
            end
        elseif (event == "mouse_click" or event == "mouse_drag") and value == 1 then
            local width = term.getSize()
            local _, cy = term.getCursorPos()
            if x >= sx and x <= width and y == cy then
                pos = math.min(math.max(scroll + x - sx, 0), #line)
                recomplete()
            end
        end
        if event == "char" or event == "paste" or event == "key" or event == "mouse_click" or event == "mouse_drag" or event == "term_resize" then redraw() end
    end
end

-- The read coroutine lets a remote start replace an empty prompt without
-- injecting keystrokes, while ordinary local/remote typing remains interactive.
local function trackedShell()
    local history = {}
    local function readCommand()
        local reader = coroutine.create(function() return readPrompt(history) end)
        commandState.ready = true
        commandState.phase, commandState.program, commandState.id = "shell", nil, nil
        local ok, filter = coroutine.resume(reader)
        foregroundChanged()
        while ok and coroutine.status(reader) ~= "dead" do
            local ev = table.pack(os.pullEventRaw())
            if ev[1] == "cc_mcp_execute" and commandState.pending then
                local pending = commandState.pending
                commandState.pending = nil
                commandState.ready = false
                commandState.phase, commandState.id = "starting", pending.id
                foregroundChanged()
                print(pending.command)
                return pending.command, pending.id
            end
            if not filter or ev[1] == filter or ev[1] == "terminate" then
                ok, filter = coroutine.resume(reader, table.unpack(ev, 1, ev.n))
            end
        end
        commandState.ready = false
        commandState.phase = "starting"
        foregroundChanged()
        if not ok then error(filter, 0) end
        return filter
    end
    while true do
        term.setTextColor(colors.yellow)
        write(shell.dir() .. "> ")
        term.setTextColor(colors.white)
        local line, id = readCommand()
        if line:match("%S") then
            history[#history + 1] = line
            if #history > 100 then table.remove(history, 1) end
            local exiting = line:match("^%s*exit%s*$") ~= nil
            local ok, result
            local savedTerminal = term.current()
            commandState.interrupted = nil
            commandState.invocation = {}
            commandState.phase, commandState.id, commandState.program = "program", id, nil
            foregroundChanged()
            if commandState.capture then commandState.capture.begin(id) end
            if exiting then ok, result = true, true else ok, result = pcall(runObserved, line) end
            commandState.debugEvent = nil
            term.redirect(savedTerminal)
            term.setCursorBlink(false)
            commandState.phase, commandState.program = "starting", nil
            foregroundChanged()
            if not ok then printError(result) end
            if commandState.capture then commandState.capture.finish() end
            if id and commandState.finish then
                commandState.finish(id, ok and result == true, commandState.interrupted and ("Interrupted (" .. commandState.interrupted .. ")") or (ok and (result == true and "" or "shell.run returned false") or tostring(result)), commandState.interrupted)
            end
            if commandState.interruptCompleted then
                commandState.interruptReply(commandState.interruptCompleted, "stopped")
                commandState.interruptCompleted = nil
            end
            if exiting then return end
        end
    end
end

local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local decodeMap = {}
for i = 1, #alphabet do decodeMap[alphabet:byte(i)] = i - 1 end
local function encode(bytes)
    local result = {}
    for i = 1, #bytes, 3 do
        local a, b, c = bytes:byte(i, i + 2)
        local n = a * 65536 + (b or 0) * 256 + (c or 0)
        local x, y, z, w = math.floor(n / 262144) % 64, math.floor(n / 4096) % 64, math.floor(n / 64) % 64, n % 64
        result[#result + 1] = alphabet:sub(x + 1, x + 1) .. alphabet:sub(y + 1, y + 1)
            .. (b and alphabet:sub(z + 1, z + 1) or "=") .. (c and alphabet:sub(w + 1, w + 1) or "=")
    end
    return table.concat(result)
end
local function decode(payload)
    assert(#payload % 4 == 0, "Invalid base64 length")
    local result = {}
    for i = 1, #payload, 4 do
        local a, b, c, d = payload:byte(i, i + 3)
        local n = assert(decodeMap[a], "Invalid base64") * 262144 + assert(decodeMap[b], "Invalid base64") * 4096
            + (decodeMap[c] or 0) * 64 + (decodeMap[d] or 0)
        result[#result + 1] = string.char(math.floor(n / 65536) % 256)
            .. (c == 61 and "" or string.char(math.floor(n / 256) % 256))
            .. (d == 61 and "" or string.char(n % 256))
    end
    return table.concat(result)
end
local crcTable = {}
for i = 0, 255 do
    local value = i
    for _ = 1, 8 do
        value = bit32.btest(value, 1) and bit32.bxor(bit32.rshift(value, 1), 0xEDB88320) or bit32.rshift(value, 1)
    end
    crcTable[i] = value
end
local function crc32(bytes)
    local crc = 0xFFFFFFFF
    for i = 1, #bytes do crc = bit32.bxor(bit32.rshift(crc, 8), crcTable[bit32.band(bit32.bxor(crc, bytes:byte(i)), 255)]) end
    return bit32.bxor(crc, 0xFFFFFFFF)
end
local function framePayload(payload)
    local format = #payload > 65535 and "!CPD%012X%s%08X\n" or "!CPC%04X%s%08X\n"
    return format:format(#payload, payload, crc32(payload))
end
local function frame(data) return framePayload(encode(data)) end
local function unpackFrame(message)
    if type(message) ~= "string" then return nil end
    local prefix = message:sub(1, 4)
    if prefix ~= "!CPC" and prefix ~= "!CPD" then return nil end
    local offset = prefix == "!CPD" and 16 or 8
    local length = tonumber(message:sub(5, offset), 16)
    if not length then return nil end
    local payload = message:sub(offset + 1, offset + length)
    return decode(payload), payload, tonumber(message:sub(offset + length + 1, offset + length + 8), 16)
end

local function retainOutput(data)
    resumeState.sequence = resumeState.sequence + 1
    local sequence = resumeState.sequence
    resumeState.logs[sequence] = data
    resumeState.bytes = resumeState.bytes + #data + 64
    while resumeState.bytes > 1024 * 1024 do
        local old = resumeState.logs[resumeState.first]
        resumeState.bytes = resumeState.bytes - #old - 64
        resumeState.logs[resumeState.first] = nil
        resumeState.first = resumeState.first + 1
    end
    return string.char(80, 0) .. string.pack("<I4", sequence) .. data
end

local function debugEvent(request)
    assert(type(request) == "table" and type(request.nonce) == "string" and #request.nonce == 32 and request.nonce:match("^[a-f0-9]+$"), "Invalid event nonce")
    assert(type(request.name64) == "string" and #request.name64 <= 172, "Invalid event name")
    local name = decode(request.name64)
    assert(#name > 0 and #name <= 128 and not name:find("%z") and name:sub(1, 7) ~= "cc_mcp_", "Invalid or reserved event name")
    assert(type(request.arguments) == "table" and #request.arguments <= 32, "Invalid event arguments")
    local nodes = 0
    local function value(node, depth)
        nodes = nodes + 1
        assert(nodes <= 1024 and depth <= 8 and type(node) == "table", "Event nesting/value limit exceeded")
        if node.type == "nil" then return nil
        elseif node.type == "string" then
            assert(type(node.value) == "string" and #node.value <= 5464, "Invalid event string")
            local bytes = decode(node.value); assert(#bytes <= 4096, "Event string too long"); return bytes
        elseif node.type == "boolean" then assert(type(node.value) == "boolean", "Invalid boolean"); return node.value
        elseif node.type == "number" then
            assert(type(node.value) == "number" and node.value == node.value and node.value ~= math.huge and node.value ~= -math.huge, "Invalid number")
            return node.value
        elseif node.type == "table" then
            assert(type(node.entries) == "table", "Invalid event table")
            local result = {}
            for _, entry in ipairs(node.entries) do
                assert(type(entry) == "table" and #entry == 2, "Invalid table entry")
                local key = value(entry[1], depth + 1)
                assert(type(key) == "string" or type(key) == "number", "Invalid event table key")
                result[key] = value(entry[2], depth + 1)
            end
            return result
        end
        error("Invalid event value type")
    end
    local event = { name, n = #request.arguments + 1 }
    for i, node in ipairs(request.arguments) do event[i + 1] = value(node, 0) end
    assert(commandState.phase == "program", "No foreground program is running; start a program before injecting events")
    assert(not commandState.debugEvent, "A debug event is already pending")
    return { nonce = request.nonce, event = event, invocation = commandState.invocation, client = resumeState.client }
end

local function computerIdentity()
    local entries = {}
    local result = { computerId = os.getComputerID(), kind = turtle and "turtle" or pocket and "pocket" or commands and "command" or "computer",
        color = term.native().isColor(), peripherals = entries, truncated = false }
    local function field(value, limit)
        if #value > limit then result.truncated = true end
        return encode(value:sub(1, limit))
    end
    local label = os.getComputerLabel()
    result.label64 = label ~= nil and field(label, 256) or false
    result.craftos64 = field(os.version(), 256)
    result.host64 = type(_HOST) == "string" and field(_HOST, 1024) or false
    local names = peripheral.getNames()
    table.sort(names)
    result.totalPeripherals = #names
    for _, name in ipairs(names) do
        if #entries >= 128 then result.truncated = true; break end
        if #name > 256 then result.truncated = true else
            local entry = { name64 = encode(name), truncated = false }
            local function list(values, maximum)
                assert(type(values) == "table", "Peripheral detached during inspection")
                table.sort(values)
                local encoded = {}
                for _, value in ipairs(values) do
                    if #encoded >= maximum then entry.truncated = true; break end
                    if #value > 256 then entry.truncated = true else encoded[#encoded + 1] = encode(value) end
                end
                return #encoded == 0 and textutils.empty_json_array or encoded
            end
            local ok, err = pcall(function()
                local types = { peripheral.getType(name) }
                assert(#types > 0, "Peripheral detached during inspection")
                entry.types64 = list(types, 32)
                entry.methods64 = list(peripheral.getMethods(name), 256)
            end)
            if not ok then entry.error64 = encode(tostring(err):sub(1, 512)) end
            entry.types64 = entry.types64 or textutils.empty_json_array
            entry.methods64 = entry.methods64 or textutils.empty_json_array
            entries[#entries + 1] = entry
            -- Bound the complete response as well as individual fields. Keep
            -- exact names and explicitly report omitted methods/peripherals.
            if #textutils.serializeJSON(result) > 32768 and entry.methods64 ~= textutils.empty_json_array then
                local methods = entry.methods64
                local function take(count)
                    local subset = {}
                    for i = 1, count do subset[i] = methods[i] end
                    entry.methods64 = count == 0 and textutils.empty_json_array or subset
                end
                entry.truncated = true
                local low, high = 0, #methods
                while low < high do
                    local middle = math.ceil((low + high) / 2)
                    take(middle)
                    if #textutils.serializeJSON(result) <= 32768 then low = middle else high = middle - 1 end
                end
                take(low)
            end
            if #textutils.serializeJSON(result) > 32768 then
                table.remove(entries); result.truncated = true; break
            end
            if entry.truncated then result.truncated = true end
        end
    end
    if #entries == 0 then result.peripherals = textutils.empty_json_array end
    return textutils.serializeJSON(result)
end

local function readChunk(data)
    assert(#data >= 12 and data:byte(3) == 1, "Unsupported chunk-read version")
    local offset, length, path, ending = string.unpack("<I4I2z", data, 5)
    assert(ending == #data + 1 and #path <= 4095, "Invalid read path")
    assert(length > 0 and length <= maxChunk, "Invalid chunk length")
    assert(not fs.isDir(path), "Cannot read a directory")
    local size = fs.getSize(path)
    assert(size <= maxFile, "File exceeds enhanced 1 MiB limit")
    assert(offset <= size, "File changed during reading")
    local file, err = fs.open(path, "rb")
    assert(file, err)
    local ok, contents = pcall(function()
        -- Modern CC: Tweaked supports binary seek. Older systems can skip in
        -- bounded blocks without ever materializing the entire file.
        if file.seek then
            local position, seekError = file.seek("set", offset)
            assert(position == offset, seekError or "Could not seek file")
        else
            local skipped = 0
            while skipped < offset do
                local chunk = file.read(math.min(maxChunk, offset - skipped))
                assert(chunk and #chunk > 0, "File changed during reading")
                skipped = skipped + #chunk
            end
        end
        local bytes = file.read(length) or ""
        assert(#bytes == math.min(length, size - offset), "File changed during reading")
        return string.pack("<I4I4", size, offset) .. bytes
    end)
    file.close()
    assert(ok, contents)
    return contents
end

-- Capture visual text lines, not an imitation stdout stream. Same-row writes
-- replace the live line; leaving a row, scrolling, clearing, or ending a command
-- commits it. Full-screen cursor-addressed programs still need screen snapshots.
local function captureTerminal(win, emit, enabled)
    local dirty, queued, queuedBytes, owner = {}, {}, 0, ""
    local capture = {}
    local function drain()
        if #queued > 0 then
            emit(string.char(1) .. string.pack("<I2", #queued) .. table.concat(queued))
            queued, queuedBytes = {}, 0
        end
    end
    local function record(kind, row, line)
        local bytes = string.char(kind) .. string.pack("<I2zI4", row, line.owner, #line.text) .. line.text
        queued[#queued + 1] = bytes
        queuedBytes = queuedBytes + #bytes
        if queuedBytes >= 4096 then drain() end
    end
    function capture.flush()
        if not enabled() then return end
        local rows = {}
        for row in pairs(dirty) do rows[#rows + 1] = row end
        table.sort(rows)
        for _, row in ipairs(rows) do
            local line = dirty[row]
            if not line.sent then record(1, row, line); line.sent = true end
        end
        drain()
    end
    local function commit(row)
        local line = dirty[row]
        if not line then return end
        dirty[row] = nil
        record(0, row, line)
    end
    local function commitAll()
        local rows = {}
        for row in pairs(dirty) do rows[#rows + 1] = row end
        table.sort(rows)
        for _, row in ipairs(rows) do commit(row) end
    end
    local function changed(row)
        if not enabled() then return end
        local text = win.getLine(row)
        if not text then return end
        text = text:gsub(" +$", "")
        local previous = dirty[row]
        if not previous or previous.text ~= text or previous.owner ~= owner then
            dirty[row] = { text = text, owner = owner }
        end
    end
    for _, method in ipairs({ "write", "blit" }) do
        local original = win[method]
        win[method] = function(...)
            local _, row = win.getCursorPos()
            local result = table.pack(original(...))
            changed(row)
            return table.unpack(result, 1, result.n)
        end
    end
    local setCursorPos, scroll, clear, clearLine, redraw, reposition = win.setCursorPos, win.scroll, win.clear, win.clearLine, win.redraw, win.reposition
    win.setCursorPos = function(x, y)
        local _, row = win.getCursorPos()
        if enabled() and y ~= row then
            if not dirty[row] and y == row + 1 and x == 1 then
                local text = win.getLine(row)
                if text and not text:find("[^ ]") then changed(row) end
            end
            commit(row)
        end
        return setCursorPos(x, y)
    end
    win.scroll = function(lines)
        if enabled() and lines ~= 0 then
            local x, row = win.getCursorPos()
            local _, height = win.getSize()
            if lines == 1 and row == height and x == 1 and not dirty[row] then
                local text = win.getLine(row)
                if text and not text:find("[^ ]") then changed(row) end
            end
            commitAll()
        end
        return scroll(lines)
    end
    win.clear = function()
        if enabled() then commitAll() end
        return clear()
    end
    win.clearLine = function()
        local result = clearLine()
        local _, row = win.getCursorPos()
        changed(row)
        return result
    end
    win.reposition = function(...)
        if enabled() then commitAll() end
        return reposition(...)
    end
    win.redraw = function(...)
        -- Upstream's 50 ms visible redraw tick also flushes an unfinished line
        -- from a program blocked on read(), even if no pixels changed this tick.
        if win.isVisible() then capture.flush() end
        return redraw(...)
    end
    function capture.begin(id)
        if enabled() then commitAll(); capture.flush() end
        owner = id or ""
    end
    function capture.finish()
        if enabled() then commitAll(); capture.flush() end
        owner = ""
    end
    return capture
end

-- Transactions use a sibling directory on the same mount. A durable intent
-- record precedes either rename; recovery never deletes an ambiguous target.
local transactions = {}
local function safeWrite(request)
    local id = request.id
    assert(type(id) == "string" and #id == 32 and id:match("^[a-f0-9]+$"), "Invalid transaction ID")
    local path = fs.combine("", decode(assert(request.path64)))
    if request.op == "mkdir" then
        assert(#path <= 4095, "Invalid directory destination")
        assert(not fs.exists(path) or fs.isDir(path), "Directory path is occupied by a file")
        fs.makeDir(path)
        return { outcome = "directory_ready" }
    end
    assert(path ~= "" and #path <= 4095 and not fs.isDir(path), "Invalid file destination")
    local dir = fs.combine(fs.getDir(path), ".cc-mcp-" .. id)
    local function readFile(p)
        local f, err = fs.open(p, "rb"); assert(f, err)
        local ok, bytes = pcall(f.readAll); f.close(); assert(ok, bytes)
        return bytes or ""
    end
    local function save(p, bytes)
        local f, err = fs.open(p, "wb"); assert(f, err)
        local ok, err = pcall(function() f.write(bytes) end)
        f.close(); assert(ok, err)
    end
    if request.op == "recover" then
        if not fs.exists(dir .. "/intent") then
            local upload = textutils.unserializeJSON(readFile(dir .. "/upload"))
            assert(upload and upload.path == path, "Recovery destination mismatch")
            fs.delete(dir); transactions[id] = nil
            return { outcome = "aborted" }
        end
        assert(fs.exists(dir .. "/intent"), "No recoverable transaction record")
        local intent = textutils.unserializeJSON(readFile(dir .. "/intent"))
        assert(intent and intent.path == path, "Recovery destination mismatch")
        if fs.exists(dir .. "/backup") then
            assert(not fs.exists(path), "Destination exists alongside backup; inspect transaction files manually")
            fs.move(dir .. "/backup", path)
            fs.delete(dir); transactions[id] = nil
            return { outcome = "restored" }
        end
        -- Before the old file was moved, or after a committed new-file rename,
        -- preserve all evidence instead of guessing which data should win.
        return { outcome = "inspection_required", transactionPath = "/" .. dir }
    end
    if request.op == "begin" then
        assert(not fs.exists(dir) and not transactions[id], "Transaction already exists")
        assert(request.condition == "any" or request.condition == "match" or request.condition == "missing", "Invalid precondition")
        assert(type(request.size) == "number" and request.size >= 0 and request.size <= maxFile, "Invalid upload size")
        assert(not request.remove or (request.condition == "match" and request.size == 0), "Deletion requires expected contents")
        assert(not fs.isReadOnly(path), "Destination is read-only")
        assert(fs.exists(fs.getDir(path)), "Parent directory does not exist")
        assert(not fs.exists(path) or fs.getSize(path) <= maxFile, "Existing file exceeds 1 MiB")
        local count = 0; for _ in pairs(transactions) do count = count + 1 end
        assert(count < 8, "Too many pending uploads; recover or abort them")
        fs.makeDir(dir)
        save(dir .. "/upload", textutils.serializeJSON({ path = path }))
        save(dir .. "/new", ""); save(dir .. "/expected", "")
        transactions[id] = { path = path, condition = request.condition, size = request.size, remove = request.remove, bytes = 0, expectedBytes = 0, parts = {}, expectedParts = {} }
        return { outcome = "ready" }
    end
    local tx = assert(transactions[id], "Unknown transaction; use recover after reconnect/restart")
    assert(tx.path == path, "Transaction destination mismatch")
    if request.op == "abort" then
        assert(not fs.exists(dir .. "/intent"), "Commit started; recovery required")
        fs.delete(dir); transactions[id] = nil; return { outcome = "aborted" }
    elseif request.op == "chunk" then
        assert(request.stream == "new" or request.stream == "expected", "Invalid upload stream")
        local bytes = request.raw or decode(assert(request.data))
        assert(#bytes <= maxChunk, "Chunk too large")
        local field = request.stream == "new" and "bytes" or "expectedBytes"
        assert(request.offset == tx[field] and tx[field] + #bytes <= maxFile, "Invalid chunk offset/size")
        local f, err = fs.open(dir .. "/" .. request.stream, "ab"); assert(f, err)
        local ok, err = pcall(f.write, bytes); f.close(); assert(ok, err)
        tx[field] = tx[field] + #bytes
        if request.stream == "new" then tx.parts[#tx.parts + 1] = bytes end
        if request.stream == "expected" then tx.expectedParts[#tx.expectedParts + 1] = bytes end
        return { outcome = "uploaded", bytes = tx[field] }
    elseif request.op == "commit" then
        assert(tx.bytes == tx.size, "Upload incomplete")
        local replacement = readFile(dir .. "/new")
        assert(replacement == table.concat(tx.parts), "Staged contents failed verification")
        local exists = fs.exists(path)
        assert(not exists or (not fs.isDir(path) and fs.getSize(path) <= maxFile), "Destination changed type/size")
        if tx.condition == "missing" then assert(not exists, "Conflict: destination already exists") end
        if tx.condition == "match" then
            local expected = readFile(dir .. "/expected")
            assert(expected == table.concat(tx.expectedParts), "Staged expected contents failed verification")
            assert(exists and readFile(path) == expected, "Conflict: destination changed since read")
        end
        save(dir .. "/intent", textutils.serializeJSON({ path = path, hadOriginal = exists, remove = tx.remove }))
        if exists then fs.move(path, dir .. "/backup") end
        local ok, err = true, nil
        if not tx.remove then ok, err = pcall(fs.move, dir .. "/new", path) end
        if not ok then
            if exists and not fs.exists(path) then pcall(fs.move, dir .. "/backup", path) end
            error("Replacement failed; recovery record retained: " .. tostring(err))
        end
        transactions[id] = nil
        local cleaned = pcall(fs.delete, dir)
        return { outcome = tx.remove and "deleted" or "committed", cleanupPending = not cleaned, transactionPath = not cleaned and ("/" .. dir) or nil }
    end
    error("Unknown transaction operation")
end

local function enhance(rawterm)
    if autoReconnect then rawterm.wsDelegate = persistentDelegate end
    local originalServer = rawterm.server
    rawterm.server = function(delegate, ...)
        -- Each monitor also receives the same websocket events. Skip unrelated
        -- packets before upstream's allocation-heavy full base64 decode. Only
        -- window 0 handles transactions; negotiation still reaches every window.
        if (select(3, ...) or 0) ~= 0 then
            local connection, windowId = delegate, select(3, ...)
            local receive = connection.receive
            local monitorDelegate = setmetatable({}, { __index = connection })
            function monitorDelegate:receive(...)
                while true do
                    local message = receive(connection, ...)
                    if not message then return message end
                    local prefix = message:sub(1, 4)
                    if prefix ~= "!CPC" and prefix ~= "!CPD" then return message end
                    local offset = prefix == "!CPD" and 16 or 8
                    local header = decode(message:sub(offset + 1, offset + 4))
                    if header:byte(1) == 6 then return message end
                    if resumeState.enabled then
                        -- Only scoped mouse packets target monitors. Inspect the
                        -- bounded frame before decoding; file uploads stay cheap.
                        if header:byte(1) == 78 and tonumber(message:sub(5, offset), 16) == 64 then
                            local data, payload, checksum = unpackFrame(message)
                            if #data == 47 and data:sub(3, 34) == resumeState.client and data:byte(35) == 0
                                and data:byte(36) == 2 and data:byte(37) == windowId and crc32(payload) == checksum then
                                return frame(data:sub(36))
                            end
                        end
                    elseif header:byte(2) == windowId then return message end
                end
            end
            return originalServer(monitorDelegate, ...)
        end
        local connection = delegate
        local originalSend = connection.send
        -- Envelope complete frames before upstream splits them into messages.
        function connection:send(message)
            local offset = message:sub(1, 4) == "!CPD" and 16 or 8
            local length = tonumber(message:sub(5, offset), 16)
            if not length then return originalSend(self, message) end
            local payload = message:sub(offset + 1, offset + length)
            local packetType = decode(payload:sub(1, 4)):byte(1)
            if resumeState.enabled and packetType ~= 6 and packetType ~= 77 then
                if not resumeState.client then return end
                -- 36-byte prefix aligns to base64 groups: avoid decoding and
                -- re-encoding every file chunk just to add a connection scope.
                message = framePayload(encode(string.char(79, 0, 1) .. resumeState.client .. "\0") .. payload)
            end
            return originalSend(self, message)
        end
        connection.flags = connection.flags or { isVersion11 = false, filesystem = false, binaryChecksum = false }
        delegate = setmetatable({ flags = connection.flags }, { __index = connection })
        local capture, outputEnabled
        do
            local receive, send = connection.receive, connection.send
            local enabled, commandsEnabled, foregroundEnabled, interruptsEnabled, safeWritesEnabled = false, false, false, false, false
            local syncFilesEnabled, debugEventsEnabled, identityEnabled = false, false, false
            local lastForeground
            commandState.foreground = function(force)
                if not foregroundEnabled then return end
                local function clean(value) return tostring(value or ""):gsub("%z", "?"):sub(1, 4095) end
                local path = commandState.program or ""
                local kind = commandState.phase
                if kind == "program" and path:gsub("^/", "") == "rom/programs/lua.lua" then kind = "lua_repl" end
                local data = string.char(1, commandState.ready and 1 or 0)
                    .. clean(kind) .. "\0" .. clean(path) .. "\0" .. clean(shell.dir()) .. "\0" .. clean(commandState.id) .. "\0"
                if force or data ~= lastForeground then
                    lastForeground = data
                    send(connection, frame(string.char(70, 0) .. data))
                end
            end
            commandState.finish = function(id, success, reason, interrupted)
                local record = resumeState.commands[id]
                if record then
                    record.state = interrupted and "interrupted" or (success and "finished" or "failed")
                    record.reason64 = encode(reason:sub(1, 512))
                end
                send(connection, frame(string.char(68, 0, interrupted and interruptsEnabled and 2 or (success and 0 or 1)) .. id .. "\0" .. reason:gsub("%z", "?"):sub(1, 512) .. "\0"))
            end
            commandState.interruptReply = function(request, outcome)
                if resumeState.enabled and request.client ~= resumeState.client then return end
                send(connection, frame(string.char(72, 0, 0, request.requestId) .. outcome .. "\0" .. (request.id or "") .. "\0"))
            end
            function delegate:receive(...)
                while true do
                    local message = receive(connection, ...)
                    if not message then return message end
                    local data, payload, checksum = unpackFrame(message)
                    local scoped = false
                    if data and data:byte(1) == 78 and resumeState.enabled then
                        assert(crc32(payload) == checksum, "Connection envelope checksum mismatch")
                        local client, position = string.unpack("<z", data, 3)
                        if client == resumeState.client then
                            data = data:sub(position)
                            assert(#data >= 2 and data:byte(1) ~= 78 and data:byte(1) ~= 6 and data:byte(1) ~= 76, "Invalid connection envelope")
                            scoped = true
                        else data = nil end
                    elseif data and resumeState.enabled and data:byte(1) ~= 6 and data:byte(1) ~= 76 then
                        data = nil -- Never accept unscoped actions after resume negotiation.
                    end
                    if not data then
                        -- Ignore stale packets instead of passing them to stock input.
                    elseif data:byte(1) == 76 and data:byte(2) == 0 and resumeState.enabled then
                        assert(crc32(payload) == checksum, "Attach checksum mismatch")
                        local request = assert(textutils.unserializeJSON(data:sub(3)), "Invalid attach request")
                        assert(type(request.client) == "string" and #request.client == 32 and request.client:match("^[a-f0-9]+$"), "Invalid attachment ID")
                        resumeState.client = request.client
                        local records = textutils.empty_json_array
                        if #resumeState.order > 0 then records = {} end
                        for _, id in ipairs(resumeState.order) do records[#records + 1] = resumeState.commands[id] end
                        send(connection, frame(string.char(77, 0) .. textutils.serializeJSON({ client = request.client, epoch = resumeState.epoch, transport = transport.serial, autoReconnect = autoReconnect, first = resumeState.first, last = resumeState.sequence, commands = records })))
                        commandState.foreground(true)
                    elseif data:byte(1) == 82 and data:byte(2) == 0 and resumeState.enabled then
                        assert((scoped or crc32(payload) == checksum) and #data == 7, "Invalid output recovery request")
                        local after = string.unpack("<I4", data, 4)
                        local sequence = math.max(after + 1, resumeState.first)
                        local batch = resumeState.logs[sequence]
                        send(connection, frame(string.char(83, 0, 0, data:byte(3)) .. string.pack("<I4I4I4", resumeState.first, batch and sequence or 0, resumeState.sequence) .. (batch or "")))
                    elseif data:byte(1) == 6 and data:byte(2) == 0 then
                        -- The extension deliberately uses base64 checksums. A
                        -- legacy client sends neither our flag nor signature.
                        local flags = string.unpack("<I2", data, 3)
                        enabled = bit32.btest(flags, capability) and data:sub(5) == signature
                            and not bit32.btest(flags, 1) and crc32(payload) == checksum
                        commandsEnabled = enabled and bit32.btest(flags, commandCapability)
                        outputEnabled = enabled and bit32.btest(flags, outputCapability)
                        foregroundEnabled = enabled and bit32.btest(flags, foregroundCapability)
                        interruptsEnabled = enabled and bit32.btest(flags, interruptCapability)
                        safeWritesEnabled = enabled and bit32.btest(flags, safeWriteCapability)
                        syncFilesEnabled = safeWritesEnabled and bit32.btest(flags, syncFilesCapability)
                        resumeState.enabled = enabled and bit32.btest(flags, resumeCapability)
                        debugEventsEnabled = resumeState.enabled and bit32.btest(flags, debugEventCapability)
                        identityEnabled = resumeState.enabled and bit32.btest(flags, identityCapability)
                        if not resumeState.enabled then resumeState.client = nil end
                        return message
                    elseif data:byte(1) == 86 and data:byte(2) == 0 and identityEnabled then
                        assert(scoped and #data == 3, "Invalid identity request")
                        local ok, result = pcall(computerIdentity)
                        if not ok then result = textutils.serializeJSON({ error = tostring(result):sub(1, 512) }) end
                        send(connection, frame(string.char(87, 0, ok and 0 or 1, data:byte(3)) .. result))
                    elseif data:byte(1) == 84 and data:byte(2) == 0 and debugEventsEnabled then
                        assert(scoped and #data <= 32771, "Invalid debug event frame")
                        local requestId = assert(data:byte(3), "Missing debug event request ID")
                        local ok, request = pcall(function() return debugEvent(textutils.unserializeJSON(data:sub(4))) end)
                        if ok then
                            commandState.debugEvent = request
                            send(connection, frame(string.char(85, 0, 0, requestId) .. textutils.serializeJSON({ outcome = "accepted", nonce = request.nonce, commandId = commandState.id or "" })))
                            return frame(string.char(3, 0, 1) .. "cc_mcp_debug_event\0" .. string.char(3) .. request.nonce .. "\0")
                        else
                            send(connection, frame(string.char(85, 0, 1, requestId) .. textutils.serializeJSON({ error = tostring(request):sub(1, 512) })))
                        end
                    elseif data and (data:byte(1) == 73 or data:byte(1) == 75) and data:byte(2) == 0 and safeWritesEnabled then
                        assert(scoped or crc32(payload) == checksum, "Transaction checksum mismatch")
                        local requestId = assert(data:byte(3), "Missing transaction request ID")
                        local ok, result = pcall(function()
                            if data:byte(1) == 75 then
                                local stream, offset, id, position = string.unpack("<BI4z", data, 4)
                                local tx = assert(transactions[id], "Unknown upload")
                                assert(stream <= 1, "Invalid upload stream")
                                return safeWrite({ op = "chunk", id = id, path64 = encode(tx.path), stream = stream == 0 and "new" or "expected", offset = offset, raw = data:sub(position) })
                            end
                            local request = assert(textutils.unserializeJSON(data:sub(4)), "Invalid transaction JSON")
                            assert(syncFilesEnabled or (request.op ~= "mkdir" and not request.remove), "Directory sync was not negotiated")
                            return safeWrite(request)
                        end)
                        if not ok then result = { error = tostring(result):sub(1, 1024) } end
                        send(connection, frame(string.char(74, 0, ok and 0 or 1, requestId) .. textutils.serializeJSON(result)))
                    elseif data and data:byte(1) == 71 and data:byte(2) == 0 and interruptsEnabled then
                        assert(scoped or crc32(payload) == checksum, "Interrupt checksum mismatch")
                        local requestId = assert(data:byte(4), "Missing interrupt request ID")
                        local ok, request = pcall(function()
                            assert(data:byte(3) == 1 and data:byte(5) <= 1, "Invalid interrupt version/mode")
                            local target, ending = string.unpack("<z", data, 6)
                            assert(ending == #data + 1 and (target == "" or (#target == 32 and target:match("^[0-9a-f]+$"))), "Invalid interrupt target")
                            assert(target == "" or (commandState.phase == "program" and target == commandState.id), "Command ID does not match the foreground program")
                            assert(not commandState.interrupt, "An interrupt is already pending")
                            return { requestId = requestId, id = commandState.id, client = resumeState.client, mode = data:byte(5) == 1 and "force" or "graceful" }
                        end)
                        if not ok then
                            send(connection, frame(string.char(72, 0, 1, requestId) .. tostring(request):gsub("%z", "?"):sub(1, 512) .. "\0\0"))
                        elseif commandState.phase ~= "program" then
                            commandState.interruptReply(request, "idle")
                        else
                            commandState.interrupt = request
                            return frame(string.char(3, 0, 0) .. "cc_mcp_interrupt\0")
                        end
                    elseif data and data:byte(1) == 66 and data:byte(2) == 0 and commandsEnabled then
                        assert(scoped or crc32(payload) == checksum, "Command request checksum mismatch")
                        local requestId = assert(data:byte(4), "Missing command request ID")
                        local ok, id, command = pcall(function()
                            assert(data:byte(3) == 1, "Unsupported command version")
                            local commandId, line, ending = string.unpack("<zz", data, 5)
                            assert(#commandId == 32 and commandId:match("^[0-9a-f]+$"), "Invalid command ID")
                            assert(not resumeState.commands[commandId], "Command ID already used; commands are never replayed")
                            assert(ending == #data + 1 and #line <= 4096 and line:match("%S") and not line:find("[\r\n]"), "Invalid command line")
                            assert(commandState.ready and not commandState.pending, "Foreground is not an idle shell prompt; use send_text/send_key for interactive input")
                            return commandId, line
                        end)
                        if ok then
                            resumeState.commands[id] = { commandId = id, command64 = encode(command), state = "running" }
                            resumeState.order[#resumeState.order + 1] = id
                            if #resumeState.order > 128 then resumeState.commands[table.remove(resumeState.order, 1)] = nil end
                            commandState.ready = false
                            commandState.pending = { id = id, command = command }
                            commandState.phase, commandState.id, commandState.program = "starting", id, nil
                            foregroundChanged()
                            send(connection, frame(string.char(67, 0, 0, requestId) .. id .. "\0"))
                            -- Deliver an internal event through rawterm to the
                            -- shell coroutine; never execute on the network loop.
                            return frame(string.char(3, 0, 0) .. "cc_mcp_execute\0")
                        else
                            send(connection, frame(string.char(67, 0, 1, requestId) .. tostring(id):gsub("%z", "?"):sub(1, 512) .. "\0"))
                        end
                    elseif data and data:byte(1) == 64 and data:byte(2) == 0 and enabled then
                        assert(scoped or crc32(payload) == checksum, "Enhanced request checksum mismatch")
                        local id = assert(data:byte(4), "Missing request ID")
                        local ok, response = pcall(readChunk, data)
                        if not ok then response = tostring(response):sub(1, 512) end
                        send(connection, frame(string.char(65, 0, ok and 0 or 1, id) .. response))
                    else
                        return scoped and frame(data) or message
                    end
                end
            end
            function delegate:send(message)
                -- Preserve all legacy packets byte-for-byte, including legacy
                -- binary checksums. Only amend negotiation for our own client.
                if enabled and message:sub(1, 4) == "!CPC" and decode(message:sub(9, 12)):byte(1) == 6 then
                    local data = unpackFrame(message)
                    if data and data:byte(1) == 6 and data:byte(2) == 0 then
                        local flags = bit32.bor(string.unpack("<I2", data, 3), capability)
                        if commandsEnabled then flags = bit32.bor(flags, commandCapability) end
                        if outputEnabled then flags = bit32.bor(flags, outputCapability) end
                        if foregroundEnabled then flags = bit32.bor(flags, foregroundCapability) end
                        if interruptsEnabled then flags = bit32.bor(flags, interruptCapability) end
                        if safeWritesEnabled then flags = bit32.bor(flags, safeWriteCapability) end
                        if syncFilesEnabled then flags = bit32.bor(flags, syncFilesCapability) end
                        if resumeState.enabled then flags = bit32.bor(flags, resumeCapability) end
                        if debugEventsEnabled then flags = bit32.bor(flags, debugEventCapability) end
                        if identityEnabled then flags = bit32.bor(flags, identityCapability) end
                        message = frame(string.char(6, 0) .. string.pack("<I2", flags) .. signature)
                        local result = send(connection, message)
                        commandState.foreground(true)
                        return result
                    end
                end
                return send(connection, message)
            end
        end
        -- Upstream races window receivers against local events using
        -- parallel.waitForAny. A local event can discard its caller while a
        -- filesystem/peripheral API is yielding. Retain the receive coroutine
        -- across those calls so an in-flight operation resumes, never restarts.
        -- Its current event filter is retained too: do not resume a suspended
        -- API with an empty or unrelated event when a new caller arrives.
        local receive = delegate.receive
        local receiver, received
        function delegate:receive(...)
            if not receiver then
                receiver = coroutine.create(receive)
                received = table.pack(coroutine.resume(receiver, self, ...))
            end
            while true do
                if not received[1] then
                    local reason = received[2]
                    receiver, received = nil, nil
                    error(reason, 0)
                end
                if coroutine.status(receiver) == "dead" then
                    local result = received
                    receiver, received = nil, nil
                    return table.unpack(result, 2, result.n)
                end
                local ev = table.pack(os.pullEventRaw(received[2]))
                received = table.pack(coroutine.resume(receiver, table.unpack(ev, 1, ev.n)))
            end
        end
        local win = originalServer(delegate, ...)
        capture = captureTerminal(win, function(data)
            local original = string.char(69, 0) .. data
            local sequenced = retainOutput(original)
            if resumeState.enabled then
                if resumeState.client then
                    originalSend(connection, frame(string.char(79, 0, 1) .. resumeState.client .. "\0" .. sequenced))
                end
            elseif outputEnabled then originalSend(connection, frame(original)) end
        end, function() return outputEnabled or autoReconnect end)
        commandState.capture = capture
        return win
    end
    return rawterm
end

-- Run the official relay-generated launcher in an isolated environment, adding
-- our delegate wrapper when it loads rawterm. Upstream owns monitors, terminal
-- events, stock filesystem operations, and connection lifecycle. We supply the
-- single-foreground tracked shell as its explicit command argument.
local url = relay:gsub("^ws", "http") .. "server.lua"
local function download(...)
    local response, err
    local backoff = 1
    repeat
        response, err = http.get(...)
        if not response and autoReconnect then sleep(backoff); backoff = math.min(backoff * 2, 30) end
    until response or not autoReconnect
    return response, err
end
local response, err = download(url)
assert(response, err)
local source = response.readAll()
response.close()
local environment = setmetatable({}, { __index = _ENV })
if autoReconnect then
    environment.http = setmetatable({ get = download }, { __index = http })
    environment.os = setmetatable({ pullEventRaw = function(filter)
        local ev = table.pack(os.pullEventRaw(filter))
        if ev[1] == "websocket_closed" and ev[2] == relay .. token then ev[1] = "cc_mcp_network_closed" end
        if ev[1] == "cc_mcp_transport_message" then ev = table.pack("websocket_message", relay .. token, ev[3]) end
        return table.unpack(ev, 1, ev.n)
    end }, { __index = os })
end
environment.shell = setmetatable({ run = function(program, ...)
    if program == "__cc_mcp_shell" then return trackedShell() end
    return shell.run(program, ...)
end }, { __index = shell })
environment.dofile = function(path)
    local result = dofile(path)
    return path == "rawterm.lua" and enhance(result) or result
end
environment.load = function(code, chunkname, mode, env)
    local fn, loadError = load(code, chunkname, mode, env or environment)
    if not fn or chunkname ~= "@rawterm.lua" then return fn, loadError end
    return function(...) return enhance(fn(...)) end
end
print("Starting CC-MCP enhanced remote...")
local launcher = assert(load(source, "@cc-mcp/stock-server.lua", "t", environment))
if autoReconnect then
    parallel.waitForAny(function() launcher(token, "__cc_mcp_shell") end, reconnectTransport)
    transport.stopped = true
    if transport.socket then pcall(transport.socket.close) end
else launcher(token, "__cc_mcp_shell") end
