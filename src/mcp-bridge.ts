import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const MM_CODER_BRIDGE_SERVER_NAME = 'mm_coder_bridge';
export const MM_CODER_PERMISSION_TOOL_NAME = `mcp__${MM_CODER_BRIDGE_SERVER_NAME}__can_use_tool`;

const BRIDGE_TEMPLATE = `#!/usr/bin/env node
'use strict';

const net = require('net');
const readline = require('readline');

const SOCKET_PATH = '__SOCKET_PATH__';
const SESSION_ID = '__SESSION_ID__';
const SERVER_NAME = '__SERVER_NAME__';
const TOOL_NAME = 'can_use_tool';

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function proxyCall(id, args) {
  const client = net.createConnection(SOCKET_PATH, () => {
    client.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: TOOL_NAME,
        arguments: {
          ...args,
          session_id: SESSION_ID,
        },
      },
    }) + '\\n');
  });

  let buffer = '';
  client.on('data', chunk => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        write(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf('\\n');
    }
  });

  client.on('error', err => {
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  });

  client.on('close', () => {
    if (buffer.trim()) {
      write(JSON.parse(buffer.trim()));
    }
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;

  const req = JSON.parse(line);

  if (req.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.1.0' },
      },
    });
    return;
  }

  if (req.method === 'notifications/initialized') {
    return;
  }

  if (req.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [{
          name: TOOL_NAME,
          description: 'Bridge mm-coder approval checks to daemon ApprovalHandler',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_input: { type: 'object' },
              message_id: { type: 'string' },
              tool_use_id: { type: 'string' },
              capability: { type: 'string' },
              operator_id: { type: 'string' },
              correlation_id: { type: 'string' },
            },
            required: ['tool_name'],
          },
        }],
      },
    });
    return;
  }

  if (req.method === 'tools/call' && req.params?.name === TOOL_NAME) {
    proxyCall(req.id, req.params.arguments || {});
    return;
  }

  write({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32601, message: 'Method not found' },
  });
});
`;

export function generateBridgeMcpConfig(scriptPath: string): { mcpServers: Record<string, { command: string; args: string[] }> } {
  return {
    mcpServers: {
      [MM_CODER_BRIDGE_SERVER_NAME]: {
        command: 'node',
        args: [scriptPath],
      },
    },
  };
}

export async function generateBridgeScript(
  sessionId: string,
  socketPath: string,
  dir?: string,
): Promise<string> {
  const outDir = dir ?? os.tmpdir();
  const scriptPath = path.join(outDir, `mcp-bridge-${sessionId}.js`);

  const content = BRIDGE_TEMPLATE
    .replace(/__SESSION_ID__/g, sessionId)
    .replace(/__SOCKET_PATH__/g, socketPath)
    .replace(/__SERVER_NAME__/g, MM_CODER_BRIDGE_SERVER_NAME);

  fs.writeFileSync(scriptPath, content, { mode: 0o600 });

  return scriptPath;
}
