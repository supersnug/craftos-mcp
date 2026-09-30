import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeIdentity } from '../src/identity.js';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Session } from '../src/session.js';
import { cstring, ENHANCED_SIGNATURE, FrameDecoder, packet, readCString } from '../src/protocol.js';

const b64 = (value: string) => Buffer.from(value, 'latin1').toString('base64');
const wire = () => ({ computerId: 42, label64: b64('Workshop\xff'), craftos64: b64('CraftOS 1.9'), host64: false,
  kind: 'turtle', color: true, peripherals: [{ name64: b64('energy_detector_0'), types64: [b64('energyDetector'), b64('energy_storage')],
    methods64: [b64('getTransferRate'), b64('setTransferRateLimit')], truncated: false }], totalPeripherals: 1, truncated: false });

test('identity preserves labels and generic modded peripheral names, types and methods', () => {
  const result = decodeIdentity(Buffer.from(JSON.stringify(wire())));
  assert.equal(result.computerId, 42);
  assert.equal(result.label, 'Workshop\xff');
  assert.equal(result.host, null);
  assert.equal(result.isTurtle, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.peripherals[0], { name: 'energy_detector_0', types: ['energyDetector', 'energy_storage'],
    methods: ['getTransferRate', 'setTransferRateLimit'], truncated: false, error: undefined });
});

test('identity validates bounds, duplicate names, unavailable labels and truncation', () => {
  const data = { ...wire(), label64: false, peripherals: [], totalPeripherals: 10 };
  assert.equal(decodeIdentity(Buffer.from(JSON.stringify(data))).label, null);
  assert.equal(decodeIdentity(Buffer.from(JSON.stringify(data))).truncated, true);
  const duplicate = wire(); duplicate.peripherals.push(duplicate.peripherals[0]); duplicate.totalPeripherals = 2;
  assert.throws(() => decodeIdentity(Buffer.from(JSON.stringify(duplicate))), /Duplicate/);
  assert.throws(() => decodeIdentity(Buffer.alloc(32769)), /Oversized/);
  assert.throws(() => decodeIdentity(Buffer.from(JSON.stringify({ ...wire(), computerId: -1 }))));
});

test('identity refreshes without screen changes and retains stale data on inspection failure', { timeout: 15000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let requests = 0;
  server.on('connection', socket => {
    let client = '';
    const decoder = new FrameDecoder();
    const scoped = (type: number, body: Buffer) => socket.send(packet(79, 0,
      Buffer.concat([Buffer.from([1]), cstring(client), Buffer.from([type, 0]), body])));
    socket.on('message', raw => {
      for (let data of decoder.push(raw.toString())) {
        if (data[0] === 78) {
          const [scope, offset] = readCString(data, 2);
          assert.equal(scope, client); data = data.subarray(offset);
        }
        if (data[0] === 6) socket.send(packet(6, 0, Buffer.concat([Buffer.from([0x42, 0x81]), ENHANCED_SIGNATURE])));
        if (data[0] === 76) {
          const attaching = !client;
          client = JSON.parse(data.toString('ascii', 2)).client;
          socket.send(packet(77, 0, Buffer.from(JSON.stringify({ client, epoch: 'a'.repeat(32), transport: 1, first: 1, last: 0, commands: [] }))));
          if (attaching) scoped(0, Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([32, 1, 0xf0, 1]), Buffer.alloc(48)]));
        }
        if (data[0] === 82) {
          const response = Buffer.alloc(14); response[1] = data[2]; response.writeUInt32LE(1, 2);
          scoped(83, response);
        }
        if (data[0] === 86) {
          requests++;
          scoped(87, Buffer.concat([Buffer.from([0, data[2]]), Buffer.from(JSON.stringify(requests === 1 ? wire() : { invalid: true }))]));
        }
      }
    });
  });
  const session = new Session('identity', `ws://127.0.0.1:${(server.address() as { port: number }).port}/test`, 1000);
  t.after(async () => {
    session.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const deadline = Date.now() + 13000;
  while (session.status().identity.stale) { assert.ok(Date.now() < deadline); await delay(10); }
  const observedAt = session.status().identity.observedAt;
  assert.equal(session.status().identity.computerId, 42);
  while (!session.status().identity.error) { assert.ok(Date.now() < deadline); await delay(10); }
  assert.equal(requests, 2);
  assert.equal(session.status().state, 'connected');
  assert.equal(session.status().identity.stale, true);
  assert.equal(session.status().identity.observedAt, observedAt);
  assert.equal(session.status().identity.label, 'Workshop\xff');
});
