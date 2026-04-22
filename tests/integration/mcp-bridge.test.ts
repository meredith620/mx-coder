import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { generateBridgeScript, generateBridgeMcpConfig, MM_CODER_BRIDGE_SERVER_NAME, MM_CODER_PERMISSION_TOOL_NAME } from '../../src/mcp-bridge.js';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

describe('MCP Bridge script generation', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-bridge-test-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bridge 脚本携带正确 sessionId', async () => {
    const scriptPath = await generateBridgeScript('sess-abc', socketPath, tmpDir);
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toContain('sess-abc');
  });

  test('bridge 文件权限为 0600', async () => {
    const scriptPath = await generateBridgeScript('sess-xyz', socketPath, tmpDir);
    const stat = fs.statSync(scriptPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('脚本路径包含 sessionId', async () => {
    const scriptPath = await generateBridgeScript('sess-path-test', socketPath, tmpDir);
    expect(scriptPath).toContain('sess-path-test');
  });

  test('生成 mcp config，server 名与 permission tool 名符合 Claude MCP 约定', () => {
    const config = generateBridgeMcpConfig('/tmp/mm-coder-bridge.js');

    expect(config.mcpServers).toEqual({
      [MM_CODER_BRIDGE_SERVER_NAME]: {
        command: 'node',
        args: ['/tmp/mm-coder-bridge.js'],
      },
    });
    expect(MM_CODER_PERMISSION_TOOL_NAME).toBe('mcp__mm_coder_bridge__can_use_tool');
  });

  test('bridge 作为 MCP stdio server 暴露 can_use_tool 并转发到 approval socket', async () => {
    const requests: string[] = [];
    const server = net.createServer(socket => {
      socket.on('data', chunk => {
        requests.push(chunk.toString());
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'allow' }] } }) + '\n');
      });
    });

    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    const scriptPath = await generateBridgeScript('sess-fwd', socketPath, tmpDir);
    const proc = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    proc.stdout.on('data', chunk => stdoutChunks.push(chunk.toString()));
    proc.stderr.on('data', chunk => stderrChunks.push(chunk.toString()));

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'can_use_tool', arguments: { tool_name: 'Edit', tool_input: { path: '/tmp/a.txt' }, message_id: 'msg-1', tool_use_id: 'tool-1' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 400));

    proc.kill('SIGTERM');
    await new Promise<void>(resolve => server.close(() => resolve()));

    const stdout = stdoutChunks.join('');
    const stderr = stderrChunks.join('');
    expect(stderr).toBe('');
    expect(stdout).toContain('"protocolVersion"');
    expect(stdout).toContain('"name":"can_use_tool"');
    expect(stdout).toContain('"type":"text"');
    expect(stdout).toContain('"text":"allow"');
    expect(requests.join('')).toContain('"method":"tools/call"');
    expect(requests.join('')).toContain('"session_id":"sess-fwd"');
  }, 10000);
});
