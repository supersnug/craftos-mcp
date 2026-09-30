import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const profileSchema = z.object({ name: z.string().min(1).max(80), relay: z.string(), token: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
export type Profile = z.infer<typeof profileSchema>;
export const defaultProfilePath = () => process.env.CRAFTOS_CONNECTIONS_FILE ?? path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'cc-mcp', 'connections.json');

/** Persist only opted-in connections. Commands and mutation requests are never stored. */
export class ConnectionProfiles {
  constructor(readonly file: string) {}

  load(): Profile[] {
    try {
      const contents = readFileSync(this.file, 'utf8');
      if (contents.length > 256 * 1024) throw new Error('Connection profile file is too large');
      const profiles = z.object({ version: z.literal(1), profiles: z.array(profileSchema).max(32) }).parse(JSON.parse(contents)).profiles;
      if (new Set(profiles.map(p => p.name)).size !== profiles.length) throw new Error('Duplicate saved connection names');
      return profiles;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not load connection profiles; inspect CRAFTOS_CONNECTIONS_FILE');
    }
  }

  save(profiles: Profile[]) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, profiles }), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
