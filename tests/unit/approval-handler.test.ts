import { describe, test, expect } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApprovalHandler } from '../../src/approval-handler.js';
import { ApprovalManager } from '../../src/approval-manager.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';

describe('ApprovalHandler protocol', () => {
  test('allow 响应为单个 text block，text 内容为 JSON 字符串', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-approval-handler-'));
    const socketPath = path.join(tmpDir, 'approval.sock');
    const approvalMgr = new ApprovalManager({
      autoAllowCapabilities: ['read_only'],
      autoAskCapabilities: ['file_write'],
      autoDenyCapabilities: ['shell_dangerous'],
      autoDenyPatterns: [],
      timeoutSeconds: 5,
    });
    const handler = new ApprovalHandler({
      socketPath,
      approvalManager: approvalMgr,
      imPlugin: new MockIMPlugin(),
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
    });
    await handler.listen();

    try {
      const req = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'can_use_tool',
          arguments: {
            tool_name: 'Read',
            input: { path: '/tmp/a.txt' },
            session_id: 'sess-1',
            message_id: 'msg-1',
            tool_use_id: 'tool-1',
            capability: 'read_only',
          },
        },
      });

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(socketPath);
        s.on('connect', () => resolve(s));
        s.on('error', reject);
      });

      let response = '';
      socket.on('data', chunk => { response += chunk.toString(); });
      socket.write(req + '\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      socket.destroy();

      const parsed = JSON.parse(response.trim());
      expect(Array.isArray(parsed.result.content)).toBe(true);
      expect(parsed.result.content).toHaveLength(1);
      expect(parsed.result.content[0].type).toBe('text');
      const payload = JSON.parse(parsed.result.content[0].text);
      expect(payload.behavior).toBe('allow');
      expect(payload.updatedInput.path).toBe('/tmp/a.txt');
    } finally {
      await handler.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('tool_input 缺失 capability 时会保守推导并发送审批请求', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-approval-handler-'));
    const socketPath = path.join(tmpDir, 'approval.sock');
    const approvalMgr = new ApprovalManager({
      autoAllowCapabilities: [],
      autoAskCapabilities: ['file_write'],
      autoDenyCapabilities: ['shell_dangerous'],
      autoDenyPatterns: [],
      timeoutSeconds: 5,
    });
    const mockIM = new MockIMPlugin();
    const handler = new ApprovalHandler({
      socketPath,
      approvalManager: approvalMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
    });
    await handler.listen();

    try {
      const req = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'can_use_tool',
          arguments: {
            tool_name: 'Edit',
            tool_input: { path: '/tmp/b.txt' },
            session_id: 'sess-2',
            message_id: 'msg-2',
            tool_use_id: 'tool-2',
          },
        },
      });

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(socketPath);
        s.on('connect', () => resolve(s));
        s.on('error', reject);
      });

      socket.write(req + '\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      socket.destroy();

      expect(mockIM.approvalRequests).toHaveLength(1);
      expect(mockIM.approvalRequests[0]?.capability).toBe('file_write');
      expect(mockIM.approvalRequests[0]?.riskLevel).toBe('medium');
    } finally {
      await handler.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Bash 危险命令缺失 capability 时会推导为 shell_dangerous 并直接 deny', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-approval-handler-'));
    const socketPath = path.join(tmpDir, 'approval.sock');
    const approvalMgr = new ApprovalManager({
      autoAllowCapabilities: [],
      autoAskCapabilities: ['file_write'],
      autoDenyCapabilities: ['shell_dangerous'],
      autoDenyPatterns: [],
      timeoutSeconds: 5,
    });
    const mockIM = new MockIMPlugin();
    const handler = new ApprovalHandler({
      socketPath,
      approvalManager: approvalMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
    });
    await handler.listen();

    try {
      const req = JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'can_use_tool',
          arguments: {
            tool_name: 'Bash',
            input: { command: 'rm -rf /tmp/demo' },
            session_id: 'sess-3',
            message_id: 'msg-3',
            tool_use_id: 'tool-3',
          },
        },
      });

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(socketPath);
        s.on('connect', () => resolve(s));
        s.on('error', reject);
      });

      let response = '';
      socket.on('data', chunk => { response += chunk.toString(); });
      socket.write(req + '\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      socket.destroy();

      const parsed = JSON.parse(response.trim());
      const payload = JSON.parse(parsed.result.content[0].text);
      expect(payload.behavior).toBe('deny');
      expect(payload.message).toBe('Denied by policy');
      expect(mockIM.approvalRequests).toHaveLength(0);
    } finally {
      await handler.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
