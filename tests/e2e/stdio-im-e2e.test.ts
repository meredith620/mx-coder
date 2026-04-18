import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import { StdioIMPlugin } from '../../src/plugins/im/stdio.js';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';

/**
 * E2E: stdio IM 插件完整链路测试
 *
 * 验证：stdin → mm-coder → mock claude → mm-coder → stdout
 * 不依赖真实 Mattermost，通过管道模拟完整收发消息流程
 */
describe('StdioIMPlugin 完整链路 E2E', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let dispatcher: IMMessageDispatcher;
  let stdinMock: Readable;
  let stdoutMock: Writable;
  let stdoutLines: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-e2e-'));
    registry = new SessionRegistry();
    stdoutLines = [];

    // Mock stdin/stdout streams
    stdinMock = new Readable({ read() {} });
    stdoutMock = new Writable({
      write(chunk, _encoding, callback) {
        stdoutLines.push(chunk.toString());
        callback();
      },
    });
  });

  afterEach(() => {
    dispatcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('stdin 消息 → mock claude → stdout 回复', async () => {
    // Create mock claude CLI that echoes input
    const mockCli = path.join(tmpDir, 'mock-claude.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      '  echo \'{"type":"assistant","payload":{"message":{"id":"msg-1","content":[{"type":"text","text":"Echo: test message"}]}}}\'',
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'done',
    ].join('\n'), { mode: 0o755 });

    const stdioPlugin = new StdioIMPlugin(stdinMock, stdoutMock);
    stdioPlugin.start();

    registry.create('stdio-session', { workdir: tmpDir, cliPlugin: 'mock' });

    // Bridge: stdin messages → registry queue
    stdioPlugin.onMessage((msg) => {
      registry.enqueueIMMessage('stdio-session', {
        plugin: msg.plugin,
        threadId: msg.threadId,
        messageId: msg.messageId,
        userId: msg.userId,
        text: msg.text,
        dedupeKey: msg.dedupeKey,
      });
    });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: stdioPlugin,
      imTarget: { plugin: 'stdio', threadId: 'thread-1' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
    });

    dispatcher.start();

    // Simulate incoming message from stdin
    stdinMock.push(JSON.stringify({
      type: 'message',
      messageId: 'in-1',
      threadId: 'thread-1',
      userId: 'user-1',
      text: 'test message',
      dedupeKey: 'dedup-1',
    }) + '\n');

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 800));

    // Verify stdout received response
    const output = stdoutLines.join('');
    expect(output).toContain('"type":"live"');
    expect(output).toContain('Echo: test message');

    stdioPlugin.stop();
  }, 10000);

  test('stdin 多条消息 → 按序处理 → stdout 多条回复', async () => {
    const mockCli = path.join(tmpDir, 'mock-claude-multi.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'COUNT=0',
      'while IFS= read -r line; do',
      '  COUNT=$((COUNT + 1))',
      "  printf '{\"type\":\"assistant\",\"payload\":{\"message\":{\"id\":\"msg-%s\",\"content\":[{\"type\":\"text\",\"text\":\"Response %s\"}]}}}\n' \"$COUNT\" \"$COUNT\"",
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'done',
    ].join('\n'), { mode: 0o755 });

    const stdioPlugin = new StdioIMPlugin(stdinMock, stdoutMock);
    stdioPlugin.start();

    registry.create('multi-session', { workdir: tmpDir, cliPlugin: 'mock' });

    // Bridge: stdin messages → registry queue
    stdioPlugin.onMessage((msg) => {
      registry.enqueueIMMessage('multi-session', {
        plugin: msg.plugin,
        threadId: msg.threadId,
        messageId: msg.messageId,
        userId: msg.userId,
        text: msg.text,
        dedupeKey: msg.dedupeKey,
      });
    });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: stdioPlugin,
      imTarget: { plugin: 'stdio', threadId: 'thread-2' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
    });

    dispatcher.start();

    // Send 2 messages
    stdinMock.push(JSON.stringify({
      type: 'message',
      messageId: 'in-1',
      threadId: 'thread-2',
      userId: 'user-1',
      text: 'msg 1',
      dedupeKey: 'dedup-1',
    }) + '\n');

    stdinMock.push(JSON.stringify({
      type: 'message',
      messageId: 'in-2',
      threadId: 'thread-2',
      userId: 'user-1',
      text: 'msg 2',
      dedupeKey: 'dedup-2',
    }) + '\n');

    // Wait for both to process
    await new Promise(resolve => setTimeout(resolve, 1500));

    const output = stdoutLines.join('');
    // Should have at least 2 live message creations across two turns
    const liveCount = (output.match(/"type":"live"/g) || []).length;
    expect(liveCount).toBeGreaterThanOrEqual(2);

    stdioPlugin.stop();
  }, 15000);

  test('stdin 审批请求 → stdout 输出 approval 事件', async () => {
    const mockCli = path.join(tmpDir, 'mock-claude-approval.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      // Simulate permission prompt via MCP bridge (not implemented in mock, just exit)
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    const stdioPlugin = new StdioIMPlugin(stdinMock, stdoutMock);
    stdioPlugin.start();

    registry.create('approval-session', { workdir: tmpDir, cliPlugin: 'mock' });

    // Manually trigger approval request (normally triggered by MCP bridge)
    await stdioPlugin.requestApproval(
      { plugin: 'stdio', threadId: 'thread-3' },
      {
        requestId: 'req-1',
        sessionName: 'approval-session',
        messageId: 'msg-1',
        toolName: 'bash',
        toolInputSummary: 'rm -rf /',
        riskLevel: 'high',
        capability: 'shell_dangerous',
        scopeOptions: ['once', 'session'],
        timeoutSeconds: 60,
      },
    );

    await new Promise(resolve => setTimeout(resolve, 100));

    const output = stdoutLines.join('');
    expect(output).toContain('"type":"approval"');
    expect(output).toContain('"requestId":"req-1"');
    expect(output).toContain('"toolName":"bash"');
    expect(output).toContain('"riskLevel":"high"');

    stdioPlugin.stop();
  }, 5000);

  test('stdin 格式错误消息 → 忽略不崩溃', async () => {
    const stdioPlugin = new StdioIMPlugin(stdinMock, stdoutMock);
    stdioPlugin.start();

    // Send malformed JSON
    stdinMock.push('not json\n');
    stdinMock.push('{"type":"unknown"}\n');
    stdinMock.push('\n'); // empty line

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should not crash, no output expected
    expect(stdoutLines.length).toBe(0);

    stdioPlugin.stop();
  }, 5000);
});
