import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';

describe('IM 消息处理 E2E', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let mockIM: MockIMPlugin;
  let dispatcher: IMMessageDispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-e2e-test-'));
    registry = new SessionRegistry();
    mockIM = new MockIMPlugin();
  });

  afterEach(() => {
    dispatcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('IM 消息 → mock claude → IM 回复', async () => {
    // Create a mock claude CLI that outputs a fixed stream-json event
    const mockCli = path.join(tmpDir, 'mock-claude.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      // Output a stream-json assistant event then exit
      'echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"Hello from mock claude"}]}}}\'',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    registry.create('test-session', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
      cliCommand: mockCli,
      cliArgs: [],
    });

    dispatcher.start();

    // Enqueue a message
    registry.enqueueIMMessage('test-session', {
      plugin: 'mock',
      threadId: 'thread-1',
      messageId: 'msg-1',
      userId: 'user-1',
      content: 'hello',
      dedupeKey: 'dedup-1',
    });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify IM received a live message with the response
    expect(mockIM.liveMessages.size).toBeGreaterThan(0);
    const messages = [...mockIM.liveMessages.values()];
    expect(messages.some(m => m.includes('Hello from mock claude'))).toBe(true);
  }, 10000);

  test('消息处理中崩溃 → 重启 → 状态恢复', async () => {
    // First invocation crashes, second succeeds
    const crashScript = path.join(tmpDir, 'crash-then-ok.sh');
    const countFile = path.join(tmpDir, 'count.txt');
    fs.writeFileSync(countFile, '0');
    fs.writeFileSync(crashScript, [
      '#!/bin/sh',
      `COUNT=$(cat ${countFile})`,
      `echo $((COUNT + 1)) > ${countFile}`,
      'if [ "$COUNT" = "0" ]; then exit 1; fi',
      'echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"recovered"}]}}}\'',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    registry.create('crash-session', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-2' },
      cliCommand: crashScript,
      cliArgs: [],
      maxRetries: 2,
    });

    dispatcher.start();

    registry.enqueueIMMessage('crash-session', {
      plugin: 'mock',
      threadId: 'thread-2',
      messageId: 'msg-crash',
      userId: 'user-1',
      content: 'test crash recovery',
      dedupeKey: 'dedup-crash',
    });

    // Wait for crash + retry + success
    await new Promise(resolve => setTimeout(resolve, 1500));

    const messages = [...mockIM.liveMessages.values()];
    expect(messages.some(m => m.includes('recovered'))).toBe(true);
  }, 15000);
});
