export const DEBUG_EVENT_WARNING = 'Synthetic debugging event: players cannot inject arbitrary events through normal in-game controls. Successful handling does not prove normal gameplay can produce it.';
export const MAX_EVENT_BYTES = 32 * 1024;

/** JSON-to-Lua values with byte-preserving strings and explicit nil nodes. */
export function encodeDebugEvent(name: string, args: unknown[]) {
  if (!name || name.length > 128 || name.includes('\0') || name.startsWith('cc_mcp_')) throw new Error('Event name must be 1–128 non-NUL bytes; cc_mcp_ names are reserved');
  if (args.length > 32) throw new Error('Events accept at most 32 arguments');
  let nodes = 0, bytes = 0;
  const text = (value: string) => {
    if (value.length > 4096 || [...value].some(c => c.codePointAt(0)! > 255)) throw new Error('Event strings must contain at most 4096 single-byte characters (U+0000–U+00FF)');
    bytes += value.length;
    if (bytes > MAX_EVENT_BYTES) throw new Error('Event exceeds 32 KiB');
    return Buffer.from(value, 'latin1').toString('base64');
  };
  function encode(value: unknown, depth: number): unknown {
    if (++nodes > 1024 || depth > 8) throw new Error('Event exceeds 1024 values or 8 nesting levels');
    if (value === null) return { type: 'nil' };
    if (typeof value === 'string') return { type: 'string', value: text(value) };
    if (typeof value === 'boolean') return { type: 'boolean', value };
    if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
    if (typeof value === 'object' && value !== null) {
      const entries = Array.isArray(value) ? value.map((item, i) => [i + 1, item]) : Object.entries(value);
      return { type: 'table', entries: entries.map(([key, item]) => [encode(key, depth + 1), encode(item, depth + 1)]) };
    }
    throw new Error('Event arguments must be JSON values with finite numbers');
  }
  const wire = { name64: text(name), arguments: args.map(value => encode(value, 0)) };
  if (Buffer.byteLength(JSON.stringify(wire)) > MAX_EVENT_BYTES - 128) throw new Error('Encoded event exceeds 32 KiB');
  return wire;
}
