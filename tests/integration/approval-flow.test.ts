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
      autoAskCapabilities: ['file_write'],
      autoDenyCapabilities: ['shell_dangerous'],
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
          tool_name: 'Edit',
          tool_input: { path: '/tmp/a.txt' },
          session_id: 'sess-approval-test',
          message_id: 'msg-1',
          tool_use_id: 'tool-1',
          capability: 'file_write',
          operator_id: 'user-1',
          correlation_id: 'corr-1',
        },
      },
    });

    const workerSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });

    let response = '';
    workerSocket.on('data', chunk => { response += chunk.toString(); });
    workerSocket.write(canUseToolRequest + '\n');

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockIM.approvalRequests).toHaveLength(1);
    const req = mockIM.approvalRequests[0];
    expect(req.toolName).toBe('Edit');
    expect(req.capability).toBe('file_write');
    expect(req.riskLevel).toBe('medium');

    const state = approvalMgr.getAllApprovalStates()[0];
    expect(state).toBeDefined();
    expect(state.context.correlationId).toBe('corr-1');
    await approvalMgr.decide(state.requestId, { decision: 'approved', scope: 'session' });

    await new Promise(resolve => setTimeout(resolve, 100));
    workerSocket.destroy();

    const parsed = JSON.parse(response.trim());
    expect(parsed.id).toBe(1);
    expect(parsed.result?.allow).toBe(true);
  }, 15000);

  test('shell_dangerous 工具直接返回 deny，不发送审批消息', async () => {
    const req = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'can_use_tool',
        arguments: {
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /tmp/demo' },
          session_id: 'sess-deny',
          message_id: 'msg-2',
          tool_use_id: 'tool-2',
          capability: 'shell_dangerous',
          operator_id: 'user-2',
          correlation_id: 'corr-2',
        },
      },
    });

    const workerSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });

    let response = '';
    workerSocket.on('data', chunk => { response += chunk.toString(); });
    workerSocket.write(req + '\n');

    await new Promise(resolve => setTimeout(resolve, 100));
    workerSocket.destroy();

    const parsed = JSON.parse(response.trim());
    expect(parsed.id).toBe(2);
    expect(parsed.result?.allow).toBe(false);
    expect(mockIM.approvalRequests).toHaveLength(0);
  });

  test('handler 使用 resolveContext 决定审批回传目标与 sessionName', async () => {
    await handler.close();
    handler = new ApprovalHandler({
      socketPath,
      approvalManager: approvalMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'fallback-thread' },
      resolveContext: (sessionId: string) => ({
        target: { plugin: 'mock', threadId: 'resolved-thread', channelId: 'resolved-channel' },
        sessionName: `${sessionId}-name`,
      }),
    });
    await handler.listen();

    const canUseToolRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'can_use_tool',
        arguments: {
          tool_name: 'Edit',
          tool_input: { path: '/tmp/c.txt' },
          session_id: 'sess-resolve',
          message_id: 'msg-4',
          tool_use_id: 'tool-4',
          capability: 'file_write',
          operator_id: 'user-4',
          correlation_id: 'corr-4',
        },
      },
    });

    const workerSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });
    workerSocket.write(canUseToolRequest + '\n');

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockIM.approvalRequests.at(-1)?.sessionName).toBe('sess-resolve-name');
    expect(mockIM.approvalTargets.at(-1)?.threadId).toBe('resolved-thread');
    expect(mockIM.approvalTargets.at(-1)?.channelId).toBe('resolved-channel');

    workerSocket.destroy();
  });

});
