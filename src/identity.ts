import { z } from 'zod';

const bytes = (limit: number) => z.string().max(Math.ceil(limit / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .transform(value => Buffer.from(value, 'base64').toString('latin1')).refine(value => value.length <= limit);
const wireSchema = z.object({
  computerId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  label64: z.union([bytes(256), z.literal(false)]),
  craftos64: bytes(256), host64: z.union([bytes(1024), z.literal(false)]),
  kind: z.enum(['computer', 'turtle', 'pocket', 'command']), color: z.boolean(),
  peripherals: z.array(z.object({
    name64: bytes(256), types64: z.array(bytes(256)).max(32), methods64: z.array(bytes(256)).max(256),
    truncated: z.boolean(), error64: bytes(512).optional(),
  })).max(128),
  totalPeripherals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), truncated: z.boolean(),
});

export function decodeIdentity(data: Buffer) {
  if (data.length > 32768) throw new Error('Oversized computer identity response');
  const wire = wireSchema.parse(JSON.parse(data.toString('utf8')));
  if (wire.totalPeripherals < wire.peripherals.length) throw new Error('Invalid peripheral count');
  const peripherals = wire.peripherals.map(entry => ({ name: entry.name64, types: entry.types64, methods: entry.methods64,
    truncated: entry.truncated, error: entry.error64 }));
  if (new Set(peripherals.map(entry => entry.name)).size !== peripherals.length) throw new Error('Duplicate peripheral names');
  return { computerId: wire.computerId, label: wire.label64 === false ? null : wire.label64,
    craftosVersion: wire.craftos64, host: wire.host64 === false ? null : wire.host64,
    kind: wire.kind, isTurtle: wire.kind === 'turtle', color: wire.color, peripherals,
    totalPeripherals: wire.totalPeripherals, truncated: wire.truncated || peripherals.some(entry => entry.truncated) || wire.totalPeripherals > peripherals.length };
}
export type ComputerIdentity = ReturnType<typeof decodeIdentity>;
