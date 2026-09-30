import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { fileHash, MAX_FILE_BYTES } from './session.js';

export const SYNC_METADATA = '.cc-mcp-sync';
export const MAX_SYNC_FILES = 1000;
export const MAX_SYNC_BYTES = 16 * 1024 * 1024;
export const hash = (data: Buffer | null) => data === null ? null : fileHash(data);
export const pack = (data: Buffer | null) => data === null ? null : data.toString('base64');
export const unpack = (data: string | null) => data === null ? null : Buffer.from(data, 'base64');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function validateRelative(file: string) {
  if (!file || file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === SYNC_METADATA)
    || /[\\\x00-\x1f]/.test(file) || [...file].some(c => c.codePointAt(0)! > 255)) {
    throw new Error(`Unsupported sync path: ${JSON.stringify(file)}`);
  }
}

/** Local byte snapshots, ignore rules, and atomic metadata updates for one root. */
export class LocalFolder {
  private constructor(readonly root: string) {}

  static async at(root: string) {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local_path must be a real directory, not a symlink');
    return new LocalFolder(await realpath(root));
  }

  private async parents(file: string, create = false) {
    validateRelative(file);
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('Local root changed');
    let current = this.root;
    for (const part of file.split('/').slice(0, -1)) {
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return false;
        await mkdir(current);
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Local parent is not a real directory: ${current}`);
    }
    return true;
  }

  async read(file: string): Promise<Buffer | null> {
    if (!await this.parents(file)) return null;
    let handle;
    try { handle = await open(path.join(this.root, file), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`Not a regular local file: ${file}`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`Local file exceeds 1 MiB: ${file}`);
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_FILE_BYTES) throw new Error(`Local file exceeds 1 MiB: ${file}`);
      const after = await handle.stat();
      if (info.size !== size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error(`Local file changed while reading: ${file}`);
      // Do not retain a 1 MiB backing allocation for every tiny project file.
      return Buffer.from(buffer.subarray(0, size));
    } finally { await handle.close(); }
  }

  async scan() {
    const files = new Map<string, Buffer>();
    const rules = new Map<string, Ignore>();
    const blocked = new Set<string>();
    let bytes = 0;
    const eligible = (file: string, directory = false) => {
      const parts = file.split('/');
      if (parts.some(p => p === '.git' || p === SYNC_METADATA || /\.cc-mcp-[a-f0-9]{32}$/.test(p))) return false;
      for (let end = 1; end <= parts.length; end++) {
        const prefix = parts.slice(0, end).join('/');
        if (blocked.has(prefix)) return false;
        const target = prefix + (end < parts.length || directory ? '/' : '');
        let ignored = false;
        for (let start = 0; start < end; start++) {
          const dir = parts.slice(0, start).join('/');
          const rule = rules.get(dir);
          if (!rule) continue;
          const result = rule.test(target.slice(dir ? dir.length + 1 : 0));
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored) return false;
      }
      return true;
    };
    const visit = async (dir: string) => {
      const gitignore = dir ? `${dir}/.gitignore` : '.gitignore';
      try {
        const info = await lstat(path.join(this.root, gitignore));
        if (info.isFile() && !info.isSymbolicLink()) {
          const data = await this.read(gitignore);
          if (data) rules.set(dir, ignore().add(data.toString('utf8')));
        }
      } catch (error) { if (!missing(error)) throw error; }
      for (const entry of await readdir(path.join(this.root, dir), { withFileTypes: true })) {
        const file = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.name === '.git' || entry.name === SYNC_METADATA) continue;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) { blocked.add(file); continue; }
        if (!eligible(file, entry.isDirectory())) { blocked.add(file); continue; }
        validateRelative(file);
        if (entry.isDirectory()) { await this.parents(`${file}/.gitignore`); await visit(file); }
        else {
          const data = await this.read(file);
          if (data === null) throw new Error(`Local file disappeared during scan: ${file}`);
          files.set(file, data);
          bytes += data.length;
          if (files.size > MAX_SYNC_FILES || bytes > MAX_SYNC_BYTES) throw new Error('Folder exceeds sync limits (1000 files / 16 MiB)');
        }
      }
    };
    // Validate the root again before traversing it (it may have changed since setup).
    await this.parents('.gitignore');
    await visit('');
    return { files, eligible };
  }

  async replace(file: string, expected: Buffer | null, contents: Buffer | null) {
    if (hash(await this.read(file)) !== hash(expected)) throw new Error(`Local conflict changed during resolution: ${file}`);
    if (contents === null) {
      if (expected !== null) await unlink(path.join(this.root, file));
      return;
    }
    await this.parents(file, true);
    const destination = path.join(this.root, file);
    const temporary = destination + '.cc-mcp-' + randomBytes(16).toString('hex');
    const mode = expected === null ? 0o666 : (await lstat(destination)).mode & 0o777;
    try {
      const handle = await open(temporary, 'wx', mode);
      try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      if (hash(await this.read(file)) !== hash(expected)) throw new Error(`Local conflict changed during resolution: ${file}`);
      await rename(temporary, destination);
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }

  private async metadata() {
    await this.parents('.gitignore');
    const dir = path.join(this.root, SYNC_METADATA);
    await mkdir(dir, { recursive: true });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Sync metadata directory must not be a symlink');
    return dir;
  }

  async load(id: string): Promise<unknown | null> {
    const dir = await this.metadata();
    try {
      const file = path.join(dir, `${id}.json`);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 48 * 1024 * 1024) throw new Error('Invalid sync history file');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  async save(id: string, data: unknown) {
    const dir = await this.metadata();
    const temporary = path.join(dir, `${id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path.join(dir, `${id}.json`));
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
}
