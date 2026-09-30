import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MAX_FILE_BYTES } from './session.js';
import { hash, LocalFolder, MAX_SYNC_BYTES, MAX_SYNC_FILES, pack, unpack, validateRelative } from './sync-files.js';

export interface SyncPeer {
  connectionKey?(): string;
  requireSyncReady(): void;
  exclusive<T>(action: () => Promise<T>): Promise<T>;
  readOptional(path: string): Promise<Buffer | null>;
  makeDirectory(path: string): Promise<unknown>;
  write(path: string, data: Buffer, expectedHash?: string, mustNotExist?: boolean): Promise<unknown>;
  deleteFile(path: string, expectedHash: string): Promise<unknown>;
}

const bytes = z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const version = bytes.nullable();
const conflictSchema = z.object({ path: z.string(), reason: z.string(), baseline: version, local: version, remote: version });
const stateSchema = z.object({
  version: z.literal(1), name: z.string(), localRoot: z.string(), remoteRoot: z.string(),
  deleteRemoved: z.boolean(), watch: z.boolean(),
  status: z.enum(['idle', 'running', 'conflict', 'paused', 'stopped']),
  base: z.array(z.object({ path: z.string(), data: bytes })).max(MAX_SYNC_FILES),
  conflict: conflictSchema.nullable(),
  pending: z.object({ path: z.string(), desired: version, local: version, remote: version }).nullable(),
  error: z.string().optional(), updatedAt: z.string(),
});
type SyncState = z.infer<typeof stateSchema>;
type Job = {
  id: string; folder: LocalFolder; state: SyncState; queue: Promise<unknown>;
  timer?: NodeJS.Timeout; stop: boolean; ticking: boolean; fingerprint?: string;
  connectionKey?: string;
  lastRun?: { uploaded: number; deleted: number; unchanged: number; kept: number };
};

function remoteRoot(value: string) {
  if (/[\\\x00-\x1f]/.test(value) || value.split('/').includes('..') || [...value].some(c => c.codePointAt(0)! > 255)) throw new Error('Invalid remote sync directory');
  return path.posix.resolve('/', value);
}
const fingerprint = (files: Map<string, Buffer>) => createHash('sha256').update(JSON.stringify([...files].map(([file, data]) => [file, hash(data)]).sort())).digest('hex');
const describe = (value: string | null) => ({ exists: value !== null, hash: hash(unpack(value)), bytes: value === null ? 0 : Buffer.from(value, 'base64').length });

/** Explicit push/resolve/continue state machine. Watchers never resume paused jobs. */
export class FolderSync {
  private jobs = new Map<string, Job>();
  private starts: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly peer: (name: string) => SyncPeer, private readonly intervalMs = 1000) {}

  private locked<T>(job: Job, action: () => Promise<T>): Promise<T> {
    const result = job.queue.then(action);
    job.queue = result.catch(() => {});
    return result;
  }

  private async save(job: Job, state = job.state) {
    state.updatedAt = new Date().toISOString();
    await job.folder.save(job.id, state);
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown sync ID. After MCP restart, call sync_folder with the same name and paths to load its history.');
    return job;
  }

  status(id?: string): unknown {
    const summary = (job: Job) => ({
      syncId: job.id, name: job.state.name, localPath: job.folder.root, remotePath: job.state.remoteRoot,
      status: job.state.status, watch: job.state.watch, watcherActive: !!job.timer && job.state.status === 'idle',
      deleteRemoved: job.state.deleteRemoved, trackedFiles: job.state.base.length, updatedAt: job.state.updatedAt,
      error: job.state.error, lastRun: job.lastRun,
      pending: job.state.pending ? { path: job.state.pending.path, outcome: 'unconfirmed; inspect and explicitly resolve before continuing' } : undefined,
      conflict: job.state.conflict ? { path: job.state.conflict.path, reason: job.state.conflict.reason,
        baseline: describe(job.state.conflict.baseline), local: describe(job.state.conflict.local), remote: describe(job.state.conflict.remote) } : undefined,
    });
    return id ? summary(this.get(id)) : [...this.jobs.values()].map(summary);
  }

  start(name: string, localPath: string, remotePath = '/', deleteRemoved = false, watch = false, waitMs?: number): Promise<unknown> {
    // Serialize setup as well as individual jobs so simultaneous first calls cannot
    // load the same history twice and launch competing writers.
    const result = this.starts.then(async () => {
      if (this.closed) throw new Error('Sync manager is closed');
      const folder = await LocalFolder.at(localPath), root = remoteRoot(remotePath);
      const id = createHash('sha256').update(JSON.stringify([folder.root, name, root])).digest('hex').slice(0, 32);
      let job = this.jobs.get(id);
      if (!job) {
        if (this.jobs.size >= 16) throw new Error('Maximum of 16 sync jobs per MCP process');
        const saved = await folder.load(id);
        const state: SyncState = saved === null ? {
          version: 1, name, localRoot: folder.root, remoteRoot: root, deleteRemoved, watch,
          status: 'idle', base: [], conflict: null, pending: null, updatedAt: new Date().toISOString(),
        } : stateSchema.parse(saved);
        if (state.name !== name || state.localRoot !== folder.root || state.remoteRoot !== root) throw new Error('Sync history target mismatch');
        const paths = new Set<string>();
        let total = 0;
        for (const entry of state.base) {
          validateRelative(entry.path);
          if (paths.has(entry.path)) throw new Error('Duplicate paths in sync history');
          paths.add(entry.path); total += Buffer.from(entry.data, 'base64').length;
        }
        if (total > MAX_SYNC_BYTES) throw new Error('Sync history exceeds 16 MiB');
        if (state.conflict) validateRelative(state.conflict.path);
        if (state.pending) validateRelative(state.pending.path);
        // A process may have stopped between the remote mutation and checkpoint.
        if (saved !== null && (state.status === 'running' || state.pending)) state.status = 'paused';
        job = { id, folder, state, queue: Promise.resolve(), stop: false, ticking: false };
        this.jobs.set(id, job);
      }
      const current = job;
      const operation = this.locked(current, async () => {
        clearInterval(current.timer); current.timer = undefined;
        current.state.watch = watch;
        current.state.deleteRemoved = deleteRemoved;
        const shouldRun = current.state.status !== 'paused' && !current.state.conflict && !current.state.pending;
        if (shouldRun) current.state.status = 'running';
        await this.save(current);
        if (!shouldRun) return this.status(id);
        current.stop = false;
        await this.run(current);
        this.arm(current);
        return this.status(id);
      });
      if (waitMs === undefined) return operation;
      await Promise.race([operation, delay(waitMs)]);
      return this.status(id);
    });
    this.starts = result.catch(() => {});
    return result;
  }

  private arm(job: Job) {
    clearInterval(job.timer); job.timer = undefined;
    if (this.closed || job.stop || !job.state.watch || job.state.status !== 'idle') return;
    job.timer = setInterval(() => {
      if (job.ticking || job.state.status !== 'idle') return;
      job.ticking = true;
      void this.locked(job, async () => {
        if (job.stop || job.state.status !== 'idle') return;
        try {
          const peer = this.peer(job.state.name);
          peer.requireSyncReady();
          if (peer.connectionKey?.() !== job.connectionKey) throw new Error('Computer reconnected; explicitly continue sync before further changes');
          const scan = await job.folder.scan();
          if (peer.connectionKey?.() !== job.connectionKey) throw new Error('Computer reconnected during scan; explicitly continue sync');
          if (fingerprint(scan.files) !== job.fingerprint) await this.run(job, scan);
        } catch (error) { await this.pause(job, error); }
      }).catch(error => {
        job.state.status = 'paused'; job.state.error = String(error);
        clearInterval(job.timer); job.timer = undefined;
      }).finally(() => { job.ticking = false; });
    }, this.intervalMs);
    job.timer.unref();
  }

  private async pause(job: Job, error: unknown) {
    job.state.status = 'paused';
    job.state.error = error instanceof Error ? error.message : String(error);
    clearInterval(job.timer); job.timer = undefined;
    await this.save(job);
  }

  private base(job: Job, file: string) {
    return job.state.base.find(entry => entry.path === file)?.data ?? null;
  }

  private nextBase(job: Job, file: string, data: Buffer | null) {
    const base = job.state.base.filter(entry => entry.path !== file);
    if (data !== null) base.push({ path: file, data: data.toString('base64') });
    if (base.length > MAX_SYNC_FILES || base.reduce((sum, entry) => sum + Buffer.from(entry.data, 'base64').length, 0) > MAX_SYNC_BYTES) {
      throw new Error('Retained sync baseline exceeds 1000 files / 16 MiB');
    }
    return base;
  }

  private async checkpoint(job: Job, file: string, data: Buffer | null) {
    const next = { ...job.state, base: this.nextBase(job, file, data), pending: null };
    await this.save(job, next);
    job.state = next;
  }

  private destination(job: Job, file: string) {
    validateRelative(file);
    const result = path.posix.join(job.state.remoteRoot, file);
    if (result.length > 4095) throw new Error('Remote sync path exceeds 4095 bytes');
    return result;
  }

  private async conflict(job: Job, file: string, local: Buffer | null, remote: Buffer | null, reason: string) {
    job.state.status = 'conflict'; job.state.error = undefined;
    job.state.conflict = { path: file, baseline: this.base(job, file), local: pack(local), remote: pack(remote), reason };
    clearInterval(job.timer); job.timer = undefined;
    await this.save(job);
  }

  private async apply(job: Job, peer: SyncPeer, file: string, local: Buffer | null, remote: Buffer | null, desired: Buffer | null, replaceLocal: boolean) {
    this.nextBase(job, file, desired); // Check retained-history bounds before any mutation.
    if (hash(await job.folder.read(file)) !== hash(local)) throw new Error(`Local file changed before sync: ${file}`);
    job.state.pending = { path: file, desired: pack(desired), local: pack(local), remote: pack(remote) };
    await this.save(job); // Durable intent before a remote or local mutation.
    if (hash(desired) !== hash(remote)) {
      const destination = this.destination(job, file);
      if (desired === null) await peer.deleteFile(destination, hash(remote)!);
      else {
        await peer.makeDirectory(path.posix.dirname(destination));
        await peer.write(destination, desired, hash(remote) ?? undefined, remote === null);
      }
    }
    if (replaceLocal && hash(local) !== hash(desired)) {
      peer.requireSyncReady();
      await job.folder.replace(file, local, desired);
    }
    await this.checkpoint(job, file, desired);
  }

  private async run(job: Job, snapshot?: Awaited<ReturnType<LocalFolder['scan']>>) {
    try {
      this.peer(job.state.name).requireSyncReady();
      job.connectionKey = this.peer(job.state.name).connectionKey?.();
      job.state.status = 'running'; job.state.error = undefined;
      await this.save(job);
      const scan = snapshot ?? await job.folder.scan();
      const counts = job.lastRun = { uploaded: 0, deleted: 0, unchanged: 0, kept: 0 };
      const files = [...new Set([...scan.files.keys(), ...job.state.base.map(entry => entry.path)])].sort();
      for (const file of files) {
        if (job.stop || this.closed) break;
        if (!scan.eligible(file)) { counts.kept++; continue; }
        const local = scan.files.get(file) ?? null;
        if (local === null && !job.state.deleteRemoved) { counts.kept++; continue; }
        const peer = this.peer(job.state.name);
        await peer.exclusive(async () => {
          peer.requireSyncReady();
          if (peer.connectionKey?.() !== job.connectionKey) throw new Error('Connection changed during sync; explicitly continue');
          const remote = await peer.readOptional(this.destination(job, file));
          if (hash(local) === hash(remote)) {
            if (pack(local) !== this.base(job, file)) await this.checkpoint(job, file, local);
            counts.unchanged++;
          } else if (hash(remote) !== hash(unpack(this.base(job, file)))) {
            await this.conflict(job, file, local, remote, 'Remote contents differ from the last synced version');
          } else {
            await this.apply(job, peer, file, local, remote, local, false);
            if (local === null) counts.deleted++; else counts.uploaded++;
          }
        });
        if (job.state.conflict) return;
      }
      job.fingerprint = fingerprint(scan.files);
      job.state.status = job.stop || this.closed ? 'stopped' : 'idle';
      await this.save(job);
    } catch (error) { await this.pause(job, error); }
  }

  async readConflict(id: string, encoding: 'text' | 'base64') {
    const job = this.get(id);
    return this.locked(job, async () => {
      const conflict = job.state.conflict;
      if (!conflict) throw new Error('No conflict is ready. If a write is unconfirmed, call continue_sync to inspect current versions without replaying it.');
      const content = (value: string | null) => ({ ...describe(value), content: value === null ? null : unpack(value)!.toString(encoding === 'text' ? 'latin1' : 'base64') });
      return { syncId: id, path: conflict.path, reason: conflict.reason, encoding,
        unconfirmedIntent: job.state.pending ? content(job.state.pending.desired) : undefined,
        baseline: content(conflict.baseline), local: content(conflict.local), remote: content(conflict.remote) };
    });
  }

  async resolve(id: string, choice: 'local' | 'remote' | 'merged', merged?: Buffer) {
    const job = this.get(id);
    return this.locked(job, async () => {
      const conflict = job.state.conflict;
      if (!conflict) throw new Error('No conflict to resolve');
      if (choice === 'merged' && (!merged || merged.length > MAX_FILE_BYTES)) throw new Error('Merged resolution requires contents up to 1 MiB');
      try {
        const scan = await job.folder.scan();
        if (!scan.eligible(conflict.path)) throw new Error('Conflict path is now ignored or a symlink; restore its eligibility before resolving');
        const peer = this.peer(job.state.name);
        await peer.exclusive(async () => {
          peer.requireSyncReady();
          const local = await job.folder.read(conflict.path), remote = await peer.readOptional(this.destination(job, conflict.path));
          if (hash(local) !== hash(unpack(conflict.local)) || hash(remote) !== hash(unpack(conflict.remote))) {
            await this.conflict(job, conflict.path, local, remote, 'Contents changed since conflict inspection; inspect again before resolving');
            return;
          }
          const desired = choice === 'local' ? local : choice === 'remote' ? remote : merged!;
          await this.apply(job, peer, conflict.path, local, remote, desired, true);
          job.state.conflict = null;
          job.state.status = 'paused'; job.state.error = 'Resolution saved. Call continue_sync to process remaining files and resume watching.';
          await this.save(job);
        });
      } catch (error) { await this.pause(job, error); }
      return this.status(id);
    });
  }

  async resume(id: string, waitMs?: number) {
    const job = this.get(id);
    const operation = this.locked(job, async () => {
      if (this.closed) throw new Error('Sync manager is closed');
      job.stop = false;
      if (job.state.pending) {
        // An acknowledgment/checkpoint was lost. Observe, then require an explicit
        // choice even if the destination already happens to equal the intent.
        try {
          const file = job.state.pending.path, peer = this.peer(job.state.name);
          await peer.exclusive(async () => {
            peer.requireSyncReady();
            await this.conflict(job, file, await job.folder.read(file), await peer.readOptional(this.destination(job, file)), 'Previous mutation was not checkpointed; inspect both versions and resolve explicitly');
          });
        } catch (error) { await this.pause(job, error); }
      } else if (!job.state.conflict) {
        await this.run(job);
        this.arm(job);
      } else {
        job.state.status = 'conflict';
        await this.save(job);
      }
      return this.status(id);
    });
    if (waitMs === undefined) return operation;
    await Promise.race([operation, delay(waitMs)]);
    return this.status(id);
  }

  async stop(id: string) {
    const job = this.get(id);
    job.stop = true;
    clearInterval(job.timer); job.timer = undefined;
    return this.locked(job, async () => {
      job.state.status = 'stopped';
      await this.save(job);
      return this.status(id);
    });
  }

  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) { job.stop = true; clearInterval(job.timer); job.timer = undefined; }
    await this.starts.catch(() => {});
    await Promise.all([...this.jobs.values()].map(job => job.queue));
  }
}
