import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import { ApprovalHandler } from '../../src/approval-handler.js';
import { ApprovalManager } from '../../src/approval-manager.js';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';

/**
 * E2E: IM 消息 → mock claude 触发 can_use_tool → ApprovalHandler 通知 IM
 *      → IM 审批 → mock claude 收到 allow → 输出结果 → IM 收到回复
 *
 * 架构：
 *   IMMessageDispatcher → spawn mock-claude.sh
 *   mock-claude.sh → 连接 approvalSocket，发送 can_use_tool JSON-RPC
 *   ApprovalHandler → 通知 MockIMPlugin.requestApproval
 *   测试代码 → approvalMgr.decide(approved)
 *   mock-claude.sh → 收到 allow:true → 输出 assistant 事件
 *   IMMessageDispatcher → StreamToIM → MockIMPlugin.updateMessage
 */
describe('审批 E2E', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let mockIM: MockIMPlugin;
  let approvalMgr: ApprovalManager;
  let approvalHandler: ApprovalHandler;
  let dispatcher: IMMessageDispatcher;
  let approvalSocketPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-approval-e2e-'));
    approvalSocketPath = path.join(tmpDir, 'approval.sock');

    registry = new SessionRegistry();
    mockIM = new MockIMPlugin();

    approvalMgr = new ApprovalManager({
      autoAllowCapabilities: [],
      autoAskCapabilities: ['shell_dangerous'],
      autoDenyCapabilities: [],
      autoDenyPatterns: [],
      timeoutSeconds: 10,
    });

    approvalHandler = new ApprovalHandler({
      socketPath: approvalSocketPath,
      approvalManager: approvalMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-approval' },
    });

    await approvalHandler.listen();
  });

  afterEach(async () => {
    dispatcher?.stop();
    await approvalHandler.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('mock claude 请求权限 → IM 收到审批请求 → 批准 → claude 输出结果 → IM 收到回复', async () => {
    // mock-claude.sh:
    //   1. 连接 approvalSocket，发送 can_use_tool JSON-RPC
    //   2. 等待响应
    //   3. 若 allow:true，输出 assistant 事件和 result 事件
    const mockCli = path.join(tmpDir, 'mock-claude-approval.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      `SOCK="${approvalSocketPath}"`,
      // Send can_use_tool via netcat-style node one-liner
      `RESPONSE=$(node -e "
const net = require('net');
const s = net.createConnection('$SOCK');
let buf = '';
s.on('data', d => { buf += d.toString(); });
s.on('connect', () => {
  s.write(JSON.stringify({
    jsonrpc:'2.0', id:1, method:'tools/call',
    params:{ name:'can_use_tool', arguments:{
      tool_name:'bash', tool_input:{command:'ls'},
      session_id:'e2e-sess', message_id:'msg-e2e', tool_use_id:'tool-e2e'
    }}
  }) + '\\n');
});
setTimeout(() => { console.log(buf.trim()); s.destroy(); }, 2000);
" 2>/dev/null)`,
      // Check if allow:true
      'ALLOW=$(echo "$RESPONSE" | node -e "const d=require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\'); try{ const r=JSON.parse(d.trim()); console.log(r.result&&r.result.allow?\'yes\':\'no\'); }catch(e){console.log(\'no\');}")',
      'if [ "$ALLOW" = "yes" ]; then',
      '  echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"approved and executed"}]}}}\'',
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'fi',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    registry.create('e2e-approval-session', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-approval' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });

    dispatcher.start();

    registry.enqueueIMMessage('e2e-approval-session', {
      plugin: 'mock',
      threadId: 'thread-approval',
      messageId: 'msg-e2e-1',
      userId: 'user-1',
      text: 'run ls',
      dedupeKey: 'dedup-e2e-1',
    });

    // Wait for ApprovalHandler to receive the can_use_tool request and notify IM
    await new Promise(resolve => setTimeout(resolve, 1500));

    // IM should have received an approval request
    expect(mockIM.approvalRequests.length).toBeGreaterThan(0);
    const req = mockIM.approvalRequests[0];
    expect(req.toolName).toBe('bash');

    // Approve via ApprovalManager
    const states = approvalMgr.getAllApprovalStates();
    expect(states.length).toBeGreaterThan(0);
    const pendingState = states.find(s => s.decision === 'pending');
    expect(pendingState).toBeDefined();
    await approvalMgr.decide(pendingState!.requestId, { decision: 'approved', scope: 'once' });

    // Wait for mock claude to receive allow and output result
    await new Promise(resolve => setTimeout(resolve, 2000));

    // IM should have received the assistant response
    const messages = [...mockIM.liveMessages.values()];
    expect(messages.some(m => m.includes('approved and executed'))).toBe(true);
  }, 20000);

  test('审批超时 → mock claude 收到 deny → 不输出结果', async () => {
    const shortTimeoutMgr = new ApprovalManager({
      autoAllowCapabilities: [],
      autoAskCapabilities: ['shell_dangerous'],
      autoDenyCapabilities: [],
      autoDenyPatterns: [],
      timeoutSeconds: 0.3, // 300ms
    });

    const shortSocketPath = path.join(tmpDir, 'short-approval.sock');
    const shortHandler = new ApprovalHandler({
      socketPath: shortSocketPath,
      approvalManager: shortTimeoutMgr,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-timeout' },
    });
    await shortHandler.listen();

    const mockCli = path.join(tmpDir, 'mock-claude-timeout.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      `SOCK="${shortSocketPath}"`,
      `RESPONSE=$(node -e "
const net = require('net');
const s = net.createConnection('$SOCK');
let buf = '';
s.on('data', d => { buf += d.toString(); });
s.on('connect', () => {
  s.write(JSON.stringify({
    jsonrpc:'2.0', id:2, method:'tools/call',
    params:{ name:'can_use_tool', arguments:{
      tool_name:'bash', tool_input:{command:'rm -rf /'},
      session_id:'e2e-timeout', message_id:'msg-t', tool_use_id:'tool-t'
    }}
  }) + '\\n');
});
setTimeout(() => { console.log(buf.trim()); s.destroy(); }, 2000);
" 2>/dev/null)`,
      'ALLOW=$(echo "$RESPONSE" | node -e "const d=require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\'); try{ const r=JSON.parse(d.trim()); console.log(r.result&&r.result.allow?\'yes\':\'no\'); }catch(e){console.log(\'no\');}")',
      'if [ "$ALLOW" = "yes" ]; then',
      '  echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"should not appear"}]}}}\'',
      'fi',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    registry.create('e2e-timeout-session', { workdir: tmpDir, cliPlugin: 'mock' });

    const timeoutDispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-timeout' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });

    timeoutDispatcher.start();

    registry.enqueueIMMessage('e2e-timeout-session', {
      plugin: 'mock',
      threadId: 'thread-timeout',
      messageId: 'msg-timeout-1',
      userId: 'user-1',
      text: 'dangerous command',
      dedupeKey: 'dedup-timeout-1',
    });

    // Wait for timeout (300ms) + processing
    await new Promise(resolve => setTimeout(resolve, 3000));

    timeoutDispatcher.stop();
    await shortHandler.close();

    // IM should NOT have received "should not appear"
    const messages = [...mockIM.liveMessages.values()];
    expect(messages.every(m => !m.includes('should not appear'))).toBe(true);
  }, 20000);
});
