import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { COMMAND_TRACKING_FLAG, cstring, decodeOutput, decodeScreen, ENHANCED_FLAG, ENHANCED_SIGNATURE, event, FrameDecoder, keys, OUTPUT_CAPTURE_FLAG, packet, readCString, type Screen } from './protocol.js';
import { OutputHistory } from './output.js';
import { decodeForeground, FOREGROUND_FLAG, INTERRUPT_FLAG, SAFE_WRITE_FLAG, SYNC_FILES_FLAG, RESUME_FLAG, type Foreground } from './protocol.js';
import { ConnectionProfiles, type Profile } from './profiles.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEBUG_EVENT_FLAG, IDENTITY_FLAG } from './protocol.js';
import { DEBUG_EVENT_WARNING, encodeDebugEvent } from './events.js';
import { decodeIdentity, type ComputerIdentity } from './identity.js';

export const MAX_FILE_BYTES = 1024 * 1024;
export const fileHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Stock rawterm only offers whole-file reads and its encoder does not yield.
export const MAX_READ_BYTES = 8 * 1024;
export const DEFAULT_RELAY = 'wss://remote.craftos-pc.cc/';
export const ENHANCED_SCRIPT_URL = 'https://raw.githubusercontent.com/supersnug/craftos-mcp/main/lua/cc-mcp.lua';
type State = 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'disconnected';
type Mode = 'negotiating' | 'enhanced' | 'compatibility';
const MONITOR_TITLE_PREFIX = 'ComputerCraft Remote Terminal: Monitor ';
export const COMPATIBILITY_WARNING = 'Entering compatibility mode… The connected computer is running the stock remote protocol. File reads are limited to 8 KiB; conflict-safe edits and command completion are unavailable. Unconditional writes may leave partial files.';
type Pending = { type: number; resolve: (data: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type CommandRecord = {
  commandId: string;
  command: string;
  state: 'running' | 'finished' | 'failed' | 'interrupted' | 'unknown';
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  reason?: string;
  outputStartCursor?: number;
  connectionId?: string;
};

export function connectionDetails(relay: string, token = randomBytes(30).toString('base64url'), autoReconnect = false) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error('Invalid session token');
  const url = new URL(relay);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Relay must be a ws:// or wss:// base URL without credentials, query, or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const websocket = new URL(token, url).href;
  const enhancedCommand = `wget run ${ENHANCED_SCRIPT_URL} ${token} ${url.href}${autoReconnect ? ' --reconnect' : ''}`;
  const installedCommand = `/cc-mcp.lua ${token} ${url.href}${autoReconnect ? ' --reconnect' : ''}`;
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  const script = new URL('server.lua', url).href;
  // URLs and tokens contain no shell whitespace/quotes after URL encoding and validation.
  return { websocket, command: `wget run ${script} ${token}`, enhancedCommand, installedCommand };
}

/** Owns one relay connection. No action is ever automatically retried. */
export class Session {
  private socket!: WebSocket;
  private decoder = new FrameDecoder();
  private state: State = 'connecting';
  private reason?: string;
  private negotiated = false;
  private filesystem = false;
  private mode: Mode = 'negotiating';
  private commandTracking = false;
  private outputCapture = false;
  private foregroundAwareness = false;
  private reliableInterruption = false;
  private safeWrites = false;
  private syncFiles = false;
  private resumable = false;
  private debugEvents = false;
  private identitySupported = false;
  private identity?: ComputerIdentity;
  private identityAt?: string;
  private identityConnection?: string;
  private identityError?: string;
  private identityRequest?: Promise<void>;
  private identityPoll = 0;
  private attached = false;
  private frameReceived = false;
  private connectionId = randomBytes(16).toString('hex');
  private remoteEpoch?: string;
  private remoteTransport?: number;
  private remoteReconnect = false;
  private remoteSequence = 0;
  private outputGap = false;
  private replay?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private retryCount = 0;
  private retryAt?: string;
  private stopped = false;
  private foreground?: Foreground;
  private output = new OutputHistory();
  private commands = new Map<string, CommandRecord>();
  private lastReply = 0;
  private probe?: NodeJS.Timeout;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private screens = new Map<number, Screen>();
  private titles = new Map<number, string>();
  private dimensions = new Map<number, { width: number; height: number }>();
  private screenErrors = new Map<number, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private actionConnection = new AsyncLocalStorage<string>();

  constructor(readonly name: string, private websocket: string, private requestTimeout = 30000, private autoReconnect = false, private retryBaseMs = 1000) {
    this.open();
  }

  connectionKey() { return this.connectionId; }

  private open() {
    if (this.stopped) return;
    this.connectionId = randomBytes(16).toString('hex');
    this.state = 'connecting';
    this.decoder = new FrameDecoder();
    this.negotiated = this.attached = this.frameReceived = false;
    this.resumable = false; this.mode = 'negotiating'; this.foreground = undefined;
    this.replay = undefined; this.retryAt = undefined;
    this.identityRequest = undefined; this.identityPoll = 0;
    const socket = this.socket = new WebSocket(this.websocket, { handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 });
    socket.on('open', () => {
      if (this.stopped || socket !== this.socket) return;
      this.state = 'waiting';
      this.negotiate();
      this.probe = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          this.lost('Relay is no longer open');
        } else if (this.negotiated && Date.now() - this.lastReply > 35000) {
          this.lost('Computer stopped responding; actions were not replayed.');
        } else if (!this.negotiated || Date.now() - this.lastReply > 10000) this.negotiate();
        if (this.state === 'connected') this.refreshIdentity();
      }, 1000);
      this.probe.unref();
    });
    socket.on('message', bytes => {
      if (this.stopped || socket !== this.socket || this.state === 'reconnecting') return;
      try {
        const raw = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer);
        for (const data of this.decoder.push(raw.toString('ascii'))) this.receive(data);
      } catch (error) {
        this.close(`Protocol error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    socket.on('error', () => { if (socket === this.socket) this.lost('Relay connection failed'); });
    socket.on('close', () => { if (socket === this.socket) this.lost('Relay connection closed'); });
  }

  private negotiate() {
    // Request filesystem and window refresh, but not binary checksums. Stock rawterm
    // has inconsistent checksum handling for negotiation packets in binary mode.
    this.send(6, Buffer.concat([Buffer.from([0xc6, 0xff]), ENHANCED_SIGNATURE]));
  }

  private send(type: number, data: Buffer, window = 0) {
    if (this.state === 'disconnected' || this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay is not connected');
    const frame = this.resumable && type !== 6 && type !== 76
      ? packet(78, 0, Buffer.concat([cstring(this.connectionId), Buffer.from([type, window]), data])) : packet(type, window, data);
    const socket = this.socket;
    for (let i = 0; i < frame.length; i += 65530) {
      socket.send(frame.slice(i, i + 65530), error => {
        if (error && socket === this.socket) this.lost('Send failed; operation outcome may be unknown');
      });
    }
  }

  private receive(data: Buffer, scoped = false) {
    const type = data[0], window = data[1];
    if (type === 79 && window === 0 && this.resumable) {
      if (data[2] !== 1) throw new Error('Invalid connection envelope version');
      const [client, position] = readCString(data, 3);
      if (client !== this.connectionId || !this.attached) return;
      const inner = data.subarray(position);
      if (inner.length < 2 || [6, 77, 79].includes(inner[0])) throw new Error('Invalid connection envelope');
      this.receive(inner, true);
      return;
    }
    if (this.resumable && !scoped && type !== 6 && type !== 77) return;
    if (type === 77 && window === 0 && this.resumable) {
      this.resumeSnapshot(data);
      return;
    }
    if (type === 80 && window === 0 && this.resumable) {
      if (data.length < 11) throw new Error('Truncated sequenced output');
      const sequence = data.readUInt32LE(2);
      if (sequence === this.remoteSequence + 1) this.acceptOutput(sequence, data.subarray(6));
      else if (sequence > this.remoteSequence) this.recoverOutput();
      return;
    }
    if (type === 6 && window === 0) {
      if (data.length < 4) throw new Error('Truncated negotiation');
      const flags = data.readUInt16LE(2);
      if ((flags & ENHANCED_FLAG) && !data.subarray(4).equals(ENHANCED_SIGNATURE)) {
        throw new Error('Unsupported enhanced protocol version; refusing to downgrade');
      }
      const mode: Mode = flags & ENHANCED_FLAG ? 'enhanced' : 'compatibility';
      const commandTracking = mode === 'enhanced' && !!(flags & COMMAND_TRACKING_FLAG);
      const outputCapture = mode === 'enhanced' && !!(flags & OUTPUT_CAPTURE_FLAG);
      const foregroundAwareness = mode === 'enhanced' && !!(flags & FOREGROUND_FLAG);
      const reliableInterruption = mode === 'enhanced' && !!(flags & INTERRUPT_FLAG);
      const safeWrites = mode === 'enhanced' && !!(flags & SAFE_WRITE_FLAG);
      const syncFiles = safeWrites && !!(flags & SYNC_FILES_FLAG);
      const resumable = mode === 'enhanced' && !!(flags & RESUME_FLAG);
      const debugEvents = resumable && !!(flags & DEBUG_EVENT_FLAG);
      const identitySupported = resumable && !!(flags & IDENTITY_FLAG);
      if (this.negotiated && identitySupported !== this.identitySupported) throw new Error('Remote identity capabilities changed; reconnect explicitly');
      if (this.negotiated && debugEvents !== this.debugEvents) throw new Error('Remote debug-event capabilities changed; reconnect explicitly');
      if (this.negotiated && resumable !== this.resumable) throw new Error('Remote resume capabilities changed; reconnect explicitly');
      if (this.negotiated && syncFiles !== this.syncFiles) throw new Error('Remote sync capabilities changed; reconnect explicitly');
      if (this.negotiated && safeWrites !== this.safeWrites) throw new Error('Remote write capabilities changed; reconnect explicitly');
      if (this.negotiated && reliableInterruption !== this.reliableInterruption) throw new Error('Remote interrupt capabilities changed; reconnect explicitly');
      if (this.negotiated && foregroundAwareness !== this.foregroundAwareness) throw new Error('Remote foreground capabilities changed; reconnect explicitly');
      if (this.mode !== 'negotiating' && this.mode !== mode) throw new Error('Remote capabilities changed; reconnect explicitly');
      if (this.negotiated && commandTracking !== this.commandTracking) throw new Error('Remote command capabilities changed; reconnect explicitly');
      if (this.negotiated && outputCapture !== this.outputCapture) throw new Error('Remote output capabilities changed; reconnect explicitly');
      this.mode = mode;
      this.commandTracking = commandTracking;
      this.outputCapture = outputCapture;
      this.foregroundAwareness = foregroundAwareness;
      this.reliableInterruption = reliableInterruption;
      this.safeWrites = safeWrites;
      this.syncFiles = syncFiles;
      this.resumable = resumable;
      this.debugEvents = debugEvents;
      this.identitySupported = identitySupported;
      if (resumable) this.send(76, Buffer.from(JSON.stringify({ client: this.connectionId }), 'ascii'));
      this.negotiated = true;
      this.filesystem = !!(flags & 2);
      this.lastReply = Date.now();
      this.markConnected();
    } else if (type === 0) {
      let screen: Screen;
      try { screen = decodeScreen(data); } catch (error) {
        if (window === 0) throw error;
        this.screenErrors.set(window, error instanceof Error ? error.message : String(error));
        return;
      }
      this.screenErrors.delete(window);
      this.screens.set(window, screen);
      // Frames carry their own dimensions. Some stock monitor scale changes
      // redraw without sending a separate window-size announcement.
      this.dimensions.set(window, { width: screen.width, height: screen.height });
      if (window === 0) { this.frameReceived = true; this.markConnected(); }
    } else if (type === 4) {
      if (data.length < 8) throw new Error('Truncated window update');
      if (data[2] === 2 || (data[2] === 1 && window === 0)) {
        this.close('Remote terminal closed');
      } else if (data[2] === 1) {
        this.screens.delete(window);
        this.titles.delete(window);
        this.dimensions.delete(window);
        this.screenErrors.delete(window);
      } else {
        const title = readCString(data, 8)[0];
        if (this.titles.has(window) && this.titles.get(window) !== title) {
          this.screens.delete(window);
          this.screenErrors.delete(window);
        }
        this.titles.set(window, title);
        this.dimensions.set(window, { width: data.readUInt16LE(4), height: data.readUInt16LE(6) });
        // Initial negotiation can precede the computer joining the relay.
        if (window === 0 && !this.negotiated) this.negotiate();
      }
    } else if (type === 70 && window === 0 && this.foregroundAwareness) {
      this.foreground = decodeForeground(data);
    } else if (type === 69 && window === 0 && this.outputCapture) {
      for (const { kind, row, ...line } of decodeOutput(data)) this.output.accept(kind, row, line);
    } else if (type === 68 && window === 0 && this.commandTracking) {
      if (data.length < 5 || data[2] > (this.reliableInterruption ? 2 : 1)) throw new Error('Invalid command completion');
      const [id, offset] = readCString(data, 3);
      const [reason, end] = readCString(data, offset);
      if (end !== data.length) throw new Error('Invalid command completion length');
      const command = this.commands.get(id);
      if (command && (command.state === 'running' || command.state === 'unknown')) {
        command.state = data[2] === 2 ? 'interrupted' : data[2] === 0 ? 'finished' : 'failed';
        command.success = data[2] === 0;
        command.finishedAt = new Date().toISOString();
        command.reason = reason || undefined;
      }
    } else if ((type === 8 || type === 9 || type === 65 || type === 67 || type === 72 || type === 74 || type === 83 || type === 85 || type === 87) && window === 0) {
      if (data.length < 4) throw new Error('Truncated filesystem response');
      const id = data[3], pending = this.pending.get(id);
      if (!pending) return;
      if ((type === 65) !== (pending.type === 64)) return;
      if ((type === 67) !== (pending.type === 66)) return;
      if ((type === 72) !== (pending.type === 71)) return;
      if ((type === 74) !== (pending.type === 73 || pending.type === 75)) return;
      if ((type === 83) !== (pending.type === 82)) return;
      if ((type === 85) !== (pending.type === 84)) return;
      if ((type === 87) !== (pending.type === 86)) return;
      if (type === 8 && data[2] !== pending.type && !([21, 23].includes(pending.type) && data[2] === 17)) return;
      if (type === 9 && pending.type !== 20) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(data);
    }
  }

  private markConnected() {
    if (this.frameReceived && this.negotiated && (!this.resumable || this.attached)) {
      this.state = 'connected'; this.reason = undefined; this.retryCount = 0;
      this.refreshIdentity();
    }
  }

  private refreshIdentity() {
    if (!this.identitySupported || !this.attached || this.identityRequest || Date.now() - this.identityPoll < 10000) return;
    this.identityPoll = Date.now();
    const client = this.connectionId;
    const operation = this.exclusive(async () => {
      this.requireReady();
      const response = await this.exchange(86, id => this.send(86, Buffer.from([id])));
      if (client !== this.connectionId) return;
      if (response[2] !== 0) throw new Error('Remote computer identity inspection failed');
      const identity = decodeIdentity(response.subarray(4));
      this.identity = identity; this.identityAt = new Date().toISOString(); this.identityConnection = client;
      this.identityError = undefined;
    });
    this.identityRequest = operation;
    void operation.catch(error => {
      if (client === this.connectionId) this.identityError = error instanceof Error ? error.message : String(error);
    }).finally(() => { if (this.identityRequest === operation) this.identityRequest = undefined; });
  }

  private identityStatus() {
    const stale = this.state !== 'connected' || !this.identitySupported || this.identityConnection !== this.connectionId
      || !!this.identityError || !this.identityAt || Date.now() - Date.parse(this.identityAt) > 25000;
    return { ...this.identity, supported: this.identitySupported, stale, observedAt: this.identityAt,
      refreshing: !!this.identityRequest, error: this.identityError,
      reason: !this.identitySupported ? 'Computer identity is unsupported or not yet negotiated' : !this.identity ? 'Waiting for computer identity' : stale ? 'Last observation only; identity is not current' : undefined };
  }

  private resumeSnapshot(data: Buffer) {
    const snapshot = JSON.parse(data.toString('utf8', 2));
    if (snapshot.client !== this.connectionId) return;
    if (!/^[a-f0-9]{32}$/.test(snapshot.epoch) || !Array.isArray(snapshot.commands) || snapshot.commands.length > 128
      || !Number.isSafeInteger(snapshot.first) || !Number.isSafeInteger(snapshot.last) || snapshot.first < 1 || snapshot.last < snapshot.first - 1) throw new Error('Invalid reattachment snapshot');
    if (!Number.isSafeInteger(snapshot.transport) || snapshot.transport < 0) throw new Error('Invalid transport generation');
    if (this.attached) {
      if (snapshot.epoch !== this.remoteEpoch || snapshot.transport !== this.remoteTransport) this.lost('Remote transport restarted; pending actions were not replayed');
      return;
    }
    this.remoteTransport = snapshot.transport;
    if (this.remoteEpoch !== snapshot.epoch) {
      if (this.remoteEpoch) this.outputGap = true;
      this.remoteSequence = 0; this.output.clearLive();
    }
    this.remoteEpoch = snapshot.epoch;
    this.remoteReconnect = snapshot.autoReconnect === true;
    this.titles.clear(); this.dimensions.clear(); this.screens.clear(); this.screenErrors.clear();
    this.frameReceived = false;
    for (const record of snapshot.commands) {
      if (!/^[a-f0-9]{32}$/.test(record.commandId) || typeof record.command64 !== 'string' || record.command64.length > 5464
        || !['running', 'finished', 'failed', 'interrupted'].includes(record.state) || (record.reason64 !== undefined && typeof record.reason64 !== 'string')) throw new Error('Invalid restored command');
      const previous = this.commands.get(record.commandId);
      this.commands.set(record.commandId, { ...previous, commandId: record.commandId,
        command: Buffer.from(record.command64, 'base64').toString('latin1'), state: record.state,
        startedAt: previous?.startedAt ?? new Date().toISOString(),
        success: record.state === 'running' ? undefined : record.state === 'finished',
        reason: record.reason64 ? Buffer.from(record.reason64, 'base64').toString('latin1') : undefined,
        connectionId: this.connectionId });
    }
    while (this.commands.size > 128) {
      const expired = [...this.commands.values()].find(record => record.state !== 'running');
      if (!expired) break;
      this.commands.delete(expired.commandId);
    }
    this.attached = true;
    this.negotiate(); // Refresh all windows after the connection-scoped attach.
    this.recoverOutput();
  }

  private acceptOutput(sequence: number, batch: Buffer) {
    if (batch[0] !== 69 || batch[1] !== 0) throw new Error('Invalid recovered output batch');
    if (sequence <= this.remoteSequence) return;
    if (sequence !== this.remoteSequence + 1) { this.outputGap = true; this.output.clearLive(); }
    for (const { kind, row, ...line } of decodeOutput(batch)) this.output.accept(kind, row, line);
    this.remoteSequence = sequence;
  }

  private recoverOutput() {
    if (this.replay || !this.attached) return;
    const client = this.connectionId;
    const operation = (async () => {
      for (;;) {
        const after = this.remoteSequence;
        const response = await this.exchange(82, id => {
          const request = Buffer.alloc(5); request[0] = id; request.writeUInt32LE(after, 1); this.send(82, request);
        });
        if (this.connectionId !== client) return;
        if (response.length < 16 || response[2] !== 0) throw new Error('Invalid output recovery response');
        const first = response.readUInt32LE(4), sequence = response.readUInt32LE(8), last = response.readUInt32LE(12);
        if (!first || first > last + 1 || sequence > last || (sequence && sequence <= after) || (!sequence && last > after)) throw new Error('Invalid output recovery range');
        if (first > this.remoteSequence + 1) { this.outputGap = true; this.output.clearLive(); }
        if (!sequence) return;
        this.acceptOutput(sequence, response.subarray(16));
        if (this.remoteSequence >= last) return;
      }
    })();
    this.replay = operation;
    void operation.catch(error => {
      if (client === this.connectionId && this.state !== 'reconnecting' && !this.stopped) this.lost(`Output recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { if (this.replay === operation) this.replay = undefined; });
  }

  status() {
    return { name: this.name, state: this.state, filesystem: this.filesystem, reason: this.reason,
      mode: this.mode, warning: this.mode === 'compatibility' ? COMPATIBILITY_WARNING : undefined,
      capabilities: { commandTracking: this.commandTracking, outputCapture: this.outputCapture, foregroundAwareness: this.foregroundAwareness, reliableInterruption: this.reliableInterruption, debugEvents: this.debugEvents },
      foreground: this.foregroundStatus(),
      identity: this.identityStatus(),
      fileSafety: { recoverableWrites: this.safeWrites, conditionalWrites: this.safeWrites, directorySync: this.syncFiles, crashAtomicReplacement: false },
      reconnection: { enabled: this.autoReconnect, supported: this.resumable, remoteEnabled: this.remoteReconnect,
        warning: this.autoReconnect && this.negotiated && (!this.resumable || !this.remoteReconnect) ? 'Update the enhanced launcher and launch with --reconnect to keep programs alive during network loss' : undefined,
        attempt: this.retryCount, retryAt: this.retryAt, remoteEpoch: this.remoteEpoch, recoveringOutput: !!this.replay, outputGap: this.outputGap },
      limits: this.mode === 'negotiating' ? null : { readBytes: this.readLimit(), editBytes: this.safeWrites ? MAX_FILE_BYTES : 0, writeBytes: MAX_FILE_BYTES },
      windows: [...this.titles].map(([id, title]) => ({ id, title,
        kind: id === 0 ? 'terminal' : this.monitorName(id, title) ? 'monitor' : 'unknown',
        monitor: this.monitorName(id, title), ...this.dimensions.get(id) })) };
  }

  private monitorName(id: number, title: string) {
    return id !== 0 && title.startsWith(MONITOR_TITLE_PREFIX) ? title.slice(MONITOR_TITLE_PREFIX.length) || undefined : undefined;
  }

  private foregroundStatus() {
    const stale = this.state !== 'connected' || !this.foreground;
    return { ...this.foreground, supported: this.foregroundAwareness,
      kind: stale ? 'unknown' : this.foreground!.kind,
      lastKnownKind: stale ? this.foreground?.kind : undefined,
      canRunCommand: !stale && this.commandTracking && this.foreground!.canRunCommand,
      stale, observation: 'shell API at yield boundaries; nested independent shells and concurrent tasks may hide deeper state',
      reason: !this.foregroundAwareness ? 'Foreground awareness is not supported by this peer' : !this.foreground ? 'Waiting for foreground state' : stale ? 'Connection is not live; last observation only' : undefined };
  }

  private readLimit() { return this.mode === 'enhanced' ? MAX_FILE_BYTES : MAX_READ_BYTES; }

  snapshot(window = 0) {
    const screen = this.screens.get(window);
    const expectedSize = this.dimensions.get(window);
    const screenError = this.screenErrors.get(window);
    const resizing = !!screen && !!expectedSize && (screen.width !== expectedSize.width || screen.height !== expectedSize.height);
    const availability = this.state === 'disconnected' ? 'disconnected' : screenError ? 'invalid_frame' : !screen ? 'waiting_for_frame' : resizing ? 'waiting_for_resize' : 'ready';
    return { ...this.status(), screen: screen ?? null, stale: this.state !== 'connected' || !screen || resizing || !!screenError,
      availability, expectedSize, screenError,
      outputKind: 'terminal_snapshot', commandCompletion: 'unknown' };
  }

  async readMonitor(monitor: string, waitMs = 0) {
    await delay(waitMs);
    const matches = [...this.titles].filter(([id, title]) => this.monitorName(id, title) === monitor);
    if (!matches.length) {
      const available = this.status().windows.flatMap(window => window.monitor ? [window.monitor] : []);
      throw new Error(`Monitor ${JSON.stringify(monitor)} is not currently advertised (computer ${this.state}). Available monitors: ${available.length ? available.join(', ') : 'none'}. It may be detached or not discovered yet.`);
    }
    if (matches.length !== 1) throw new Error('Monitor name is ambiguous; inspect list_computers and use read_terminal with a window ID');
    const [window] = matches[0];
    return { ...this.snapshot(window), monitor, window, outputKind: 'monitor_snapshot' };
  }

  private lost(reason: string) {
    if (this.stopped || this.state === 'reconnecting' || this.state === 'disconnected') return;
    if (!this.autoReconnect) { this.close(reason); return; }
    this.state = 'reconnecting';
    this.drop(reason);
    const wait = Math.min(this.retryBaseMs * 2 ** Math.min(this.retryCount++, 5), 30000);
    this.retryAt = new Date(Date.now() + wait).toISOString();
    this.retry = setTimeout(() => this.open(), wait);
    this.retry.unref();
  }

  close(reason = 'Disconnected by client') {
    if (this.stopped) return;
    this.stopped = true;
    this.state = 'disconnected';
    clearTimeout(this.retry);
    this.retryAt = undefined;
    this.drop(reason);
  }

  private drop(reason: string) {
    this.reason = reason;
    for (const command of this.commands.values()) {
      if (command.state === 'running' || command.state === 'unknown') {
        command.state = 'unknown';
        command.reason = `${reason}; completion was not observed. Do not automatically rerun the command.`;
      }
    }
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
    const client = this.connectionId;
    const result = this.queue.then(() => {
      if (client !== this.connectionId) throw new Error('Connection changed while operation was queued; it was not sent');
      return this.actionConnection.run(client, operation);
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private requireReady(fs = false) {
    const client = this.actionConnection.getStore();
    if (client && client !== this.connectionId) throw new Error('Connection changed during operation; remaining actions were not sent');
    if (this.state !== 'connected') throw new Error(`Computer is ${this.state}; wait for connection before sending actions`);
    if (fs && !this.filesystem) throw new Error('Remote computer did not enable filesystem access');
  }

  async terminal(action: 'command' | 'text' | 'key' | 'interrupt', value = '', waitMs = 250, modifiers: string[] = []) {
    this.requireReady();
    if (action === 'command' || action === 'text') {
      if (/[\r\n]/.test(value)) throw new Error('Terminal input must be a single line; use write_file for multiline programs');
      if (value.length > 4096) throw new Error('Terminal input exceeds 4096 characters');
      if (action === 'command' && this.commandTracking) return this.runTracked(value, waitMs);
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

  async sendEvent(eventName: string, args: unknown[], waitMs = 250) {
    this.requireReady();
    if (!this.debugEvents) throw new Error('Debug event injection requires an updated enhanced launcher advertising debugEvents');
    const request = { ...encodeDebugEvent(eventName, args), nonce: randomBytes(16).toString('hex') };
    const response = await this.exchange(84, id => this.send(84, Buffer.concat([Buffer.from([id]), Buffer.from(JSON.stringify(request), 'ascii')])));
    if (response[2] > 1) throw new Error('Invalid debug event acknowledgment; outcome is unknown');
    const result = JSON.parse(response.toString('utf8', 4));
    if (response[2]) throw new Error(String(result.error));
    if (result.outcome !== 'accepted' || result.nonce !== request.nonce) throw new Error('Debug event acknowledgment mismatch; outcome is unknown');
    await delay(waitMs);
    return { ...this.snapshot(), warning: DEBUG_EVENT_WARNING,
      injection: { event: eventName, argumentCount: args.length, outcome: 'accepted', handling: 'unknown', commandId: result.commandId || undefined } };
  }

  async mouse(action: 'mouse_click' | 'mouse_up' | 'mouse_drag' | 'mouse_scroll', x: number, y: number,
    button?: 'left' | 'right' | 'middle', direction?: 'up' | 'down', waitMs = 250, monitor?: string) {
    this.requireReady();
    let window = 0;
    if (monitor !== undefined) {
      const matches = [...this.titles].filter(([id, title]) => this.monitorName(id, title) === monitor);
      if (matches.length !== 1) throw new Error('Monitor must be currently advertised with an unambiguous peripheral name; inspect list_computers');
      window = matches[0][0];
      if (action !== 'mouse_click' || button !== 'left' || direction !== undefined) throw new Error('Monitors support touch events only');
    }
    const snapshot = this.snapshot(window);
    if (snapshot.stale || !snapshot.screen) throw new Error('Target has no current usable screen; read it again before sending input');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1 || x > snapshot.screen.width || y > snapshot.screen.height) {
      throw new Error(`Coordinates must be 1-based character cells within ${snapshot.screen.width}x${snapshot.screen.height}`);
    }
    const actions = { mouse_click: 0, mouse_up: 1, mouse_scroll: 2, mouse_drag: 3 };
    const buttons = { left: 1, right: 2, middle: 3 };
    if (!Object.hasOwn(actions, action)) throw new Error('Unsupported mouse event');
    if (action === 'mouse_scroll') {
      if (button !== undefined || (direction !== 'up' && direction !== 'down')) throw new Error('mouse_scroll requires direction and no button');
    } else if (direction !== undefined || button === undefined || !Object.hasOwn(buttons, button)) {
      throw new Error('Click, up and drag require button and no direction');
    }
    const data = Buffer.alloc(10);
    data[0] = actions[action];
    data[1] = action === 'mouse_scroll' ? direction === 'up' ? 0 : 1 : buttons[button!];
    data.writeUInt32LE(x, 2); data.writeUInt32LE(y, 6);
    this.send(2, data, window);
    await delay(waitMs);
    const current = this.snapshot(window);
    const detached = monitor !== undefined && this.monitorName(window, this.titles.get(window) ?? '') !== monitor;
    return { ...current, ...(detached ? { screen: null, stale: true, availability: 'detached' } : {}),
      input: { event: monitor === undefined ? action : 'monitor_touch', monitor, x, y,
        button: monitor === undefined ? button : undefined, direction, delivery: 'sent', handling: 'unknown' } };
  }

  async interrupt(mode: 'graceful' | 'force', commandId?: string, waitMs = 250) {
    this.requireReady();
    if (!this.reliableInterruption) {
      if (mode === 'force' || commandId) throw new Error('Force interruption and command-ID targeting require an updated enhanced launcher');
      return { ...await this.terminal('interrupt', '', waitMs), interruption: { mode, outcome: 'unknown', reliable: false, warning: 'Best-effort terminate only; older scripts can ignore it or close an idle remote shell' } };
    }
    const response = await this.exchange(71, id => this.send(71, Buffer.concat([Buffer.from([1, id, mode === 'force' ? 1 : 0]), cstring(commandId ?? '')])));
    const [outcome, next] = readCString(response, 4);
    const [target, end] = readCString(response, next);
    if (end !== response.length || response[2] > 1) throw new Error('Invalid interrupt response');
    if (response[2] === 1) throw new Error(outcome);
    if (!['idle', 'running', 'stopped'].includes(outcome) || (target && !/^[a-f0-9]{32}$/.test(target))) throw new Error('Invalid interrupt outcome');
    if (commandId && target !== commandId) throw new Error('Interrupt response target mismatch; outcome is unknown, do not retry automatically');
    await delay(waitMs);
    const command = target ? this.commands.get(target) : undefined;
    return { ...this.snapshot(), interruption: { mode, outcome, reliable: true, commandId: target || undefined }, command: command ? { ...command } : undefined };
  }

  private async runTracked(line: string, waitMs: number) {
    if (!line.trim()) throw new Error('Command must not be blank');
    if ([...this.commands.values()].some(command => command.state === 'running' || (command.state === 'unknown' && command.connectionId === this.connectionId))) {
      throw new Error('Foreground is not an idle shell prompt: a tracked command is still running or its outcome is unknown; use get_command_status or send_text/send_key');
    }
    const encoded = cstring(line);
    const commandId = randomBytes(16).toString('hex');
    // Bound local history. Active commands are never evicted to make room.
    if (this.commands.size >= 128) {
      const expired = [...this.commands.values()].find(command => command.state !== 'running');
      if (expired) this.commands.delete(expired.commandId);
      else throw new Error('Command history is full of active commands');
    }
    const command: CommandRecord = { commandId, command: line, state: 'unknown', connectionId: this.connectionId, startedAt: new Date().toISOString(), reason: 'Awaiting start acknowledgment', outputStartCursor: this.outputCapture ? this.output.cursor : undefined };
    this.commands.set(commandId, command);
    try {
      const response = await this.exchange(66, id => this.send(66, Buffer.concat([Buffer.from([1, id]), cstring(commandId), encoded])));
      const [message, end] = readCString(response, 4);
      if (end !== response.length || response[2] > 1) throw new Error('Invalid command start response');
      if (response[2] === 1) {
        this.commands.delete(commandId);
        throw new Error(message);
      }
      if (message !== commandId) throw new Error('Command acknowledgment ID mismatch');
      // A short command may finish in the same batch as its acknowledgment.
      if (command.state === 'unknown' && this.state === 'connected') {
        command.state = 'running';
        command.reason = undefined;
      }
    } catch (error) {
      if (this.commands.has(commandId) && command.state === 'unknown') command.reason = 'Start outcome or completion is unknown; do not automatically rerun';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${this.commands.has(commandId) ? ` (commandId: ${commandId}; inspect get_command_status)` : ''}`);
    }
    await delay(waitMs);
    return { ...this.snapshot(), commandId, commandCompletion: command.state, command: { ...command } };
  }

  async commandStatus(commandId: string, waitMs = 0) {
    await delay(waitMs);
    const command = this.commands.get(commandId);
    if (!command) throw new Error('Unknown or expired command ID; history retains the most recent 128 commands in this session');
    return { commandId, commandCompletion: command.state, command: { ...command } };
  }

  async readOutput(cursor?: number, commandId?: string, limit = 200, waitMs = 0) {
    await delay(waitMs);
    if (!this.outputCapture) return { supported: false, reason: 'Output capture is not negotiated. Stock and older launchers provide screen snapshots only; update the enhanced launcher.', stale: this.state !== 'connected' };
    const command = commandId ? this.commands.get(commandId) : undefined;
    if (commandId && !command && !this.output.hasCommand(commandId)) throw new Error('Unknown or expired command ID; no output or command record remains');
    const page = this.output.read(cursor ?? command?.outputStartCursor ?? 0, commandId, limit);
    return { supported: true, commandId, commandState: command?.state ?? (commandId ? 'unknown' : undefined),
      commandStatusAvailable: commandId ? !!command : undefined,
      ...page, truncated: page.truncated || this.outputGap, recoveryGap: this.outputGap, recovering: !!this.replay, stale: this.state !== 'connected' };
  }

  private request(type: number, path: string, content?: Buffer, offset = 0): Promise<Buffer> {
    this.requireReady(true);
    const encodedPath = cstring(path);
    if (encodedPath.length > 4096) throw new Error('Path exceeds 4095 bytes');
    return this.exchange(type, id => {
      if (type === 64) {
        const header = Buffer.alloc(8);
        header[0] = 1;
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
    });
  }

  private exchange(type: number, send: (id: number) => void): Promise<Buffer> {
    const id = this.nextId++ % 256;
    if (this.pending.has(id)) throw new Error('Too many outstanding filesystem requests');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Close on timeout so a late response cannot be mistaken for a reused ID.
        this.lost(type === 71 ? 'Interrupt acknowledgment timed out' : type === 66 ? 'Command start acknowledgment timed out' : type === 84 ? 'Debug event acknowledgment timed out' : type === 86 ? 'Computer identity request timed out' : 'Filesystem request timed out');
      }, this.requestTimeout);
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        send(id);
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
    const result = await this.write(path, content, undefined, this.safeWrites && !overwrite);
    return { ...result, instructions: 'Script installed. At the remote shell prompt, run exit to stop the current remote script. Disconnect this local name and call connect_computer again. Run its installedCommand in-game to use /cc-mcp.lua without downloading it again. Do not launch a nested remote script.' };
  }

  requireSyncReady() {
    this.requireReady(true);
    if (!this.syncFiles) throw new Error('Folder sync requires an updated enhanced launcher with directorySync support');
  }

  async readOptional(path: string): Promise<Buffer | null> {
    const response = await this.request(0, path);
    if (response.length !== 5 || response[4] > 1) throw new Error('Could not check file existence');
    return response[4] ? this.read(path) : null;
  }

  async makeDirectory(path: string) {
    this.requireSyncReady();
    return this.transaction({ op: 'mkdir', path, id: randomBytes(16).toString('hex') });
  }

  async deleteFile(path: string, expectedHash: string) {
    this.requireSyncReady();
    const expected = await this.read(path);
    if (fileHash(expected) !== expectedHash) throw new Error('Conflict: destination changed since read');
    return this.stagedWrite(path, Buffer.alloc(0), expected, false, true);
  }

  async read(path: string): Promise<Buffer> {
    this.requireReady(true);
    if (this.mode === 'enhanced') return this.readEnhanced(path);
    const sizeResponse = await this.request(3, path);
    if (sizeResponse.length !== 8) throw new Error('Invalid file size response');
    const size = sizeResponse.readUInt32LE(4);
    if (size === 0xffffffff) throw new Error('Could not get file size');
    if (size > MAX_READ_BYTES) throw new Error('File exceeds stock-mode 8 KiB read limit; reading it could stop the remote script');
    const response = await this.request(20, path);
    if (response[0] !== 9 || response.length < 8) throw new Error('Invalid file response');
    const length = response.readUInt32LE(4);
    if (length !== response.length - 8) throw new Error('Truncated file response');
    if (response[2]) throw new Error(response.toString('latin1', 8));
    if (length > MAX_READ_BYTES) throw new Error('File exceeds stock-mode 8 KiB read limit');
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

  private async transaction(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireReady(true);
    if (!this.safeWrites) throw new Error('Recoverable/conditional file operations require an updated enhanced launcher');
    cstring(String(request.path));
    const wire = { ...request, path: undefined, path64: Buffer.from(String(request.path), 'latin1').toString('base64') };
    const isChunk = request.op === 'chunk';
    const response = await this.exchange(isChunk ? 75 : 73, id => {
      if (isChunk) {
        const header = Buffer.alloc(6);
        header[0] = id; header[1] = request.stream === 'new' ? 0 : 1;
        header.writeUInt32LE(Number(request.offset), 2);
        this.send(75, Buffer.concat([header, cstring(String(request.id)), Buffer.from(String(request.data), 'base64')]));
      } else this.send(73, Buffer.concat([Buffer.from([id]), Buffer.from(JSON.stringify(wire), 'ascii')]));
    });
    if (response[2] > 1) throw new Error('Invalid transaction response');
    const result = JSON.parse(response.toString('utf8', 4));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid transaction response');
    if (response[2]) throw new Error(String(result.error));
    const outcomes: Record<string, string[]> = { begin: ['ready'], chunk: ['uploaded'], commit: ['committed', 'deleted'], mkdir: ['directory_ready'], abort: ['aborted'], recover: ['aborted', 'restored', 'inspection_required'] };
    if (!outcomes[String(request.op)]?.includes(result.outcome)) throw new Error('Invalid transaction outcome; operation may have completed');
    return result;
  }

  async recoverWrite(path: string, transactionId: string) {
    return this.transaction({ op: 'recover', path, id: transactionId });
  }

  private async stagedWrite(path: string, content: Buffer, expected?: Buffer, mustNotExist = false, remove = false) {
    const id = randomBytes(16).toString('hex');
    let commitStarted = false;
    try {
      await this.transaction({ op: 'begin', path, id, size: content.length, condition: expected !== undefined ? 'match' : mustNotExist ? 'missing' : 'any', remove });
      for (const [stream, bytes] of [['expected', expected], ['new', content]] as const) {
        if (!bytes) continue;
        for (let offset = 0; offset < bytes.length; offset += 4096) {
          await this.transaction({ op: 'chunk', path, id, stream, offset, data: bytes.subarray(offset, offset + 4096).toString('base64') });
        }
      }
      commitStarted = true;
      const result = await this.transaction({ op: 'commit', path, id });
      if (result.outcome !== (remove ? 'deleted' : 'committed')) throw new Error('Unexpected commit outcome; inspect destination before continuing');
      return { path, bytesWritten: content.length, hash: remove ? null : fileHash(content), transactionId: id, safety: 'recoverable', ...result };
    } catch (error) {
      if (!commitStarted && this.state === 'connected') {
        try { await this.transaction({ op: 'abort', path, id }); } catch { /* Retain recovery evidence if cleanup fails. */ }
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)} (transactionId: ${id}, path: ${path}; use recover_file_write after inspecting state; never replay an uncertain commit)`);
    }
  }

  async write(path: string, content: Buffer, expectedHash?: string, mustNotExist = false) {
    if (content.length > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB limit');
    if (expectedHash && mustNotExist) throw new Error('Choose expected_hash or must_not_exist, not both');
    if (!this.safeWrites && (expectedHash || mustNotExist)) throw new Error('Conditional writes require an updated enhanced launcher');
    let expected: Buffer | undefined;
    if (expectedHash) {
      expected = await this.read(path);
      if (fileHash(expected) !== expectedHash) throw new Error('Conflict: destination changed since read');
    }
    if (this.safeWrites) return this.stagedWrite(path, content, expected, mustNotExist);
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
    return { path, bytesWritten: content.length, hash: fileHash(content), safety: 'legacy_partial_write_possible' };
  }

  async edit(path: string, oldText: string, newText: string, expectedHash: string) {
    if (!this.safeWrites) throw new Error('Conflict-safe edits require an updated enhanced launcher');
    const oldBytes = encodeText(oldText), newBytes = encodeText(newText);
    if (!oldBytes.length) throw new Error('old_text must not be empty');
    const original = await this.read(path);
    if (fileHash(original) !== expectedHash) throw new Error('Conflict: destination changed since read');
    const offset = original.indexOf(oldBytes);
    if (offset < 0) throw new Error('old_text was not found; file was not changed');
    if (original.indexOf(oldBytes, offset + 1) >= 0) throw new Error('old_text is ambiguous; provide a unique match');
    const result = Buffer.concat([original.subarray(0, offset), newBytes, original.subarray(offset + oldBytes.length)]);
    if (result.length > MAX_FILE_BYTES) throw new Error('Edited file would exceed enhanced 1 MiB limit');
    // The remote commit compares these exact bytes immediately before replacement.
    return this.stagedWrite(path, result, original);
  }
}

export function encodeText(text: string): Buffer {
  if ([...text].some(char => char.codePointAt(0)! > 255)) throw new Error('Text must use single-byte characters (U+0000–U+00FF); use base64 for arbitrary bytes');
  return Buffer.from(text, 'latin1');
}

export class Sessions {
  private sessions = new Map<string, Session>();
  private profiles = new Map<string, Profile>();
  private saved = new Set<string>();

  constructor(private readonly store?: ConnectionProfiles) {}

  restore() {
    const profiles = this.store?.load() ?? [];
    for (const profile of profiles) connectionDetails(profile.relay, profile.token, true);
    for (const profile of profiles) {
      this.connect(profile.name, profile.relay, profile.token, 'enhanced', true, false);
      this.saved.add(profile.name);
    }
  }

  connect(name: string, relay = DEFAULT_RELAY, token?: string, script: 'enhanced' | 'stock' = 'enhanced', reconnect = false, persist = reconnect) {
    if (this.sessions.has(name)) throw new Error('Name already exists; disconnect it before reconnecting');
    if (this.sessions.size >= 32) throw new Error('Maximum of 32 sessions reached');
    if (reconnect && script === 'stock') throw new Error('Automatic reconnection requires the enhanced launcher');
    const details = connectionDetails(relay, token, reconnect);
    const profile = { name, relay, token: new URL(details.websocket).pathname.split('/').pop()! };
    if (persist) {
      if (!this.store) throw new Error('Persistent connection storage is not configured');
      this.store.save([...this.profiles.values()].filter(p => this.saved.has(p.name)).concat(profile));
      this.saved.add(name);
    }
    this.profiles.set(name, profile);
    const session = new Session(name, details.websocket, 30000, reconnect);
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
    this.get(name);
    if (this.saved.has(name)) this.store!.save([...this.profiles.values()].filter(p => p.name !== name && this.saved.has(p.name)));
    this.get(name).close();
    this.sessions.delete(name);
    this.profiles.delete(name); this.saved.delete(name);
    return { name, state: 'disconnected' };
  }

  async startup(name: string, enabled: boolean) {
    const session = this.get(name), profile = this.profiles.get(name)!;
    const startupPath = '/startup/zz-cc-mcp.lua';
    const marker = '-- Managed by CC-MCP startup v1\n';
    // JSON quoting is Lua-compatible for these validated URL/token strings.
    const command = connectionDetails(profile.relay, profile.token, true).installedCommand;
    const contents = Buffer.from(marker + 'shell.run(' + JSON.stringify(command) + ')\n', 'ascii');
    return session.exclusive(async () => {
      session.requireSyncReady();
      const existing = await session.readOptional(startupPath);
      if (existing && !existing.toString('ascii').startsWith(marker)) throw new Error('Startup path is occupied by an unmanaged file; it was preserved');
      if (enabled) {
        if (!this.saved.has(name)) throw new Error('Connect with reconnect=true before enabling boot startup');
        const launcher = await session.readOptional('/cc-mcp.lua');
        if (!launcher?.includes(Buffer.from('resumeCapability'))) throw new Error('Install the current enhanced launcher at /cc-mcp.lua first');
        await session.makeDirectory('/startup');
        await session.write(startupPath, contents, existing ? fileHash(existing) : undefined, !existing);
      } else if (existing) await session.deleteFile(startupPath, fileHash(existing));
      return { name, enabled, path: startupPath, instructions: 'Takes effect at next computer boot. Existing startup files are preserved. Earlier startup programs must return before this script can run. Disabling does not stop the current launcher.' };
    });
  }

  close() {
    for (const session of this.sessions.values()) session.close('MCP server shutting down');
    this.sessions.clear();
    this.profiles.clear(); this.saved.clear();
  }
}
