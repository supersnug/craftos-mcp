import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { DEFAULT_RELAY, encodeText, MAX_FILE_BYTES, Sessions } from './session.js';
import { keys } from './protocol.js';

const name = z.string().min(1).max(80).describe('Local name assigned with connect_computer');
const path = z.string().min(1).max(4095).describe('CraftOS filesystem path, relative to filesystem root, not shell working directory');
const wait_ms = z.number().int().min(0).max(5000).default(250).describe('Bounded wait for screen updates; does not imply program completion');
const encoding = z.enum(['text', 'base64']).default('text');

export function createServer(sessions = new Sessions()) {
  const server = new McpServer({ name: 'cc-craftos-mcp', version: '0.1.0' }, {
    instructions: 'Access CC: Tweaked using our enhanced remote script or the official stock script. Connect a named computer and give the returned connectionCommand to the user to download and launch the enhanced script directly from GitHub. No prior installation is needed. installedCommand uses an existing /cc-mcp.lua; bootstrapCommand is the stock compatibility fallback. Wait for connected state before acting. Surface the "Entering compatibility mode…" warning when a stock connection is detected. Connection metadata reports actual negotiated mode and file limits. Read the terminal before submitting commands: input goes to the foreground program, which may not be the shell. Terminal results are screen snapshots, not stdout or exit status. Never assume a quiet screen means completion. Use file tools rather than the interactive editor. Never replay uncertain actions after a timeout or disconnect. File paths are rooted at the computer filesystem. Text uses one byte per character; use base64 to preserve arbitrary bytes.',
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
          ...(status ? [{ type: 'text' as const, text: JSON.stringify({ connection: status }) }] : [])] };
      }
    });
  }

  tool('connect_computer', 'Create a named session and return a direct GitHub wget-run command for the enhanced script, plus stock/bootstrap and locally installed alternatives. No prior installation is needed for the default command. Returns before the computer joins. Supply a token to attach to an existing session. Use one controlling client per token.', {
    name, relay: z.string().default(process.env.CRAFTOS_RELAY_URL ?? DEFAULT_RELAY),
    token: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().describe('Existing session token; omit to generate one'),
    script: z.enum(['enhanced', 'stock']).default('enhanced').describe('Selects the suggested launch command only; mode is always negotiated with the actual computer'),
  }, false, ({ name, relay, token, script }) => sessions.connect(name, relay, token, script));

  tool('install_enhanced_script', 'Copy the bundled enhanced launcher to /cc-mcp.lua through an existing connection, including stock bootstrap connections. Returns instructions for restarting in enhanced mode; does not execute the script or interrupt the foreground program.', {
    name, overwrite: z.boolean().default(false),
  }, false, async ({ name, overwrite }) => {
    const content = await readFile(new URL('../lua/cc-mcp.lua', import.meta.url));
    const session = sessions.get(name);
    return session.exclusive(() => session.install(content, overwrite));
  });

  tool('list_computers', 'List session states and available terminal windows. Does not expose connection tokens.', {}, true, () => sessions.list());
  tool('disconnect_computer', 'Close and forget a local session. Does not shut down the in-game computer.', { name }, false,
    ({ name }) => sessions.disconnect(name));

  tool('read_terminal', 'Read the latest screen, cursor, colors, and connection state. Main terminal is window 0; attached monitors may have other IDs. Disconnected screens are marked stale.', {
    name, window: z.number().int().min(0).max(255).default(0), wait_ms,
  }, true, async ({ name, window, wait_ms }) => {
    const session = sessions.get(name);
    await delay(wait_ms);
    return session.snapshot(window);
  });

  tool('run_command', 'Paste a single line and press Enter in the foreground terminal. At a shell prompt this runs a CraftOS command; in a Lua REPL it evaluates Lua. Return a screen snapshot after a bounded wait, with completion unknown. Does not clear existing input.', {
    name, command: z.string().min(1).max(4096), wait_ms,
  }, false, ({ name, command, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.terminal('command', command, wait_ms));
  });

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

  tool('interrupt_program', 'Send the CraftOS terminate event. Best effort: stock event filters and programs using pullEventRaw may ignore it. At an idle shell it can close the remote shell/session. Does not reboot the computer.', {
    name, wait_ms,
  }, false, ({ name, wait_ms }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.terminal('interrupt', '', wait_ms));
  });

  tool('list_files', 'List directory entries using the stock filesystem protocol.', { name, path: path.default('/') }, true,
    ({ name, path }) => { const session = sessions.get(name); return session.exclusive(() => session.list(path)); });

  tool('read_file', 'Read up to 1 MiB with the enhanced script, or 8 KiB in stock compatibility mode. Enhanced reads use bounded chunks. Text maps bytes to U+0000–U+00FF; base64 preserves arbitrary binary data.', { name, path, encoding }, true,
    ({ name, path, encoding }) => {
      const session = sessions.get(name);
      return session.exclusive(async () => {
        const data = await session.read(path);
        return { path, encoding, bytes: data.length, content: data.toString(encoding === 'text' ? 'latin1' : 'base64') };
      });
    });

  tool('write_file', 'Create or overwrite a file, up to 1 MiB, using acknowledged 4 KiB chunks. A failed write can leave a partial file; a timeout means the last chunk outcome is unknown. Does not use the interactive editor.', {
    name, path, content: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4), encoding,
  }, false, ({ name, path, content, encoding }) => {
    if (encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))) {
      throw new Error('Invalid base64 content');
    }
    const data = encoding === 'text' ? encodeText(content) : Buffer.from(content, 'base64');
    const session = sessions.get(name);
    return session.exclusive(() => session.write(path, data));
  });

  tool('edit_file', 'Replace exactly one occurrence of old_text with new_text in a file up to 1 MiB (8 KiB in stock compatibility mode). Refuses missing or ambiguous matches and checks for intervening changes. This is not an atomic edit against external writers.', {
    name, path, old_text: z.string().min(1).max(MAX_FILE_BYTES), new_text: z.string().max(MAX_FILE_BYTES),
  }, false, ({ name, path, old_text, new_text }) => {
    const session = sessions.get(name);
    return session.exclusive(() => session.edit(path, old_text, new_text));
  });

  return { server, sessions };
}
