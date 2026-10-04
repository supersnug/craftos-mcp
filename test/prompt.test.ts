import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('enhanced prompt editing, completion, rendering and readiness', () => {
  const result = spawnSync(process.env.LUA_BIN ?? 'lua', ['test/prompt.lua'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
