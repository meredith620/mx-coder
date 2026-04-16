/**
 * Integration tests: daemon IM routing, /help /list /open commands, dispatcher thread routing.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Daemon } from '../../src/daemon.js';
import { SessionRegistry } from '../../src/session-registry.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import type { IncomingMessage } from '../../src/types.js';

// ── helper: build a minimal IncomingMessage ────────────────────────────────
function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    plugin: 'mattermost',
    channelId: 'ch1',
    threadId: 'thread-1',
    isTopLevel: false,
    userId: 'user-1',
    text: 'hello',
    createdAt: new Date().toISOString(),
    dedupeKey: 'dedup-1',
    ...overrides,
  };
}

// ── Daemon IM routing tests ────────────────────────────────────────────────
describe('Daemon IM 路由', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-im-route-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('新 thread 首条消息自动创建 session 并绑定', () => {
    const registry = daemon.registry;

    // Directly test the internal routing logic via _getOrCreateSessionForThread
    // (exposed as public for testing via internal method naming convention)
    const session = (daemon as any)._getOrCreateSessionForThread('thread-abc', 'mattermost');
    expect(session).toBeTruthy();
    expect(session.name).toContain('im-thread-a');

    const found = registry.getByIMThread('mattermost', 'thread-abc');
    expect(found?.name).toBe(session.name);
  });

  test('同 thread 第二条消息命中同一 session', () => {
    const s1 = (daemon as any)._getOrCreateSessionForThread('thread-xyz', 'mattermost');
    const s2 = (daemon as any)._getOrCreateSessionForThread('thread-xyz', 'mattermost');
    expect(s1.name).toBe(s2.name);
    expect(daemon.registry.list().filter(s => s.name.startsWith('im-thread-x'))).toHaveLength(1);
  });

  test('不同 thread 产生不同 session', () => {
    const s1 = (daemon as any)._getOrCreateSessionForThread('thread-111', 'mattermost');
    const s2 = (daemon as any)._getOrCreateSessionForThread('thread-222', 'mattermost');
    expect(s1.name).not.toBe(s2.name);
  });

  test('/help 不入队', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    const msg = makeMsg({ text: '/help', threadId: 'help-thread' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    // No session created for help-thread (command only)
    const session = daemon.registry.getByIMThread('mattermost', 'help-thread');
    expect(session).toBeUndefined();
    // Response was sent via sendMessage (not createLiveMessage)
    expect(mockIM.sent.length).toBeGreaterThan(0);
    expect(mockIM.sent[0].content.kind).toBe('text');
    const text = (mockIM.sent[0].content as any).text as string;
    expect(text).toContain('/list');
  });

  test('/list 不入队，返回会话列表', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    // Pre-create a session
    daemon.registry.create('existing-session', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const msg = makeMsg({ text: '/list', threadId: 'list-thread' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.sent.length).toBeGreaterThan(0);
    const text = (mockIM.sent[0].content as any).text as string;
    expect(text).toContain('existing-session');
  });

  test('/open <sessionName> 在顶层消息中对未绑定 session 创建新 thread', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    daemon.registry.create('demo', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const msg = makeMsg({ text: '/open demo', threadId: 'root-post-1', isTopLevel: true });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.liveMessageTargets.size).toBe(1);
    const newThreadId = [...mockIM.liveMessageTargets.keys()][0];
    const liveTarget = mockIM.liveMessageTargets.get(newThreadId)!;
    expect(liveTarget.threadId).toBe('');

    const binding = daemon.registry.get('demo')!.imBindings.find((item: any) => item.plugin === 'mattermost');
    expect(binding?.threadId).toBe(newThreadId);
    expect(binding?.channelId).toBe('ch1');

    expect(mockIM.sent).toHaveLength(1);
    expect(mockIM.sent[0].target.threadId).toBe('');
    expect((mockIM.sent[0].content as any).text).toContain('创建独立 thread');
  });

  test('/open <sessionName> 在顶层消息中对已绑定 session 发送锚点', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    daemon.registry.create('demo', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('demo', { plugin: 'mattermost', threadId: 'target-thread-99', channelId: 'ch1' });

    const msg = makeMsg({ text: '/open demo', threadId: 'root-post-1', isTopLevel: true });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.sent).toHaveLength(2);
    expect(mockIM.sent[0].target.threadId).toBe('target-thread-99');
    expect(mockIM.sent[1].target.threadId).toBe('');
    expect((mockIM.sent[1].content as any).text).toContain('发送定位消息');
  });

  test('/open <sessionName> 在 thread 中对已绑定 session 发送锚点', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    daemon.registry.create('my-sess', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('my-sess', { plugin: 'mattermost', threadId: 'target-thread-99', channelId: 'ch1' });

    const msg = makeMsg({ text: '/open my-sess', threadId: 'requester-thread', isTopLevel: false });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.sent).toHaveLength(2);
    const toTarget = mockIM.sent.find(s => s.target.threadId === 'target-thread-99');
    expect(toTarget).toBeTruthy();
    expect((toTarget!.content as any).text).toContain('my-sess');

    const ack = mockIM.sent.find(s => s.target.threadId === 'requester-thread');
    expect(ack).toBeTruthy();
  });

  test('/open <sessionName> 创建 thread 失败时不写入绑定', async () => {
    const mockIM = new MockIMPlugin();
    mockIM.failCreateLiveMessage = true;
    mockIM.createLiveMessageError = new Error('api down');
    (daemon as any)._imPlugin = mockIM;

    daemon.registry.create('demo', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const msg = makeMsg({ text: '/open demo', threadId: 'root-post-1', isTopLevel: true });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(daemon.registry.get('demo')!.imBindings).toHaveLength(0);
    expect(mockIM.sent).toHaveLength(1);
    expect((mockIM.sent[0].content as any).text).toContain('创建 thread 失败');
  });

  test('/open <sessionName> 并发创建时只绑定一个 thread', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    daemon.registry.create('demo', { workdir: '/tmp', cliPlugin: 'claude-code' });

    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let calls = 0;
    mockIM.createLiveMessage = async (target, content) => {
      calls += 1;
      if (calls === 1) {
        await createStarted;
      }
      return MockIMPlugin.prototype.createLiveMessage.call(mockIM, target, content);
    };

    const first = (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '/open demo', threadId: 'root-post-1', isTopLevel: true }), 'ch1');
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '/open demo', threadId: 'root-post-2', isTopLevel: true, messageId: 'msg-2', dedupeKey: 'dedup-2' }), 'ch1');

    releaseCreate();
    await Promise.all([first, second]);

    const bindings = daemon.registry.get('demo')!.imBindings.filter((item: any) => item.plugin === 'mattermost');
    expect(bindings).toHaveLength(1);
    expect(calls).toBe(2);
    expect(mockIM.sent.some(s => (s.content as any).text.includes('已被绑定到其他 thread'))).toBe(true);
  });

  test('普通消息入队到对应 session', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;

    const msg = makeMsg({ text: 'hello world', threadId: 'normal-thread' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'normal-thread');
    expect(session).toBeTruthy();
    expect(session!.messageQueue).toHaveLength(1);
    expect(session!.messageQueue[0].content).toBe('hello world');
  });
});

// ── Dispatcher thread routing tests ───────────────────────────────────────
describe('IMMessageDispatcher 动态 thread 路由', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let mockIM: MockIMPlugin;
  let dispatcher: IMMessageDispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-disp-test-'));
    registry = new SessionRegistry();
    mockIM = new MockIMPlugin();
  });

  afterEach(() => {
    dispatcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('dispatcher 回复使用 QueuedMessage 的 threadId（不用固定 imTarget.threadId）', async () => {
    const mockCli = path.join(tmpDir, 'mock-claude.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"hi"}]}}}\'',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess1', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: 'FIXED-WRONG-THREAD' },
      cliPlugin: new MockCLIPlugin(mockCli),
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess1', {
      text: 'hello',
      dedupeKey: 'dk1',
      plugin: 'mattermost',
      threadId: 'dynamic-thread-42',
      messageId: 'msg-1',
      userId: 'user-1',
    });

    await new Promise(resolve => setTimeout(resolve, 600));

    // Live message should be routed to the dynamic thread, NOT the fixed WRONG thread
    const targets = [...mockIM.liveMessageTargets.values()];
    expect(targets.length).toBeGreaterThan(0);
    const usedThreadId = targets[0].threadId;
    expect(usedThreadId).toBe('dynamic-thread-42');
    expect(usedThreadId).not.toBe('FIXED-WRONG-THREAD');
  }, 10000);

  test('两条不同 thread 消息各回各 thread', async () => {
    const mockCli = path.join(tmpDir, 'mock-claude2.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"reply"}]}}}\'',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess-a', { workdir: tmpDir, cliPlugin: 'mock' });
    registry.create('sess-b', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      cliPlugin: new MockCLIPlugin(mockCli),
      pollIntervalMs: 50,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-a', {
      text: 'msg-a',
      dedupeKey: 'dk-a',
      plugin: 'mattermost',
      threadId: 'thread-AAA',
      messageId: 'mid-a',
      userId: 'u1',
    });

    registry.enqueueIMMessage('sess-b', {
      text: 'msg-b',
      dedupeKey: 'dk-b',
      plugin: 'mattermost',
      threadId: 'thread-BBB',
      messageId: 'mid-b',
      userId: 'u2',
    });

    await new Promise(resolve => setTimeout(resolve, 700));

    const threads = new Set([...mockIM.liveMessageTargets.values()].map(t => t.threadId));
    expect(threads.has('thread-AAA')).toBe(true);
    expect(threads.has('thread-BBB')).toBe(true);
  }, 10000);

  test('Claude 非 0 退出时消息状态为 failed', async () => {
    const failCli = path.join(tmpDir, 'fail.sh');
    fs.writeFileSync(failCli, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    registry.create('sess-fail', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      cliPlugin: new MockCLIPlugin(failCli),
      maxRetries: 0,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-fail', {
      text: 'will fail',
      dedupeKey: 'dk-fail',
      plugin: 'mattermost',
      threadId: 'thread-fail',
      messageId: 'mid-fail',
      userId: 'u-fail',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const s = registry.get('sess-fail')!;
    const msg = s.messageQueue.find(m => m.messageId === 'mid-fail');
    expect(msg?.status).toBe('failed');
  }, 10000);
});
