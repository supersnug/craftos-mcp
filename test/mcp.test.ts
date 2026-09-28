import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';

test('MCP handshake exposes tools and returns actionable tool errors', async t => {
  const { server, sessions } = createServer();
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { sessions.close(); await client.close(); await server.close(); });
  await server.connect(a);
  await client.connect(b);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  assert.ok(tools.some(tool => tool.name === 'edit_file'));
  const result = await client.callTool({ name: 'read_file', arguments: { name: 'missing', path: 'test.lua' } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Unknown computer/);
  const list = await client.callTool({ name: 'list_computers', arguments: {} });
  assert.equal(list.isError, undefined);
  assert.deepEqual(list.content, [{ type: 'text', text: '[]' }]);
});

test('compiled entry point completes an MCP stdio handshake and shuts down cleanly', async t => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 13);
});
