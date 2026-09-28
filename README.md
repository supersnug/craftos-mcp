# CC: Tweaked MCP

A local MCP server for controlling in-game CC: Tweaked computers through CraftOS-PC Remote. It includes an **enhanced Lua launcher** with chunked file access and automatically supports the official stock scripts in **compatibility mode**. Turtle and peripheral control use normal CraftOS programs or the Lua REPL.

No Minecraft server plugin or custom relay is required. The default relay is `wss://remote.craftos-pc.cc/`. The enhanced launcher runs the official relay-generated script with a protocol extension; it preserves its normal terminal and monitor behavior.

## Install

Requires Node.js **22 or newer**, npm, and a CC: Tweaked computer with HTTP and WebSocket access enabled on its Minecraft server. Upstream documents CC: Tweaked 1.85+ support and recommends 1.91+; use a current release where possible.

```sh
npm ci
npm run build
```

Configure your MCP client to launch:

```json
{
  "mcpServers": {
    "craftos": {
      "command": "node",
      "args": ["/absolute/path/to/cc-mcp/dist/index.js"]
    }
  }
}
```

This is the common `mcpServers` configuration format; the surrounding configuration keys depend on your client. The executable uses **stdio**, with stdout reserved for MCP messages. It works from any working directory when given the absolute script path.

## First-time setup

1. Ask your AI client to call `connect_computer` with a name such as `workshop`.
2. Paste the returned **`connectionCommand`** into the in-game CraftOS shell. It downloads and launches the enhanced script directly from GitHub:

   ```lua
   wget run https://raw.githubusercontent.com/supersnug/craftos-mcp/main/lua/cc-mcp.lua <generated-token> wss://remote.craftos-pc.cc/
   ```

3. Call `read_terminal` for `workshop` until its state is `connected`. The session should report `mode: "enhanced"` with 1 MiB read/write/edit limits.

No prior installation or stock bootstrap connection is needed. The GitHub URL requires `lua/cc-mcp.lua` to be published on the repository's `main` branch.

### Persistent installation

To save a local copy instead of downloading the enhanced launcher on every connection:

```lua
wget https://raw.githubusercontent.com/supersnug/craftos-mcp/main/lua/cc-mcp.lua /cc-mcp.lua
```

Use the returned **`installedCommand`** to launch that copy:

```lua
/cc-mcp.lua <generated-token> wss://remote.craftos-pc.cc/
```

Alternatively, call `install_enhanced_script` with `{"name":"workshop"}` over any existing connection, including stock. It copies the bundled launcher to `/cc-mcp.lua` without executing it. An existing file is preserved unless `overwrite: true` is explicitly supplied. At the remote shell prompt, run `exit`, disconnect the old local name, create a fresh connection, and run its `installedCommand`. Avoid launching a nested remote script.

### Stock-only connections

Set `script: "stock"` on `connect_computer` to get the official script as the primary `connectionCommand`. Stock terminal/file tools continue to work with their existing limits. Mode detection depends on the **actual peer's negotiated capabilities**, not the chosen launch command.

The same official command is always returned as **`bootstrapCommand`**:

```lua
wget run https://remote.craftos-pc.cc/server.lua <generated-token>
```

It can also bootstrap installation through `install_enhanced_script` if the enhanced script is not yet published on GitHub. A detected stock connection reports:

> **Entering compatibility mode…** The connected computer is running the stock remote protocol. File reads and edits are limited to 8 KiB; command completion is unavailable.

Every computer-specific tool result includes connection metadata with `mode`, negotiated `limits`, and the compatibility `warning` when applicable. `list_computers` and terminal snapshots expose the same state. A failed enhanced operation, a malformed negotiation, or a disconnect is an error—not a reason to silently switch to stock mode.

### Multiple computers and reconnection

Each computer gets a separate name and token. You can also pass an existing remote session's `token` to `connect_computer`. Use one controlling client per token: another client such as VS Code can interleave input and filesystem request IDs.

Session tokens grant access to that remote terminal and filesystem. The public relay carries the connection traffic. Names and tokens are held in memory; restarting the MCP server forgets sessions. To reconnect, disconnect the old local name and connect again, using the existing token if the stock remote script is still running, or running the new returned command in-game.

### Self-hosted relay

Pass `relay` to `connect_computer`, or set `CRAFTOS_RELAY_URL` in the MCP process environment. Use a `ws://` or `wss://` base URL. The relay must implement the [upstream relay](https://github.com/MCJack123/remote.craftos-pc.cc) behavior and serve its generated `server.lua`, `rawterm.lua`, and `string_pack.lua` from the corresponding HTTP(S) base URL. Merely changing the client URL cannot redirect a script downloaded from the public relay.

The relay must be reachable by both the Minecraft server and the MCP process. CC: Tweaked's server-side HTTP rules apply.

## Tools

All computer-specific tools take `name`.

| Tool | Purpose |
| --- | --- |
| `connect_computer` | Create a session and return enhanced and stock/bootstrap commands; optionally attach using a token |
| `install_enhanced_script` | Install `/cc-mcp.lua` over an existing connection and return restart instructions |
| `list_computers` | List connection states and terminal/monitor windows |
| `disconnect_computer` | Close and forget a local session |
| `read_terminal` | Return the latest text screen, colors, cursor, dimensions, and timestamp |
| `run_command` | Paste one line and press Enter in the foreground terminal |
| `send_text` | Paste one line without pressing Enter |
| `send_key` | Press/release navigation, letter, function, or modifier keys |
| `interrupt_program` | Send a best-effort `terminate` event |
| `list_files` | List a directory, defaulting to `/` |
| `read_file` | Read text or base64 data, up to **1 MiB enhanced / 8 KiB stock** |
| `write_file` | Create/overwrite a file, up to **1 MiB**, using acknowledged **4 KiB** chunks |
| `edit_file` | Replace exactly one occurrence of `old_text` with `new_text`, up to **1 MiB enhanced / 8 KiB stock** |

### Example: write and run a Lua program

```json
{"name":"workshop","path":"/hello.lua","content":"print(\"Hello from MCP\")\n"}
```

Pass that to `write_file`, then call `run_command`:

```json
{"name":"workshop","command":"/hello.lua","wait_ms":500}
```

Read the returned screen or call `read_terminal` again. To update the program, call `edit_file`:

```json
{"name":"workshop","path":"/hello.lua","old_text":"Hello from MCP","new_text":"Updated through MCP"}
```

For turtles and peripherals, write ordinary Lua programs using `turtle` and `peripheral`, or run `lua` and send expressions at its prompt. `run_command` always sends input to whichever program is currently in the foreground.

## Behavior and limits

- **Screen snapshots, not process execution results.** The remote protocol has no command-completion signal or exit status. `wait_ms` waits 0–5000 ms; a quiet screen is not proof of completion. Output that scrolls away between frames is not recoverable as a full transcript.
- **Read before typing.** `run_command` does not clear an existing input line or force the shell to the foreground. Interactive programs remain accessible through text/key tools. Input is single-line, capped at 4096 characters; use file tools for multiline Lua.
- **Direct file access.** File tools use the negotiated remote filesystem protocol, independently of the shell's current directory. Paths are rooted at the computer filesystem. Filesystem operations can stall if the remote program is not yielding.
- **Enhanced file access.** Reads transfer at most 4 KiB per request using an efficient encoder; writes use acknowledged 4 KiB stock append operations. Read, write, and edit limits are 1 MiB. Chunked reads check offsets, lengths, and file size on every response. Empty files and binary contents are supported.
- **Stock read/edit limit.** Upstream's whole-file base64 encoder does not yield. Testing found that larger reads can stop the remote script with “Too long without yielding.” In compatibility mode, the MCP checks file size before requesting contents and limits reads/edits to 8 KiB. Writes still support 1 MiB through small append operations.
- **Concurrent writes are not atomic.** An interrupted write can leave a partial file. Errors report acknowledged bytes; the last chunk may have an unknown outcome. Edits require a unique match and re-read before writing to detect intervening changes. Neither mode provides atomic compare-and-swap, and same-size external changes during a chunked read may not be detected. Use one writer per computer.
- **Byte-preserving text.** CraftOS uses single-byte strings. Text content maps bytes to U+0000–U+00FF, rather than assuming UTF-8; paths and pasted text cannot contain NUL. Use `encoding: "base64"` for arbitrary binary content. Screen glyphs above ASCII may render differently in your client than in Minecraft.
- **Interrupt is best effort.** Programs using `os.pullEventRaw` and stock event filters can ignore `terminate`. Sending it at an idle shell can close the remote shell and disconnect the session.
- **Explicit recovery.** No commands or file operations are automatically replayed. File requests time out after 30 seconds. The session probes the computer and disconnects after roughly 35 seconds without a negotiation response. Reconnect explicitly and inspect the state before deciding whether to repeat an action.
- **Text terminals.** Window 0 is the main computer terminal. `read_terminal` can also read advertised monitor windows. CraftOS-PC graphics-mode frames are not supported; CC: Tweaked's normal text terminals are the primary target.
- **Session lifetime.** The in-game remote script must remain running. Shutdowns, unloaded computers/chunks, and relay disconnections can end access. Up to 32 named sessions are supported per MCP process.

## Development and verification

```sh
npm run check
```

Builds and runs protocol, local WebSocket session, MCP tool-discovery, error-handling, and compiled stdio-startup tests. Tests do not contact the public relay.

An additional integration test runs **the actual upstream Lua scripts and our enhanced launcher in CraftOS-PC** against a temporary local relay, using headless and raw renderers:

```sh
RUN_STOCK_INTEGRATION=1 npm test
```

It requires `craftos` on `PATH` (or `CRAFTOS_BIN`), network access to fetch upstream sources, and the directory `/tmp/opencode`. It verifies the fetched source against recorded Git blob hashes and cleans up its temporary computer data. Coverage includes stock terminal/filesystem operations and warning metadata, installation over stock, reconnecting in enhanced mode, 1 MiB binary round-trips and text edits, monitor preservation, empty files and file errors, and an unextended legacy client controlling the enhanced terminal. Local WebSocket tests also verify negotiation failures, timeouts without fallback, and changing-file detection.

This provides stock-script compatibility evidence in an emulator. An actual Minecraft-server connection remains the final environment-specific acceptance check: connect, write `/hello.lua`, run it, and observe the output.

## Source layout

- `src/protocol.ts` — framing, checksums, screen decoding, strings, and scan codes.
- `src/session.ts` — relay lifecycle, negotiation, request correlation, terminal and file operations.
- `src/server.ts` — MCP tool schemas and tool behavior.
- `src/index.ts` — stdio entry point and shutdown.
- `lua/cc-mcp.lua` — enhanced launcher, capability advertisement, and bounded chunk reads.
- `docs/enhanced-protocol.md` — extension wire format and compatibility rules.

Protocol references: [CraftOS-PC Remote documentation](https://www.craftos-pc.cc/docs/remote), [official remote scripts](https://github.com/MCJack123/remote.craftos-pc.cc). The enhanced launcher fetches the relay's official `server.lua`, which loads/caches its corresponding `rawterm.lua`. This project does not bundle or rewrite those upstream sources; the launcher wraps their delegates at runtime.
