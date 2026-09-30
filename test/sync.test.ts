import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileHash } from '../src/session.js';
import { FolderSync, type SyncPeer } from '../src/sync.js';

class Peer implements SyncPeer {
  files = new Map<string, Buffer>();
  directories = new Set<string>();
  mutations: string[] = [];
  online = true;
  generation = 'initial';
  connectionKey() { return this.generation; }
  afterWrite?: () => void;
  beforeWrite?: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  requireSyncReady() { if (!this.online) throw new Error('Computer disconnected'); }
  exclusive<T>(action: () => Promise<T>) {
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  async readOptional(file: string) { this.requireSyncReady(); return this.files.has(file) ? Buffer.from(this.files.get(file)!) : null; }
  async makeDirectory(dir: string) { this.requireSyncReady(); this.directories.add(dir); }
  async write(file: string, data: Buffer, expected?: string, missing = false) {
    this.requireSyncReady(); this.beforeWrite?.();
    const old = this.files.get(file);
    if ((missing && old) || (expected && (!old || fileHash(old) !== expected))) throw new Error('Conflict at remote commit');
    this.files.set(file, Buffer.from(data)); this.mutations.push(`write:${file}`);
    this.afterWrite?.();
  }
  async deleteFile(file: string, expected: string) {
    this.requireSyncReady();
    const old = this.files.get(file);
    if (!old || fileHash(old) !== expected) throw new Error('Conflict at remote deletion');
    this.files.delete(file); this.mutations.push(`delete:${file}`);
  }
}

type Status = { syncId: string; status: string; watcherActive: boolean; trackedFiles: number; error?: string; pending?: unknown; conflict?: { path: string; reason: string }; lastRun?: { uploaded: number; unchanged: number } };
async function fixture(t: TestContext) {
  const root = await mkdtemp('/tmp/opencode/cc-sync-');
  const peer = new Peer();
  const sync = new FolderSync(() => peer, 20);
  t.after(async () => { await sync.close(); await rm(root, { recursive: true, force: true }); });
  const put = async (file: string, data: string | Buffer) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), data); };
  const start = async (deletions = false, watch = false) => await sync.start('computer', root, '/project', deletions, watch) as Status;
  return { root, peer, sync, put, start };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'watcher did not reach expected state'); await delay(10); }
}

test('sync pushes nested byte-exact files, skips equal files, and respects nested ignore rules and symlinks', async t => {
  const { root, peer, put, start } = await fixture(t);
  await put('.gitignore', '*.tmp\nignored/\n!keep.tmp\n');
  await put('lib/.gitignore', 'secret.lua\n!keep.tmp\n');
  await put('main.lua', 'print("hello")'); await put('lib/data.bin', Buffer.from([0, 255, 128]));
  await put('empty', ''); await put('keep.tmp', 'included'); await put('lib/keep.tmp', 'included');
  await put('drop.tmp', 'ignored'); await put('lib/secret.lua', 'ignored'); await put('ignored/main.lua', 'ignored');
  await put('.git/config', 'ignored');
  await symlink(path.join(root, 'main.lua'), path.join(root, 'linked.lua'));
  await symlink(path.join(root, 'lib'), path.join(root, 'linked-dir'));
  const status = await start();
  assert.equal(status.status, 'idle');
  assert.deepEqual([...peer.files.keys()].sort(), ['/project/.gitignore', '/project/empty', '/project/keep.tmp', '/project/lib/.gitignore', '/project/lib/data.bin', '/project/lib/keep.tmp', '/project/main.lua']);
  assert.deepEqual(peer.files.get('/project/lib/data.bin'), Buffer.from([0, 255, 128]));
  assert.ok(peer.directories.has('/project/lib'));
  assert.equal((await start()).lastRun?.uploaded, 0);
  assert.equal(peer.mutations.length, 7);
});

test('first-sync collisions pause in path order; local resolution then continue applies the remaining files', async t => {
  const { peer, sync, put, start } = await fixture(t);
  await put('a.lua', 'local'); await put('z.lua', 'later');
  peer.files.set('/project/a.lua', Buffer.from('remote'));
  const status = await start();
  assert.equal(status.status, 'conflict'); assert.equal(peer.mutations.length, 0);
  const conflict = await sync.readConflict(status.syncId, 'text');
  assert.equal(conflict.baseline.content, null); assert.equal(conflict.remote.content, 'remote');
  const resolved = await sync.resolve(status.syncId, 'local') as Status;
  assert.equal(resolved.status, 'paused'); assert.equal(peer.files.get('/project/a.lua')!.toString(), 'local');
  assert.equal(peer.files.has('/project/z.lua'), false);
  assert.equal((await sync.resume(status.syncId) as Status).status, 'idle');
  assert.equal(peer.files.get('/project/z.lua')!.toString(), 'later');
});

test('remote and merged resolutions update both copies; stale resolutions refresh the conflict instead of overwriting', async t => {
  const { root, peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const { syncId } = await start();
  await put('file', 'local'); peer.files.set('/project/file', Buffer.from('remote'));
  assert.equal((await start()).status, 'conflict');
  peer.files.set('/project/file', Buffer.from('new remote'));
  assert.equal((await sync.resolve(syncId, 'local') as Status).status, 'conflict');
  assert.equal((await sync.readConflict(syncId, 'text')).remote.content, 'new remote');
  await sync.resolve(syncId, 'remote');
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'new remote');
  await sync.resume(syncId);
  await put('file', 'local again'); peer.files.set('/project/file', Buffer.from('remote again'));
  await start(); await sync.resolve(syncId, 'merged', Buffer.from([0, 128, 255]));
  assert.deepEqual(await readFile(path.join(root, 'file')), Buffer.from([0, 128, 255]));
  assert.deepEqual(peer.files.get('/project/file'), Buffer.from([0, 128, 255]));
  assert.equal((await sync.resume(syncId) as Status).status, 'idle');
});

test('sync history survives restart and detects edits made while the MCP was offline', async t => {
  const { root, peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const status = await start(); await sync.close();
  const restarted = new FolderSync(() => peer);
  t.after(() => restarted.close());
  peer.files.set('/project/file', Buffer.from('in-game edit'));
  const next = await restarted.start('computer', root, '/project') as Status;
  assert.equal(next.syncId, status.syncId); assert.equal(next.status, 'conflict');
  assert.equal((await restarted.readConflict(next.syncId, 'text')).baseline.content, 'base');
  assert.equal(peer.mutations.length, 1);
});

test('optional deletions preserve remote-only and ignored files, and conflict on edited remote copies', async t => {
  const { root, peer, sync, put, start } = await fixture(t);
  await put('keep', 'base'); await put('remove', 'base'); await put('ignored', 'base');
  const { syncId } = await start();
  peer.files.set('/project/remote-only', Buffer.from('keep'));
  await rm(path.join(root, 'remove')); await rm(path.join(root, 'keep')); await rm(path.join(root, 'ignored'));
  await put('.gitignore', 'ignored\n');
  await start(); assert.ok(peer.files.has('/project/remove'));
  peer.files.set('/project/keep', Buffer.from('edited'));
  assert.equal((await start(true)).status, 'conflict');
  await sync.resolve(syncId, 'remote');
  assert.equal(await readFile(path.join(root, 'keep'), 'utf8'), 'edited');
  await sync.resume(syncId);
  assert.equal(peer.files.has('/project/remove'), false);
  assert.ok(peer.files.has('/project/remote-only')); assert.ok(peer.files.has('/project/ignored'));
  // Accepting a remote deletion explicitly removes the local file.
  peer.files.delete('/project/keep'); await put('keep', 'local edit');
  await start(true); await sync.resolve(syncId, 'remote');
  await assert.rejects(readFile(path.join(root, 'keep')), /ENOENT/);
});

test('lost mutation acknowledgments persist intent and require inspection, never automatic replay', async t => {
  const { root, peer, sync, put, start } = await fixture(t);
  await put('file', 'new');
  peer.afterWrite = () => { throw new Error('Write timed out; transactionId: ' + 'a'.repeat(32)); };
  const failed = await start();
  assert.equal(failed.status, 'paused'); assert.ok(failed.pending); assert.match(failed.error!, /transactionId/);
  await sync.close(); peer.afterWrite = undefined;
  const restarted = new FolderSync(() => peer); t.after(() => restarted.close());
  const loaded = await restarted.start('computer', root, '/project') as Status;
  assert.equal(loaded.status, 'paused'); assert.equal(peer.mutations.length, 1);
  assert.equal((await restarted.resume(loaded.syncId) as Status).status, 'conflict');
  const conflict = await restarted.readConflict(loaded.syncId, 'text');
  assert.equal(conflict.unconfirmedIntent?.content, 'new');
  assert.equal(peer.mutations.length, 1);
  await restarted.resolve(loaded.syncId, 'remote'); await restarted.resume(loaded.syncId);
  assert.equal(peer.mutations.length, 1);
});

test('remote edits racing a push are rejected at commit and become explicit conflicts on continue', async t => {
  const { peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const { syncId } = await start(); await put('file', 'local');
  peer.beforeWrite = () => peer.files.set('/project/file', Buffer.from('race'));
  assert.equal((await start()).status, 'paused');
  assert.equal(peer.files.get('/project/file')!.toString(), 'race');
  peer.beforeWrite = undefined;
  assert.equal((await sync.resume(syncId) as Status).status, 'conflict');
  assert.equal((await sync.readConflict(syncId, 'text')).remote.content, 'race');
});

test('watchers push changes, pause on disconnect, require continue, and stop cleanly', async t => {
  const { peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const { syncId } = await start(false, true);
  await put('file', 'watched');
  await until(() => peer.files.get('/project/file')?.toString() === 'watched');
  peer.online = false;
  await until(() => (sync.status(syncId) as Status).status === 'paused');
  await put('file', 'offline edit'); peer.online = true;
  await delay(100); assert.equal(peer.files.get('/project/file')!.toString(), 'watched');
  await sync.resume(syncId);
  assert.equal(peer.files.get('/project/file')!.toString(), 'offline edit');
  await sync.stop(syncId); await put('file', 'after stop'); await delay(100);
  assert.equal(peer.files.get('/project/file')!.toString(), 'offline edit');
  assert.equal((sync.status(syncId) as Status).watcherActive, false);
});

test('watchers pause at conflicts and never resume merely because a local file changes', async t => {
  const { peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const { syncId } = await start(false, true);
  peer.files.set('/project/file', Buffer.from('remote')); await put('file', 'local');
  await until(() => (sync.status(syncId) as Status).status === 'conflict');
  await put('file', 'manually edited'); await delay(100);
  assert.equal(peer.files.get('/project/file')!.toString(), 'remote');
  await sync.resolve(syncId, 'local'); // Refreshes stale local conflict.
  await sync.resolve(syncId, 'local');
  assert.equal((sync.status(syncId) as Status).watcherActive, false);
  await sync.resume(syncId);
  assert.equal((sync.status(syncId) as Status).watcherActive, true);
});

test('symlink replacements are not deleted remotely and invalid remote paths fail before mutation', async t => {
  const { root, peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); await start();
  await rm(path.join(root, 'file')); await symlink('/etc/hosts', path.join(root, 'file'));
  await start(true); assert.equal(peer.files.get('/project/file')!.toString(), 'base');
  await assert.rejects(sync.start('computer', root, '/../outside'), /Invalid remote/);
  assert.equal(peer.mutations.length, 1);
});

test('bounded sync starts return a running job ID and stop waits only for the current file', async t => {
  const { root, peer, sync, put } = await fixture(t);
  await put('a', 'one'); await put('b', 'two');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const write = peer.write.bind(peer);
  let entered = false;
  peer.write = async (...args) => { entered = true; await blocked; await write(...args); };
  const started = await sync.start('computer', root, '/project', false, false, 0) as Status;
  assert.equal(started.status, 'running');
  await until(() => entered);
  const stopped = sync.stop(started.syncId);
  release(); await stopped;
  assert.deepEqual(peer.mutations, ['write:/project/a']);
  assert.equal((sync.status(started.syncId) as Status).status, 'stopped');
});

test('changing a local conflict after inspection cannot be overwritten by a stale remote choice', async t => {
  const { root, peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const { syncId } = await start();
  peer.files.set('/project/file', Buffer.from('remote')); await start();
  await put('file', 'new local');
  const result = await sync.resolve(syncId, 'remote') as Status;
  assert.equal(result.status, 'conflict');
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'new local');
  assert.equal((await sync.readConflict(syncId, 'text')).local.content, 'new local');
});

test('a reconnect between watcher polls still pauses sync until explicit continuation', async t => {
  const { peer, sync, put, start } = await fixture(t);
  await put('file', 'base'); const { syncId } = await start(false, true);
  // Simulate losing and regaining a connection entirely between poll ticks.
  peer.generation = 'replacement';
  await put('file', 'changed');
  await until(() => (sync.status(syncId) as Status).status === 'paused');
  assert.equal(peer.files.get('/project/file')!.toString(), 'base');
  await sync.resume(syncId);
  assert.equal(peer.files.get('/project/file')!.toString(), 'changed');
});
