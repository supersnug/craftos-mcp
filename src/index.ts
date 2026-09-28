#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const { server, sessions } = createServer();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  sessions.close();
  await server.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
const transport = new StdioServerTransport();
await server.connect(transport);
// SDK owns the transport's onclose callback; use the server callback for cleanup.
server.server.onclose = () => sessions.close();
