# CC-MCP rawterm extension, version 1

This is a private extension to the CraftOS-PC raw terminal protocol. The relay remains an opaque WebSocket message forwarder. Existing terminal, key, event, monitor, and stock filesystem packets retain their upstream formats.

## Negotiation

Type 6, window 0 uses the standard little-endian 16-bit flags. Current CC-MCP clients request flags `0xFFC6`:

- `0x0002`: upstream filesystem support.
- `0x0004`: upstream window refresh.
- `0x8000`: CC-MCP enhanced chunk reads, **only when followed by the exact 8-byte signature `CCMCP/1\0`**.
- `0x4000`: optional tracked commands, advertised only when requested and the enhanced signature is valid.
- `0x2000`: optional main-terminal line capture, likewise advertised only when requested and the enhanced signature is valid.
- `0x1000`: optional foreground awareness, likewise advertised only when requested and the enhanced signature is valid.
- `0x0800`: reliable interruption, likewise advertised only when requested and the enhanced signature is valid.
- `0x0400`: staged recoverable writes and commit-time expected-content checks.
- `0x0200`: directory creation and conditional deletion for folder sync; requires `0x0400`.
- `0x0100`: connection-scoped attachment, retained command observations, and sequenced output recovery.
- `0x0080`: synthetic foreground debug-event injection; requires `0x0100`.
- `0x0040`: structured computer identity and generic peripheral inventory; requires `0x0100`.

The enhanced launcher adds `0x8000` and the same signature to its type-6 response only when the request contains both. Stock rawterm ignores the extra flag and trailing bytes and returns its normal response. An unextended client receives the normal stock response from the enhanced launcher.

The launcher also echoes `0x4000` when tracking was requested. Older enhanced launchers continue to respond with only `0x8000`; they support chunk reads but not tracked commands. Both old `0x8006` clients and unextended clients can still use the current launcher's terminal.

It echoes `0x2000` when capture was requested. Capture support is independent of tracking: without tracked execution, lines have no command ID. Old enhanced clients receive no output packets unless they request this capability. Capabilities cannot change mid-session; a changed flag is an error rather than a silent downgrade.

The enhanced protocol does not request binary checksums (`0x0001`). Frames use the usual rawterm base64 payload CRC32. Legacy clients' frames/checksum behavior are left intact by the launcher.

The MCP reports:

- `negotiating` before a valid reply: no compatibility warning and no assumed limits.
- `enhanced` on a valid flag/signature reply: 1 MiB read/write limits, plus 1 MiB edits when `0x0400` is present (otherwise edits are unsupported).
- `compatibility` on a valid stock reply: 8 KiB reads and 1 MiB unconditional writes, edits unsupported, plus **“Entering compatibility mode…”** in connection metadata.

The requested launch script does not determine mode. Advertising the extension with an unknown signature is an error. Changing modes after negotiation is also an error. A timeout or broken connection cannot trigger fallback or replay an operation.

## Tracked commands

Command tracking is independently negotiated with `0x4000`. It uses window 0 and the same base64/CRC framing. Requests and replies share the session's byte-sized request ID allocator. Command IDs are separate, randomly generated 32-character lowercase hexadecimal strings.

### Start request: type 66

The decoded bytes are `type=66`, `window=0`, `version=1`, `requestId`, followed by two NUL-terminated strings: `commandId` and `command`. Commands must be non-blank, single-line, and at most 4096 bytes. The launcher rejects a request unless its single foreground shell is at an empty idle prompt. Spaces count as input; non-text keys do not make an empty prompt busy, and clearing all input restores readiness.

### Start acknowledgment: type 67

The bytes are `type=67`, `window=0`, `status`, `requestId`, then a NUL-terminated string. Status 0 means accepted and the string is the command ID. Status 1 means rejected and the string is an explanation. Rejection never triggers paste-and-Enter fallback.

On acceptance the launcher marks the shell busy, acknowledges, then delivers a private `cc_mcp_execute` event to its shell coroutine. Programs run through `shell.run` on that coroutine, not in the network receiver. While a program yields, file requests and text/key input remain available. All later start requests are rejected until the shell reaches its next empty prompt.

### Completion notification: type 68

The bytes are `type=68`, `window=0`, `result`, then NUL-terminated `commandId` and `reason` strings. Result 0 means `shell.run` returned true; result 1 means it returned false or threw. Reason is empty on success and at most 512 bytes otherwise. There is no numeric exit code and no command-output payload.

The client keeps up to 128 local records. Completion can arrive alongside the acknowledgment; the client must not overwrite a completed record with running. A missing acknowledgment produces an unknown outcome and retains the ID in the error for status inspection. Disconnection before completion marks unfinished records unknown, without replaying commands or downgrading. Known finished/failed records remain available until the session is explicitly forgotten or their bounded history entry expires. With `0x0100`, a still-running launcher restores retained observations on attachment; history is not durable across computer reboot.

## Interruption: types 71/72, window 0

Enabled by `0x0800`. Request type 71 contains version byte 1, a byte-sized request ID, mode byte (0 graceful, 1 force), and a NUL-terminated target command ID (empty for the current invocation). The target, when supplied, must match the running tracked command. Mismatches are rejected; an untargeted non-running shell is an idle no-op.

The launcher returns a private `cc_mcp_interrupt` event to its supervising coroutine, which accepts it independently of the program's filter. Graceful mode resumes the program with `terminate`; if it yields again the result is `running`. Force mode abandons that coroutine without resuming it. When the program ends, terminal redirect is restored, output flushed, and completion emitted before the stopped response.

Type 72 contains status (0 success, 1 rejection), request ID, and two NUL-terminated strings: outcome/error and target command ID. Outcomes are `idle`, `running`, or `stopped`. These describe the observation when handled, not a durable guarantee about later execution. Rejections contain an error and empty target. Timeouts close the connection and never replay or fall back to a stock terminate event.

For peers which negotiated interruption, type-68 completion adds result 2 for `interrupted` (success false), with the mode in its reason. Old clients still receive only their existing completion codes. Force abandons the entire invocation, including nested coroutine calls; it cannot unwind arbitrary Lua cleanup or shared state. Non-yielding programs prevent the receiver from servicing either mode.

## Foreground notifications: type 70, window 0

Enabled only by negotiated `0x1000`. After the type/window bytes, byte 2 is version 1 and byte 3 is a readiness boolean (0 or 1). Four NUL-terminated strings follow: kind, observed program path, tracked-shell working directory, and command ID. Each is limited to 4095 bytes. Empty path/ID means unavailable/untracked. Kinds are `unknown`, `shell`, `starting`, `program`, and `lua_repl`; readiness may be true only for `shell`. Command IDs, when present, are 32 lowercase hex characters.

The launcher sends a state after the negotiation response and when observed state changes. Prompt readiness/edited state is emitted directly from its shell loop. Programs execute inside a forwarding coroutine, which preserves event filters and termination delivery and samples `shell.getRunningProgram()` and the shell directory at yield boundaries. Completion/error handling and output flushes retain their existing ordering. The built-in Lua program path is identified as `lua_repl`; arbitrary programs named `lua` are not assumed to be REPLs.

This observes the shared shell API, not a global process registry. Independent shells/loaders and parallel tasks may obscure deeper state. No waiting-for-input assertion is made. The client validates states, records receive timestamps and exposes metadata through existing tools. On disconnect the kind becomes unknown, readiness false, and the previous state is marked stale. An unsupported peer remains unknown rather than being classified by guessing from its screen. Foreground capability changes mid-connection are errors, like other capability changes.

## Captured terminal lines: type 69, window 0

This is a batched notification, enabled by `0x2000`. After type and window, byte 2 is version 1 and bytes 3–4 are a little-endian record count. Records follow in order:

| Field | Size | Meaning |
| --- | --- | --- |
| Kind | 1 | 0 = commit a line, 1 = replace a live row |
| Row | 2 | One-based terminal row, unsigned little-endian |
| Command ID | variable | NUL-terminated tracked ID, or empty for untracked terminal activity |
| Text length | 4 | Unsigned little-endian byte length, at most 65535 |
| Text | variable | Raw single-byte text, including any NUL bytes; no newline terminator |

The launcher observes the main rawterm window's `write`, `blit`, cursor movement, scrolling, clearing, and resize operations. Writes on the same row update a mutable line. Leaving a dirty row, scrolling/clearing, or ending a command commits it. Blank newline movements are retained, trailing spaces are trimmed, and terminal-width wrapping remains visible as separate lines. Full-screen redraws are only best-effort readable lines, not a stdout reconstruction.

The producer batches roughly 4 KiB of record data before sending and flushes live updates on the stock 50 ms visible redraw tick. A single very wide line can require an extended `!CPD` frame. Only window 0 is observed; monitors retain their existing screen protocol. Command boundaries flush all prior dirty lines before changing ownership. Final output packets are sent before the type-68 completion notification.

The client validates complete batches before applying them, assigns a monotonically increasing sequence number to each committed line, and retains a 1 MiB rolling budget with per-record accounting. A commit removes the corresponding live row; a live update replaces it without allocating a committed sequence number. Eviction records the last discarded sequence. The `read_output` tool reads these local records with cursor pagination and optional command filtering; live rows are returned separately and never advance the cursor. Stale history remains available after disconnect. `0x0100` adds remote retention and recovery as described below.

## Reattachment and output recovery (`0x0100`)

These packets use window 0 and ordinary base64 CRC32 framing. Each new MCP socket uses a fresh 32-hex-character client ID. The launcher has a 32-hex-character execution epoch for its lifetime and a transport serial incremented on each remote socket replacement.

- **76 — attach:** ASCII JSON `{client}` after type/window. Sent after negotiation, including probes. It selects the current controlling client; use only one controller per token.
- **77 — snapshot:** UTF-8 JSON `{client, epoch, transport, autoReconnect, first, last, commands}`. `commands` is an array (including when empty), at most 128 entries containing `commandId`, base64 `command64`, `state`, and optional base64 `reason64`. A repeated snapshot with the same epoch/transport is ignored once attached. A changed epoch/transport invalidates pending operations and requires a fresh attachment.
- **78 — client envelope:** NUL-terminated client ID followed by a complete decoded inner packet (type/window included). The launcher accepts only the attached client's scope. Negotiation and attach stay unwrapped. Inner negotiation, attach, and nested client envelopes are rejected.
- **79 — server envelope:** version byte `1`, NUL-terminated client ID, then the complete decoded inner packet. Its 36-byte prefix aligns with base64 groups, allowing efficient framing without decoding/re-encoding file chunks. Negotiation and snapshots stay unwrapped. The MCP ignores stale scopes and rejects nested server envelopes or wrapped negotiation/snapshots.
- **80 — sequenced output:** uint32 sequence followed by the original decoded type-69 batch. Sent inside type 79. Sequence is launcher-local, distinct from the MCP's committed-line cursor.
- **82 — recover output:** byte-sized request ID and uint32 last-observed sequence, inside type 78.
- **83 — recovered batch:** status byte `0`, request ID, uint32 earliest-retained sequence, uint32 returned sequence (zero when no batch), uint32 latest sequence, then an optional decoded type-69 batch. Sent inside type 79. One batch per request bounds recovery work.

The launcher retains 1 MiB of output batches with per-batch accounting and up to 128 command observations in memory. Recovery reads each missing sequence once; duplicates do not add output. Eviction gaps or an epoch change clear mutable local rows and are explicitly reported as `recoveryGap`/`truncated`. The client exposes `recovering` while fetching batches. New MCP sessions create fresh local cursors, even when restoring remote history.

With `--reconnect`, the launcher supplies a persistent virtual delegate to upstream rawterm. The foreground shell, terminal, monitors, command observations and capture stay alive while only the WebSocket is replaced. Output is retained offline; outbound input acknowledgments/mutation responses are dropped rather than queued. A network retry never executes a program. Initial HTTP fetches and failed WebSocket connections retry with delays capped at 30 seconds. Normal launcher exit ends the shell and closes the session.

The MCP similarly retries only opted-in connections and restores saved relay/token profiles at process startup. Disconnect rejects pending requests and queued operations; connection IDs prevent late packets from satisfying new requests. Sync jobs require explicit continuation after loss/replacement. Boot setup writes a managed startup script through existing protected file operations and preserves other startup files. Tokens remain access credentials, not an additional authentication protocol.

## Computer identity: types 86/87

Negotiated by `0x0040`, requiring connection-scoped `0x0100` framing. A type-86 window-0 request contains only its byte-sized request ID. Type 87 contains status (0 success, 1 error), request ID, and UTF-8 JSON. Success fields:

- `computerId`: nonnegative integer from `os.getComputerID()`.
- `label64`: base64 label bytes, or `false` for no label.
- `craftos64`: base64 bytes of `os.version()`.
- `host64`: base64 `_HOST` bytes, or `false` if unavailable.
- `kind`: `turtle`, `pocket`, `command`, or `computer`, determined from the corresponding APIs.
- `color`: boolean from `term.isColor()`.
- `peripherals`: array of `{name64, types64, methods64, truncated, error64?}`. Names and array entries are base64 byte strings; per-device errors are also base64.
- `totalPeripherals`, `truncated`: discovered count and explicit completeness indication.

The launcher queries standard CC:Tweaked metadata APIs, including all return values of `peripheral.getType`, so wired/modded devices are not restricted to built-in types. It never invokes discovered peripheral methods. Individual device failures produce an error entry; an overall inspection failure returns status 1 with an `error` string. Empty lists are JSON arrays.

Response bounds are 32 KiB JSON, 128 peripherals, 32 types and 256 methods per peripheral, 256 bytes per name/type/method/label/CraftOS version, 1024 host bytes, and 512 error bytes. Metadata text uses base64 to preserve CraftOS bytes. Names/types/methods exceeding the byte bound are omitted rather than renamed. Excess methods or peripherals are omitted with explicit truncation; labels/version/host strings may be clipped with the same indication.

The client requests a fresh observation on attachment and about every 10 seconds thereafter. It validates limits and duplicate names before replacing its cache. Responses belong to the requesting connection; old observations remain historical until a new response is validated. The exposed identity includes `supported`, `stale`, `observedAt`, `refreshing`, and optional `error`; disconnected/replaced connections, errors, and observations older than 25 seconds are stale. Unsupported peers are never probed with terminal commands.

## Debug event injection: types 84/85

Enabled by `0x0080`, with connection-scoped framing (`0x0100`). Type 84, window 0 contains a byte-sized request ID and ASCII JSON `{name64, arguments, nonce}`. `name64` is the base64 single-byte event name (1–128 bytes, no NUL, no `cc_mcp_` prefix); `nonce` is 32 lowercase hex characters. `arguments` is an array of at most 32 tagged value nodes:

- `{type:"nil"}`
- `{type:"string", value:<base64 bytes>}` (at most 4096 decoded bytes)
- `{type:"number", value:<finite number>}`
- `{type:"boolean", value:<boolean>}`
- `{type:"table", entries:[[keyNode,valueNode], ...]}` (string or numeric keys)

The request is bounded to 32 KiB JSON, 1024 nodes including table keys, and depth 8 (top-level argument depth 0). JSON arrays map to numeric keys starting at 1; objects map to string keys. Explicit nil nodes preserve the top-level argument count without depending on JSON null parsing. Nested table nil values follow normal Lua semantics. Strings are byte-preserving, including NUL in values.

Type 85 contains status byte (0 accepted, 1 rejected), request ID, and UTF-8 JSON. Success is `{outcome:"accepted", nonce, commandId}` (empty command ID for a manually launched program). Rejection includes `error`. The nonce is checked against the request; timeouts invalidate pending operations and never replay the event.

The launcher admits one pending injection only while a foreground program is running. It returns a private rawterm event to the supervisor, which converts the stored values back to Lua arguments with an explicit `n` count. The pending event is tied to the current invocation and attachment; stale events are discarded. Normal program filters, including the normal terminate exception, apply before resuming the program coroutine. Synthetic names never enter the launcher's global network/peripheral event loop. Acceptance does not promise consumption, delivery before program exit, or immediate handling by a non-yielding program.

## Pointer input: type 2

Pointer tools use upstream type 2 with the target window ID. Its payload is event subtype (byte), button/direction (byte), x (uint32 little-endian), y (uint32 little-endian). Coordinates are one-based character cells. Subtypes are 0 click, 1 release, 2 scroll, 3 drag. Buttons 1/2/3 represent left/right/middle; scroll encodes 0 for up (-1 in Lua), 1 for down (+1 in Lua).

Window 0 delivers `mouse_click`, `mouse_up`, `mouse_scroll`, or `mouse_drag`. A monitor-window click is translated by the upstream launcher to `monitor_touch(peripheralName, x, y)`. The MCP resolves an exact advertised monitor name and emits only a left click for touches; it synthesizes no release. These are input notifications without acknowledgments or replay.

When `0x0100` is negotiated, pointer packets use type-78 client envelopes. Monitor delegates accept only matching client IDs and their own window in a checksummed, fixed-size mouse envelope (47 decoded bytes, 64 base64 characters). They reject stale/unscoped input and skip unrelated packets without decoding file uploads. Clients without resume negotiation retain upstream input framing. The MCP validates coordinates and current screen availability before sending.

## Chunk reads

All offsets below refer to decoded packet bytes, starting at zero. Integers are unsigned little-endian. Files and contents are byte strings; paths use the same NUL-terminated, single-byte representation as stock rawterm.

### Request: type 64, window 0

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Packet type: 64 |
| 1 | 1 | Window: 0 |
| 2 | 1 | Version: 1 |
| 3 | 1 | Request ID |
| 4 | 4 | File byte offset |
| 8 | 2 | Requested byte count, 1–4096 |
| 10 | variable | Path and terminating NUL, at most 4095 path bytes |

The launcher opens the file in binary mode, checks its size (maximum 1 MiB), seeks to the offset, reads at most the requested count, and closes the handle. Systems without binary seek skip bytes in bounded blocks. Directory reads, missing files, invalid offsets, invalid requests, and oversized files return errors.

### Success: type 65, window 0

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Packet type: 65 |
| 1 | 1 | Window: 0 |
| 2 | 1 | Status: 0 |
| 3 | 1 | Request ID |
| 4 | 4 | Total file size |
| 8 | 4 | File byte offset |
| 12 | variable | Raw contents, exactly `min(requestedCount, totalSize - offset)` bytes |

For an empty file, total size and offset are zero and contents are empty. Reads are serialized by the MCP. It requests another chunk only after receiving and validating the previous response, preserving event-loop yield opportunities. The client checks matching offsets and stable total size across all chunks. This is not a file snapshot: same-size external modifications can still race the read.

### Error: type 65, window 0

Bytes 0–3 have the same layout, but status is 1. Remaining bytes contain the error text (at most 512 bytes, not NUL-terminated). Errors end the current read, without retry or stock fallback.

## Recoverable write transactions: types 73/74/75

Negotiated by `0x0400`. A type-73 window-0 request contains a byte-sized request ID then ASCII JSON. Fields include `op`, a 32-hex-character transaction `id`, and `path64` (base64 of the single-byte destination path). Operations:

- `begin`: `size` (0–1 MiB) and `condition` (`any`, `match`, `missing`). Creates a same-parent transaction directory, empty staged files, and durable upload metadata.
- `chunk`: `stream` (`new` or `expected`), exact next `offset`, and base64 `data` (at most 4096 decoded bytes). Acknowledged chunks are retained in memory for on-disk verification.
- `commit`: verifies complete new content against received chunks. For `match`, verifies expected staging data and compares current destination bytes directly against it. For `missing`, checks absence. Writes intent, renames destination to backup when present, then staged new file to destination, rolling back the backup on replacement failure where possible. Filesystem calls execute in this handler without deliberately yielding between precondition validation and replacement; this is not a transaction against external writers or crashes.
- `abort`: removes an upload only before commit intent exists.
- `recover`: uses durable records, including after launcher restart. Aborts pre-commit staging, restores backup only when the destination is absent, otherwise preserves evidence and returns `inspection_required` or an error.

A type-74 window-0 response contains status (0 success, 1 error), request ID, then JSON outcome/error. The client never replays timed-out commits. A staged upload failure reports its transaction ID for explicit recovery. Ordinary cleanup follows success; cleanup failures are reported separately.

For chunk uploads the client uses type 75, window 0: request ID (one byte), stream (one byte: 0 new, 1 expected), offset (little-endian uint32), transaction ID (NUL-terminated ASCII), then up to 4096 raw bytes. This avoids JSON/base64 encoding inside the already-base64-framed packet. Replies are type 74, as above.

### Directory sync additions (`0x0200`)

The type-73 `mkdir` operation uses the usual `id` and `path64` fields. It creates a directory and any missing parents, accepts an existing directory, and rejects an existing file. Its outcome is `directory_ready`. The root directory is supported. A timeout is uncertain and must not cause an automatic replay.

`begin` additionally accepts `remove: true` only with `condition: "match"` and `size: 0`. The client uploads expected contents, then commits. The same byte-for-byte precondition check is applied before moving the destination to the transaction backup; no replacement is moved into place. Successful deletion returns `outcome: "deleted"`. Intent and backup use the existing recovery mechanism; if an interrupted deletion retains a backup with an absent destination, explicit recovery restores it. `cleanupPending` indicates that transaction evidence remains. Requests for `mkdir` or removal are rejected unless `0x0200` was negotiated.

The MCP's folder-sync state machine is local, not a remote protocol transaction. It persists baseline bytes and pre-mutation intent under `.cc-mcp-sync`, serializes each remote file operation with other session mutations, and uses hash preconditions or must-not-exist when pushing. A folder pass can be partially applied. Polling watchers pause on errors/conflicts/disconnect and never resume or replay uncertain mutations without explicit user/agent action.

The SHA-256 hash exposed in MCP is computed by Node over returned file bytes. For conflict-safe edits, the client verifies `expected_hash`, then sends those exact expected bytes; the Lua commit check uses byte equality rather than a weak checksum or metadata-only version. Edits require the hash. Conditional writes are optional; unsupported peers reject preconditions/edits rather than falling back.

## Legacy writes and edits

Peers without recoverable-write support use existing stock write/open (`21`) and append/open (`23`) operations followed by type-9 data packets, with at most 4096 content bytes each, for unconditional writes only. The stock type-8 acknowledgment for a successful write uses operation code `17`. Each chunk is acknowledged before the next is sent.

Legacy peers reject edits and conditional writes. Reads, edits, and writes are serialized per MCP session. `limits.editBytes` is zero when conditional writes are unavailable.

## Launcher integration

`lua/cc-mcp.lua` fetches the official relay-generated `server.lua` and runs it in an environment that wraps the loaded rawterm library and supplies a single-foreground tracked shell as the launch command. It handles both the cached-file and in-memory rawterm loading paths. Only window 0's delegate handles enhanced requests; monitor delegates filter unrelated window packets before full decoding, while preserving shared stock flags and negotiation packets. Responses use a table-based base64 encoder to avoid upstream's repeated string-concatenation bottleneck.

Use one controlling client per session token. Mixing clients can interleave request IDs and input. The extension is not an authentication layer; the relay token remains the access credential.
