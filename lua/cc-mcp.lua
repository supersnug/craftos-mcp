-- CC-MCP enhanced remote launcher, protocol version 1.
-- Usage: /cc-mcp.lua <token> [ws[s]://relay/]
-- Keeps upstream terminal behavior, extending capability negotiation and reads.
local token, relay = ...
relay = relay or "wss://remote.craftos-pc.cc/"
assert(type(token) == "string" and #token <= 128 and token:match("^[%w_-]+$"), "Expected a session token")
assert(relay:match("^wss?://") and not relay:find("[%s?#]"), "Expected a WebSocket relay base URL")
if relay:sub(-1) ~= "/" then relay = relay .. "/" end
local signature, capability = "CCMCP/1\0", 0x8000
local maxFile, maxChunk = 1024 * 1024, 4096

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
local function frame(data)
    local payload = encode(data)
    assert(#payload <= 65535, "Enhanced response exceeds frame limit")
    return ("!CPC%04X%s%08X\n"):format(#payload, payload, crc32(payload))
end
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

local function enhance(rawterm)
    local originalServer = rawterm.server
    rawterm.server = function(delegate, ...)
        -- Each monitor also calls receive for the same websocket events. Wrap
        -- only window 0, or one chunk request would be handled once per monitor.
        if (select(3, ...) or 0) ~= 0 then return originalServer(delegate, ...) end
        local connection = delegate
        connection.flags = connection.flags or { isVersion11 = false, filesystem = false, binaryChecksum = false }
        delegate = setmetatable({ flags = connection.flags }, { __index = connection })
        do
            local receive, send = connection.receive, connection.send
            local enabled = false
            function delegate:receive(...)
                while true do
                    local message = receive(connection, ...)
                    if not message then return message end
                    local data, payload, checksum = unpackFrame(message)
                    if data and data:byte(1) == 6 and data:byte(2) == 0 then
                        -- The extension deliberately uses base64 checksums. A
                        -- legacy client sends neither our flag nor signature.
                        local flags = string.unpack("<I2", data, 3)
                        enabled = bit32.btest(flags, capability) and data:sub(5) == signature
                            and not bit32.btest(flags, 1) and crc32(payload) == checksum
                        return message
                    elseif data and data:byte(1) == 64 and data:byte(2) == 0 and enabled then
                        assert(crc32(payload) == checksum, "Enhanced request checksum mismatch")
                        local id = assert(data:byte(4), "Missing request ID")
                        local ok, response = pcall(readChunk, data)
                        if not ok then response = tostring(response):sub(1, 512) end
                        send(connection, frame(string.char(65, 0, ok and 0 or 1, id) .. response))
                    else
                        return message
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
                        message = frame(string.char(6, 0) .. string.pack("<I2", flags) .. signature)
                    end
                end
                return send(connection, message)
            end
        end
        return originalServer(delegate, ...)
    end
    return rawterm
end

-- Run the official relay-generated launcher in an isolated environment, adding
-- our delegate wrapper when it loads rawterm. Upstream still owns shell,
-- monitors, terminal events, stock filesystem operations, and lifecycle.
local url = relay:gsub("^ws", "http") .. "server.lua"
local response, err = http.get(url)
assert(response, err)
local source = response.readAll()
response.close()
local environment = setmetatable({}, { __index = _ENV })
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
assert(load(source, "@cc-mcp/stock-server.lua", "t", environment))(token)
