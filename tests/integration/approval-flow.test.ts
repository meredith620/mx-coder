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
    expect(mockIM.approvalInteractions).toHaveLength(1);
    expect(mockIM.approvalInteractions[0]?.requestId).toBe(req.requestId);
    expect(mockIM.reactionAdds.at(-1)?.emojis).toEqual(['👍', '✅', '👎', '⏹️']);

    const state = approvalMgr.getAllApprovalStates()[0];
    expect(state).toBeDefined();
    expect(state.context.correlationId).toBe('corr-1');
    await approvalMgr.decide(state.requestId, { decision: 'approved', scope: 'session' });

    await new Promise(resolve => setTimeout(resolve, 100));
    workerSocket.destroy();

    const parsed = JSON.parse(response.trim());
    expect(parsed.id).toBe(1);
    expect(parsed.result?.content?.[0]?.type).toBe('text');
    const payload = JSON.parse(parsed.result?.content?.[0]?.text ?? '{}');
    expect(payload.behavior).toBe('allow');
    expect(payload.updatedInput?.path).toBe('/tmp/a.txt');
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
    const payload = JSON.parse(parsed.result?.content?.[0]?.text ?? '{}');
    expect(payload.behavior).toBe('deny');
    expect(payload.message).toBe('Denied by policy');
    expect(mockIM.approvalRequests).toHaveLength(0);
  });

  test('同一 session + operator + capability 在 scope=session 后后续请求直接 autoAllow，不再发第二次审批', async () => {
    await handler.close();
    handler = new ApprovalHandler({
      socketPath,
      approvalManager: approvalMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
      resolveContext: (sessionId: string) => ({
        target: { plugin: 'mock', threadId: 'thread-1' },
        sessionName: sessionId,
        operatorId: 'user-1',
      }),
    });
    await handler.listen();

    const request = (id: number) => JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'can_use_tool',
        arguments: {
          tool_name: 'Edit',
          input: { path: '/tmp/a.txt' },
          session_id: 'sess-cache',
          message_id: `msg-${id}`,
          tool_use_id: `tool-${id}`,
          capability: 'file_write',
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
    workerSocket.write(request(10) + '\n');
    await new Promise(resolve => setTimeout(resolve, 100));

    const firstReq = mockIM.approvalRequests.at(-1);
    expect(firstReq?.requestId).toBeDefined();
    await approvalMgr.decide(firstReq!.requestId, { decision: 'approved', scope: 'session' });
    await new Promise(resolve => setTimeout(resolve, 100));

    const approvalCountBefore = mockIM.approvalRequests.length;
    response = '';
    workerSocket.write(request(11) + '\n');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockIM.approvalRequests).toHaveLength(approvalCountBefore);
    const parsed = JSON.parse(response.trim());
    const payload = JSON.parse(parsed.result?.content?.[0]?.text ?? '{}');
    expect(payload.behavior).toBe('allow');

    workerSocket.destroy();
  });

  test('旧 requestId 在新审批产生后再决策时应视为 stale，且不覆盖当前 pending', async () => {
    const request = (id: number) => JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'can_use_tool',
        arguments: {
          tool_name: 'Edit',
          input: { path: `/tmp/${id}.txt` },
          session_id: 'sess-stale',
          message_id: `msg-${id}`,
          tool_use_id: `tool-${id}`,
          capability: 'file_write',
          operator_id: 'user-stale',
          correlation_id: `corr-${id}`,
        },
      },
    });

    const firstSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });
    const secondSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('connect', () => resolve(s));
      s.on('error', reject);
    });

    let firstResponse = '';
    let secondResponse = '';
    firstSocket.on('data', chunk => { firstResponse += chunk.toString(); });
    secondSocket.on('data', chunk => { secondResponse += chunk.toString(); });

    firstSocket.write(request(20) + '\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const firstReq = mockIM.approvalRequests.at(-1)!;

    secondSocket.write(request(21) + '\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const secondReq = mockIM.approvalRequests.at(-1)!;

    expect(firstReq.requestId).not.toBe(secondReq.requestId);
    expect(approvalMgr.getApprovalState(firstReq.requestId)?.decision).toBe('cancelled');
    expect(approvalMgr.getPendingApprovalForSession('sess-stale')?.requestId).toBe(secondReq.requestId);

    const staleResult = await approvalMgr.decideByApprover(firstReq.requestId, 'approver-1', { decision: 'approved', scope: 'once' });
    expect(staleResult.status).toBe('stale');
    expect(approvalMgr.getPendingApprovalForSession('sess-stale')?.requestId).toBe(secondReq.requestId);

    await approvalMgr.decide(secondReq.requestId, { decision: 'approved', scope: 'once' });
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(firstResponse).toContain('Cancelled by user');
    expect(secondResponse).toContain('allow');

    firstSocket.destroy();
    secondSocket.destroy();
  });

});
