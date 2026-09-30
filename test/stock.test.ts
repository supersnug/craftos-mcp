import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { ENHANCED_SCRIPT_URL, Sessions } from '../src/session.js';
import { ConnectionProfiles } from '../src/profiles.js';
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
  let offline = false;
  wss.on('connection', socket => {
    if (offline) { socket.close(); return; }
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
  const { server, sessions, syncs } = createServer(new Sessions(new ConnectionProfiles(directory + '/connections.json')));
  const client = new Client({ name: 'stock-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => { sessions.close(); await syncs.close(); await client.close(); await server.close(); });
  let output = '';
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: { name: 'stock', ...args } }, undefined, { timeout: 120000 })
      .catch(error => { throw new Error(`${name} ${args.path ?? ''}: ${String(error)}; computer output: ${output.slice(-500)}`); });
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
      `settings.set("bios.use_multishell", false); ${monitor ? 'assert(periphemu.create("left", "monitor")); assert(periphemu.create("back", "monitor"));' : ''} shell.run(${JSON.stringify(command)})`,
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
      assert.ok(Date.now() < until, `Computer failed to respond: ${JSON.stringify(sessions.list())}; ${output.slice(-500)}`);
      await delay(50);
    }
  }
  async function verifyPointerEvents() {
    const expected = [['mouse_click', 1, 2, 3], ['mouse_drag', 1, 4, 5], ['mouse_up', 1, 4, 5],
      ['mouse_click', 2, 2, 3], ['mouse_up', 3, 2, 3], ['mouse_scroll', -1, 2, 3], ['mouse_scroll', 1, 2, 3],
      ['monitor_touch', 'left', 2, 3], ['monitor_touch', 'back', 4, 5]];
    await call('write_file', { path: '/pointer-events.lua', content: 'local events={}; while #events<9 do local e={os.pullEvent()}; if e[1]=="monitor_touch" or e[1]:match("^mouse_") then events[#events+1]=e end end; local f=assert(fs.open("/pointer-result","w")); f.write(textutils.serializeJSON(events)); f.close()' });
    await call('write_file', { path: '/pointer-result', content: '' });
    await call('run_command', { command: 'pointer-events', wait_ms: 100 });
    for (const [event, value, x, y] of expected) {
      if (event === 'monitor_touch') await call('touch_monitor', { monitor: value, x, y, wait_ms: 0 });
      else await call('send_mouse', { event, x, y, ...(event === 'mouse_scroll' ? { direction: value === -1 ? 'up' : 'down' } : { button: ['left', 'right', 'middle'][Number(value) - 1] }), wait_ms: 0 });
    }
    const deadline = Date.now() + 10000;
    let contents = '';
    while (!contents) {
      contents = (await call('read_file', { path: '/pointer-result' })).content;
      assert.ok(Date.now() < deadline, 'Pointer events were not delivered');
      if (!contents) await delay(20);
    }
    assert.deepEqual(JSON.parse(contents), expected);
  }
  const stock = startComputer(connection.connectionCommand, true);
  await waitFor(() => sessions.get('stock').status().state === 'connected');
  const status = sessions.get('stock').status();
  assert.equal(status.mode, 'compatibility');
  assert.match(status.warning!, /^Entering compatibility mode…/);
  assert.equal(status.limits!.readBytes, 8192);
  assert.equal((await call('read_output')).supported, false);
  assert.ok(status.windows.some(window => window.monitor === 'left'));
  assert.ok(status.windows.some(window => window.monitor === 'back'));
  await call('write_file', { path: '/monitors.lua', content: 'for _,name in ipairs({"left","back"}) do local m=peripheral.wrap(name); m.setBackgroundColor(colors.blue); m.setTextColor(colors.yellow); m.clear(); m.setCursorPos(1,1); m.write(name=="left" and "LEFT" or "BACK"); m.setCursorPos(2,2); m.setCursorBlink(true) end' });
  await call('run_command', { command: 'monitors', wait_ms: 300 });
  const stockMonitor = await call('read_monitor', { monitor: 'left' });
  assert.equal(stockMonitor.availability, 'ready');
  assert.equal(stockMonitor.screen.lines[0].slice(0, 4), 'LEFT');
  assert.equal(stockMonitor.screen.foreground[0].slice(0, 4), '4444');
  assert.equal(stockMonitor.screen.background[0].slice(0, 4), 'bbbb');
  assert.deepEqual(stockMonitor.screen.cursor, { x: 2, y: 2, blinking: true });
  assert.equal((await call('read_monitor', { monitor: 'back' })).screen.lines[0].slice(0, 4), 'BACK');
  await verifyPointerEvents();
  await call('write_file', { path: '/hello.lua', content: 'print("MCP_STOCK_OK")\n' });
  assert.equal((await call('read_file', { path: '/hello.lua' })).content, 'print("MCP_STOCK_OK")\n');
  assert.ok((await call('list_files', { path: '/' })).entries.includes('hello.lua'));
  await call('run_command', { command: 'hello', wait_ms: 500 });
  assert.match((await call('read_terminal', { wait_ms: 500 })).screen.lines.join('\n'), /MCP_STOCK_OK/);
  const stockEdit = await client.callTool({ name: 'edit_file', arguments: { name: 'stock', path: '/hello.lua', old_text: 'MCP_STOCK_OK', new_text: 'EDITED_OK', expected_hash: (await call('read_file', { path: '/hello.lua' })).hash } });
  assert.equal(stockEdit.isError, true);
  await call('write_file', { path: '/hello.lua', content: 'print("EDITED_OK")\n' });
  assert.equal((await call('read_file', { path: '/hello.lua' })).content, 'print("EDITED_OK")\n');
  await call('write_file', { path: '/ambiguous', content: 'aaa' });
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
  assert.equal(enhancedStatus.capabilities.commandTracking, true);
  assert.equal(enhancedStatus.capabilities.outputCapture, true);
  assert.equal(enhancedStatus.capabilities.foregroundAwareness, true);
  assert.equal(enhancedStatus.foreground.kind, 'shell');
  assert.equal(enhancedStatus.foreground.canRunCommand, true);
  assert.equal(enhancedStatus.warning, undefined);
  assert.ok(enhancedStatus.windows.length > 1, 'Enhanced launcher preserves monitor windows');
  await verifyPointerEvents();
  await call('run_command', { command: 'monitors', wait_ms: 300 });
  const beforeResize = await call('read_monitor', { monitor: 'left' });
  assert.equal(beforeResize.screen.lines[0].slice(0, 4), 'LEFT');
  await call('write_file', { path: '/resize-monitor.lua', content: 'local m=peripheral.wrap("left"); m.setTextScale(0.5); m.clear(); m.setCursorPos(1,1); m.write("SCALE")' });
  await call('run_command', { command: 'resize-monitor', wait_ms: 300 });
  const resized = await call('read_monitor', { monitor: 'left' });
  assert.equal(resized.availability, 'ready');
  assert.equal(resized.screen.lines[0].slice(0, 5), 'SCALE');
  // CraftOS-PC's raw renderer may keep its grid size when changing text scale.
  // Size-changing protocol frames are covered separately in session.test.ts.
  assert.equal(resized.screen.width, resized.expectedSize.width);
  assert.equal(resized.screen.height, resized.expectedSize.height);
  await call('write_file', { path: '/attach-monitor.lua', content: 'assert(periphemu.create("right", "monitor")); sleep(0.1); local m=peripheral.wrap("right"); m.clear(); m.setCursorPos(1,1); m.write("NEW")' });
  await call('run_command', { command: 'attach-monitor', wait_ms: 300 });
  assert.equal((await call('read_monitor', { monitor: 'right' })).screen.lines[0].slice(0, 3), 'NEW');
  await call('write_file', { path: '/detach-monitor.lua', content: 'periphemu.remove("right")' });
  await call('run_command', { command: 'detach-monitor', wait_ms: 300 });
  const detached = await client.callTool({ name: 'read_monitor', arguments: { name: 'stock', monitor: 'right', wait_ms: 100 } });
  assert.equal(detached.isError, true);
  assert.deepEqual(enhancedStatus.limits, { readBytes: 1048576, editBytes: 1048576, writeBytes: 1048576 });
  assert.equal(enhancedStatus.fileSafety.recoverableWrites, true);
  for (const [path, old_text, message] of [['/hello.lua', 'not found', /not found/], ['/ambiguous', 'aa', /ambiguous/]] as const) {
    const invalidEdit = await client.callTool({ name: 'edit_file', arguments: {
      name: 'stock', path, old_text, new_text: 'wrong', expected_hash: (await call('read_file', { path })).hash,
    } });
    assert.equal(invalidEdit.isError, true);
    assert.match(JSON.stringify(invalidEdit.content), message);
  }
  await call('write_file', { path: '/conflict.txt', content: 'original' });
  const originalVersion = await call('read_file', { path: '/conflict.txt' });
  assert.match(originalVersion.hash, /^[a-f0-9]{64}$/);
  await call('write_file', { path: '/conflict.txt', content: 'external' });
  const staleEdit = await client.callTool({ name: 'edit_file', arguments: { name: 'stock', path: '/conflict.txt', old_text: 'external', new_text: 'bad', expected_hash: originalVersion.hash } });
  assert.equal(staleEdit.isError, true);
  assert.match(JSON.stringify(staleEdit.content), /Conflict/);
  const existsWrite = await client.callTool({ name: 'write_file', arguments: { name: 'stock', path: '/conflict.txt', content: 'bad', must_not_exist: true } });
  assert.equal(existsWrite.isError, true);
  const conflictId = JSON.stringify(existsWrite.content).match(/transactionId: ([a-f0-9]{32})/)![1];
  assert.equal((await call('recover_file_write', { path: '/conflict.txt', transaction_id: conflictId })).outcome, 'aborted');
  assert.equal((await call('read_file', { path: '/conflict.txt' })).content, 'external');
  const currentVersion = await call('read_file', { path: '/conflict.txt' });
  const conditional = await call('write_file', { path: '/conflict.txt', content: 'conditional', expected_hash: currentVersion.hash });
  assert.equal(conditional.safety, 'recoverable');
  assert.equal(conditional.hash, (await call('read_file', { path: '/conflict.txt' })).hash);

  // Drive the transaction protocol in stages to interleave a real in-game
  // writer before commit, rather than only testing the client-side hash check.
  const txSession = sessions.get('stock') as unknown as { transaction(request: Record<string, unknown>): Promise<Record<string, unknown>> };
  const txId = 'a'.repeat(32), txPath = '/conflict.txt';
  await txSession.transaction({ op: 'begin', id: txId, path: txPath, size: 3, condition: 'match' });
  await txSession.transaction({ op: 'chunk', id: txId, path: txPath, stream: 'expected', offset: 0, data: Buffer.from('conditional').toString('base64') });
  await txSession.transaction({ op: 'chunk', id: txId, path: txPath, stream: 'new', offset: 0, data: Buffer.from('new').toString('base64') });
  assert.equal((await call('read_file', { path: txPath })).content, 'conditional', 'Staging cannot modify the destination');
  await call('write_file', { path: '/external-writer.lua', content: 'local f=fs.open("/conflict.txt","w"); f.write("CHANGED"); f.close()' });
  await call('run_command', { command: 'external-writer', wait_ms: 100 });
  await assert.rejects(txSession.transaction({ op: 'commit', id: txId, path: txPath }), /Conflict/);
  assert.equal((await call('read_file', { path: txPath })).content, 'CHANGED');
  assert.equal((await call('recover_file_write', { path: txPath, transaction_id: txId })).outcome, 'aborted');

  // Simulate a crash after the backup rename using the real filesystem, then
  // verify conservative recovery restores the old contents and no new data.
  const recoveryId = 'b'.repeat(32);
  await txSession.transaction({ op: 'begin', id: recoveryId, path: txPath, size: 3, condition: 'any' });
  await call('write_file', { path: '/simulate-crash.lua', content: 'local d="/.cc-mcp-' + recoveryId + '"; local f=fs.open(d.."/intent","w"); f.write(textutils.serializeJSON({path="conflict.txt",hadOriginal=true})); f.close(); fs.move("/conflict.txt",d.."/backup")' });
  await call('run_command', { command: 'simulate-crash', wait_ms: 100 });
  assert.equal((await call('recover_file_write', { path: txPath, transaction_id: recoveryId })).outcome, 'restored');
  assert.equal((await call('read_file', { path: txPath })).content, 'CHANGED');

  const damagedId = 'c'.repeat(32);
  await txSession.transaction({ op: 'begin', id: damagedId, path: txPath, size: 3, condition: 'any' });
  await txSession.transaction({ op: 'chunk', id: damagedId, path: txPath, stream: 'new', offset: 0, data: Buffer.from('new').toString('base64') });
  await call('write_file', { path: '/damage-stage.lua', content: 'local f=fs.open("/.cc-mcp-' + damagedId + '/new","w"); f.write("BAD"); f.close()' });
  await call('run_command', { command: 'damage-stage', wait_ms: 100 });
  await assert.rejects(txSession.transaction({ op: 'commit', id: damagedId, path: txPath }), /verification/);
  await call('recover_file_write', { path: txPath, transaction_id: damagedId });
  assert.equal((await call('read_file', { path: txPath })).content, 'CHANGED');
  assert.equal((await call('read_file', { path: '/binary', encoding: 'base64' })).content, large.toString('base64'));
  assert.equal(enhancedStatus.fileSafety.directorySync, true);
  await sessions.get('stock').makeDirectory('/');
  // Deletions use the same commit-time comparison as replacement, never an
  // unchecked stock fs.delete between the read and mutation.
  const deleteId = 'e'.repeat(32);
  await txSession.transaction({ op: 'begin', id: deleteId, path: txPath, size: 0, condition: 'match', remove: true });
  await txSession.transaction({ op: 'chunk', id: deleteId, path: txPath, stream: 'expected', offset: 0, data: Buffer.from('CHANGED').toString('base64') });
  await call('write_file', { path: txPath, content: 'NEWER' });
  await assert.rejects(txSession.transaction({ op: 'commit', id: deleteId, path: txPath }), /Conflict/);
  assert.equal((await call('read_file', { path: txPath })).content, 'NEWER');
  await call('recover_file_write', { path: txPath, transaction_id: deleteId });
  await call('write_file', { path: txPath, content: 'CHANGED' });
  const syncRoot = await mkdtemp('/tmp/opencode/cc-mcp-sync-integration-');
  t.after(() => rm(syncRoot, { recursive: true, force: true }));
  await mkdir(syncRoot + '/lib');
  await writeFile(syncRoot + '/main.lua', 'print("SYNC_BASE")');
  await writeFile(syncRoot + '/lib/data.bin', Buffer.from([0, 128, 255]));
  await writeFile(syncRoot + '/.gitignore', '*.tmp\n');
  await writeFile(syncRoot + '/ignored.tmp', 'do not upload');
  const push = await call('sync_folder', { local_path: syncRoot, remote_path: '/synced/project', wait_ms: 5000 });
  assert.equal(push.status, 'idle', JSON.stringify(push));
  assert.equal((await call('read_file', { path: '/synced/project/main.lua' })).content, 'print("SYNC_BASE")');
  assert.equal((await call('read_file', { path: '/synced/project/lib/data.bin', encoding: 'base64' })).content, Buffer.from([0, 128, 255]).toString('base64'));
  assert.ok(!(await call('list_files', { path: '/synced/project' })).entries.includes('ignored.tmp'));
  const unchangedPush = await call('sync_folder', { local_path: syncRoot, remote_path: '/synced/project', wait_ms: 5000 });
  assert.equal(unchangedPush.lastRun.uploaded, 0);
  await call('write_file', { path: '/synced/project/main.lua', content: 'print("IN_GAME")' });
  await writeFile(syncRoot + '/main.lua', 'print("LOCAL")');
  const conflictedPush = await call('sync_folder', { local_path: syncRoot, remote_path: '/synced/project', wait_ms: 5000 });
  assert.equal(conflictedPush.status, 'conflict');
  const versions = await call('read_sync_conflict', { sync_id: push.syncId });
  assert.equal(versions.baseline.content, 'print("SYNC_BASE")');
  assert.equal(versions.remote.content, 'print("IN_GAME")');
  assert.equal((await call('resolve_sync_conflict', { sync_id: push.syncId, resolution: 'merged', content: 'print("MERGED")' })).status, 'paused');
  assert.equal(await readFile(syncRoot + '/main.lua', 'utf8'), 'print("MERGED")');
  assert.equal((await call('continue_sync', { sync_id: push.syncId, wait_ms: 5000 })).status, 'idle');
  await rm(syncRoot + '/lib/data.bin');
  assert.equal((await call('sync_folder', { local_path: syncRoot, remote_path: '/synced/project', delete_removed: true, watch: true, wait_ms: 5000 })).status, 'idle');
  assert.deepEqual((await call('list_files', { path: '/synced/project/lib' })).entries, []);
  await writeFile(syncRoot + '/main.lua', 'print("WATCHED")');
  const watchDeadline = Date.now() + 10000;
  while ((await call('read_file', { path: '/synced/project/main.lua' })).content !== 'print("WATCHED")') {
    assert.ok(Date.now() < watchDeadline, JSON.stringify(await call('get_sync_status', { sync_id: push.syncId })));
    await delay(50);
  }
  assert.equal((await call('stop_sync', { sync_id: push.syncId })).status, 'stopped');
  assert.equal((await call('read_file', { path: '/empty' })).content, '');
  assert.ok((await call('list_files')).entries.includes('hello.lua'));
  const binary = Buffer.alloc(1048576);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  await call('write_file', { path: '/one-mib.bin', content: binary.toString('base64'), encoding: 'base64' });
  assert.equal((await call('read_file', { path: '/one-mib.bin', encoding: 'base64' })).content, binary.toString('base64'));
  const text = 'a'.repeat(524285) + 'UNIQUE' + 'b'.repeat(524285);
  assert.equal(text.length, 1048576);
  await call('write_file', { path: '/one-mib.txt', content: text });
  await call('edit_file', { path: '/one-mib.txt', old_text: 'UNIQUE', new_text: 'EDITED', expected_hash: (await call('read_file', { path: '/one-mib.txt' })).hash });
  assert.equal((await call('read_file', { path: '/one-mib.txt' })).content, text.replace('UNIQUE', 'EDITED'));
  const tooLarge = await client.callTool({ name: 'edit_file', arguments: {
    name: 'stock', path: '/one-mib.txt', old_text: 'EDITED', new_text: 'TOO_LARGE', expected_hash: (await call('read_file', { path: '/one-mib.txt' })).hash,
  } });
  assert.equal(tooLarge.isError, true);
  const absent = await client.callTool({ name: 'read_file', arguments: { name: 'stock', path: '/missing' } });
  assert.equal(absent.isError, true);
  const successful = await call('run_command', { command: 'hello', wait_ms: 300 });
  assert.equal(successful.commandCompletion, 'finished');
  assert.equal(successful.command.success, true);
  assert.equal(successful.connection.foreground.prompt, 'idle');
  const helloOutput = await call('read_output', { command_id: successful.commandId, wait_ms: 0 });
  assert.equal(helloOutput.text, 'EDITED_OK\n');
  assert.equal(helloOutput.truncated, false);
  assert.match((await call('read_terminal')).screen.lines.join('\n'), /EDITED_OK/);
  assert.equal((await call('get_command_status', { command_id: successful.commandId })).command.state, 'finished');
  const missingProgram = await call('run_command', { command: 'no-such-program', wait_ms: 200 });
  assert.equal(missingProgram.commandCompletion, 'failed');
  assert.equal(missingProgram.command.success, false);
  await call('write_file', { path: '/fail.lua', content: 'error("EXPECTED_FAILURE")' });
  const failed = await call('run_command', { command: 'fail', wait_ms: 200 });
  assert.equal(failed.commandCompletion, 'failed');
  assert.match((await call('read_output', { command_id: failed.commandId, wait_ms: 0 })).text, /EXPECTED_FAILURE/);
  await call('write_file', { path: '/input.lua', content: 'print("INPUT_READY"); local text=read(); print("INPUT="..text)' });
  const interactive = await call('run_command', { command: 'input', wait_ms: 100 });
  assert.equal(interactive.commandCompletion, 'running');
  assert.equal(interactive.connection.foreground.kind, 'program');
  assert.match(interactive.connection.foreground.program, /input.lua$/);
  assert.equal(interactive.connection.foreground.commandId, interactive.commandId);
  assert.equal(interactive.connection.foreground.canRunCommand, false);
  const busy = await client.callTool({ name: 'run_command', arguments: { name: 'stock', command: 'hello' } });
  assert.equal(busy.isError, true);
  assert.match(JSON.stringify(busy.content), /not an idle shell prompt/);
  await call('send_text', { text: 'user input', wait_ms: 0 });
  await call('send_key', { key: 'enter', wait_ms: 100 });
  assert.equal((await call('get_command_status', { command_id: interactive.commandId })).command.state, 'finished');
  await waitFor(() => sessions.get('stock').snapshot().screen?.lines.join('\n').includes('INPUT=user input') === true);
  assert.match((await call('read_terminal')).screen.lines.join('\n'), /INPUT=user input/);
  await call('write_file', { path: '/sleep.lua', content: 'sleep(0.5)' });
  const sleeping = await call('run_command', { command: 'sleep', wait_ms: 0 });
  assert.equal(sleeping.commandCompletion, 'running');
  assert.equal((await call('get_command_status', { command_id: sleeping.commandId, wait_ms: 800 })).command.state, 'finished');
  await call('send_text', { text: 'hel', wait_ms: 0 });
  const partial = await client.callTool({ name: 'run_command', arguments: { name: 'stock', command: 'hello' } });
  assert.equal(partial.isError, true);
  assert.equal((await call('read_terminal')).foreground.prompt, 'editing');
  await call('send_key', { key: 'enter', wait_ms: 100 });
  await call('send_text', { text: 'lua', wait_ms: 0 });
  await call('send_key', { key: 'enter', wait_ms: 100 });
  const replBusy = await client.callTool({ name: 'run_command', arguments: { name: 'stock', command: 'hello' } });
  assert.equal(replBusy.isError, true);
  const repl = await call('read_terminal');
  assert.equal(repl.foreground.kind, 'lua_repl');
  assert.equal(repl.foreground.commandId, undefined);
  await call('send_text', { text: 'exit()', wait_ms: 0 });
  await call('send_key', { key: 'enter', wait_ms: 100 });
  await call('write_file', { path: '/nested.lua', content: 'shell.run("wait")' });
  const nested = await call('run_command', { command: 'nested', wait_ms: 150 });
  assert.match(nested.connection.foreground.program, /wait.lua$/);
  assert.equal(nested.connection.foreground.commandId, nested.commandId);
  await call('interrupt_program', { wait_ms: 100 });
  await call('run_command', { command: 'cd /rom', wait_ms: 100 });
  await waitFor(() => sessions.get('stock').status().foreground.workingDirectory === '/rom');
  assert.equal((await call('read_terminal')).foreground.workingDirectory, '/rom');
  await call('run_command', { command: 'cd /', wait_ms: 100 });
  const waiting = await call('run_command', { command: 'wait', wait_ms: 100 });
  assert.equal(waiting.commandCompletion, 'running');
  await call('interrupt_program', { wait_ms: 100 });
  assert.equal((await call('get_command_status', { command_id: waiting.commandId })).command.state, 'interrupted');
  const idleInterrupt = await call('interrupt_program', { wait_ms: 0 });
  assert.equal(idleInterrupt.interruption.outcome, 'idle');
  assert.equal(idleInterrupt.state, 'connected');
  await call('send_text', { text: 'hel', wait_ms: 100 });
  assert.equal((await call('interrupt_program', { mode: 'force', wait_ms: 0 })).interruption.outcome, 'idle');
  await call('send_text', { text: 'lo', wait_ms: 0 });
  await call('send_key', { key: 'enter', wait_ms: 100 });
  await call('write_file', { path: '/ignore.lua', content: 'while true do os.pullEventRaw("timer") end' });
  const ignoring = await call('run_command', { command: 'ignore', wait_ms: 100 });
  const mismatch = await client.callTool({ name: 'interrupt_program', arguments: { name: 'stock', mode: 'force', command_id: '0'.repeat(32) } });
  assert.equal(mismatch.isError, true);
  assert.equal((await call('get_command_status', { command_id: ignoring.commandId })).command.state, 'running');
  const ignored = await call('interrupt_program', { command_id: ignoring.commandId, wait_ms: 100 });
  assert.equal(ignored.interruption.outcome, 'running');
  const forced = await call('interrupt_program', { mode: 'force', command_id: ignoring.commandId, wait_ms: 100 });
  assert.equal(forced.interruption.outcome, 'stopped');
  assert.equal(forced.command.state, 'interrupted');
  assert.equal(forced.foreground.kind, 'shell');
  assert.equal((await call('run_command', { command: 'hello', wait_ms: 100 })).commandCompletion, 'finished');
  await call('write_file', { path: '/cleanup.lua', content: 'local ev=os.pullEventRaw("timer"); if ev=="terminate" then local f=fs.open("/cleaned","w"); f.write("yes"); f.close() end' });
  const cleanup = await call('run_command', { command: 'cleanup', wait_ms: 100 });
  assert.equal((await call('interrupt_program', { command_id: cleanup.commandId })).interruption.outcome, 'stopped');
  assert.equal((await call('read_file', { path: '/cleaned' })).content, 'yes');
  await call('write_file', { path: '/nested-ignore.lua', content: 'shell.run("ignore"); local f=fs.open("/must-not-run","w"); f.write("bad"); f.close()' });
  const nestedIgnore = await call('run_command', { command: 'nested-ignore', wait_ms: 100 });
  assert.equal((await call('interrupt_program', { mode: 'force', command_id: nestedIgnore.commandId })).interruption.outcome, 'stopped');
  assert.ok(!(await call('list_files')).entries.includes('must-not-run'));
  await call('send_text', { text: 'ignore', wait_ms: 0 });
  await call('send_key', { key: 'enter', wait_ms: 100 });
  const manualForce = await call('interrupt_program', { mode: 'force' });
  assert.equal(manualForce.interruption.outcome, 'stopped');
  assert.equal(manualForce.interruption.commandId, undefined);
  assert.equal(manualForce.foreground.kind, 'shell');
  await call('write_file', { path: '/logs.lua', content: 'for i=1,120 do print("LOG_"..i) end; print(); print("END_LOG")' });
  const logs = await call('run_command', { command: 'logs', wait_ms: 500 });
  const logsDeadline = Date.now() + 15000;
  let logsStatus;
  do {
    logsStatus = await call('get_command_status', { command_id: logs.commandId, wait_ms: 250 });
    if (Date.now() >= logsDeadline) assert.fail('Log-producing program did not complete within 15 seconds: ' + JSON.stringify({ logsStatus, output: await sessions.get('stock').readOutput(undefined, logs.commandId) }));
  } while (logsStatus.command.state === 'running');
  assert.equal(logsStatus.command.state, 'finished');
  const logged: string[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = await call('read_output', { command_id: logs.commandId, cursor, limit: 17, wait_ms: 0 });
    logged.push(...page.lines.map((line: { text: string }) => line.text));
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.deepEqual(logged, [...Array.from({ length: 120 }, (_, i) => `LOG_${i + 1}`), '', 'END_LOG']);
  assert.equal((await call('read_output', { command_id: logs.commandId, cursor, wait_ms: 0 })).text, '');
  await call('write_file', { path: '/progress.lua', content: 'local x,y=term.getCursorPos(); term.write("0%"); os.pullEvent("key"); term.setCursorPos(x,y); term.clearLine(); term.write("100%"); os.pullEvent("key"); print("")' });
  const progress = await call('run_command', { command: 'progress', wait_ms: 150 });
  const live = await call('read_output', { command_id: progress.commandId, wait_ms: 0 });
  assert.equal(live.text, '');
  assert.equal(live.liveLines[0].text, '0%');
  await call('send_key', { key: 'space', wait_ms: 150 });
  const updated = await call('read_output', { command_id: progress.commandId, cursor: live.nextCursor, wait_ms: 0 });
  assert.equal(updated.liveLines[0].text, '100%');
  await call('send_key', { key: 'enter', wait_ms: 150 });
  const committed = await call('read_output', { command_id: progress.commandId, cursor: updated.nextCursor, wait_ms: 0 });
  assert.equal(committed.text, '100%\n');
  assert.equal(committed.liveLines.length, 0);
  await call('write_file', { path: '/blit.lua', content: 'term.blit("TAIL", "0000", "ffff")' });
  const blit = await call('run_command', { command: 'blit', wait_ms: 100 });
  assert.equal((await call('read_output', { command_id: blit.commandId, wait_ms: 0 })).text, 'TAIL\n');
  const overall = await call('read_output', { limit: 1000, wait_ms: 0 });
  assert.match(overall.text, /LOG_1\n/);
  // Leave an incomplete upload and a post-backup-rename record across an actual
  // process restart. Recovery must depend on disk records, not in-memory state.
  const uploadId = 'd'.repeat(32);
  await call('write_file', { path: '/upload-original', content: 'untouched' });
  await txSession.transaction({ op: 'begin', id: uploadId, path: '/upload-original', size: 6, condition: 'any' });
  await txSession.transaction({ op: 'chunk', id: uploadId, path: '/upload-original', stream: 'new', offset: 0, data: Buffer.from('new').toString('base64') });
  await txSession.transaction({ op: 'begin', id: recoveryId, path: txPath, size: 3, condition: 'any' });
  assert.equal((await call('run_command', { command: 'simulate-crash', wait_ms: 100 })).commandCompletion, 'finished');
  const lost = await call('run_command', { command: 'wait', wait_ms: 100 });
  assert.equal(sessions.get('stock').status().mode, 'enhanced');
  await enhanced.stop();
  for (const peer of wss.clients) peer.terminate();
  await waitFor(() => sessions.get('stock').status().state === 'disconnected');
  assert.equal((await call('get_command_status', { command_id: lost.commandId })).command.state, 'unknown');
  assert.equal((await call('get_command_status', { command_id: successful.commandId })).command.state, 'finished');
  const retained = await call('read_output', { command_id: logs.commandId, limit: 1000, wait_ms: 0 });
  assert.equal(retained.stale, true);
  assert.equal(retained.lines.length, 122);
  const offlineMonitor = await call('read_monitor', { monitor: 'left', wait_ms: 0 });
  assert.equal(offlineMonitor.stale, true);
  assert.equal(offlineMonitor.availability, 'disconnected');
  assert.equal(offlineMonitor.foreground.kind, 'unknown');
  assert.equal(offlineMonitor.foreground.stale, true);
  assert.equal(offlineMonitor.foreground.canRunCommand, false);
  assert.equal(offlineMonitor.screen.lines[0].slice(0, 5), 'SCALE');
  await call('disconnect_computer');

  const restartedConnection = await call('connect_computer', { relay, token: 'recovery' });
  const restarted = startComputer(restartedConnection.installedCommand);
  await waitFor(() => sessions.get('stock').status().state === 'connected');
  assert.equal((await call('read_file', { path: '/upload-original' })).content, 'untouched');
  assert.equal((await call('recover_file_write', { path: '/upload-original', transaction_id: uploadId })).outcome, 'aborted');
  // An occupied destination must never be overwritten by recovery.
  await call('write_file', { path: txPath, content: 'preserve me' });
  const ambiguousRecovery = await client.callTool({ name: 'recover_file_write', arguments: { name: 'stock', path: txPath, transaction_id: recoveryId } });
  assert.equal(ambiguousRecovery.isError, true);
  assert.equal((await call('read_file', { path: txPath })).content, 'preserve me');
  assert.equal((await call('read_file', { path: `/.cc-mcp-${recoveryId}/backup` })).content, 'CHANGED');
  await call('write_file', { path: '/remove-conflict.lua', content: 'fs.delete("/conflict.txt")' });
  assert.equal((await call('run_command', { command: 'remove-conflict', wait_ms: 100 })).commandCompletion, 'finished');
  assert.equal((await call('recover_file_write', { path: txPath, transaction_id: recoveryId })).outcome, 'restored');
  assert.equal((await call('read_file', { path: txPath })).content, 'CHANGED');
  await restarted.stop();
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
  legacy.terminate();

  const persistent = await call('connect_computer', { relay, token: 'persistent', reconnect: true });
  const resident = startComputer(persistent.installedCommand, true);
  await waitFor(() => sessions.get('stock').status().state === 'connected');
  assert.equal(sessions.get('stock').status().reconnection.remoteEnabled, true);
  const initialEpoch = sessions.get('stock').status().reconnection.remoteEpoch;
  await call('write_file', { path: '/startup.lua', content: 'local f=fs.open("/boot-marker","w"); f.write("booted"); f.close()' });
  await call('configure_startup', { enabled: true });
  assert.match((await call('read_file', { path: '/startup/zz-cc-mcp.lua' })).content, /--reconnect/);
  await call('write_file', { path: '/offline.lua', content: 'sleep(2); local f=fs.open("/once","a"); f.write("x"); f.close(); print("OFFLINE_FINISHED")' });
  const offlineCommand = await call('run_command', { command: 'offline', wait_ms: 0 });
  offline = true;
  for (const socket of wss.clients) socket.terminate();
  await waitFor(() => sessions.get('stock').status().state !== 'connected');
  await delay(2500);
  offline = false;
  await waitFor(() => sessions.get('stock').status().state === 'connected' && !sessions.get('stock').status().reconnection.recoveringOutput);
  assert.equal(sessions.get('stock').status().reconnection.remoteEpoch, initialEpoch);
  assert.equal((await call('get_command_status', { command_id: offlineCommand.commandId })).command.state, 'finished');
  assert.equal((await call('read_file', { path: '/once' })).content, 'x');
  assert.equal((await call('read_output', { command_id: offlineCommand.commandId, wait_ms: 0 })).text, 'OFFLINE_FINISHED\n');
  assert.ok(sessions.get('stock').status().windows.some(window => window.monitor === 'left'));
  // Restoring the MCP manager reattaches to the same foreground invocation.
  const residentInput = await call('run_command', { command: 'input', wait_ms: 100 });
  sessions.close(); sessions.restore();
  await waitFor(() => sessions.get('stock').status().state === 'connected');
  assert.equal((await call('get_command_status', { command_id: residentInput.commandId })).command.state, 'running');
  await call('send_text', { text: 'after restart', wait_ms: 0 });
  await call('send_key', { key: 'enter', wait_ms: 100 });
  assert.equal((await call('get_command_status', { command_id: residentInput.commandId })).command.state, 'finished');
  await resident.stop();
  // Run the actual ROM startup dispatcher as a fresh boot, preserving startup.lua.
  const booted = startComputer('/rom/startup.lua');
  await waitFor(() => sessions.get('stock').status().state === 'connected' && sessions.get('stock').status().reconnection.remoteEpoch !== initialEpoch);
  assert.equal((await call('read_file', { path: '/boot-marker' })).content, 'booted');
  assert.equal((await call('read_file', { path: '/once' })).content, 'x');
  await call('configure_startup', { enabled: false });
  assert.deepEqual((await call('list_files', { path: '/startup' })).entries, []);
  assert.match((await call('read_file', { path: '/startup.lua' })).content, /boot-marker/);
  await call('write_file', { path: '/startup/zz-cc-mcp.lua', content: 'print("unmanaged")' });
  const unmanaged = await client.callTool({ name: 'configure_startup', arguments: { name: 'stock', enabled: false } });
  assert.equal(unmanaged.isError, true);
  assert.equal((await call('read_file', { path: '/startup/zz-cc-mcp.lua' })).content, 'print("unmanaged")');
  await call('disconnect_computer');
  assert.deepEqual(JSON.parse(await readFile(directory + '/connections.json', 'utf8')).profiles, []);
  await booted.stop();
});
