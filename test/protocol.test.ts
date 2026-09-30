import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, decodeForeground, decodeScreen, FrameDecoder, packet, cstring } from '../src/protocol.js';
import { connectionDetails, encodeText } from '../src/session.js';

test('CRC32 agrees with the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('foreground packets validate state and distinguish prompt readiness from program input', () => {
  const make = (kind: string, ready: number, path = '', id = '') => Buffer.concat([
    Buffer.from([70, 0, 1, ready]), cstring(kind), cstring(path), cstring('work'), cstring(id),
  ]);
  const idle = decodeForeground(make('shell', 1));
  assert.equal(idle.prompt, 'idle');
  assert.equal(idle.workingDirectory, '/work');
  assert.equal(decodeForeground(make('shell', 0)).prompt, 'editing');
  const repl = decodeForeground(make('lua_repl', 0, 'rom/programs/lua.lua', 'a'.repeat(32)));
  assert.equal(repl.programName, 'lua.lua');
  assert.equal(repl.commandId, 'a'.repeat(32));
  assert.equal(repl.canRunCommand, false);
  assert.throws(() => decodeForeground(make('program', 1)), /Invalid foreground/);
  assert.throws(() => decodeForeground(make('invented', 0)), /Invalid foreground/);
  assert.throws(() => decodeForeground(make('program', 0, '', 'bad-id')), /Invalid foreground/);
  assert.throws(() => decodeForeground(make('shell', 1).subarray(0, -1)), /Unterminated/);
});

test('streaming frames accept fragmented and coalesced short/extended packets', () => {
  const decoder = new FrameDecoder();
  const bytes = Buffer.alloc(80000, 0xab);
  const frames = packet(6, 0, Buffer.from([6, 0])) + packet(9, 0, bytes);
  const output: Buffer[] = [];
  for (let i = 0; i < frames.length; i += 137) output.push(...decoder.push(frames.slice(i, i + 137)));
  assert.deepEqual(output, [Buffer.from([6, 0, 6, 0]), Buffer.concat([Buffer.from([9, 0]), bytes])]);
  assert.match(packet(9, 0, bytes), /^!CPD/);
});

test('reject corrupt, oversized, or malformed frames', () => {
  const frame = packet(6, 0, Buffer.from([6, 0]));
  assert.throws(() => new FrameDecoder().push(frame.slice(0, -9) + '00000000\n'), /checksum/);
  assert.throws(() => new FrameDecoder().push('!CPDffffffffffff'), /size/);
  assert.throws(() => new FrameDecoder().push('!CPCzzzz'), /length/);
  assert.throws(() => new FrameDecoder().push('oops'), /prefix/);
});

test('decode stock text screen layout, colors, and one-based cursor', () => {
  const header = Buffer.from([0, 0, 0, 1, 3, 0, 2, 0, 2, 0, 1, 0, 0, 0, 0, 0]);
  const screen = decodeScreen(Buffer.concat([header, Buffer.from([65, 3, 66, 3, 0xf0, 6]), Buffer.alloc(48)]));
  assert.deepEqual(screen.lines, ['AAA', 'BBB']);
  assert.deepEqual(screen.foreground, ['000', '000']);
  assert.deepEqual(screen.background, ['fff', 'fff']);
  assert.deepEqual(screen.cursor, { x: 3, y: 2, blinking: true });
  assert.throws(() => decodeScreen(Buffer.concat([header, Buffer.from([65, 7]), Buffer.alloc(48)])), /run length/);
});

test('connection command uses the stock script and validates tokens/relay URLs', () => {
  assert.deepEqual(connectionDetails('wss://remote.craftos-pc.cc', 'abc_123'), {
    websocket: 'wss://remote.craftos-pc.cc/abc_123',
    command: 'wget run https://remote.craftos-pc.cc/server.lua abc_123',
    enhancedCommand: 'wget run https://raw.githubusercontent.com/supersnug/craftos-mcp/main/lua/cc-mcp.lua abc_123 wss://remote.craftos-pc.cc/',
    installedCommand: '/cc-mcp.lua abc_123 wss://remote.craftos-pc.cc/',
  });
  assert.throws(() => connectionDetails('https://example.com'), /Relay/);
  assert.throws(() => connectionDetails('ws://localhost/', 'x y'), /token/);
  assert.throws(() => connectionDetails('ws://user:password@localhost/'), /Relay/);
  assert.throws(() => cstring('bad\0path'), /NUL/);
  assert.throws(() => encodeText('🐢'), /single-byte/);
  assert.deepEqual(encodeText('\0ÿ'), Buffer.from([0, 255]));
});
