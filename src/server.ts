import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { DEFAULT_RELAY, encodeText, fileHash, MAX_FILE_BYTES, Sessions } from './session.js';
import { keys } from './protocol.js';
import { FolderSync } from './sync.js';
import { DEBUG_EVENT_WARNING } from './events.js';

const name = z.string().min(1).max(80).describe('Local name assigned with connect_computer');
const path = z.string().min(1).max(4095).describe('CraftOS filesystem path, relative to filesystem root, not shell working directory');
const wait_ms = z.number().int().min(0).max(5000).default(250).describe('Bounded wait for screen updates; does not imply program completion');
const encoding = z.enum(['text', 'base64']).default('text');

export function createServer(sessions = new Sessions()) {
  const syncs = new FolderSync(name => sessions.get(name));
  const server = new McpServer({ name: 'cc-craftos-mcp', version: '0.1.0' }, {
    instructions: 'Access CC: Tweaked using our enhanced remote script or the official stock script. Connect a named computer and give the returned connectionCommand to the user to download and launch the enhanced script directly from GitHub. No prior installation is needed. installedCommand uses an existing /cc-mcp.lua; bootstrapCommand is the stock compatibility fallback. Wait for connected state before acting. Surface the "Entering compatibility mode…" warning when a stock connection is detected. Connection metadata reports negotiated mode, file limits, and capabilities. When commandTracking is true, run_command starts a tracked command only at an idle shell prompt; use get_command_status with its commandId to observe completion. Use send_text/send_key for input to running programs and the Lua REPL. Without commandTracking, run_command only pastes and presses Enter, with completion unknown. When outputCapture is true, use read_output for retained text lines and pass nextCursor on subsequent reads. Report truncation; liveLines are mutable snapshots, not new committed output. Read the terminal before sending input and for full-screen programs. A quiet screen or empty output page never proves completion. Use file tools rather than the interactive editor. Never replay uncertain actions after a timeout or disconnect. File paths are rooted at the computer filesystem. Text uses one byte per character; use base64 to preserve arbitrary bytes.',
  });

  function tool<S extends z.ZodRawShape>(toolName: string, description: string, inputSchema: S,
    readOnly: boolean, action: (args: z.output<z.ZodObject<S>>) => Promise<unknown> | unknown) {
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(toolName, { description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true } },
    async args => {
      const connection = () => {
        if (typeof args.name !== 'string' || toolName === 'disconnect_computer') return undefined;
        try { return sessions.get(args.name).status(); } catch { return undefined; }
      };
      try {
        const result = await action(args as z.output<z.ZodObject<S>>);
        const status = connection();
        const output = status && result && typeof result === 'object' && !Array.isArray(result)
          ? { ...result, connection: status } : result;
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
      } catch (error) {
        const status = connection();
        return { isError: true, content: [{ type: 'text' as const,
          text: error instanceof Error ? error.message : String(error) },
          ...(toolName === 'send_event' ? [{ type: 'text' as const, text: DEBUG_EVENT_WARNING }] : []),
          ...(status ? [{ type: 'text' as const, text: JSON.stringify({ connection: status }) }] : [])] };
      }
    });
  }

  tool('connect_computer', 'Create a named session and return a direct GitHub wget-run command for the enhanced script, plus stock/bootstrap and locally installed alternatives. No prior installation is needed for the default command. Returns before the computer joins. Supply a token to attach to an existing session. Use one controlling client per token.', {
    name, relay: z.string().default(process.env.CRAFTOS_RELAY_URL ?? DEFAULT_RELAY),
    token: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().describe('Existing session token; omit to generate one'),
    script: z.enum(['enhanced', 'stock']).default('enhanced').describe('Selects the suggested launch command only; mode is always negotiated with the actual computer'),
    reconnect: z.boolean().default(false).describe('Opt in to network retries and saving this named relay/token profile for restoration after MCP restart. Enhanced launcher required; commands and mutations are never replayed.'),
  }, false, ({ name, relay, token, script, reconnect }) => sessions.connect(name, relay, token, script, reconnect));

  tool('configure_startup', 'Enable or disable managed in-game boot startup. Requires a persistent reconnect=true connection and an installed current /cc-mcp.lua when enabling. Preserves existing startup files, rejects an occupied unmanaged destination, and changes only /startup/zz-cc-mcp.lua. Earlier startup programs must return. Does not reboot or interrupt a running program.', {
    name, enabled: z.boolean(),
  }, false, ({ name, enabled }) => sessions.startup(name, enabled));

  tool('install_enhanced_script', 'Copy the bundled enhanced launcher to /cc-mcp.lua through an existing connection, including stock bootstrap connections. Returns instructions for restarting in enhanced mode; does not execute the script or interrupt the foreground program.', {
    name, overwrite: z.boolean().default(false),
  }, false, async ({ name, overwrite }) => {
    const content = await readFile(new URL('../lua/cc-mcp.lua', import.meta.url));
    const session = sessions.get(name);
    return session.exclusive(() => session.install(content, overwrite));
  });

  tool('list_computers', 'List session states, computer identity/peripheral inventories, foreground observations, and terminal/monitor windows. identity reports computer ID, nullable label, CraftOS/host versions, device kind, color support, and exact peripheral names/types/methods including wired and modded devices. Current enhanced launchers refresh identity about every 10 seconds; inspect supported, stale, observedAt, truncated and per-peripheral errors. Foreground reports shell/program/Lua REPL state, working directory, tracked command ID and canRunCommand. Stale fields are historical; observations do not imply waiting for input. Does not expose connection tokens.', {}, true, () => sessions.list());
  tool('disconnect_computer', 'Close and forget a local session, stop MCP retries and remove its saved connection profile. Does not shut down the in-game computer or remove its boot script; disable configure_startup first if wanted.', { name }, false,
    ({ name }) => sessions.disconnect(name));

  tool('read_terminal', 'Read the latest screen, cursor, colors, connection and foreground state. Use foreground.canRunCommand for shell readiness; use text/key tools for a running program or Lua REPL. Observations are advisory and do not prove a program is waiting for input. Main terminal is window 0; attached monitors may have other IDs. Disconnected screens and foreground observations are marked stale.', {
    name, window: z.number().int().min(0).max(255).default(0), wait_ms,
  }, true, async ({ name, window, wait_ms }) => {
    const session = sessions.get(name);
    await delay(wait_ms);
    return session.snapshot(window);
  });

  tool('read_monitor', 'Read a monitor by its exact peripheral name (such as left or monitor_0) from list_computers. Returns its current text, color rows, size, cursor and timestamp. Supports stock and enhanced scripts. Reports waiting for a first/resized frame and stale disconnected snapshots explicitly; detached/unknown names are errors. Snapshot only, no monitor scrollback. Use touch_monitor for input.', {
    name, monitor: z.string().min(1).max(256).describe('Exact monitor peripheral name advertised in list_computers windows'), wait_ms,
  }, true, ({ name, monitor, wait_ms }) => sessions.get(name).readMonitor(monitor, wait_ms));

  tool('run_command', 'Start a tracked command at an idle enhanced shell prompt and return its commandId, status, and terminal snapshot. Rejects while a program is running or a prompt has partial input; use send_text/send_key for interactive input. Stock and older enhanced scripts without commandTracking retain paste-and-Enter behavior with completion unknown. wait_ms is only a bounded wait; use get_command_status for later completion.', {
    name, command: z.string().min(1).max(4096), wait_ms,
  }, false, ({ name, command, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.terminal('command', command, wait_ms));
  });

  tool('get_command_status', 'Inspect a tracked command by its commandId. Reports running, finished, failed, interrupted, or unknown, with shell.run success when observed. A disconnect before completion makes status unknown; never automatically rerun. Resumable launchers restore up to 128 retained records on reattachment, including after MCP restart. Computer reboot loses remote execution history. Does not capture program output.', {
    name, command_id: z.string().regex(/^[0-9a-f]{32}$/), wait_ms,
  }, true, ({ name, command_id, wait_ms }) => sessions.get(name).commandStatus(command_id, wait_ms));

  tool('read_output', 'Read captured main-terminal lines, optionally filtered by command_id. Use nextCursor as cursor for incremental committed lines. liveLines are replaceable unfinished row snapshots. Local history and resumable launchers each retain bounded 1 MiB buffers; reattachment recovers retained offline output without replaying commands. Report truncated/recoveryGap; recovering=true means recovery is still running. Start without a cursor after MCP restart or a new named session. Stock/older launchers may return supported=false. Use read_terminal for full-screen programs.', {
    name, command_id: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(1000).default(200), wait_ms,
  }, true, ({ name, command_id, cursor, limit, wait_ms }) => sessions.get(name).readOutput(cursor, command_id, limit, wait_ms));

  tool('send_text', 'Send a single-line paste event without Enter. Use send_key for navigation or Enter.', {
    name, text: z.string().max(4096), wait_ms,
  }, false, ({ name, text, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.terminal('text', text, wait_ms));
  });

  tool('send_key', 'Press and release a named key, optionally with held modifiers. For typing characters, use send_text. Supported keys: ' + Object.keys(keys).join(', '), {
    name, key: z.string().refine(key => Object.hasOwn(keys, key), 'Unsupported key'),
    modifiers: z.array(z.enum(['leftCtrl', 'rightCtrl', 'leftShift', 'rightShift', 'leftAlt', 'rightAlt'])).max(6).default([]), wait_ms,
  }, false, ({ name, key, modifiers, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.terminal('key', key, wait_ms, modifiers));
  });

  tool('interrupt_program', 'Interrupt the foreground program. Enhanced graceful mode delivers terminate regardless of its event filter and reports stopped or running. Force mode abandons the yielding program without cleanup and restores the remote shell. An idle/edited enhanced prompt is a no-op. Optional command_id requires an exact foreground match. Non-yielding loops block remote handling; timeouts mean unknown, never retry automatically. Older scripts support only untargeted best-effort graceful terminate.', {
    name, wait_ms, mode: z.enum(['graceful', 'force']).default('graceful'), command_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  }, false, ({ name, wait_ms, mode, command_id }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.interrupt(mode, command_id, wait_ms));
  });

  tool('send_event', DEBUG_EVENT_WARNING + ' Inject one named event into the current foreground program (including the Lua REPL or a manually launched program). Requires updated enhanced debugEvents support; idle shells reject injection. arguments accepts JSON scalars, null (Lua nil), arrays (1-based tables), and objects (string-keyed tables). Strings use single-byte characters, including NUL in argument values. Normal program event filters apply; acceptance does not prove handling. Non-yielding programs cannot receive immediately. cc_mcp_ names are reserved. Limits: 32 arguments, 4096 bytes per string, 8 nesting levels, 1024 values, 32 KiB encoded request. No execution of Lua source, no action replay after disconnect.', {
    name, event: z.string().min(1).max(128),
    arguments: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.unknown())])).max(32).default([]), wait_ms,
  }, false, ({ name, event, arguments: args, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.sendEvent(event, args, wait_ms));
  });

  const coordinate = z.number().int().min(1).max(65535).describe('1-based character-cell coordinate within the latest screen');
  tool('send_mouse', 'Send exactly one computer-terminal mouse event: mouse_click, mouse_up, mouse_drag, or mouse_scroll. Buttons map to Lua 1=left, 2=right, 3=middle; scrolling maps to -1=up, +1=down. Supply button for click/up/drag or direction for scroll. A drag sequence is explicitly click, drag(s), up. Requires a current screen and in-bounds character coordinates. Read the terminal first. Delivery does not prove a program handled the event; input is never replayed after disconnect.', {
    name, event: z.enum(['mouse_click', 'mouse_up', 'mouse_drag', 'mouse_scroll']), x: coordinate, y: coordinate,
    button: z.enum(['left', 'right', 'middle']).optional(), direction: z.enum(['up', 'down']).optional(), wait_ms,
  }, false, ({ name, event, x, y, button, direction, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.mouse(event, x, y, button, direction, wait_ms));
  });

  tool('touch_monitor', 'Send one monitor_touch(peripheralName, x, y) event to the foreground program using an exact monitor name from list_computers. Read the monitor first; coordinates are 1-based character cells in its current screen. Rejects unknown, ambiguous, disconnected or resizing targets. No automatic mouse-up or replay. Delivery does not prove application handling. Current enhanced launchers support connection-scoped monitor routing; update the launcher when using resumable connections.', {
    name, monitor: z.string().min(1).max(256), x: coordinate, y: coordinate, wait_ms,
  }, false, ({ name, monitor, x, y, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.mouse('mouse_click', x, y, 'left', undefined, wait_ms, monitor));
  });

  tool('list_files', 'List directory entries using the stock filesystem protocol.', { name, path: path.default('/') }, true,
    ({ name, path }) => { const session = sessions.get(name); return session.exclusive(() => session.list(path)); });

  tool('read_file', 'Read up to 1 MiB with the enhanced script, or 8 KiB in stock compatibility mode. Enhanced reads use bounded chunks. Text maps bytes to U+0000–U+00FF; base64 preserves arbitrary binary data.', { name, path, encoding }, true,
    ({ name, path, encoding }) => {
      const session = sessions.get(name);
      return session.exclusive(async () => {
        const data = await session.read(path);
        return { path, encoding, bytes: data.length, hash: fileHash(data), content: data.toString(encoding === 'text' ? 'latin1' : 'base64') };
      });
    });

  tool('write_file', 'Create or replace up to 1 MiB. New enhanced peers stage and validate uploads then perform recoverable replacement with backup; this is not crash-atomic. Optional expected_hash requires the version from read_file, or must_not_exist protects creation. Older peers retain partial-write-possible behavior but reject preconditions. Failed staged writes report a transactionId for recover_file_write; never replay an uncertain commit.', {
    name, path, content: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4), encoding,
    expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), must_not_exist: z.boolean().default(false),
  }, false, ({ name, path, content, encoding, expected_hash, must_not_exist }) => {
    if (encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))) {
      throw new Error('Invalid base64 content');
    }
    const data = encoding === 'text' ? encodeText(content) : Buffer.from(content, 'base64');
    const session = sessions.get(name);
    return session.exclusive(() => session.write(path, data, expected_hash, must_not_exist));
  });

  tool('edit_file', 'Conflict-safe unique text replacement up to 1 MiB. Requires expected_hash from read_file and an enhanced peer with conditional writes. Rejects changed contents or ambiguous/missing text, stages the result, and compares expected bytes on the computer immediately before recoverable replacement. Not transactional against crashes/external host writers. Older peers reject this operation.', {
    name, path, old_text: z.string().min(1).max(MAX_FILE_BYTES), new_text: z.string().max(MAX_FILE_BYTES),
    expected_hash: z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 hash returned by read_file for the version being edited'),
  }, false, ({ name, path, old_text, new_text, expected_hash }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.edit(path, old_text, new_text, expected_hash));
  });

  tool('recover_file_write', 'Recover a staged write by path and transaction ID from its error. Aborts uploads before commit, restores backup only if the destination is absent, and otherwise preserves ambiguous evidence for inspection. Never replays a write.', {
    name, path, transaction_id: z.string().regex(/^[a-f0-9]{32}$/),
  }, false, ({ name, path, transaction_id }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.recoverWrite(path, transaction_id));
  });

  const sync_id = z.string().regex(/^[a-f0-9]{32}$/).describe('Sync ID returned by sync_folder');
  tool('sync_folder', 'Push a folder on the MCP host to a computer, preserving relative paths and skipping equal files. Requires directorySync capability. Persists baselines in local .cc-mcp-sync, respects nested .gitignore rules, skips symlinks and .git. Stops at the first conflict for inspect/resolve/continue. Optional watch polls local changes every second; conflicts, disconnects and errors pause it. No automatic command execution or mutation replay. Limits: 1000 files, 16 MiB total, 1 MiB per file. Earlier files remain applied if a later file fails. Reuse the same name and paths to load history after MCP restart.', {
    name, local_path: z.string().min(1).describe('Local directory on the machine running this MCP server'),
    remote_path: path.default('/').describe('Destination directory rooted at the computer filesystem'),
    delete_removed: z.boolean().default(false).describe('Delete only previously synced files missing locally, with remote hash checks. Ignored files and remote-only files are preserved.'),
    watch: z.boolean().default(false).describe('Keep watching after a successful push; paused watches require continue_sync'),
    wait_ms: wait_ms.describe('Bounded wait for the sync pass; inspect get_sync_status if still running'),
  }, false, ({ name, local_path, remote_path, delete_removed, watch, wait_ms }) => syncs.start(name, local_path, remote_path, delete_removed, watch, wait_ms));

  tool('get_sync_status', 'Inspect one sync job or list jobs loaded in this MCP process. Reports watcher state, progress counts, conflict hashes, and unconfirmed mutations. Content is available through read_sync_conflict.', {
    sync_id: sync_id.optional(),
  }, true, ({ sync_id }) => syncs.status(sync_id));

  tool('read_sync_conflict', 'Read the saved baseline, local and remote versions for the current paused conflict, including existence, hashes and contents. A null version means absent. Includes the intended contents of an unconfirmed mutation when available. Resolve rechecks both live versions and refuses stale choices.', {
    sync_id, encoding,
  }, true, ({ sync_id, encoding }) => syncs.readConflict(sync_id, encoding));

  tool('resolve_sync_conflict', 'Resolve the current file using local, remote, or supplied merged bytes. Remote and merged choices update the local copy too; choosing an absent version deletes the other copy. Revalidates both conflict versions before applying. Saves the resolution but leaves sync paused until continue_sync. A newly changed version requires inspection and resolution again.', {
    sync_id, resolution: z.enum(['local', 'remote', 'merged']),
    content: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4).optional(), encoding,
  }, false, ({ sync_id, resolution, content, encoding }) => {
    if (resolution !== 'merged' && content !== undefined) throw new Error('content is only used for merged resolutions');
    if (resolution === 'merged' && content === undefined) throw new Error('Merged resolution requires content');
    if (content !== undefined && encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error('Invalid base64 content');
    const data = content === undefined ? undefined : encoding === 'text' ? encodeText(content) : Buffer.from(content, 'base64');
    return syncs.resolve(sync_id, resolution, data);
  });

  tool('continue_sync', 'Explicitly continue a paused/stopped sync, rescanning before applying further files and rearming its watcher if enabled. Unresolved conflicts stay paused. After an unconfirmed mutation, this only reads current versions and creates a conflict for explicit resolution; it never replays the old action. Reconnect the named computer first if needed.', {
    sync_id, wait_ms: wait_ms.describe('Bounded wait for the resumed pass; inspect get_sync_status if still running'),
  }, false, ({ sync_id, wait_ms }) => syncs.resume(sync_id, wait_ms));

  tool('stop_sync', 'Stop watching and pause a sync after any current file operation finishes. Keeps history, conflicts and recovery evidence. Earlier applied files are not rolled back. continue_sync explicitly restarts the job.', {
    sync_id,
  }, false, ({ sync_id }) => syncs.stop(sync_id));

  return { server, sessions, syncs };
}
