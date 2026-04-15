import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApprovalHandler } from '../../src/approval-handler.js';
import { ApprovalManager } from '../../src/approval-manager.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';

describe('审批链路集成', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: net.Server;
  let approvalMgr: ApprovalManager;
  let mockIM: MockIMPlugin;
  let handler: ApprovalHandler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-approval-test-'));
    socketPath = path.join(tmpDir, 'approval.sock');

    approvalMgr = new ApprovalManager({
      autoAllowCapabilities: [],
      autoAskCapabilities: ['bash', 'computer'],
      autoDenyCapabilities: [],
      autoDenyPatterns: [],
      timeoutSeconds: 5,
    });

    mockIM = new MockIMPlugin();

    handler = new ApprovalHandler({
      socketPath,
      approvalManager: approvalMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
    });

    server = await handler.listen();
  });

  afterEach(async () => {
    await handler.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('mock worker 发送 can_use_tool → IM 收到审批请求 → 批准 → worker 收到 allow', async () => {
    const canUseToolRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'can_use_tool',
        arguments: {
          tool_name: 'bash',
          tool_input: { command: 'ls -la' },
          session_id: 'sess-approval-test',
          message_id: 'msg-1',
          tool_use_id: 'tool-1',
        },
      },
    });

    // Connect a mock worker
    const workerSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });

    let response = '';
    workerSocket.on('data', chunk => { response += chunk.toString(); });

    workerSocket.write(canUseToolRequest + '\n');

    // Wait for IM to get the approval request
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockIM.approvalRequests).toHaveLength(1);
    const req = mockIM.approvalRequests[0];
    expect(req.toolName).toBe('bash');

    // Approve the request
    const state = approvalMgr.getAllApprovalStates()[0];
    expect(state).toBeDefined();
    await approvalMgr.decide(state.requestId, { decision: 'approved', scope: 'once' });

    // Wait for worker to receive response
    await new Promise(resolve => setTimeout(resolve, 100));

    workerSocket.destroy();

    const parsed = JSON.parse(response.trim());
    expect(parsed.id).toBe(1);
    expect(parsed.result?.allow).toBe(true);
  }, 15000);

  test('超时后 worker 收到 deny 响应', async () => {
    const shortTimeoutMgr = new ApprovalManager({
      autoAllowCapabilities: [],
      autoAskCapabilities: ['bash'],
      autoDenyCapabilities: [],
      autoDenyPatterns: [],
      timeoutSeconds: 0.2, // 200ms timeout
    });

    const shortHandler = new ApprovalHandler({
      socketPath: path.join(tmpDir, 'short.sock'),
      approvalManager: shortTimeoutMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
    });
    await shortHandler.listen();

    const req = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'can_use_tool',
        arguments: {
          tool_name: 'bash',
          tool_input: { command: 'rm -rf /' },
          session_id: 'sess-timeout',
          message_id: 'msg-2',
          tool_use_id: 'tool-2',
        },
      },
    });

    const workerSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(path.join(tmpDir, 'short.sock'));
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });

    let response = '';
    workerSocket.on('data', chunk => { response += chunk.toString(); });
    workerSocket.write(req + '\n');

    // Wait for timeout (300ms > 200ms timeout)
    await new Promise(resolve => setTimeout(resolve, 400));
    workerSocket.destroy();
    await shortHandler.close();

    const parsed = JSON.parse(response.trim());
    expect(parsed.id).toBe(2);
    expect(parsed.result?.allow).toBe(false);
  }, 15000);
});
