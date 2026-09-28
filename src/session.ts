import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { cstring, decodeScreen, ENHANCED_FLAG, ENHANCED_SIGNATURE, event, FrameDecoder, keys, packet, readCString, type Screen } from './protocol.js';

export const MAX_FILE_BYTES = 1024 * 1024;
// Stock rawterm only offers whole-file reads and its encoder does not yield.
export const MAX_READ_BYTES = 8 * 1024;
export const DEFAULT_RELAY = 'wss://remote.craftos-pc.cc/';
export const ENHANCED_SCRIPT_URL = 'https://raw.githubusercontent.com/supersnug/craftos-mcp/main/lua/cc-mcp.lua';
type State = 'connecting' | 'waiting' | 'connected' | 'disconnected';
type Mode = 'negotiating' | 'enhanced' | 'compatibility';
export const COMPATIBILITY_WARNING = 'Entering compatibility mode… The connected computer is running the stock remote protocol. File reads and edits are limited to 8 KiB; command completion is unavailable.';
type Pending = { type: number; resolve: (data: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export function connectionDetails(relay: string, token = randomBytes(30).toString('base64url')) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error('Invalid session token');
  const url = new URL(relay);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Relay must be a ws:// or wss:// base URL without credentials, query, or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const websocket = new URL(token, url).href;
  const enhancedCommand = `wget run ${ENHANCED_SCRIPT_URL} ${token} ${url.href}`;
  const installedCommand = `/cc-mcp.lua ${token} ${url.href}`;
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  const script = new URL('server.lua', url).href;
  // URLs and tokens contain no shell whitespace/quotes after URL encoding and validation.
  return { websocket, command: `wget run ${script} ${token}`, enhancedCommand, installedCommand };
}

/** Owns one relay connection. No action is ever automatically retried. */
export class Session {
  private socket: WebSocket;
  private decoder = new FrameDecoder();
  private state: State = 'connecting';
  private reason?: string;
  private negotiated = false;
  private filesystem = false;
  private mode: Mode = 'negotiating';
  private lastReply = 0;
  private probe?: NodeJS.Timeout;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private screens = new Map<number, Screen>();
  private titles = new Map<number, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly name: string, websocket: string, private requestTimeout = 30000) {
    this.socket = new WebSocket(websocket, { handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 });
    this.socket.on('open', () => {
      if (this.state === 'disconnected') return;
      this.state = 'waiting';
      this.negotiate();
      this.probe = setInterval(() => {
        if (this.socket.readyState !== WebSocket.OPEN) {
          this.close('Relay is no longer open');
        } else if (this.negotiated && Date.now() - this.lastReply > 35000) {
          this.close('Computer stopped responding; reconnect explicitly. Actions were not replayed.');
        } else if (!this.negotiated || Date.now() - this.lastReply > 10000) this.negotiate();
      }, 1000);
      this.probe.unref();
    });
    this.socket.on('message', bytes => {
      if (this.state === 'disconnected') return;
      try {
        const raw = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer);
        for (const data of this.decoder.push(raw.toString('ascii'))) this.receive(data);
      } catch (error) {
        this.close(`Protocol error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.socket.on('error', () => this.close('Relay connection failed'));
    this.socket.on('close', () => this.close('Relay connection closed'));
  }

  private negotiate() {
    // Request filesystem and window refresh, but not binary checksums. Stock rawterm
    // has inconsistent checksum handling for negotiation packets in binary mode.
    this.send(6, Buffer.concat([Buffer.from([6, 0x80]), ENHANCED_SIGNATURE]));
  }

  private send(type: number, data: Buffer, window = 0) {
    if (this.state === 'disconnected' || this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay is not connected');
    const frame = packet(type, window, data);
    for (let i = 0; i < frame.length; i += 65530) {
      this.socket.send(frame.slice(i, i + 65530), error => {
        if (error) this.close('Send failed; operation outcome may be unknown');
      });
    }
  }

  private receive(data: Buffer) {
    const type = data[0], window = data[1];
    if (type === 6 && window === 0) {
      if (data.length < 4) throw new Error('Truncated negotiation');
      const flags = data.readUInt16LE(2);
      if ((flags & ENHANCED_FLAG) && !data.subarray(4).equals(ENHANCED_SIGNATURE)) {
        throw new Error('Unsupported enhanced protocol version; refusing to downgrade');
      }
      const mode: Mode = flags & ENHANCED_FLAG ? 'enhanced' : 'compatibility';
      if (this.mode !== 'negotiating' && this.mode !== mode) throw new Error('Remote capabilities changed; reconnect explicitly');
      this.mode = mode;
      this.negotiated = true;
      this.filesystem = !!(flags & 2);
      this.lastReply = Date.now();
      if (this.screens.has(0)) this.state = 'connected';
    } else if (type === 0) {
      const screen = decodeScreen(data);
      this.screens.set(window, screen);
      if (window === 0 && this.negotiated) this.state = 'connected';
    } else if (type === 4) {
      if (data.length < 8) throw new Error('Truncated window update');
      if (data[2] === 2 || (data[2] === 1 && window === 0)) {
        this.close('Remote terminal closed');
      } else if (data[2] === 1) {
        this.screens.delete(window);
        this.titles.delete(window);
      } else {
        this.titles.set(window, readCString(data, 8)[0]);
        // Initial negotiation can precede the computer joining the relay.
        if (window === 0 && !this.negotiated) this.negotiate();
      }
    } else if ((type === 8 || type === 9 || type === 65) && window === 0) {
      if (data.length < 4) throw new Error('Truncated filesystem response');
      const id = data[3], pending = this.pending.get(id);
      if (!pending) return;
      if ((type === 65) !== (pending.type === 64)) return;
      if (type === 8 && data[2] !== pending.type && !([21, 23].includes(pending.type) && data[2] === 17)) return;
      if (type === 9 && pending.type !== 20) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(data);
    }
  }

  status() {
    return { name: this.name, state: this.state, filesystem: this.filesystem, reason: this.reason,
      mode: this.mode, warning: this.mode === 'compatibility' ? COMPATIBILITY_WARNING : undefined,
      limits: this.mode === 'negotiating' ? null : { readBytes: this.readLimit(), editBytes: this.readLimit(), writeBytes: MAX_FILE_BYTES },
      windows: [...this.titles].map(([id, title]) => ({ id, title })) };
  }

  private readLimit() { return this.mode === 'enhanced' ? MAX_FILE_BYTES : MAX_READ_BYTES; }

  snapshot(window = 0) {
    const screen = this.screens.get(window);
    return { ...this.status(), screen: screen ?? null, stale: this.state !== 'connected',
      outputKind: 'terminal_snapshot', commandCompletion: 'unknown' };
  }

  close(reason = 'Disconnected by client') {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.reason = reason;
    clearInterval(this.probe);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason}. Operation outcome may be unknown; nothing was retried.`));
    }
    this.pending.clear();
    this.socket.terminate();
  }

  /** Serialize input and read-modify-write operations for this MCP connection. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private requireReady(fs = false) {
    if (this.state !== 'connected') throw new Error(`Computer is ${this.state}; wait for connection before sending actions`);
    if (fs && !this.filesystem) throw new Error('Remote computer did not enable filesystem access');
  }

  async terminal(action: 'command' | 'text' | 'key' | 'interrupt', value = '', waitMs = 250, modifiers: string[] = []) {
    this.requireReady();
    if (action === 'command' || action === 'text') {
      if (/[\r\n]/.test(value)) throw new Error('Terminal input must be a single line; use write_file for multiline programs');
      if (value.length > 4096) throw new Error('Terminal input exceeds 4096 characters');
      this.send(3, event('paste', value));
      if (action === 'command') this.pressKey('enter');
    } else if (action === 'key') {
      for (const name of [...modifiers, value]) {
        if (!Object.hasOwn(keys, name)) throw new Error(`Unsupported key: ${name}`);
      }
      for (const modifier of modifiers) this.send(1, Buffer.from([keys[modifier], 0]));
      this.pressKey(value);
      for (const modifier of [...modifiers].reverse()) this.send(1, Buffer.from([keys[modifier], 1]));
    } else this.send(3, event('terminate'));
    await delay(waitMs);
    return this.snapshot();
  }

  private pressKey(name: string) {
    this.send(1, Buffer.from([keys[name], 0]));
    this.send(1, Buffer.from([keys[name], 1]));
  }

  private request(type: number, path: string, content?: Buffer, offset = 0): Promise<Buffer> {
    this.requireReady(true);
    const encodedPath = cstring(path);
    if (encodedPath.length > 4096) throw new Error('Path exceeds 4095 bytes');
    const id = this.nextId++ % 256;
    if (this.pending.has(id)) throw new Error('Too many outstanding filesystem requests');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Close on timeout so a late response cannot be mistaken for a reused ID.
        this.close('Filesystem request timed out');
      }, this.requestTimeout);
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        if (type === 64) {
          const header = Buffer.alloc(8);
          header[0] = 1; // Extension protocol version.
          header[1] = id;
          header.writeUInt32LE(offset, 2);
          header.writeUInt16LE(4096, 6);
          this.send(64, Buffer.concat([header, encodedPath]));
        } else this.send(7, Buffer.concat([Buffer.from([type, id]), encodedPath]));
        if (content !== undefined) {
          const header = Buffer.alloc(6);
          header[1] = id;
          header.writeUInt32LE(content.length, 2);
          this.send(9, Buffer.concat([header, content]));
        }
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async list(path: string) {
    const response = await this.request(7, path);
    if (response.length < 8) throw new Error('Could not list directory');
    const count = response.readUInt32LE(4);
    if (count > 100000) throw new Error('Invalid or oversized directory listing');
    const entries: string[] = [];
    let offset = 8;
    for (let i = 0; i < count; i++) {
      const [entry, next] = readCString(response, offset);
      entries.push(entry);
      offset = next;
    }
    return { path, entries };
  }

  async install(content: Buffer, overwrite: boolean) {
    const path = '/cc-mcp.lua';
    const response = await this.request(0, path);
    if (response.length !== 5 || response[4] > 1) throw new Error('Could not check installer destination');
    if (response[4] === 1 && !overwrite) throw new Error('/cc-mcp.lua already exists; use overwrite=true to replace it');
    const result = await this.write(path, content);
    return { ...result, instructions: 'Script installed. At the remote shell prompt, run exit to stop the current remote script. Disconnect this local name and call connect_computer again. Run its installedCommand in-game to use /cc-mcp.lua without downloading it again. Do not launch a nested remote script.' };
  }

  async read(path: string): Promise<Buffer> {
    this.requireReady(true);
    if (this.mode === 'enhanced') return this.readEnhanced(path);
    const sizeResponse = await this.request(3, path);
    if (sizeResponse.length !== 8) throw new Error('Invalid file size response');
    const size = sizeResponse.readUInt32LE(4);
    if (size === 0xffffffff) throw new Error('Could not get file size');
    if (size > MAX_READ_BYTES) throw new Error('File exceeds stock-mode 8 KiB read/edit limit; reading it could stop the remote script');
    const response = await this.request(20, path);
    if (response[0] !== 9 || response.length < 8) throw new Error('Invalid file response');
    const length = response.readUInt32LE(4);
    if (length !== response.length - 8) throw new Error('Truncated file response');
    if (response[2]) throw new Error(response.toString('latin1', 8));
    if (length > MAX_READ_BYTES) throw new Error('File exceeds stock-mode 8 KiB read/edit limit');
    return response.subarray(8);
  }

  private async readEnhanced(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0, total: number | undefined;
    do {
      const response = await this.request(64, path, undefined, offset);
      if (response[2] === 1) throw new Error(response.toString('latin1', 4));
      if (response[2] !== 0 || response.length < 12) throw new Error('Invalid enhanced read response');
      const size = response.readUInt32LE(4), position = response.readUInt32LE(8);
      if (size > MAX_FILE_BYTES) throw new Error('File exceeds enhanced 1 MiB limit');
      if (total !== undefined && size !== total) throw new Error('File changed during reading; read it again');
      total = size;
      const bytes = response.subarray(12);
      if (position !== offset || offset > total || bytes.length !== Math.min(4096, total - offset)) {
        throw new Error('Invalid enhanced read chunk');
      }
      chunks.push(bytes);
      offset += bytes.length;
    } while (offset < total);
    return Buffer.concat(chunks, total);
  }

  async write(path: string, content: Buffer) {
    if (content.length > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB limit');
    // Stock Lua's base64 decoder concatenates strings in a loop and can hit the
    // VM's non-yielding watchdog on large packets. Each append is acknowledged
    // before the next chunk is sent. These are distinct writes, never retries.
    let confirmed = 0;
    try {
      do {
        const chunk = content.subarray(confirmed, confirmed + 4096);
        const response = await this.request(confirmed === 0 ? 21 : 23, path, chunk);
        const error = readCString(response, 4)[0];
        if (error) throw new Error(error);
        confirmed += chunk.length;
      } while (confirmed < content.length);
    } catch (error) {
      throw new Error(`Write failed after ${confirmed} acknowledged bytes; file may be partial. ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path, bytesWritten: content.length };
  }

  async edit(path: string, oldText: string, newText: string) {
    const oldBytes = encodeText(oldText), newBytes = encodeText(newText);
    if (!oldBytes.length) throw new Error('old_text must not be empty');
    const original = await this.read(path);
    const offset = original.indexOf(oldBytes);
    if (offset < 0) throw new Error('old_text was not found; file was not changed');
    if (original.indexOf(oldBytes, offset + 1) >= 0) throw new Error('old_text is ambiguous; provide a unique match');
    const result = Buffer.concat([original.subarray(0, offset), newBytes, original.subarray(offset + oldBytes.length)]);
    if (result.length > this.readLimit()) throw new Error(`Edited file would exceed ${this.mode === 'enhanced' ? 'enhanced 1 MiB' : 'stock-mode 8 KiB'} read/edit limit`);
    // Detect changes by another client between the first read and write preparation.
    if (!(await this.read(path)).equals(original)) throw new Error('File changed during editing; read it again');
    return this.write(path, result);
  }
}

export function encodeText(text: string): Buffer {
  if ([...text].some(char => char.codePointAt(0)! > 255)) throw new Error('Text must use single-byte characters (U+0000–U+00FF); use base64 for arbitrary bytes');
  return Buffer.from(text, 'latin1');
}

export class Sessions {
  private sessions = new Map<string, Session>();

  connect(name: string, relay = DEFAULT_RELAY, token?: string, script: 'enhanced' | 'stock' = 'enhanced') {
    if (this.sessions.has(name)) throw new Error('Name already exists; disconnect it before reconnecting');
    if (this.sessions.size >= 32) throw new Error('Maximum of 32 sessions reached');
    const details = connectionDetails(relay, token);
    const session = new Session(name, details.websocket);
    this.sessions.set(name, session);
    return { ...session.status(), connectionCommand: script === 'enhanced' ? details.enhancedCommand : details.command,
      bootstrapCommand: details.command, enhancedCommand: details.enhancedCommand, installedCommand: details.installedCommand,
      instructions: script === 'enhanced'
        ? 'Run connectionCommand in the in-game CraftOS shell to download and launch the enhanced script from GitHub. No prior installation is needed. If /cc-mcp.lua is already installed, installedCommand launches that local copy. bootstrapCommand launches the official stock script as a compatibility fallback. Capabilities are detected from the actual peer, not the selected script.'
        : 'Run connectionCommand in the in-game CraftOS shell, then call read_terminal until connected. Stock connections enter compatibility mode.' };
  }

  get(name: string) {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Unknown computer: ${name}`);
    return session;
  }

  list() { return [...this.sessions.values()].map(session => session.status()); }

  disconnect(name: string) {
    this.get(name).close();
    this.sessions.delete(name);
    return { name, state: 'disconnected' };
  }

  close() {
    for (const session of this.sessions.values()) session.close('MCP server shutting down');
    this.sessions.clear();
  }
}
