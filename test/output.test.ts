import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTPUT_BUDGET, OutputHistory } from '../src/output.js';
import { decodeOutput } from '../src/protocol.js';

test('live progress replaces its row and commits only the final line', () => {
  const output = new OutputHistory();
  output.accept(1, 2, { text: '0%' });
  output.accept(1, 2, { text: '50%' });
  assert.deepEqual(output.read().liveLines, [{ row: 2, text: '50%' }]);
  assert.equal(output.read().nextCursor, 0);
  output.accept(0, 2, { text: '100%' });
  const page = output.read();
  assert.equal(page.text, '100%\n');
  assert.equal(page.liveLines.length, 0);
  assert.equal(output.read(page.nextCursor).text, '');
});

test('command-filtered pagination advances across unrelated lines without duplicates', () => {
  const output = new OutputHistory();
  output.accept(0, 1, { text: '> run' });
  output.accept(0, 2, { text: 'one', commandId: 'a' });
  output.accept(0, 3, { text: 'other', commandId: 'b' });
  output.accept(0, 4, { text: 'two', commandId: 'a' });
  output.accept(0, 5, { text: '> ' });
  const first = output.read(0, 'a', 1);
  assert.equal(first.text, 'one\n');
  assert.equal(first.hasMore, true);
  const second = output.read(first.nextCursor, 'a', 1);
  assert.equal(second.text, 'two\n');
  assert.equal(second.nextCursor, 5);
  assert.equal(second.hasMore, false);
  assert.equal(output.read(second.nextCursor, 'a').text, '');
  assert.equal(output.hasCommand('a'), true);
  assert.equal(output.hasCommand('absent'), false);
  assert.throws(() => output.read(6), /cursor/);
});

test('rolling budget bounds blank-line metadata as well as text and reports expired cursors', () => {
  const output = new OutputHistory();
  for (let i = 0; i < 15000; i++) output.accept(0, 1, { text: '' });
  const page = output.read();
  assert.equal(page.budgetBytes, OUTPUT_BUDGET);
  assert.ok(page.retainedBytes <= OUTPUT_BUDGET);
  assert.equal(page.truncated, true);
  assert.ok(page.droppedThroughCursor > 0);
  assert.equal(output.read(page.droppedThroughCursor).truncated, false);
});

test('live row retention and response limits report truncation explicitly', () => {
  const output = new OutputHistory(400);
  output.accept(1, 1, { text: 'x'.repeat(200) });
  output.accept(1, 2, { text: 'y'.repeat(200) });
  const page = output.read();
  assert.equal(page.droppedLiveLines, 1);
  assert.equal(page.liveLines[0].row, 2);
  assert.ok(page.retainedBytes <= 400);
  const large = new OutputHistory();
  large.accept(0, 1, { text: 'a'.repeat(65535) });
  large.accept(0, 2, { text: 'b' });
  large.accept(1, 3, { text: 'c' });
  const first = large.read();
  assert.equal(first.text.length, 65536);
  assert.equal(first.hasMore, true);
  assert.equal(first.liveTruncated, true);
  assert.equal(large.read(first.nextCursor).text, 'b\n');
});

test('output packet decoder preserves binary text and rejects malformed batches', () => {
  const header = Buffer.from([69, 0, 1, 1, 0, 0, 2, 0, 0, 3, 0, 0, 0]);
  const data = Buffer.concat([header, Buffer.from([0, 128, 255])]);
  assert.deepEqual(decodeOutput(data), [{ kind: 0, row: 2, commandId: undefined, text: '\0\x80\xff' }]);
  assert.throws(() => decodeOutput(data.subarray(0, -1)), /length/);
  assert.throws(() => decodeOutput(Buffer.concat([data, Buffer.from([0])])), /Trailing/);
});
