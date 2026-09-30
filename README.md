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

### OpenCode 2

OpenCode 2 uses `mcp.servers` instead of the v1 `mcp` server map:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "craftos": {
        "type": "local",
        "command": ["node", "/absolute/path/to/cc-mcp/dist/index.js"]
      }
    }
  }
}
```

Put this entry in your global `~/.config/opencode/opencode.jsonc` or project configuration. Servers connect automatically; v2 uses `disabled: true` to disable one, rather than v1's `enabled` field. Leave the protocol at its default (`legacy`), which supports this server's standard MCP initialization handshake. Verify with `opencode mcp list`. Connection has been verified with OpenCode **v2.0.18**. Restart OpenCode after configuration changes or rebuilding the server to load the updated tools.

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

> **Entering compatibility mode…** The connected computer is running the stock remote protocol. File reads are limited to 8 KiB; conflict-safe edits and command completion are unavailable. Unconditional writes may leave partial files.

Every computer-specific tool result includes connection metadata with `mode`, negotiated `limits`, and the compatibility `warning` when applicable. `list_computers` and terminal snapshots expose the same state. A failed enhanced operation, a malformed negotiation, or a disconnect is an error—not a reason to silently switch to stock mode.

### Multiple computers and reconnection

Each computer gets a separate name and token. You can also pass an existing remote session's `token` to `connect_computer`. Use one controlling client per token: another client such as VS Code can interleave input and filesystem request IDs.

Session tokens grant access to that remote terminal and filesystem. The public relay carries the connection traffic. By default, names and tokens are held in memory and reconnecting is explicit. Opt in to persistence and network retries with `reconnect: true` on `connect_computer` (enhanced launcher only).

### Automatic startup and reconnection

```json
{"name":"workshop","reconnect":true}
```

Run the returned `connectionCommand` in-game. It includes `--reconnect`. Both sides retry network connections with increasing delays capped at 30 seconds. The enhanced launcher keeps the foreground program and terminal alive during an outage; it replaces the network connection rather than restarting the shell. Programs must still yield normally. Computer shutdown/reboot ends the running invocation.

Opted-in profiles save the name, relay and token in **`$XDG_STATE_HOME/cc-mcp/connections.json`**, defaulting to `~/.local/state/cc-mcp/connections.json`. Set `CRAFTOS_CONNECTIONS_FILE` to override the location. The file is written with owner-only permissions. The MCP restores these connections on startup; it stores no commands or pending mutations in that file. Use one MCP process per profile file and one controller per token. Invalid profile files are reported rather than silently discarded.

For in-game boot startup:

1. Connect with `reconnect: true`.
2. Use `install_enhanced_script` to install the current `/cc-mcp.lua` (`overwrite: true` when updating).
3. Call `configure_startup` with `{"name":"workshop","enabled":true}`.

This creates **`/startup/zz-cc-mcp.lua`**, using the saved relay/token, and takes effect on the next boot. Existing startup files are preserved. An existing `/startup` file prevents creation of the directory; an unmanaged file at the managed script path is rejected. Existing startup programs must return before ours runs. CraftOS startup must be enabled, and a disk startup can override root startup. The launcher still needs the relay's HTTP resources during startup, retrying initial downloads when unavailable.

Call `configure_startup` with `enabled: false` to remove only the managed boot script; this does not stop the running launcher. `disconnect_computer` stops MCP retries and deletes the saved profile, while leaving the in-game launcher and boot script alone. Disable boot startup before disconnecting if both should be removed.

Reattachment uses a fresh connection ID. Queued input and unfinished requests are rejected, never replayed. Up to 128 command records and a bounded 1 MiB remote output buffer can be recovered from a still-running launcher, including after MCP restart. A reboot starts a new execution epoch: old unfinished commands remain unknown, never rerun. `reconnection` metadata reports support, local/remote enablement, retry state and output recovery. `read_output` reports `recovering` and `recoveryGap`; gaps also set `truncated`. Start without an output cursor after MCP restart or creating a new named session.

Sync remains paused after connection loss or replacement, even when reconnection succeeds. Use `continue_sync` explicitly. Uncertain file mutations retain their transaction IDs and require inspection/recovery. Older peers keep their compatibility behavior; metadata explains when the current launcher or `--reconnect` is missing.

### Self-hosted relay

Pass `relay` to `connect_computer`, or set `CRAFTOS_RELAY_URL` in the MCP process environment. Use a `ws://` or `wss://` base URL. The relay must implement the [upstream relay](https://github.com/MCJack123/remote.craftos-pc.cc) behavior and serve its generated `server.lua`, `rawterm.lua`, and `string_pack.lua` from the corresponding HTTP(S) base URL. Merely changing the client URL cannot redirect a script downloaded from the public relay.

The relay must be reachable by both the Minecraft server and the MCP process. CC: Tweaked's server-side HTTP rules apply.

## Computer identity and peripheral capabilities

Current enhanced launchers automatically collect identity when connected and refresh it about every **10 seconds**, including while a foreground program is running. `list_computers`, terminal snapshots and existing computer-specific tool results expose an `identity` object:

```json
{
  "supported": true,
  "stale": false,
  "computerId": 42,
  "label": "Workshop",
  "craftosVersion": "CraftOS 1.9",
  "host": "ComputerCraft ...",
  "kind": "turtle",
  "isTurtle": true,
  "color": true,
  "peripherals": [
    {"name":"left","types":["modem"],"methods":["open","close"],"truncated":false}
  ],
  "totalPeripherals": 1,
  "truncated": false,
  "observedAt": "...",
  "refreshing": false
}
```

`kind` is `computer`, `turtle`, `pocket`, or `command`. An unset label and unavailable host string are `null`. `color` reports color-terminal support. Computer IDs are supplied by that Minecraft world/emulator, not globally unique identifiers.

Discovery uses `peripheral.getNames`, every value returned by `peripheral.getType`, and `peripheral.getMethods`. It includes direct attachments and peripherals exposed through wired modems. Names, types and methods are sorted and preserved as reported; this works with standard CC:Tweaked peripherals and mods such as **[Advanced Peripherals](https://docs.advanced-peripherals.de/0.7/)** that expose the same API. Discovery only lists methods. Invoke them with ordinary Lua through programs or the REPL; mod configuration and permissions still determine which calls work. Actual Advanced Peripherals devices have not been tested in the emulator.

Labels and hot attachment/detachment appear on a subsequent refresh. Inspection does not type into or interrupt the foreground program. Non-yielding programs can delay it, as with other remote requests. Each observation is best-effort rather than an atomic world snapshot; a device detached during inspection may carry its own `error`.

Before the initial response, `stale` is true. Disconnection, reattachment awaiting fresh data, failed inspection, or an observation older than 25 seconds also marks data stale. Historical values remain available with their `observedAt` timestamp. Stock/older launchers report `supported: false` instead of inferring identity from terminal titles. Update the enhanced launcher to enable this feature.

Inventory is bounded to **128 peripherals, 32 types and 256 methods per peripheral, and a 32 KiB wire response**. Names/types/methods are limited to 256 bytes; overlong entries and excess data are omitted, with `truncated` and `totalPeripherals` making incomplete inventories explicit. Labels/version/host fields have bounded lengths too. Do not treat a truncated list as proof that a peripheral or method is absent.

## Tools

All computer-specific tools take `name`.

| Tool | Purpose |
| --- | --- |
| `connect_computer` | Create a session and return enhanced and stock/bootstrap commands; optionally attach using a token |
| `install_enhanced_script` | Install `/cc-mcp.lua` over an existing connection and return restart instructions |
| `configure_startup` | Enable/disable the managed in-game boot script, preserving existing startup files |
| `list_computers` | List connection states and terminal/monitor windows |
| `disconnect_computer` | Close and forget a local session |
| `read_terminal` | Return the latest text screen, colors, cursor, dimensions, and timestamp |
| `read_monitor` | Read an advertised monitor by its peripheral name, including colors and screen availability |
| `run_command` | Start a tracked command at an idle enhanced shell; stock/older scripts use paste-and-Enter |
| `get_command_status` | Check a tracked command's running/finished/failed/unknown state by ID |
| `read_output` | Read terminal scrollback or command-specific output with an incremental cursor |
| `send_text` | Paste one line without pressing Enter |
| `send_key` | Press/release navigation, letter, function, or modifier keys |
| `send_mouse` | Send one computer-terminal click, release, drag, or scroll event |
| `touch_monitor` | Send a touchscreen event by exact monitor peripheral name |
| `send_event` | Inject a synthetic Lua event into the foreground program for debugging |
| `interrupt_program` | Graceful or force interruption with enhanced peers; best-effort terminate with older peers |
| `list_files` | List a directory, defaulting to `/` |
| `read_file` | Read text or base64 data, up to **1 MiB enhanced / 8 KiB stock** |
| `write_file` | Replace up to **1 MiB** with staged recovery on current enhanced peers; optional hash or create-only preconditions |
| `edit_file` | Conflict-safe unique replacement up to **1 MiB**, requiring `expected_hash` and a current enhanced launcher |
| `recover_file_write` | Abort staged uploads or conservatively restore a backup using the transaction ID |
| `sync_folder` | Push a local project folder, optionally watching for changes |
| `get_sync_status` | Inspect loaded sync jobs, progress, pauses and conflict hashes |
| `read_sync_conflict` | Read baseline/local/remote versions of the current conflict |
| `resolve_sync_conflict` | Choose local, remote, or supplied merged contents |
| `continue_sync` | Explicitly continue a paused sync and resume its watcher |
| `stop_sync` | Stop after the current file, retaining history and conflict evidence |

### Example: write and run a Lua program

```json
{"name":"workshop","path":"/hello.lua","content":"print(\"Hello from MCP\")\n"}
```

Pass that to `write_file`, then call `run_command`:

```json
{"name":"workshop","command":"/hello.lua","wait_ms":500}
```

Read the returned screen or call `read_terminal` again. To update the program, first call `read_file`, then pass its `hash` to `edit_file`:

```json
{"name":"workshop","path":"/hello.lua","old_text":"Hello from MCP","new_text":"Updated through MCP","expected_hash":"<hash returned by read_file>"}
```

For turtles and peripherals, write ordinary Lua programs using `turtle` and `peripheral`, or run `lua` and send expressions at its prompt through `send_text` and `send_key` (`enter`). A tracked `run_command` is for starting a shell program, not for typing into an existing program.

## Recoverable writes and conflict-safe edits

`read_file` returns the SHA-256 `hash` of its returned bytes. `edit_file` requires this as `expected_hash`. The client rejects a stale hash, then uploads both the expected contents and replacement to a sibling staging directory. Immediately before replacement the computer compares the destination byte-for-byte with the expected contents. Missing, changed, and same-size modified destinations conflict without being overwritten. Unique-match text replacement is still required.

`write_file` optionally accepts `expected_hash` for conditional replacement, or `must_not_exist: true` for create-only writes. Without either, replacement is unconditional. They cannot be combined. Current enhanced peers advertise `fileSafety.recoverableWrites` and `conditionalWrites`; older peers reject edits and conditional writes instead of weakening their semantics. Their unconditional writes remain legacy chunked overwrites.

For current enhanced peers, the original file stays untouched during upload. The remote script verifies the staged file against received chunks before commit. It records replacement intent, moves the old file to a backup, and moves the completed staged file into place. A failed second rename attempts restoration. Success includes the resulting hash, `transactionId`, and `safety: "recoverable"`.

**This is recoverable replacement, not a crash-atomic overwrite.** CC: Tweaked cannot rename over an existing destination. A crash or filesystem failure can leave the destination absent between renames, but the backup and intent record remain available. Arbitrary external host writers and open file handles are outside the guarantee. Same-size changes during a chunked read can produce a mixed read; the commit-time byte comparison rejects that version unless it exactly matches the then-current destination.

On failure, keep the transaction ID and path from the error and use:

```json
{"name":"workshop","path":"/hello.lua","transaction_id":"<32-character transaction ID>"}
```

Pass this to `recover_file_write`. It aborts an upload if commit never began, or restores a backup only when the destination is absent. If a destination exists alongside backup/intent evidence, it preserves everything and requests inspection rather than guessing. Recovery works with the on-disk record after reconnecting/restarting the launcher. Never replay an uncertain commit. Successful writes normally remove their staging directory; `cleanupPending` reports a cleanup failure.

Staging uses `.cc-mcp-<transaction ID>` alongside the destination, on the same mount, and requires additional disk space for staged replacement and expected contents. The parent directory must already exist. Existing destinations and new contents are limited to 1 MiB; at most eight active uploads are held per launcher. Unfinished uploads are not blindly garbage-collected: use their transaction IDs to recover them. The installer also uses recoverable writes when connected to a capable launcher, while retaining stock bootstrap compatibility.

## Local folder sync

`sync_folder` pushes files from a directory **on the machine running this MCP server** to a connected computer. It requires a current enhanced launcher advertising `fileSafety.directorySync: true`. Update both the MCP server and `/cc-mcp.lua` to enable it.

```json
{
  "name": "workshop",
  "local_path": "/home/me/projects/turtle-app",
  "remote_path": "/apps/turtle-app",
  "watch": true,
  "delete_removed": false,
  "wait_ms": 250
}
```

Omit `watch` for an on-demand push. Paths are preserved under `remote_path`, needed directories are created, and equal files are skipped. All eligible regular files are copied byte-for-byte, including binary assets. Empty directories are not copied. Nested `.gitignore` rules are respected; `.git`, `.cc-mcp-sync`, symlinks, special files, and internal temporary files are excluded. Ignore rules come from within the selected root, not global Git configuration. Files excluded by ignore rules or replaced by symlinks are preserved remotely even when deletion is enabled.

The tool returns a `syncId` and status. A large pass continues after the bounded `wait_ms` expires; inspect `get_sync_status` instead of starting it again:

```json
{"sync_id":"<returned syncId>"}
```

Statuses are `running`, `idle` (the last pass completed), `conflict`, `paused` (error or resolved file awaiting continuation), and `stopped`. Status includes counts for uploaded, deleted, unchanged and kept files. Omit the ID from `get_sync_status` to list jobs loaded in this MCP process.

### Conflicts: inspect, resolve, continue

Each file's last successfully synced contents are its baseline. A different remote version pauses the pass at that file, including a differing destination on the first push. Earlier files remain applied. Even a remote-only edit with an unchanged local copy becomes a conflict during an explicit pass; sync does not silently replace it.

1. Call `read_sync_conflict` with the sync ID. It returns baseline, local and remote contents and hashes. `content: null` means absent; an empty string is an existing empty file. Use `encoding: "base64"` for binary data.
2. Call `resolve_sync_conflict` with `resolution: "local"`, `"remote"`, or `"merged"`. A merged resolution also requires `content` and optionally `encoding`. Both live versions are rechecked; if either changed since the conflict was recorded, the conflict is refreshed and the choice must be made again.
3. Call `continue_sync` with the sync ID to rescan, process remaining files, and rearm the watcher if enabled. Resolving one file does not automatically continue the whole pass.

For example:

```json
{"sync_id":"<syncId>","resolution":"merged","content":"print(\"resolved\")\n"}
```

Choosing remote or merged contents updates the local copy too. Choosing an absent version explicitly deletes the other copy. There is no automatic text merge and no automatic program execution. This is normally a local-to-computer push; copying remote contents back is an explicit conflict resolution.

### Watching, deletion and recovery

- Watching polls eligible local contents about once per second and starts a pass when they change. It does not continuously poll remote file contents while local files are unchanged. Use an explicit push to check for remote-only edits.
- Remote deletions are **off by default**. With `delete_removed: true`, only previously synced files that disappeared locally are removed, and only if their remote contents still match the baseline. Edited remote files conflict; remote-only files and directories are never swept.
- `stop_sync` prevents further files from starting and waits for the current file operation. It keeps history and the watch preference; `continue_sync` explicitly restarts it. Applied files are not rolled back.
- Conflicts, errors and disconnected computers pause watching. Reconnect the same named computer, inspect the state, and explicitly continue. Watches are not automatically restored when the MCP process restarts.
- Baselines, conflicts and mutation intent are stored in **`<local_path>/.cc-mcp-sync/`**, with separate history for each canonical local root, computer name and remote root. Use the same name/paths with `sync_folder` after restart to load that history. A paused/interrupted pass remains paused. Pass `watch: true` again when loading if watching is wanted. Use one MCP process to manage a given history.
- Intent is saved before mutations, then checkpointed after success. If a mutation's acknowledgment or checkpoint is lost, continuing **only inspects the current versions and creates a conflict**; it never automatically replays the old mutation. `read_sync_conflict` also shows the unconfirmed intended contents. A remote transaction ID in the error can be inspected/recovered with `recover_file_write` before resolving the sync conflict.

Limits are **1 MiB per file, 1000 files and 16 MiB per scanned folder/retained baseline, and 16 loaded jobs per MCP process**. Local path components must be representable as CraftOS single-byte paths. Each remote file uses staged recoverable replacement or hash-checked deletion; the whole folder is not a transaction. Local resolutions use a temporary file and recheck contents before replacement, but do not claim transactional isolation against arbitrary external filesystem writers.

## Reading monitors

Call `list_computers` to discover monitors. Each session's `windows` includes the window ID, title, `kind`, monitor peripheral name, and advertised dimensions. Then call `read_monitor`:

```json
{"name":"workshop","monitor":"left","wait_ms":250}
```

Use the exact advertised peripheral name, such as `left` or `monitor_0`. Both stock and enhanced remote scripts are supported. Names are derived from the upstream monitor window titles; if a custom script uses different titles, use `read_terminal` with its numeric window ID instead.

The result includes `screen.lines`, per-character hexadecimal `foreground` and `background` colors, width/height, a one-based cursor, and `updatedAt`. It reports:

- `ready`: a current frame is available.
- `waiting_for_frame`: the monitor is advertised but has not sent a frame yet; `screen` is null.
- `waiting_for_resize`: an announced size differs from the cached frame; the previous screen is marked stale until the next frame.
- `invalid_frame`: a monitor frame could not be decoded; `screenError` explains why and any previous screen is stale. Other windows remain usable.
- `disconnected`: the last received monitor screen is retained and marked stale.

Detached or unknown names return an error with currently advertised names. Cached contents are discarded when a monitor detaches, preventing a reused window ID from exposing an old monitor's screen. Monitor frames carry their own dimensions, so scale changes can update the size even without a separate resize announcement.

These are current-screen reads only. Output scrollback remains main-terminal-only. Reads depend on frames supplied by the remote script; they do not execute Lua to probe peripherals. Real-script tests cover two side-attached monitors, text/colors/cursors, scale-change redraws, and hot attachment/detachment. Wired-style names and dimension-changing frames are additionally covered by protocol-level tests; an actual wired Minecraft network is not part of the emulator test.

## Mouse and monitor touch input

`send_mouse` targets the main computer terminal. Coordinates are **1-based character cells**, matching `read_terminal`, not pixels. Each call emits exactly one Lua event:

| `event` | Required argument | Lua event arguments |
| --- | --- | --- |
| `mouse_click` | `button`: `left`, `right`, or `middle` | button (1, 2, or 3), x, y |
| `mouse_up` | `button` | button, x, y |
| `mouse_drag` | `button` | button, x, y |
| `mouse_scroll` | `direction`: `up` or `down` | direction (-1 or +1), x, y |

```json
{"name":"workshop","event":"mouse_click","button":"left","x":5,"y":3}
```

A drag is an explicit `mouse_click` → one or more `mouse_drag` → `mouse_up` sequence. Click does not automatically release. Scroll emits one step; it takes `direction` rather than `button`. There is no implicit held-button state or synthesized gesture.

For a monitor, use `touch_monitor`:

```json
{"name":"workshop","monitor":"left","x":5,"y":3}
```

This delivers **`monitor_touch("left", 5, 3)`** to the foreground program. Use the exact peripheral name from `list_computers`; monitor input has no button, release, drag or scroll event.

Read the target screen first. Both tools reject out-of-bounds/fractional coordinates, disconnected targets, and missing, invalid or resizing screens. Unknown or ambiguous monitor names are rejected. Validation uses the latest observed frame, not a lock against a subsequent resize or detach. Results include a screen snapshot and input metadata; `delivery: "sent"` does not acknowledge application handling. `wait_ms` is a bounded observation delay. Input is never queued for replay after reconnection.

Stock and enhanced launchers are supported. **Update the enhanced launcher** for monitor touches on resumable connections: its monitor delegates now validate connection-scoped input while rejecting stale and unscoped packets. Tests verify exact Lua arguments for all five event names, both scroll directions, all three mouse buttons, two monitors, and touches after reconnection.

## Debug event injection

`send_event` injects one event into the currently running foreground program, including manually launched programs and the Lua REPL. It requires a current enhanced launcher advertising `capabilities.debugEvents`; stock and older peers reject it. Start a program first: idle shell prompts reject injection.

**Every result explicitly warns:**

> Synthetic debugging event: players cannot inject arbitrary events through normal in-game controls. Successful handling does not prove normal gameplay can produce it.

```json
{
  "name": "workshop",
  "event": "debug_update",
  "arguments": ["example", 42, true, {"enabled": false}, null],
  "wait_ms": 250
}
```

The program receives `"debug_update", "example", 42, true, {enabled=false}, nil`. Arguments default to an empty array. Custom names and simulated game events such as `key`, `timer`, or `redstone` are supported. `cc_mcp_` names are reserved for the launcher.

- Strings, finite numbers and booleans preserve their types. Strings use CraftOS single-byte characters (U+0000–U+00FF); argument strings may contain NUL.
- JSON arrays become 1-based Lua tables; objects become string-keyed tables. JSON null becomes Lua nil, including trailing top-level arguments. Within tables, nil removes a key or leaves an array hole; Lua's usual sparse-table length rules apply.
- Normal event filters apply: a program waiting in `os.pullEvent("key")` ignores `debug_update`. A synthetic `terminate` follows normal Lua termination semantics. It does not force a non-yielding program to run or preempt its execution.
- Injection reaches the supervised foreground invocation, not the launcher's network/peripheral event handlers or the entire computer's event queue. It does not execute Lua source or construct functions/userdata.
- `injection.outcome: "accepted"` acknowledges the request, **not application handling**. An event may be filtered or discarded if the invocation ends or attachment changes before delivery. It is never transferred to a later program or replayed after disconnect. A missing acknowledgment means unknown outcome.

Limits: 32 arguments, 4096 bytes per string, 8 nesting levels, 1024 encoded values (including table keys), and a 32 KiB encoded request. `wait_ms` returns a later terminal snapshot without proving completion. Use real keyboard, mouse, or monitor tools when testing behavior a player can perform normally.

## Command completion tracking

Current enhanced launchers advertise `connection.capabilities.commandTracking: true`. `run_command` returns a `commandId`, a `command` record, and a terminal snapshot. For example, after starting a long-running program:

```json
{
  "commandId": "<32-character ID returned by run_command>",
  "commandCompletion": "running",
  "command": {
    "commandId": "<same ID>",
    "command": "/my-program.lua",
    "state": "running",
    "startedAt": "<client timestamp>"
  }
}
```

Pass its ID to `get_command_status`:

```json
{"name":"workshop","command_id":"<returned commandId>","wait_ms":500}
```

- **`running`** — the script acknowledged the start; completion has not been observed.
- **`finished`** — `shell.run` returned `true`; `success` is `true`.
- **`failed`** — `shell.run` returned `false` or threw; `success` is `false`. This includes an ordinary Lua error or an observed program termination.
- **`interrupted`** — an enhanced interruption stopped the program; `success` is false and the reason identifies graceful or force mode.
- **`unknown`** — acceptance or completion could not be confirmed, such as after a lost acknowledgment or disconnect. Never automatically rerun an unknown command.

There is no invented numeric exit code. A short command can finish before `run_command` returns. The wait is bounded, not an execution deadline; a long-running command stays interactive and can be queried later. Timestamps are client observations; restored records without a previous local record use reattachment time. Status history retains the most recent 128 commands in memory. Disconnect marks unfinished commands unknown. A resumable launcher restores retained command states on reattachment; older launchers cannot restore them after the MCP forgets a session or restarts.

The enhanced launcher uses a single foreground shell that calls CraftOS's `shell.run`, preserving command lookup, aliases, working-directory changes, interactive programs, completion, and an in-session input history. It does not start multishell tabs. Commands are admitted only at an untouched idle prompt; a running program or keyboard-edited prompt rejects the request without injecting any input. Finish/submit an existing input line through the text/key tools before starting another tracked command. Commands entered manually are not assigned tracking IDs.

Stock connections and older enhanced launchers advertise `commandTracking: false`. They retain the original paste-and-Enter `run_command` behavior and report completion as unknown. Upgrade the Lua launcher as well as the MCP server to enable tracking. A locally installed copy can be updated with `install_enhanced_script` and `overwrite: true`, then restarted using a fresh connection's `installedCommand`.

## Reliable program interruption

Launchers with `capabilities.reliableInterruption: true` support:

```json
{"name":"workshop","mode":"graceful","command_id":"<optional tracked command ID>","wait_ms":250}
```

Call `interrupt_program` with these arguments. `graceful` is the default: it delivers `terminate` to the foreground program regardless of its event filter, allowing cleanup code to run. A program using `os.pullEventRaw` may still ignore termination. The result's `interruption.outcome` reports:

- `stopped`: the program ended (or was forcibly abandoned), output was flushed, and the launcher is returning to the shell.
- `running`: the program received `terminate` and yielded again without ending. This is an observation at delivery time; use command status/foreground metadata for later state.
- `idle`: there was no running foreground program. Idle and partially edited prompts are preserved.

Use `mode: "force"` explicitly to stop scheduling the foreground program coroutine, including nested calls beneath it. This stops yielding programs even when they ignore termination. The launcher restores its terminal redirect and flushes captured output, then returns to its shell. Program cleanup/finalizers do not run; force does not undo completed actions, restore modified global APIs, close arbitrary program-owned resources, or roll back partial files. It does not reboot the computer.

The optional `command_id` is checked against the actual foreground program on the remote computer; a mismatch is an error and stops nothing. Omit it to interrupt a manually launched program. The entire foreground invocation is interrupted, not only an observed nested child. Tracked programs which stop because of this operation report `interrupted`. An ignored graceful request leaves the command running, with no automatic escalation.

A loop which never yields also blocks the remote receiver, so neither mode can guarantee interruption before a yield or the VM watchdog. A missing response/disconnect means the operation's outcome is unknown; requests are never replayed or downgraded automatically. The normal 30-second request timeout applies.

Stock and older enhanced launchers permit only untargeted graceful interruption. It sends the existing best-effort `terminate` event and explicitly reports `reliable: false`, `outcome: "unknown"`. Force mode or command-ID targeting on those peers is rejected. Older peers may ignore termination or close an idle remote shell.

## Foreground program awareness

Current enhanced launchers advertise `capabilities.foregroundAwareness: true`. The existing `list_computers`, terminal/monitor snapshots, and computer-specific tool-result connection metadata include `foreground`; no separate tool is required.

Example while a tracked program is running:

```json
{
  "supported": true,
  "kind": "program",
  "program": "my-program.lua",
  "programName": "my-program.lua",
  "workingDirectory": "/",
  "commandId": "<tracked command ID>",
  "canRunCommand": false,
  "stale": false
}
```

- **`shell`** with `prompt: "idle"`: the enhanced shell can accept a tracked command when `canRunCommand` is true.
- **`shell`** with `prompt: "editing"`: keyboard input has touched the current prompt. Submit/finish that line with the text/key tools before starting a tracked command. This conservatively includes navigation and backspacing a line to empty.
- **`starting`**: the shell is transitioning between the prompt and execution; it cannot accept another command.
- **`program`**: a program is executing; use `send_text`/`send_key` for its input.
- **`lua_repl`**: the observed running path is the built-in `rom/programs/lua.lua`. Send Lua expressions as interactive input, not tracked shell commands.
- **`unknown`**: support/state is unavailable, or the connection is no longer live. On disconnect, `lastKnownKind`, path, directory and command ID remain historical observations, with `stale: true` and `canRunCommand: false`.

`program` and `programName` are present when observed, including manually started programs. A `commandId` is present only when execution belongs to a tracked command. The working directory is the tracked shell API's directory. `observedAt` is the client receive timestamp. New peers send their current state after negotiation, without requiring a command to be launched first.

Observations come from the shell API at coroutine yield boundaries. Nested programs launched through the same `shell.run` API are visible; independent nested shells, custom loaders, parallel tasks, and code which does not yield may hide deeper or newer state. This is explicitly identified in the `observation` field. A reported program or quiet terminal is not proof that it is waiting for user input. Snapshots are advisory: command admission is still checked by the remote shell when a start arrives.

Stock and older enhanced scripts expose `supported: false`, `kind: "unknown"`. Update and restart the enhanced launcher to enable awareness; terminal snapshots remain available on older peers.

## Output capture and scrollback

Current enhanced launchers advertise `connection.capabilities.outputCapture: true`. Capture runs at the main terminal's write/scroll boundary, rather than inferring output from periodic screen snapshots. This preserves fast logs that scroll off-screen between frames.

Read one command's output:

```json
{"name":"workshop","command_id":"<returned commandId>","limit":200}
```

Pass this to `read_output`. Omit `command_id` for the overall terminal history, which also includes prompts and manually entered commands. To follow output incrementally, reuse the response's `nextCursor` as `cursor`, keeping the same command filter:

```json
{"name":"workshop","command_id":"<returned commandId>","cursor":123,"limit":200,"wait_ms":250}
```

The result contains:

- **`lines` / `text`:** immutable committed lines, each with a session-wide sequence number and its tracked command ID when applicable. `text` is those lines joined with a trailing newline per line.
- **`nextCursor` / `hasMore`:** the cursor for the next page and whether more matching committed lines remain. Cursors belong to the current local session; start without one after reconnecting into a new session or changing filters.
- **`liveLines`:** unfinished rows, keyed by terminal row. These are replaceable snapshots: a progress bar can change from `0%` to `100%` without adding intermediate versions to scrollback. They do not advance the cursor. When finalized, the row moves into committed `lines`.
- **`truncated` / `droppedThroughCursor`:** indicate that the requested cursor predates retained history. This is a conservative global-history indication, even with a command filter. Do not present truncated output as complete.
- **`liveTruncated` / `droppedLiveLines`:** indicate pending rows omitted from the response or discarded from retention, respectively.
- **`stale`:** indicates the connection is no longer live; previously received output remains readable.

History has a **1 MiB rolling retention budget per computer**, accounting for text and a fixed metadata allowance per record so even blank-line floods are bounded. Old committed lines are evicted first. Each response contains at most 64 KiB of text plus metadata; `limit` defaults to 200 and accepts 1–1000 lines. Read additional pages while `hasMore` is true. Large pages can omit live rows; query again at the returned cursor to inspect those separately.

Command-specific capture excludes the shell's echoed command and following prompt. It flushes the last unfinished line before reporting command completion. Captured text combines normal output and errors as displayed; it is not separate stdout/stderr, and terminal-width wrapping, trimmed trailing spaces, cursor addressing, and synthetic line boundaries at command end mean it is not byte-for-byte process output. Full-screen applications and output redirected to monitors should still be inspected with `read_terminal`; this feature captures only the main terminal.

Output is retained in memory, not on the computer's disk. Current resumable launchers retain a bounded remote buffer which can restore offline output after reconnection or MCP restart; `--reconnect` enables capture from launcher startup. Older launchers capture only after negotiation and cannot recover missed packets. If a command's separate 128-entry status record expires, its output can still be filtered while retained, but `commandStatusAvailable` is false. Peers without output capture return **`supported: false`**.

## Behavior and limits

- **Snapshots, captured lines, and status are distinct.** Only tracked command records establish completion. `read_terminal` returns a screen snapshot; `read_output` returns retained main-terminal text when supported. `wait_ms` waits 0–5000 ms; a quiet screen or empty output page is not proof of completion.
- **Read before typing.** `run_command` does not clear an existing input line or force the shell to the foreground. With tracking it rejects busy/edited prompts; without tracking it sends input to the foreground program. Interactive programs remain accessible through text/key tools. Input is single-line, capped at 4096 characters; use file tools for multiline Lua.
- **Direct file access.** File tools use the negotiated remote filesystem protocol, independently of the shell's current directory. Paths are rooted at the computer filesystem. Filesystem operations can stall if the remote program is not yielding.
- **Enhanced file access.** Reads transfer at most 4 KiB per request using an efficient encoder; current enhanced writes use acknowledged 4 KiB staged uploads. Read, write, and edit limits are 1 MiB on current launchers. Chunked reads check offsets, lengths, and file size on every response. Empty files and binary contents are supported.
- **Stock read limit.** Upstream's whole-file base64 encoder does not yield. Testing found that larger reads can stop the remote script with “Too long without yielding.” In compatibility mode, the MCP checks file size before requesting contents and limits reads to 8 KiB. Unconditional writes still support 1 MiB through small append operations; conflict-safe edits require the current enhanced launcher.
- **Write guarantees are negotiated.** Current enhanced launchers provide staged, verified, recoverable replacement and commit-time conflict checks. Older launchers' unconditional writes can leave partial files. No mode claims crash-atomic replacement or transactions against external host writers. See the file-safety section for recovery.
- **Byte-preserving text.** CraftOS uses single-byte strings. Text content maps bytes to U+0000–U+00FF, rather than assuming UTF-8; paths and pasted text cannot contain NUL. Use `encoding: "base64"` for arbitrary binary content. Screen glyphs above ASCII may render differently in your client than in Minecraft.
- **Interrupt support is negotiated.** Current enhanced scripts support graceful/force modes and preserve idle prompts; stock and older scripts remain best-effort. Non-yielding code blocks remote handling. See the interruption section for cleanup and outcome semantics.
- **Explicit action recovery.** No commands or file operations are automatically replayed. File requests time out after 30 seconds. The session probes the computer and drops the connection after roughly 35 seconds without a negotiation response. Opted-in connections retry the transport only; inspect uncertain actions and explicitly continue paused syncs.
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

It requires `craftos` on `PATH` (or `CRAFTOS_BIN`), network access to fetch upstream sources, and the directory `/tmp/opencode`. It verifies the fetched source against recorded Git blob hashes and cleans up its temporary computer data. Coverage includes stock terminal/filesystem operations and warning metadata, installation over stock, direct-download enhanced startup, 1 MiB binary round-trips and text edits, monitor preservation, and an unextended legacy client controlling the enhanced terminal. Command tests exercise successful/failed and delayed completion, interactive input, busy/partial-prompt rejection, the Lua REPL, interruption, and disconnect uncertainty. Output tests cover fast scrolling logs, blank/error lines, live progress replacement, final partial lines, command filtering, pagination, retention/truncation, and access after disconnect. Local WebSocket tests also verify acknowledgment/completion races, lost acknowledgments without retry, legacy behavior, and changing-file detection.

This provides stock-script compatibility evidence in an emulator. An actual Minecraft-server connection remains the final environment-specific acceptance check: connect, write `/hello.lua`, run it, and observe the output.

## Source layout

- `src/protocol.ts` — framing, checksums, screen decoding, strings, and scan codes.
- `src/session.ts` — relay lifecycle, negotiation, request correlation, terminal and file operations.
- `src/output.ts` — bounded committed-line history, mutable live rows, and cursor pagination.
- `src/events.ts` — bounded JSON-to-Lua debug-event encoding and the synthetic-event warning.
- `src/profiles.ts` — opt-in named connection profile persistence.
- `src/identity.ts` — validated computer identity and generic peripheral inventory decoding.
- `src/sync.ts` — persistent push/resolve/continue state machine and local-change watchers.
- `src/sync-files.ts` — local snapshots, ignore rules, local resolutions and metadata persistence.
- `src/server.ts` — MCP tool schemas and tool behavior.
- `src/index.ts` — stdio entry point and shutdown.
- `lua/cc-mcp.lua` — enhanced launcher, capability advertisement, and bounded chunk reads.
- `docs/enhanced-protocol.md` — extension wire format and compatibility rules.

Protocol references: [CraftOS-PC Remote documentation](https://www.craftos-pc.cc/docs/remote), [official remote scripts](https://github.com/MCJack123/remote.craftos-pc.cc). The enhanced launcher fetches the relay's official `server.lua`, which loads/caches its corresponding `rawterm.lua`. This project does not bundle or rewrite those upstream sources; the launcher wraps their delegates at runtime.
