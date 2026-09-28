import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { ENHANCED_SCRIPT_URL } from '../src/session.js';
import { decodeScreen, event, FrameDecoder, packet } from '../src/protocol.js';

// Opt-in: requires CraftOS-PC and network access. Downloads upstream source into
// memory, verifies Git blob hashes, and serves it through a temporary local relay.
// Source is unchanged except for the stock relay's URL/SIZE template substitutions.
test('stock bootstrap, enhanced 1 MiB files, and legacy terminal compatibility in CraftOS-PC', {
  skip: process.env.RUN_STOCK_INTEGRATION !== '1', timeout: 180000,
}, async t => {
  const hashes: Record<string, string> = {
    'server.lua': '43972e815ca2aee38fca03c9293daf2212496597',
    'rawterm.lua': 'e62ac11c14df4222ffe2e492a40eaf78a0397712',
    'string_pack.lua': 'c46cd334c47a3fa2c2478ee977982e73773cc2c8',
  };
  const sources = new Map<string, string>();
  sources.set('/cc-mcp.lua', await readFile(new URL('../lua/cc-mcp.lua', import.meta.url), 'utf8'));
  await Promise.all(Object.entries(hashes).map(async ([file, hash]) => {
    const response = await fetch(`https://raw.githubusercontent.com/MCJack123/remote.craftos-pc.cc/master/${file}`, {
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `Download ${file}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(actual, hash, `Upstream ${file} changed; review before updating fixture hash`);
    sources.set('/' + file, bytes.toString());
  }));
  let relay = '';
  const http = createHttpServer((req, res) => {
    const source = sources.get(req.url ?? '');
    if (!source) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'text/plain');
    res.end(source.replace('${URL}', relay).replace('[[${SIZE}]]', String(Buffer.byteLength(sources.get('/rawterm.lua')!))));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', socket => {
    socket.on('message', data => {
      for (const peer of wss.clients) if (peer !== socket && peer.readyState === 1) peer.send(data);
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  relay = `ws://127.0.0.1:${(http.address() as { port: number }).port}/`;
  t.after(async () => {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const directory = await mkdtemp('/tmp/opencode/cc-mcp-stock-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { server, sessions } = createServer();
  const client = new Client({ name: 'stock-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => { sessions.close(); await client.close(); await server.close(); });
  let output = '';
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: { name: 'stock', ...args } });
    if (result.isError) await delay(200);
    assert.ok(!result.isError, `${JSON.stringify(result.content)}\n${output.slice(-300)}`);
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text);
  }
  const connection = await call('connect_computer', { relay, token: 'integration', script: 'stock' });
  assert.match(connection.connectionCommand, /wget run/);
  function startComputer(command: string, monitor = false) {
    const computer = spawn(process.env.CRAFTOS_BIN ?? 'craftos', [
      monitor ? '--raw' : '--headless', '--directory', directory, '--exec',
      `settings.set("bios.use_multishell", false); ${monitor ? 'assert(periphemu.create("left", "monitor"));' : ''} shell.run(${JSON.stringify(command)})`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    computer.stdout.on('data', data => { output = (output + data.toString()).slice(-16000); });
    computer.stderr.on('data', data => { output = (output + data.toString()).slice(-16000); });
    const exited = once(computer, 'exit');
    const stop = async () => { if (computer.exitCode === null && computer.signalCode === null) computer.kill('SIGKILL'); await exited; };
    t.after(stop);
    return { computer, stop };
  }
  async function waitFor(check: () => boolean) {
    const until = Date.now() + 30000;
    while (!check()) {
      assert.ok(Date.now() < until, `Computer failed to respond: ${output}`);
      await delay(50);
    }
  }
  const stock = startComputer(connection.connectionCommand);
  await waitFor(() => sessions.get('stock').status().state === 'connected');
  const status = sessions.get('stock').status();
  assert.equal(status.mode, 'compatibility');
  assert.match(status.warning!, /^Entering compatibility mode…/);
  assert.equal(status.limits!.readBytes, 8192);
  await call('write_file', { path: '/hello.lua', content: 'print("MCP_STOCK_OK")\n' });
  assert.equal((await call('read_file', { path: '/hello.lua' })).content, 'print("MCP_STOCK_OK")\n');
  assert.ok((await call('list_files', { path: '/' })).entries.includes('hello.lua'));
  await call('run_command', { command: 'hello', wait_ms: 500 });
  assert.match((await call('read_terminal', { wait_ms: 500 })).screen.lines.join('\n'), /MCP_STOCK_OK/);
  await call('edit_file', { path: '/hello.lua', old_text: 'MCP_STOCK_OK', new_text: 'EDITED_OK' });
  assert.equal((await call('read_file', { path: '/hello.lua' })).content, 'print("EDITED_OK")\n');
  const missing = await client.callTool({ name: 'edit_file', arguments: {
    name: 'stock', path: '/hello.lua', old_text: 'not found', new_text: 'wrong',
  } });
  assert.equal(missing.isError, true);
  await call('write_file', { path: '/ambiguous', content: 'aaa' });
  const ambiguous = await client.callTool({ name: 'edit_file', arguments: {
    name: 'stock', path: '/ambiguous', old_text: 'aa', new_text: 'wrong',
  } });
  assert.equal(ambiguous.isError, true);
  assert.equal((await call('read_file', { path: '/ambiguous' })).content, 'aaa');
  await call('write_file', { path: '/empty', content: '' });
  assert.equal((await call('read_file', { path: '/empty' })).content, '');
  const large = Buffer.alloc(100000);
  for (let i = 0; i < large.length; i++) large[i] = i % 256;
  await call('write_file', { path: '/binary', content: large.toString('base64'), encoding: 'base64' });
  const oversized = await client.callTool({ name: 'read_file', arguments: { name: 'stock', path: '/binary', encoding: 'base64' } });
  assert.equal(oversized.isError, true);
  assert.match(JSON.stringify(oversized.content), /8 KiB/);
  await call('write_file', { path: '/verify.lua', content: 'local f=assert(fs.open("/binary","rb")); local s=f.readAll(); f.close(); assert(#s==100000); for i=1,#s do assert(s:byte(i)==(i-1)%256) end; print("LARGE_BYTES_OK")' });
  await call('run_command', { command: 'verify', wait_ms: 500 });
  assert.match((await call('read_terminal')).screen.lines.join('\n'), /LARGE_BYTES_OK/);
  const readable = large.subarray(0, 8192);
  await call('write_file', { path: '/readable', content: readable.toString('base64'), encoding: 'base64' });
  assert.equal((await call('read_file', { path: '/readable', encoding: 'base64' })).content, readable.toString('base64'));
  const readOnly = await client.callTool({ name: 'write_file', arguments: {
    name: 'stock', path: '/rom/should-fail.lua', content: 'no',
  } });
  assert.equal(readOnly.isError, true);
  // Verify a failed write does not poison the next file request.
  assert.equal((await call('read_file', { path: '/hello.lua' })).content, 'print("EDITED_OK")\n');
  await call('write_file', { path: '/wait.lua', content: 'while true do os.pullEvent() end' });
  await call('run_command', { command: 'wait', wait_ms: 100 });
  const interrupted = await call('interrupt_program', { wait_ms: 500 });
  assert.equal(interrupted.state, 'connected', `${JSON.stringify(interrupted)}\n${output.slice(-1800)}`);
  await call('run_command', { command: 'hello', wait_ms: 500 });
  assert.match((await call('read_terminal')).screen.lines.join('\n'), /EDITED_OK/);

  // Install through the real stock connection, with no separately hosted script.
  const installed = await call('install_enhanced_script');
  assert.equal(installed.path, '/cc-mcp.lua');
  assert.equal(installed.connection.mode, 'compatibility');
  assert.match(installed.connection.warning, /^Entering compatibility mode…/);
  const existing = await client.callTool({ name: 'install_enhanced_script', arguments: { name: 'stock' } });
  assert.equal(existing.isError, true);
  await call('run_command', { command: 'exit', wait_ms: 300 });
  assert.equal(sessions.get('stock').status().state, 'disconnected');
  await stock.stop();
  await call('disconnect_computer');
  const enhancedConnection = await call('connect_computer', { relay, token: 'enhanced' });
  // Exercise the direct-download command against our local HTTP fixture; the
  // test must not depend on whether this revision has been published to GitHub.
  const enhanced = startComputer(enhancedConnection.connectionCommand.replace(ENHANCED_SCRIPT_URL, relay.replace(/^ws/, 'http') + 'cc-mcp.lua'), true);
  await waitFor(() => sessions.get('stock').status().state === 'connected');
  const enhancedStatus = sessions.get('stock').status();
  assert.equal(enhancedStatus.mode, 'enhanced');
  assert.equal(enhancedStatus.warning, undefined);
  assert.ok(enhancedStatus.windows.length > 1, 'Enhanced launcher preserves monitor windows');
  assert.deepEqual(enhancedStatus.limits, { readBytes: 1048576, editBytes: 1048576, writeBytes: 1048576 });
  assert.equal((await call('read_file', { path: '/binary', encoding: 'base64' })).content, large.toString('base64'));
  assert.equal((await call('read_file', { path: '/empty' })).content, '');
  assert.ok((await call('list_files')).entries.includes('hello.lua'));
  const binary = Buffer.alloc(1048576);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  await call('write_file', { path: '/one-mib.bin', content: binary.toString('base64'), encoding: 'base64' });
  assert.equal((await call('read_file', { path: '/one-mib.bin', encoding: 'base64' })).content, binary.toString('base64'));
  const text = 'a'.repeat(524285) + 'UNIQUE' + 'b'.repeat(524285);
  assert.equal(text.length, 1048576);
  await call('write_file', { path: '/one-mib.txt', content: text });
  await call('edit_file', { path: '/one-mib.txt', old_text: 'UNIQUE', new_text: 'EDITED' });
  assert.equal((await call('read_file', { path: '/one-mib.txt' })).content, text.replace('UNIQUE', 'EDITED'));
  const tooLarge = await client.callTool({ name: 'edit_file', arguments: {
    name: 'stock', path: '/one-mib.txt', old_text: 'EDITED', new_text: 'TOO_LARGE',
  } });
  assert.equal(tooLarge.isError, true);
  const absent = await client.callTool({ name: 'read_file', arguments: { name: 'stock', path: '/missing' } });
  assert.equal(absent.isError, true);
  await call('run_command', { command: 'hello', wait_ms: 300 });
  assert.match((await call('read_terminal')).screen.lines.join('\n'), /EDITED_OK/);
  assert.equal(sessions.get('stock').status().mode, 'enhanced');
  await enhanced.stop();
  await call('disconnect_computer');

  // A legacy client which never requests our flag still gets stock negotiation
  // and can read/type into the enhanced launcher using ordinary rawterm packets.
  const legacy = new WebSocket(relay + 'legacy');
  t.after(() => legacy.terminate());
  await once(legacy, 'open');
  const decoder = new FrameDecoder();
  let legacyFlags: number | undefined, screen = '';
  legacy.on('message', message => {
    for (const data of decoder.push(message.toString())) {
      if (data[0] === 4 && data[2] === 0 && legacyFlags === undefined) legacy.send(packet(6, 0, Buffer.from([6, 0])));
      if (data[0] === 6) {
        legacyFlags = data.readUInt16LE(2);
        assert.equal(data.length, 4);
      }
      if (data[0] === 0) screen = decodeScreen(data).lines.join('\n');
    }
  });
  const legacyComputer = startComputer(`/cc-mcp.lua legacy ${relay}`);
  await waitFor(() => legacyFlags !== undefined && screen.length > 0);
  assert.equal(legacyFlags! & 0x8000, 0);
  legacy.send(packet(3, 0, event('paste', 'hello')));
  legacy.send(packet(1, 0, Buffer.from([28, 0])));
  legacy.send(packet(1, 0, Buffer.from([28, 1])));
  await waitFor(() => screen.includes('EDITED_OK'));
  await legacyComputer.stop();
});
