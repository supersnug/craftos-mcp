# CC-MCP rawterm extension, version 1

This is a private extension to the CraftOS-PC raw terminal protocol. The relay remains an opaque WebSocket message forwarder. Existing terminal, key, event, monitor, and stock filesystem packets retain their upstream formats.

## Negotiation

Type 6, window 0 uses the standard little-endian 16-bit flags. CC-MCP requests flags `0x8006`:

- `0x0002`: upstream filesystem support.
- `0x0004`: upstream window refresh.
- `0x8000`: CC-MCP enhanced chunk reads, **only when followed by the exact 8-byte signature `CCMCP/1\0`**.

The enhanced launcher adds `0x8000` and the same signature to its type-6 response only when the request contains both. Stock rawterm ignores the extra flag and trailing bytes and returns its normal response. An unextended client receives the normal stock response from the enhanced launcher.

The enhanced protocol does not request binary checksums (`0x0001`). Frames use the usual rawterm base64 payload CRC32. Legacy clients' frames/checksum behavior are left intact by the launcher.

The MCP reports:

- `negotiating` before a valid reply: no compatibility warning and no assumed limits.
- `enhanced` on a valid flag/signature reply: 1 MiB read/write/edit limits.
- `compatibility` on a valid stock reply: 8 KiB read/edit and 1 MiB write limits, plus **“Entering compatibility mode…”** in connection metadata.

The requested launch script does not determine mode. Advertising the extension with an unknown signature is an error. Changing modes after negotiation is also an error. A timeout or broken connection cannot trigger fallback or replay an operation.

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

## Writes and edits

Both modes use existing stock write/open (`21`) and append/open (`23`) operations followed by type-9 data packets, with at most 4096 content bytes each. The stock type-8 acknowledgment for a successful write uses operation code `17`. Each chunk is acknowledged before the next is sent.

Edits read the full logical file, require exactly one matching byte sequence, enforce the negotiated resulting-size limit, read again to check for intervening changes, and write the replacement in chunks. Reads, edits, and writes are serialized per MCP session. The protocol does not claim atomicity against other clients or in-game programs.

## Launcher integration

`lua/cc-mcp.lua` fetches the official relay-generated `server.lua` and runs it in an environment that wraps the loaded rawterm library. It handles both the cached-file and in-memory rawterm loading paths. Only window 0's delegate handles enhanced requests; monitor delegates keep the shared stock flags and normal packet behavior. Responses use a table-based base64 encoder to avoid upstream's repeated string-concatenation bottleneck.

Use one controlling client per session token. Mixing clients can interleave request IDs and input. The extension is not an authentication layer; the relay token remains the access credential.
