#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { Sessions } from './session.js';
import { ConnectionProfiles, defaultProfilePath } from './profiles.js';

const { server, sessions, syncs } = createServer(new Sessions(new ConnectionProfiles(defaultProfilePath())));
sessions.restore();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  sessions.close();
  await syncs.close();
  await server.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
const transport = new StdioServerTransport();
await server.connect(transport);
// SDK owns the transport's onclose callback; use the server callback for cleanup.
server.server.onclose = () => { sessions.close(); void syncs.close(); };
