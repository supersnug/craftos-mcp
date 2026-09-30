// CraftOS-PC raw mode: base64 payloads, CRC32, and little-endian fields.
// Reference: https://github.com/MCJack123/remote.craftos-pc.cc/blob/master/rawterm.lua
const MAX_FRAME = 8 * 1024 * 1024;
export const ENHANCED_FLAG = 0x8000;
export const COMMAND_TRACKING_FLAG = 0x4000;
export const OUTPUT_CAPTURE_FLAG = 0x2000;
export const FOREGROUND_FLAG = 0x1000;
export const INTERRUPT_FLAG = 0x0800;
export const SAFE_WRITE_FLAG = 0x0400;
export const SYNC_FILES_FLAG = 0x0200;
export const RESUME_FLAG = 0x0100;
export const DEBUG_EVENT_FLAG = 0x0080;
export const IDENTITY_FLAG = 0x0040;

export interface Foreground {
  kind: 'unknown' | 'shell' | 'starting' | 'program' | 'lua_repl';
  canRunCommand: boolean;
  prompt?: 'idle' | 'editing';
  program?: string;
  programName?: string;
  workingDirectory: string;
  commandId?: string;
  observedAt: string;
}

export function decodeForeground(data: Buffer): Foreground {
  if (data.length < 8 || data[2] !== 1 || data[3] > 1) throw new Error('Invalid foreground packet');
  let offset = 4;
  const fields: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [value, next] = readCString(data, offset);
    if (value.length > 4095) throw new Error('Oversized foreground field');
    fields.push(value); offset = next;
  }
  const [kind, program, directory, commandId] = fields;
  if (offset !== data.length || !['unknown', 'shell', 'starting', 'program', 'lua_repl'].includes(kind)
    || (data[3] === 1 && kind !== 'shell') || (commandId && !/^[a-f0-9]{32}$/.test(commandId))) throw new Error('Invalid foreground state');
  return { kind: kind as Foreground['kind'], canRunCommand: data[3] === 1,
    prompt: kind === 'shell' ? data[3] === 1 ? 'idle' : 'editing' : undefined,
    program: program || undefined, programName: program ? program.split('/').pop() : undefined,
    workingDirectory: '/' + directory.replace(/^\/+/, ''),
    commandId: commandId || undefined, observedAt: new Date().toISOString() };
}
export const ENHANCED_SIGNATURE = Buffer.from('CCMCP/1\0', 'ascii');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function packet(type: number, window: number, data: Buffer = Buffer.alloc(0)): string {
  const payload = Buffer.concat([Buffer.from([type, window]), data]).toString('base64');
  if (payload.length > MAX_FRAME) throw new Error('Packet exceeds size limit');
  const prefix = payload.length > 0xffff ? '!CPD' : '!CPC';
  const length = payload.length.toString(16).padStart(prefix === '!CPD' ? 12 : 4, '0');
  return prefix + length + payload + crc32(Buffer.from(payload)).toString(16).padStart(8, '0') + '\n';
}

/** Streaming decoder: stock server splits a single packet across WebSocket messages. */
export class FrameDecoder {
  private buffer = '';

  push(chunk: string): Buffer[] {
    this.buffer += chunk;
    const frames: Buffer[] = [];
    while (this.buffer.length) {
      this.buffer = this.buffer.replace(/^[\r\n]+/, '');
      if (this.buffer.length < 4) break;
      const prefix = this.buffer.slice(0, 4);
      if (prefix !== '!CPC' && prefix !== '!CPD') throw new Error('Invalid rawterm frame prefix');
      const offset = prefix === '!CPD' ? 16 : 8;
      if (this.buffer.length < offset) break;
      const hex = this.buffer.slice(4, offset);
      if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('Invalid frame length');
      const size = Number.parseInt(hex, 16);
      if (size > MAX_FRAME || size < 4 || size % 4 !== 0) throw new Error('Invalid frame size');
      if (this.buffer.length < offset + size + 8) break;
      const payload = this.buffer.slice(offset, offset + size);
      const checksum = this.buffer.slice(offset + size, offset + size + 8);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || !/^[0-9a-f]{8}$/i.test(checksum)) {
        throw new Error('Malformed frame');
      }
      if (crc32(Buffer.from(payload)) !== Number.parseInt(checksum, 16)) throw new Error('Frame checksum mismatch');
      const decoded = Buffer.from(payload, 'base64');
      if (decoded.length < 2) throw new Error('Truncated packet');
      frames.push(decoded);
      this.buffer = this.buffer.slice(offset + size + 8);
    }
    return frames;
  }
}

export function cstring(value: string): Buffer {
  if (value.includes('\0')) throw new Error('NUL is not supported in protocol strings');
  if ([...value].some(char => char.codePointAt(0)! > 255)) throw new Error('CraftOS strings must use single-byte characters (U+0001–U+00FF)');
  return Buffer.from(value + '\0', 'latin1');
}

export function readCString(data: Buffer, offset: number): [string, number] {
  const end = data.indexOf(0, offset);
  if (end < 0) throw new Error('Unterminated protocol string');
  return [data.toString('latin1', offset, end), end + 1];
}

export function decodeOutput(data: Buffer) {
  if (data.length < 5 || data[2] !== 1) throw new Error('Unsupported output packet');
  const count = data.readUInt16LE(3);
  const records: { kind: 0 | 1; row: number; commandId?: string; text: string }[] = [];
  let offset = 5;
  for (let i = 0; i < count; i++) {
    if (offset + 3 > data.length) throw new Error('Truncated output record');
    const kind = data[offset], row = data.readUInt16LE(offset + 1);
    if (kind > 1 || row === 0) throw new Error('Invalid output record');
    const [commandId, next] = readCString(data, offset + 3);
    if (commandId && !/^[0-9a-f]{32}$/.test(commandId)) throw new Error('Invalid output command ID');
    offset = next;
    if (offset + 4 > data.length) throw new Error('Truncated output length');
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > 65535 || offset + length > data.length) throw new Error('Invalid output text length');
    records.push({ kind: kind as 0 | 1, row, commandId: commandId || undefined, text: data.toString('latin1', offset, offset + length) });
    offset += length;
  }
  if (offset !== data.length) throw new Error('Trailing output packet data');
  return records;
}

export function event(name: string, text?: string): Buffer {
  return Buffer.concat([Buffer.from([text === undefined ? 0 : 1]), cstring(name),
    ...(text === undefined ? [] : [Buffer.from([3]), cstring(text)])]);
}

export interface Screen {
  window: number;
  width: number;
  height: number;
  cursor: { x: number; y: number; blinking: boolean };
  lines: string[];
  foreground: string[];
  background: string[];
  updatedAt: string;
}

export function decodeScreen(data: Buffer): Screen {
  if (data.length < 16) throw new Error('Truncated screen header');
  if (data[2] !== 0) throw new Error('Only text-mode terminals are supported');
  const width = data.readUInt16LE(4), height = data.readUInt16LE(6);
  const cells = width * height;
  if (!cells || cells > 262144) throw new Error('Invalid terminal dimensions');
  let offset = 16;
  function unrle(): Buffer {
    const output = Buffer.alloc(cells);
    let used = 0;
    while (used < cells) {
      if (offset + 2 > data.length) throw new Error('Truncated screen data');
      const char = data[offset++], count = data[offset++];
      if (!count || used + count > cells) throw new Error('Invalid screen run length');
      output.fill(char, used, used + count);
      used += count;
    }
    return output;
  }
  const text = unrle(), colors = unrle();
  if (data.length !== offset + 48) throw new Error('Invalid terminal palette size');
  const lines: string[] = [], foreground: string[] = [], background: string[] = [];
  for (let y = 0; y < height; y++) {
    lines.push(text.toString('latin1', y * width, (y + 1) * width));
    const row = [...colors.subarray(y * width, (y + 1) * width)];
    foreground.push(row.map(c => (c & 15).toString(16)).join(''));
    background.push(row.map(c => (c >>> 4).toString(16)).join(''));
  }
  return { window: data[1], width, height, cursor: { x: data.readUInt16LE(8) + 1,
    y: data.readUInt16LE(10) + 1, blinking: !!data[3] }, lines, foreground, background,
    updatedAt: new Date().toISOString() };
}

// Raw mode uses legacy scan codes; rawterm translates them to CC: Tweaked keys.
export const keys: Record<string, number> = {
  enter: 28, backspace: 14, tab: 15, space: 57,
  up: 200, down: 208, left: 203, right: 205, home: 199, end: 207,
  pageUp: 201, pageDown: 209, insert: 210, delete: 211,
  leftCtrl: 29, rightCtrl: 157, leftShift: 42, rightShift: 54, leftAlt: 56, rightAlt: 184,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
};
