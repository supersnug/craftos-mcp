import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { fileHash, Session } from '../src/session.js';
import { cstring, packet } from '../src/protocol.js';

for (const reconnect of [false, true]) test(`launcher remains responsive after scrolling output and remote-only outages (reconnect=${reconnect})`, {
  skip: process.env.RUN_STOCK_INTEGRATION !== '1', timeout: 120000,
}, async t => {
  const sources = new Map<string, string>();
  const hashes = { 'server.lua': '43972e815ca2aee38fca03c9293daf2212496597', 'rawterm.lua': 'e62ac11c14df4222ffe2e492a40eaf78a0397712', 'string_pack.lua': 'c46cd334c47a3fa2c2478ee977982e73773cc2c8' };
  for (const [file, hash] of Object.entries(hashes)) {
    const response = await fetch(`https://raw.githubusercontent.com/MCJack123/remote.craftos-pc.cc/master/${file}`, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), hash);
    sources.set('/' + file, bytes.toString());
  }
  sources.set('/cc-mcp.lua', await readFile(new URL('../lua/cc-mcp.lua', import.meta.url), 'utf8'));
  let relay = '', remote: import('ws').WebSocket | undefined;
  const http = createServer((req, res) => {
    const source = sources.get(req.url ?? '');
    if (!source) { res.writeHead(404).end(); return; }
    res.end(source.replace('${URL}', relay).replace('[[${SIZE}]]', String(Buffer.byteLength(sources.get('/rawterm.lua')!))));
  });
  const sockets = new WebSocketServer({ server: http });
  sockets.on('connection', (socket, request) => {
    if (request.headers['x-rawterm-is-server']) remote = socket;
    socket.on('message', data => {
      for (const peer of sockets.clients) if (peer !== socket && peer.readyState === 1) peer.send(data);
    });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  relay = `ws://127.0.0.1:${(http.address() as { port: number }).port}/`;
  const directory = await mkdtemp('/tmp/opencode/cc-resident-');
  const session = new Session('test', relay + 'test', 5000, true, 10);
  const computer = spawn(process.env.CRAFTOS_BIN ?? 'craftos', ['--raw', '--directory', directory, '--exec',
    `settings.set("bios.use_multishell",false); periphemu.create("left","monitor"); periphemu.create("back","monitor"); shell.run("wget run ${relay.replace(/^ws/, 'http')}cc-mcp.lua test ${relay}${reconnect ? ' --reconnect' : ''}")`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  computer.stdout.on('data', data => { output = (output + data).slice(-2000); });
  computer.stderr.on('data', data => { output = (output + data).slice(-2000); });
  const exited = once(computer, 'exit');
  t.after(async () => {
    session.close(); if (computer.exitCode === null && computer.signalCode === null) computer.kill('SIGKILL'); await exited;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function until(check: () => boolean | Promise<boolean>, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (!await check()) { assert.ok(Date.now() < deadline, JSON.stringify(session.status()) + output); await delay(10); }
  }
  await until(() => session.status().state === 'connected');
  await until(() => !session.status().identity.stale);
  const identity = session.status().identity;
  assert.equal(identity.computerId, 0);
  assert.equal(identity.label, null);
  assert.equal(identity.kind, 'computer');
  assert.equal(identity.isTurtle, false);
  assert.equal(identity.color, true);
  assert.match(identity.craftosVersion!, /^CraftOS/);
  assert.ok(identity.peripherals!.find(p => p.name === 'left')!.types.includes('monitor'));
  assert.ok(identity.peripherals!.find(p => p.name === 'left')!.methods.includes('write'));
  await session.write('/identity-change.lua', Buffer.from([
    'os.setComputerLabel("Updated label"); assert(periphemu.create("right","monitor")); sleep(0.1); periphemu.remove("back")',
    // A synthetic standard-API device tests modded/wired naming and multiple types.
    'local names,types,methods=peripheral.getNames,peripheral.getType,peripheral.getMethods',
    'peripheral.getNames=function() local result=names(); result[#result+1]="energy_detector_0"; return result end',
    'peripheral.getType=function(name) if name=="energy_detector_0" then return "energyDetector","energy_storage" end; return types(name) end',
    'peripheral.getMethods=function(name) if name=="energy_detector_0" then return {"getTransferRate","setTransferRateLimit"} end; return methods(name) end',
    'while true do os.pullEvent("key") end',
  ].join('\n')));
  const inspecting = await session.exclusive(() => session.terminal('command', 'identity-change', 100));
  assert.ok('commandId' in inspecting);
  await until(() => session.status().identity.label === 'Updated label' && session.status().identity.peripherals!.some(p => p.name === 'right') && !session.status().identity.peripherals!.some(p => p.name === 'back'));
  assert.equal((await session.commandStatus(inspecting.commandId)).command.state, 'running');
  const modded = session.status().identity.peripherals!.find(p => p.name === 'energy_detector_0')!;
  assert.deepEqual(modded.types, ['energyDetector', 'energy_storage']);
  assert.deepEqual(modded.methods, ['getTransferRate', 'setTransferRateLimit']);
  await session.exclusive(() => session.interrupt('force', inspecting.commandId, 100));
  const large = Buffer.alloc(1024 * 1024, 97);
  await session.exclusive(() => session.write('/large', large));
  assert.deepEqual(await session.exclusive(() => session.read('/large')), large);
  await session.exclusive(() => session.write('/large', Buffer.alloc(large.length, 98), fileHash(large)));
  await session.write('/logs.lua', Buffer.from('for i=1,120 do print("LOG_"..i) end'));
  for (let i = 0; i < 5; i++) {
    const started = await session.exclusive(() => session.terminal('command', 'logs', 0));
    assert.ok('commandId' in started);
    await until(async () => (await session.commandStatus(started.commandId)).command.state === 'finished');
    await session.exclusive(() => session.write('/after', Buffer.from(String(i))));
    assert.equal((await session.read('/after')).toString(), String(i));
  }
  assert.equal(session.status().capabilities.debugEvents, true);
  await assert.rejects(session.sendEvent('debug', [], 0), /No foreground program/);
  await session.write('/debug.lua', Buffer.from([
    'local e=table.pack(os.pullEvent("debug_values"))',
    'assert(e.n==7 and e[2]==nil and e[3]==string.char(0,255) and e[4]==1.5 and e[5]==false)',
    'assert(e[6].items[1]==1 and e[6].items[2]==nil and e[6].items[3]==3 and e[6].removed==nil and e[7]==nil)',
    'local f=fs.open("/debug-values","w"); f.write("ok"); f.close()',
    'local k=table.pack(os.pullEvent("key")); assert(k.n==3 and k[2]==42 and k[3]==false)',
    'local done=table.pack(os.pullEvent("debug_finish")); assert(done.n==1)',
    'local f=fs.open("/debug-finished","w"); f.write("ok"); f.close()',
  ].join('\n')));
  const debug = await session.exclusive(() => session.terminal('command', 'debug', 100));
  assert.ok('commandId' in debug);
  const filtered = await session.exclusive(() => session.sendEvent('not_the_filter', [123], 0));
  assert.equal(filtered.injection.outcome, 'accepted');
  assert.match(filtered.warning, /players cannot inject arbitrary events through normal in-game controls/);
  assert.equal(await session.readOptional('/debug-values'), null);
  await session.exclusive(() => session.sendEvent('debug_values', [null, '\0\xff', 1.5, false, { items: [1, null, 3], removed: null }, null], 0));
  await until(async () => (await session.readOptional('/debug-values')) !== null);
  assert.equal((await session.read('/debug-values')).toString(), 'ok');
  await session.exclusive(() => session.sendEvent('key', [42, false], 0));
  await session.exclusive(() => session.sendEvent('debug_finish', [], 0));
  await until(async () => (await session.commandStatus(debug.commandId)).command.state !== 'running');
  assert.equal((await session.commandStatus(debug.commandId)).command.state, 'finished');
  assert.equal((await session.read('/debug-finished')).toString(), 'ok');
  if (!reconnect) return;
  const key = session.connectionKey();
  remote!.terminate(); // MCP socket stays up; the remote transport alone changes.
  await until(() => session.status().state === 'connected' && session.connectionKey() !== key, 20000);
  await until(() => !session.status().identity.stale);
  assert.equal(session.status().identity.label, 'Updated label');
  assert.equal((await session.read('/after')).toString(), '4');
  await session.write('/touch.lua', Buffer.from('local _,name,x,y=os.pullEvent("monitor_touch"); local f=fs.open("/touch-result","w"); f.write(name..":"..x..":"..y); f.close()'));
  await session.exclusive(() => session.terminal('command', 'touch', 100));
  const monitor = session.status().windows.find(window => window.monitor === 'left')!;
  const stale = Buffer.alloc(10); stale[1] = 1; stale.writeUInt32LE(1, 2); stale.writeUInt32LE(1, 6);
  remote!.send(packet(78, 0, Buffer.concat([cstring(key), Buffer.from([2, monitor.id]), stale])));
  remote!.send(packet(2, monitor.id, stale)); // Unscoped input is also refused.
  await session.exclusive(() => session.mouse('mouse_click', 2, 3, 'left', undefined, 100, 'left'));
  await until(async () => (await session.readOptional('/touch-result')) !== null);
  assert.equal((await session.read('/touch-result')).toString(), 'left:2:3');
  session.close();
  assert.equal(session.status().identity.stale, true);
  assert.equal(session.status().identity.label, 'Updated label');
});
