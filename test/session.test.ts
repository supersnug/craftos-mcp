import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { Session } from '../src/session.js';
import { cstring, ENHANCED_SIGNATURE, FrameDecoder, packet, readCString } from '../src/protocol.js';

async function waitFor(check: () => boolean, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out');
    await delay(10);
  }
}

async function fixture(t: TestContext, timeout = 1000, enhanced = false, tracking = false, interrupts = false, safeWrites = false) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const packets: Buffer[] = [];
  let peer: WebSocket;
  server.on('connection', socket => {
    peer = socket;
    const decoder = new FrameDecoder();
    socket.on('message', message => {
      for (const data of decoder.push(message.toString())) {
        packets.push(data);
        if (data[0] === 6) {
          socket.send(packet(6, 0, enhanced ? Buffer.concat([Buffer.from([2, (tracking ? 0xc0 : 0x80) | (interrupts ? 8 : 0) | (safeWrites ? 4 : 0)]), ENHANCED_SIGNATURE]) : Buffer.from([2, 0])));
          const header = Buffer.from([0, 1, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          socket.send(packet(0, 0, Buffer.concat([header, Buffer.from([62, 1, 32, 2, 0xf0, 3]), Buffer.alloc(48)])));
        }
      }
    });
  });
  const session = new Session('test', `ws://127.0.0.1:${(address as { port: number }).port}/token`, timeout);
  assert.equal(session.status().mode, 'negotiating');
  assert.equal(session.status().warning, undefined);
  assert.equal(session.status().limits, null);
  t.after(async () => {
    session.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await waitFor(() => session.status().state === 'connected');
  return { session, packets, peer: peer! };
}

test('terminal sends paste then Enter; interrupt sends terminate; disconnect marks cached screen stale', async t => {
  const { session, packets, peer } = await fixture(t);
  assert.equal(session.status().mode, 'compatibility');
  assert.equal(session.status().foreground.supported, false);
  assert.equal(session.status().identity.supported, false);
  assert.equal(session.status().identity.stale, true);
  assert.equal(session.status().foreground.kind, 'unknown');
  assert.equal(session.status().foreground.canRunCommand, false);
  assert.match(session.status().warning!, /^Entering compatibility mode…/);
  assert.equal(session.status().limits!.readBytes, 8192);
  await session.terminal('command', 'lua', 0);
  await waitFor(() => packets.filter(p => p[0] === 1).length === 2);
  assert.deepEqual(packets.find(p => p[0] === 3), Buffer.from([3, 0, 1, ...Buffer.from('paste\0'), 3, ...Buffer.from('lua\0')]));
  assert.deepEqual(packets.filter(p => p[0] === 1), [Buffer.from([1, 0, 28, 0]), Buffer.from([1, 0, 28, 1])]);
  await session.terminal('interrupt', '', 0);
  await waitFor(() => packets.filter(p => p[0] === 3).length === 2);
  assert.deepEqual(packets.filter(p => p[0] === 3)[1], Buffer.from([3, 0, 0, ...Buffer.from('terminate\0')]));
  peer.close();
  await waitFor(() => session.status().state === 'disconnected');
  assert.equal(session.snapshot().stale, true);
  assert.ok(session.snapshot().screen);
  await assert.rejects(session.terminal('command', 'lua', 0), /disconnected/);
});

test('filesystem timeout closes the connection without retrying or reusing IDs', async t => {
  const { session, packets } = await fixture(t, 50);
  await assert.rejects(session.read('/file'), /timed out.*outcome may be unknown/);
  assert.equal(session.status().state, 'disconnected');
  assert.equal(packets.filter(p => p[0] === 7).length, 1);
});

test('connection loss rejects an outstanding file operation promptly', async t => {
  const { session, peer, packets } = await fixture(t);
  const operation = session.read('/file');
  const rejection = assert.rejects(operation, /closed.*outcome may be unknown/);
  await waitFor(() => packets.some(p => p[0] === 7));
  peer.close();
  await rejection;
});

test('malformed remote packets close the session without crashing the server', async t => {
  const { session, peer } = await fixture(t);
  peer.send('invalid');
  await waitFor(() => session.status().state === 'disconnected');
  assert.match(session.status().reason!, /Protocol error/);
});

test('writes use acknowledged 4 KiB chunks followed by append requests', async t => {
  const { session, peer, packets } = await fixture(t);
  const decoder = new FrameDecoder();
  const chunks: Buffer[] = [];
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] === 9) {
        chunks.push(data.subarray(8));
        peer.send(packet(8, 0, Buffer.from([17, data[3], 0])));
      }
    }
  });
  const content = Buffer.alloc(9000, 0xae);
  assert.equal((await session.write('/large', content)).bytesWritten, 9000);
  assert.deepEqual(packets.filter(p => p[0] === 7).map(p => p[2]), [21, 23, 23]);
  assert.deepEqual(chunks.map(chunk => chunk.length), [4096, 4096, 808]);
  assert.deepEqual(Buffer.concat(chunks), content);
});

test('oversized reads are refused before requesting contents and preserve the session', async t => {
  const { session, peer, packets } = await fixture(t);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] === 7 && data[2] === 3) {
        const response = Buffer.alloc(6);
        response[0] = 3;
        response[1] = data[3];
        response.writeUInt32LE(8193, 2);
        peer.send(packet(8, 0, response));
      }
    }
  });
  await assert.rejects(session.read('/large'), /8 KiB/);
  assert.equal(packets.filter(p => p[0] === 7).length, 1);
  assert.equal(session.status().state, 'connected');
});

test('stock and older enhanced peers reject protected mutations before sending file requests', async t => {
  for (const enhanced of [false, true]) {
    const { session, packets } = await fixture(t, 1000, enhanced);
    await assert.rejects(session.edit('/file', 'old', 'new', '0'.repeat(64)), /updated enhanced launcher/);
    await assert.rejects(session.write('/file', Buffer.from('new'), '0'.repeat(64)), /updated enhanced launcher/);
    await assert.rejects(session.write('/file', Buffer.from('new'), undefined, true), /updated enhanced launcher/);
    assert.equal(session.status().fileSafety.conditionalWrites, false);
    assert.throws(() => session.requireSyncReady(), /directorySync/);
    await assert.rejects(session.sendEvent('debug', [], 0), /updated enhanced launcher/);
    assert.equal(packets.filter(p => p[0] !== 6).length, 0);
  }
});

test('uncertain staged uploads and commits retain their IDs without abort, replay, or legacy fallback', async t => {
  for (const stopAt of ['chunk', 'commit']) {
    const { session, peer, packets } = await fixture(t, 50, true, false, false, true);
    const decoder = new FrameDecoder();
    const operations: string[] = [];
    let transactionId = '';
    peer.on('message', message => {
      for (const data of decoder.push(message.toString())) {
        if (data[0] !== 73 && data[0] !== 75) continue;
        const request = data[0] === 73 ? JSON.parse(data.toString('ascii', 3)) : { op: 'chunk' };
        operations.push(request.op);
        if (request.op === 'begin') transactionId = request.id;
        if (request.op !== stopAt) peer.send(packet(74, 0, Buffer.concat([
          Buffer.from([0, data[2]]), Buffer.from(JSON.stringify({ outcome: request.op === 'begin' ? 'ready' : 'uploaded' })),
        ])));
      }
    });
    await assert.rejects(session.write('/file', Buffer.from('new')), error => {
      assert.match(String(error), /timed out.*outcome may be unknown/);
      assert.ok(String(error).includes(`transactionId: ${transactionId}`));
      return true;
    });
    assert.deepEqual(operations, stopAt === 'chunk' ? ['begin', 'chunk'] : ['begin', 'chunk', 'commit']);
    assert.equal(session.status().state, 'disconnected');
    assert.equal(packets.filter(p => p[0] === 7 || p[0] === 9).length, 0);
  }
});

test('enhanced capabilities allow chunked binary reads with no stock warning', async t => {
  const { session, peer, packets } = await fixture(t, 1000, true);
  assert.equal(session.status().mode, 'enhanced');
  assert.equal(session.status().warning, undefined);
  assert.equal(session.status().limits!.editBytes, 0);
  const content = Buffer.alloc(10000, 0xff);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] !== 64) continue;
      assert.equal(data[2], 1);
      const offset = data.readUInt32LE(4), length = data.readUInt16LE(8);
      const header = Buffer.alloc(10);
      header[1] = data[3];
      header.writeUInt32LE(content.length, 2);
      header.writeUInt32LE(offset, 6);
      peer.send(packet(65, 0, Buffer.concat([header, content.subarray(offset, offset + length)])));
    }
  });
  assert.deepEqual(await session.read('/binary'), content);
  assert.deepEqual(packets.filter(p => p[0] === 64).map(p => p.readUInt32LE(4)), [0, 4096, 8192]);
  assert.equal(packets.filter(p => p[0] === 7).length, 0);
});

test('enhanced timeout is an error, never a downgrade or stock retry', async t => {
  const { session, packets } = await fixture(t, 50, true);
  await assert.rejects(session.read('/file'), /timed out/);
  assert.equal(session.status().mode, 'enhanced');
  assert.equal(session.status().warning, undefined);
  assert.equal(session.status().state, 'disconnected');
  assert.equal(packets.filter(p => p[0] === 64).length, 1);
  assert.equal(packets.filter(p => p[0] === 7).length, 0);
});

test('changed or incompatible enhanced capabilities cannot silently fall back', async t => {
  const { session, peer } = await fixture(t, 1000, true);
  peer.send(packet(6, 0, Buffer.from([2, 0])));
  await waitFor(() => session.status().state === 'disconnected');
  assert.match(session.status().reason!, /capabilities changed/);
  assert.equal(session.status().mode, 'enhanced');
  assert.equal(session.status().warning, undefined);
});

test('unsupported enhanced protocol version is rejected', async t => {
  const { session, peer } = await fixture(t, 1000, true);
  peer.send(packet(6, 0, Buffer.concat([Buffer.from([2, 0x80]), Buffer.from('CCMCP/99\0')])));
  await waitFor(() => session.status().state === 'disconnected');
  assert.match(session.status().reason!, /Unsupported enhanced protocol version/);
});

test('enhanced file size changes are detected between chunks', async t => {
  const { session, peer } = await fixture(t, 1000, true);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] !== 64) continue;
      const offset = data.readUInt32LE(4);
      const header = Buffer.alloc(10);
      header[1] = data[3];
      header.writeUInt32LE(offset === 0 ? 8192 : 8193, 2);
      header.writeUInt32LE(offset, 6);
      peer.send(packet(65, 0, Buffer.concat([header, Buffer.alloc(4096)])));
    }
  });
  await assert.rejects(session.read('/changing'), /File changed during reading/);
  assert.equal(session.status().mode, 'enhanced');
});

test('command completion arriving with acknowledgment is retained as finished', async t => {
  const { session, peer, packets } = await fixture(t, 1000, true, true);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] !== 66) continue;
      const [id] = readCString(data, 4);
      peer.send(packet(67, 0, Buffer.concat([Buffer.from([0, data[3]]), cstring(id)]))
        + packet(68, 0, Buffer.concat([Buffer.from([0]), cstring(id), cstring('')])));
    }
  });
  const result = await session.terminal('command', 'hello', 0);
  assert.equal(result.commandCompletion, 'finished');
  assert.ok('commandId' in result && typeof result.commandId === 'string');
  const status = await session.commandStatus(result.commandId);
  assert.equal(status.command.success, true);
  peer.close();
  await waitFor(() => session.status().state === 'disconnected');
  assert.equal((await session.commandStatus(result.commandId)).command.state, 'finished');
  assert.equal(packets.filter(p => p[0] === 3 || p[0] === 1).length, 0, 'Tracked starts must not type into the terminal');
});

test('busy rejection is returned without falling back to terminal input', async t => {
  const { session, peer, packets } = await fixture(t, 1000, true, true);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] === 66) peer.send(packet(67, 0, Buffer.concat([Buffer.from([1, data[3]]), cstring('Foreground is not an idle shell prompt')])));
    }
  });
  await assert.rejects(session.terminal('command', 'hello', 0), /not an idle shell/);
  assert.equal(packets.filter(p => p[0] === 3 || p[0] === 1).length, 0);
  assert.equal(session.status().state, 'connected');
});

test('disconnect after acceptance makes a running command unknown', async t => {
  const { session, peer, packets } = await fixture(t, 1000, true, true);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] === 66) peer.send(packet(67, 0, Buffer.concat([Buffer.from([0, data[3]]), cstring(readCString(data, 4)[0])])));
    }
  });
  const result = await session.terminal('command', 'long-program', 0);
  assert.equal(result.commandCompletion, 'running');
  assert.ok('commandId' in result && typeof result.commandId === 'string');
  await assert.rejects(session.terminal('command', 'another-program', 0), /not an idle shell/);
  assert.equal(packets.filter(p => p[0] === 66).length, 1, 'Do not queue another start behind a potentially non-yielding program');
  peer.close();
  await waitFor(() => session.status().state === 'disconnected');
  const status = await session.commandStatus(result.commandId);
  assert.equal(status.command.state, 'unknown');
  assert.equal(status.command.success, undefined);
  assert.match(status.command.reason!, /completion was not observed/);
});

test('lost start acknowledgment preserves an unknown command ID without retry', async t => {
  const { session, packets } = await fixture(t, 50, true, true);
  let id = '';
  await assert.rejects(session.terminal('command', 'side-effect', 0), error => {
    assert.match(String(error), /timed out/);
    id = String(error).match(/commandId: ([0-9a-f]{32})/)![1];
    return true;
  });
  assert.equal((await session.commandStatus(id)).command.state, 'unknown');
  assert.equal(packets.filter(p => p[0] === 66).length, 1);
  assert.equal(packets.filter(p => p[0] === 3).length, 0);
});

test('older enhanced launchers keep snapshot-only command behavior', async t => {
  const { session, packets } = await fixture(t, 1000, true);
  assert.equal(session.status().capabilities.commandTracking, false);
  assert.equal(session.status().capabilities.outputCapture, false);
  assert.equal(session.status().capabilities.foregroundAwareness, false);
  assert.equal(session.status().foreground.kind, 'unknown');
  assert.equal((await session.readOutput()).supported, false);
  const result = await session.terminal('command', 'hello', 0);
  assert.equal(result.commandCompletion, 'unknown');
  await waitFor(() => packets.some(p => p[0] === 3));
  assert.equal(packets.filter(p => p[0] === 66).length, 0);
});

test('old peers cannot silently downgrade force or targeted interruption', async t => {
  const { session, packets } = await fixture(t);
  await assert.rejects(session.interrupt('force'), /updated enhanced launcher/);
  await assert.rejects(session.interrupt('graceful', 'a'.repeat(32)), /updated enhanced launcher/);
  assert.equal(packets.filter(packet => packet[0] === 3 || packet[0] === 71).length, 0);
  const result = await session.interrupt('graceful', undefined, 0);
  assert.equal(result.interruption.reliable, false);
  assert.equal(result.interruption.outcome, 'unknown');
});

test('interrupt timeout closes the session without retry or terminate fallback', async t => {
  const { session, packets } = await fixture(t, 50, true, true, true);
  await assert.rejects(session.interrupt('force'), /Interrupt acknowledgment timed out/);
  assert.equal(session.status().state, 'disconnected');
  assert.equal(packets.filter(packet => packet[0] === 71).length, 1);
  assert.equal(packets.filter(packet => packet[0] === 3).length, 0);
});

test('enhanced interruption returns an explicit idle no-op', async t => {
  const { session, peer } = await fixture(t, 1000, true, true, true);
  const decoder = new FrameDecoder();
  peer.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] === 71) peer.send(packet(72, 0, Buffer.concat([Buffer.from([0, data[3]]), cstring('idle'), cstring('')])));
    }
  });
  assert.equal((await session.interrupt('graceful', undefined, 0)).interruption.outcome, 'idle');
  assert.equal(session.status().state, 'connected');
});

function monitorAnnouncement(id: number, name: string, width = 4, height = 2) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(width, 2);
  header.writeUInt16LE(height, 4);
  return packet(4, id, Buffer.concat([header, cstring(`ComputerCraft Remote Terminal: Monitor ${name}`)]));
}

function monitorScreen(id: number, width = 4, height = 2) {
  const header = Buffer.alloc(14);
  header[1] = 1;
  header.writeUInt16LE(width, 2);
  header.writeUInt16LE(height, 4);
  header.writeUInt16LE(1, 6);
  header.writeUInt16LE(1, 8);
  return packet(0, id, Buffer.concat([header, Buffer.from([65, width * height, 0xb4, width * height]), Buffer.alloc(48)]));
}

test('mouse events encode exact button, scroll and cell fields without adding events', async t => {
  const { session, packets } = await fixture(t);
  await session.mouse('mouse_click', 1, 1, 'left', undefined, 0);
  await session.mouse('mouse_drag', 2, 1, 'right', undefined, 0);
  await session.mouse('mouse_up', 3, 1, 'middle', undefined, 0);
  await session.mouse('mouse_scroll', 1, 1, undefined, 'up', 0);
  await session.mouse('mouse_scroll', 1, 1, undefined, 'down', 0);
  await waitFor(() => packets.filter(p => p[0] === 2).length === 5);
  assert.deepEqual(packets.filter(p => p[0] === 2).map(p => [p[1], p[2], p[3], p.readUInt32LE(4), p.readUInt32LE(8)]),
    [[0, 0, 1, 1, 1], [0, 3, 2, 2, 1], [0, 1, 3, 3, 1], [0, 2, 0, 1, 1], [0, 2, 1, 1, 1]]);
  for (const [x, y] of [[0, 1], [4, 1], [1, 2], [1.5, 1]]) await assert.rejects(session.mouse('mouse_click', x, y, 'left', undefined, 0), /Coordinates/);
  await assert.rejects(session.mouse('mouse_scroll', 1, 1, 'left', 'up', 0), /requires direction/);
  await assert.rejects(session.mouse('mouse_up', 1, 1, undefined, undefined, 0), /require button/);
  session.close();
  await assert.rejects(session.mouse('mouse_click', 1, 1, 'left', undefined, 0), /disconnected/);
  assert.equal(packets.filter(p => p[0] === 2).length, 5);
});

test('monitor touches require a unique current screen and target its advertised window', async t => {
  const { session, peer, packets } = await fixture(t);
  const touch = () => session.mouse('mouse_click', 4, 2, 'left', undefined, 0, 'monitor_12');
  await assert.rejects(touch(), /advertised/);
  peer.send(monitorAnnouncement(3, 'monitor_12'));
  await waitFor(() => session.status().windows.length === 1);
  await assert.rejects(touch(), /current usable screen/);
  peer.send(monitorScreen(3));
  await waitFor(() => !session.snapshot(3).stale);
  assert.equal((await touch()).input.event, 'monitor_touch');
  await waitFor(() => packets.some(p => p[0] === 2));
  const data = packets.find(p => p[0] === 2)!;
  assert.deepEqual([data[1], data[2], data[3], data.readUInt32LE(4), data.readUInt32LE(8)], [3, 0, 1, 4, 2]);
  peer.send(monitorAnnouncement(3, 'monitor_12', 6, 2));
  await waitFor(() => session.snapshot(3).stale);
  await assert.rejects(touch(), /current usable screen/);
  peer.send(monitorAnnouncement(4, 'monitor_12'));
  await waitFor(() => session.status().windows.length === 2);
  await assert.rejects(touch(), /unambiguous/);
  assert.equal(packets.filter(p => p[0] === 2).length, 1);
});

test('named stock monitors expose text, colors and cursor; resize and disconnect are explicit', async t => {
  const { session, peer } = await fixture(t);
  peer.send(monitorAnnouncement(3, 'monitor_12'));
  await waitFor(() => session.status().windows.some(window => window.monitor === 'monitor_12'));
  const pending = await session.readMonitor('monitor_12');
  assert.equal(pending.availability, 'waiting_for_frame');
  assert.equal(pending.screen, null);
  assert.equal(pending.stale, true);
  peer.send(monitorScreen(3));
  await waitFor(() => session.snapshot(3).availability === 'ready');
  const ready = await session.readMonitor('monitor_12');
  assert.equal(ready.window, 3);
  assert.equal(ready.stale, false);
  assert.deepEqual(ready.screen!.lines, ['AAAA', 'AAAA']);
  assert.deepEqual(ready.screen!.foreground, ['4444', '4444']);
  assert.deepEqual(ready.screen!.background, ['bbbb', 'bbbb']);
  assert.deepEqual(ready.screen!.cursor, { x: 2, y: 2, blinking: true });
  peer.send(monitorAnnouncement(3, 'monitor_12', 6, 2));
  await waitFor(() => session.snapshot(3).availability === 'waiting_for_resize');
  assert.equal((await session.readMonitor('monitor_12')).stale, true);
  peer.send(monitorScreen(3, 6, 2));
  await waitFor(() => session.snapshot(3).availability === 'ready');
  assert.equal((await session.readMonitor('monitor_12')).screen!.width, 6);
  peer.close();
  await waitFor(() => session.status().state === 'disconnected');
  const stale = await session.readMonitor('monitor_12');
  assert.equal(stale.availability, 'disconnected');
  assert.equal(stale.stale, true);
  assert.equal(stale.screen!.width, 6);
});

test('detached monitors cannot leak their cached screen into a reused window ID', async t => {
  const { session, peer } = await fixture(t, 1000, true);
  peer.send(monitorAnnouncement(1, 'left') + monitorScreen(1));
  await waitFor(() => !!session.snapshot(1).screen);
  peer.send(packet(4, 1, Buffer.from([1, 0, 0, 0, 0, 0, 0])));
  await waitFor(() => session.status().windows.length === 0);
  await assert.rejects(session.readMonitor('left'), /not currently advertised/);
  assert.equal(session.status().state, 'connected');
  peer.send(monitorAnnouncement(1, 'right'));
  await waitFor(() => session.status().windows.some(window => window.monitor === 'right'));
  assert.equal((await session.readMonitor('right')).screen, null);
  await assert.rejects(session.readMonitor('left'), /Available monitors: right/);
});

test('malformed monitor frames are isolated from the main terminal and recover on a valid frame', async t => {
  const { session, peer } = await fixture(t);
  peer.send(monitorAnnouncement(1, 'left') + monitorScreen(1));
  await waitFor(() => !!session.snapshot(1).screen);
  peer.send(packet(0, 1, Buffer.from([0])));
  await waitFor(() => session.snapshot(1).availability === 'invalid_frame');
  assert.equal(session.status().state, 'connected');
  assert.equal((await session.readMonitor('left')).stale, true);
  peer.send(monitorScreen(1, 7, 2));
  await waitFor(() => session.snapshot(1).availability === 'ready');
  assert.equal((await session.readMonitor('left')).screen!.width, 7);
});
