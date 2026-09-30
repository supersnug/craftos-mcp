import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { ConnectionProfiles } from '../src/profiles.js';
import { Session, Sessions } from '../src/session.js';
import { cstring, ENHANCED_SIGNATURE, FrameDecoder, packet, readCString } from '../src/protocol.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Reconnect timed out'); await delay(10); }
}

test('opted-in profiles restore into a new manager and explicit disconnect forgets them', async t => {
  const directory = await mkdtemp('/tmp/opencode/cc-profiles-');
  const store = new ConnectionProfiles(directory + '/connections.json');
  const first = new Sessions(store), second = new Sessions(store);
  t.after(async () => { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const result = first.connect('saved', 'ws://127.0.0.1:1/', 'test-token', 'enhanced', true);
  assert.match(result.installedCommand, /--reconnect$/);
  first.connect('temporary', 'ws://127.0.0.1:1/', 'temporary');
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).profiles.length, 1);
  first.close(); second.restore();
  assert.deepEqual(second.list().map(p => p.name), ['saved']);
  assert.equal(second.get('saved').status().reconnection.enabled, true);
  second.disconnect('saved');
  assert.deepEqual(store.load(), []);
});

for (const retainedFirst of [1, 4]) test(`reattachment restores completion/output without replay and reports retention gaps (${retainedFirst})`, async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const epoch = 'a'.repeat(32);
  let starts = 0, events = 0, commandId = '', oldClient = '', connections = 0;
  server.on('connection', socket => {
    connections++;
    let client = '';
    const decoder = new FrameDecoder();
    const scoped = (type: number, body: Buffer, scope = client) => socket.send(packet(79, 0, Buffer.concat([Buffer.from([1]), cstring(scope), Buffer.from([type, 0]), body])));
    socket.on('message', raw => {
      for (let data of decoder.push(raw.toString())) {
        if (data[0] === 78) {
          const [scope, offset] = readCString(data, 2);
          assert.equal(scope, client); data = data.subarray(offset);
        }
        if (data[0] === 6) socket.send(packet(6, 0, Buffer.concat([Buffer.from([0x82, 0xe1]), ENHANCED_SIGNATURE])));
        if (data[0] === 76) {
          client = JSON.parse(data.toString('ascii', 2)).client;
          socket.send(packet(77, 0, Buffer.from(JSON.stringify({ client, epoch, transport: 1, autoReconnect: true, first: commandId ? retainedFirst : 1, last: commandId ? retainedFirst : 0,
            commands: commandId ? [{ commandId, command64: Buffer.from('once').toString('base64'), state: 'finished' }] : [] }))));
          scoped(0, Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([32, 1, 0xf0, 1]), Buffer.alloc(48)]));
          if (oldClient && oldClient !== client) scoped(68, Buffer.concat([Buffer.from([1]), cstring(commandId), cstring('stale failure')]), oldClient);
        }
        if (data[0] === 82) {
          const after = data.readUInt32LE(3);
          const header = Buffer.alloc(14); header[1] = data[2]; header.writeUInt32LE(commandId ? retainedFirst : 1, 2);
          const hasBatch = !!commandId && after < retainedFirst;
          header.writeUInt32LE(hasBatch ? retainedFirst : 0, 6); header.writeUInt32LE(commandId ? retainedFirst : 0, 10);
          const text = Buffer.from('offline result');
          const length = Buffer.alloc(4); length.writeUInt32LE(text.length);
          const batch = Buffer.concat([Buffer.from([69, 0, 1, 1, 0, 0, 1, 0]), cstring(commandId), length, text]);
          scoped(83, Buffer.concat([header, hasBatch ? batch : Buffer.alloc(0)]));
        }
        if (data[0] === 66) {
          starts++; commandId = readCString(data, 4)[0]; oldClient = client;
          // The command completed, but its start acknowledgment was lost.
        }
        if (data[0] === 84) events++; // Lost event acknowledgment must never cause a replay.
      }
    });
  });
  const session = new Session('resume', `ws://127.0.0.1:${(server.address() as { port: number }).port}/token`, 80, true, 10);
  t.after(async () => { session.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await until(() => session.status().state === 'connected');
  await assert.rejects(session.exclusive(() => session.terminal('command', 'once', 0)), /timed out/);
  await until(() => connections > 1 && session.status().state === 'connected' && !session.status().reconnection.recoveringOutput);
  assert.equal((await session.commandStatus(commandId)).command.state, 'finished');
  assert.equal((await session.readOutput(undefined, commandId)).text, 'offline result\n');
  assert.equal((await session.readOutput(undefined, commandId)).truncated, retainedFirst > 1);
  assert.equal(starts, 1);
  const beforeEvent = connections;
  const firstEvent = session.exclusive(() => session.sendEvent('debug_test', [], 0));
  const queuedEvent = session.exclusive(() => session.sendEvent('queued_event', [], 0));
  const queuedRejected = assert.rejects(queuedEvent, /reconnecting|Connection changed/);
  await assert.rejects(firstEvent, /Debug event acknowledgment timed out/);
  await queuedRejected;
  await until(() => connections > beforeEvent && session.status().state === 'connected' && !session.status().reconnection.recoveringOutput);
  assert.equal(events, 1);
  const count = connections; session.close(); await delay(100); assert.equal(connections, count);
});
