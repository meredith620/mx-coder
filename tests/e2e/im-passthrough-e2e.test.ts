import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';

describe('passthrough E2E', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let mockIM: MockIMPlugin;
  let dispatcher: IMMessageDispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pass-e2e-'));
    registry = new SessionRegistry();
    mockIM = new MockIMPlugin();
  });

  afterEach(() => {
    dispatcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('//model sonnet → worker stdin → IM 回复', async () => {
    const captureFile = path.join(tmpDir, 'pass-e2e.jsonl');
    const mockCli = path.join(tmpDir, 'mock-claude-pass.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf "%s\\n" "$line" >> "${captureFile}"`,
      '  echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"passthrough ok"}]}}}\'',
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('pass-e2e-session', { workdir: tmpDir, cliPlugin: 'mock' });
    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-pass-e2e' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });
    dispatcher.start();

    registry.enqueueIMMessage('pass-e2e-session', {
      plugin: 'mock',
      threadId: 'thread-pass-e2e',
      messageId: 'msg-pass-e2e-1',
      userId: 'user-1',
      text: '/model sonnet',
      dedupeKey: 'dedup-pass-e2e-1',
      isPassthrough: true,
    } as any);

    await new Promise(resolve => setTimeout(resolve, 600));

    const stdinLines = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(stdinLines).toHaveLength(1);
    const payload = JSON.parse(stdinLines[0]!);
    expect(payload.message.content[0].text).toBe('/model sonnet');

    const messages = [...mockIM.liveMessages.values()];
    expect(messages.some(m => m.includes('passthrough ok'))).toBe(true);
  });

  test('passthrough 与普通文本混排时顺序不乱', async () => {
    const captureFile = path.join(tmpDir, 'pass-order-e2e.jsonl');
    const mockCli = path.join(tmpDir, 'mock-claude-pass-order.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf "%s\\n" "$line" >> "${captureFile}"`,
      '  echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"ok"}]}}}\'',
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('pass-order-session', { workdir: tmpDir, cliPlugin: 'mock' });
    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-pass-order' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });
    dispatcher.start();

    registry.enqueueIMMessage('pass-order-session', {
      plugin: 'mock', threadId: 'thread-pass-order', messageId: 'm1', userId: 'u1', text: 'hello', dedupeKey: 'd1',
    });
    registry.enqueueIMMessage('pass-order-session', {
      plugin: 'mock', threadId: 'thread-pass-order', messageId: 'm2', userId: 'u1', text: '/compact', dedupeKey: 'd2', isPassthrough: true,
    } as any);
    registry.enqueueIMMessage('pass-order-session', {
      plugin: 'mock', threadId: 'thread-pass-order', messageId: 'm3', userId: 'u1', text: 'world', dedupeKey: 'd3',
    });

    await new Promise(resolve => setTimeout(resolve, 1500));

    const lines = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
    const texts = lines.map(line => JSON.parse(line).message.content[0].text);
    expect(texts).toEqual(['hello', '/compact', 'world']);
  });
});
