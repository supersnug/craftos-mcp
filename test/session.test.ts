import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { Session } from '../src/session.js';
import { ENHANCED_SIGNATURE, FrameDecoder, packet } from '../src/protocol.js';

async function waitFor(check: () => boolean, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out');
    await delay(10);
  }
}

async function fixture(t: TestContext, timeout = 1000, enhanced = false) {
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
          socket.send(packet(6, 0, enhanced ? Buffer.concat([Buffer.from([2, 0x80]), ENHANCED_SIGNATURE]) : Buffer.from([2, 0])));
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
  assert.deepEqual(await session.write('/large', content), { path: '/large', bytesWritten: 9000 });
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

test('enhanced capabilities allow chunked binary reads with no stock warning', async t => {
  const { session, peer, packets } = await fixture(t, 1000, true);
  assert.equal(session.status().mode, 'enhanced');
  assert.equal(session.status().warning, undefined);
  assert.equal(session.status().limits!.editBytes, 1048576);
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
