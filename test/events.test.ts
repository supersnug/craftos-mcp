import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeDebugEvent } from '../src/events.js';

test('debug event encoding preserves byte strings, nil arguments, tables and finite scalar types', () => {
  assert.deepEqual(encodeDebugEvent('test', ['\0\xff', null, 1.5, false, { list: [1, null] }, null]), {
    name64: 'dGVzdA==', arguments: [
      { type: 'string', value: 'AP8=' }, { type: 'nil' }, { type: 'number', value: 1.5 }, { type: 'boolean', value: false },
      { type: 'table', entries: [[{ type: 'string', value: 'bGlzdA==' }, { type: 'table', entries: [
        [{ type: 'number', value: 1 }, { type: 'number', value: 1 }], [{ type: 'number', value: 2 }, { type: 'nil' }],
      ] }]] }, { type: 'nil' },
    ],
  });
});

test('debug events reject reserved names, invalid values and bounded payload violations', () => {
  for (const name of ['', 'bad\0name', 'cc_mcp_execute']) assert.throws(() => encodeDebugEvent(name, []), /name/);
  for (const value of [NaN, Infinity, undefined, () => {}]) assert.throws(() => encodeDebugEvent('debug', [value]), /JSON/);
  assert.throws(() => encodeDebugEvent('debug', ['🐢']), /single-byte/);
  assert.throws(() => encodeDebugEvent('debug', ['x'.repeat(4097)]), /4096/);
  assert.throws(() => encodeDebugEvent('debug', Array(33).fill(null)), /32 arguments/);
  assert.throws(() => encodeDebugEvent('debug', [Array(600).fill(1)]), /1024/);
  assert.throws(() => encodeDebugEvent('debug', Array(12).fill('x'.repeat(4096))), /32 KiB/);
  let deep: unknown = 1;
  for (let i = 0; i < 10; i++) deep = [deep];
  assert.throws(() => encodeDebugEvent('debug', [deep]), /nesting/);
});
