import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Daemon } from '../../src/daemon.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import type { IncomingMessage } from '../../src/types.js';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-pass-1',
    plugin: 'mattermost',
    channelId: 'ch1',
    threadId: 'thread-pass-1',
    isTopLevel: false,
    userId: 'user-1',
    text: '//compact',
    createdAt: new Date().toISOString(),
    dedupeKey: 'dedup-pass-1',
    ...overrides,
  };
}

describe('IM passthrough routing', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let mockIM: MockIMPlugin;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pass-route-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
    mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('//compact 应作为 passthrough 入队，不走单斜杠命令拦截', async () => {
    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '//compact', threadId: 'thread-pass-compact' }), 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-pass-compact');
    expect(session).toBeTruthy();
    expect(session!.messageQueue).toHaveLength(1);
    expect(session!.messageQueue[0].content).toBe('/compact');
    expect(mockIM.sent).toHaveLength(0);
  });

  test('//model sonnet 应转换为 /model sonnet 入队', async () => {
    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '//model sonnet', threadId: 'thread-pass-model', messageId: 'msg-pass-2', dedupeKey: 'dedup-pass-2' }), 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-pass-model');
    expect(session).toBeTruthy();
    expect(session!.messageQueue).toHaveLength(1);
    expect(session!.messageQueue[0].content).toBe('/model sonnet');
  });

  test('/status 仍优先作为 mx-coder 控制命令，不进入 passthrough', async () => {
    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '/status', threadId: 'thread-pass-status', messageId: 'msg-pass-3', dedupeKey: 'dedup-pass-3' }), 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-pass-status');
    expect(session).toBeUndefined();
    expect(mockIM.sent.length).toBeGreaterThan(0);
  });

  test('空命令 // 不应入队，并返回明确提示', async () => {
    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '//', threadId: 'thread-pass-empty', messageId: 'msg-pass-4', dedupeKey: 'dedup-pass-4' }), 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-pass-empty');
    expect(session).toBeUndefined();
    expect(mockIM.sent.at(-1)?.content && (mockIM.sent.at(-1)!.content as any).text).toContain('passthrough');
  });

  test('///foo 应保留一个前导斜杠，转换为 //foo 入队', async () => {
    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '///foo', threadId: 'thread-pass-triple', messageId: 'msg-pass-5', dedupeKey: 'dedup-pass-5' }), 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-pass-triple');
    expect(session).toBeTruthy();
    expect(session!.messageQueue[0].content).toBe('//foo');
  });
});
