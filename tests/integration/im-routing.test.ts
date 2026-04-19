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
import { IMWorkerManager } from '../../src/im-worker-manager.js';
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

  test('不同 IM 插件 thread 不会串到同一 session', () => {
    const s1 = (daemon as any)._getOrCreateSessionForThread('thread-shared', 'mattermost');
    const s2 = (daemon as any)._getOrCreateSessionForThread('thread-shared', 'discord');
    expect(s1.name).not.toBe(s2.name);
    expect(daemon.registry.getByIMThread('mattermost', 'thread-shared')?.name).toBe(s1.name);
    expect(daemon.registry.getByIMThread('discord', 'thread-shared')?.name).toBe(s2.name);
  });

  test('/help 根据消息 plugin 返回对应帮助文案', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    const msg = makeMsg({ text: '/help', plugin: 'mattermost', threadId: 'help-thread' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.sent.length).toBeGreaterThan(0);
    const text = (mockIM.sent[0].content as any).text as string;
    expect(text).toContain('/list');
    expect(text).toContain('/open <sessionName>');
    expect(text).toContain('/takeover <sessionName>');
  });

  test('/list 按当前 plugin 展示绑定 thread 和 cli', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    // Pre-create a session
    daemon.registry.create('existing-session', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('existing-session', { plugin: 'discord', threadId: 'discord-thread', channelId: 'd1' });

    const msg = makeMsg({ text: '/list', threadId: 'list-thread' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.sent.length).toBeGreaterThan(0);
    const text = (mockIM.sent[0].content as any).text as string;
    expect(text).toContain('existing-session');
    expect(text).toContain('cli=claude-code');
    expect(text).toContain('未绑定');
  });

  test('/open <sessionName> 在顶层消息中对未绑定 session 创建新 thread', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    daemon.registry.create('demo', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const msg = makeMsg({ text: '/open demo', threadId: 'root-post-1', isTopLevel: true });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.liveMessageTargets.size).toBe(1);
    const newThreadId = [...mockIM.liveMessageTargets.keys()][0];
    const liveTarget = mockIM.liveMessageTargets.get(newThreadId)!;
    expect(liveTarget.threadId).toBe('');
    expect(liveTarget.channelId).toBe('ch1');

    const binding = daemon.registry.get('demo')!.imBindings.find((item: any) => item.plugin === 'mattermost');
    expect(binding?.threadId).toBe(newThreadId);
    expect(binding?.channelId).toBe('ch1');

    expect(mockIM.sent).toHaveLength(2);
    expect(mockIM.sent[0].target.threadId).toBe(newThreadId);
    expect((mockIM.sent[0].content as any).text).toContain('已定位到会话 demo');
    expect(mockIM.sent[1].target.threadId).toBe('');
    expect((mockIM.sent[1].content as any).text).toContain('创建独立 thread');
  });

  test('/open <sessionName> 在 channel 模式下通过主 channel 创建独立 private channel', async () => {
    const mockIM = new MockIMPlugin();
    (mockIM as any).createChannelConversation = async ({ channelId, teamId, isPrivate }: any) => {
      mockIM.createdConversations.push({ channelId, kind: 'channel', teamId, isPrivate });
      return 'channel-conv-1';
    };
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPluginConfig = { spaceStrategy: 'channel', teamId: 'team-1' };

    daemon.registry.create('demo-channel', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const msg = makeMsg({ text: '/open demo-channel', threadId: 'root-post-1', isTopLevel: true });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.createdConversations).toHaveLength(1);
    expect(mockIM.createdConversations[0]).toMatchObject({ kind: 'channel', teamId: 'team-1', isPrivate: true });
    const binding = daemon.registry.get('demo-channel')!.imBindings.find((item: any) => item.plugin === 'mattermost');
    expect(binding?.bindingKind).toBe('channel');
    expect(binding?.channelId).toBe('channel-conv-1');
  });


  test('/open <sessionName> 在 thread 中对已绑定 session 发送锚点', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

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

  test('/open <sessionName> 已有失效绑定时移除旧绑定并创建新 thread', async () => {
    const mockIM = new MockIMPlugin();
    let sendCalls = 0;
    const originalSend = mockIM.sendMessage.bind(mockIM);
    mockIM.sendMessage = async (target, content) => {
      sendCalls += 1;
      if (sendCalls === 1 && target.threadId === 'stale-thread') {
        throw new Error('thread not found');
      }
      return originalSend(target, content);
    };
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    daemon.registry.create('demo', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('demo', { plugin: 'mattermost', threadId: 'stale-thread', channelId: 'old-ch' });

    const msg = makeMsg({ text: '/open demo', threadId: 'root-post-1', isTopLevel: true });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    const bindings = daemon.registry.get('demo')!.imBindings.filter((item: any) => item.plugin === 'mattermost');
    expect(bindings).toHaveLength(1);
    expect(bindings[0].threadId).not.toBe('stale-thread');
    expect(bindings[0].channelId).toBe('ch1');
    expect(mockIM.liveMessageTargets.size).toBe(1);
    expect(mockIM.sent.at(-1)?.target.threadId).toBe('');
    expect(mockIM.sent.some(s => s.target.threadId === bindings[0].threadId && (s.content as any).text.includes('已定位到会话 demo'))).toBe(true);
  });

  test('/open <sessionName> 创建 thread 失败时不写入绑定', async () => {
    const mockIM = new MockIMPlugin();
    mockIM.failCreateLiveMessage = true;
    mockIM.createLiveMessageError = new Error('api down');
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

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
    (daemon as any)._imPluginName = 'mattermost';

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

  test('attached 状态下普通消息直接拒绝且不入队', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    daemon.registry.create('demo-attached', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.markAttached('demo-attached', 1234);
    daemon.registry.bindIM('demo-attached', { plugin: 'mattermost', threadId: 'thread-attached', channelId: 'ch1' });

    const msg = makeMsg({ text: 'hello attached', threadId: 'thread-attached', isTopLevel: false });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(mockIM.sent).toHaveLength(1);
    expect((mockIM.sent[0].content as any).text).toContain('当前会话 `demo-attached` 正在终端中使用');
    expect((mockIM.sent[0].content as any).text).toContain('/takeover demo-attached');
    expect(daemon.registry.get('demo-attached')?.messageQueue).toHaveLength(0);
  });

  test('/takeover <sessionName> 将 attached session 置为 takeover_pending', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    daemon.registry.create('demo-takeover', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.markAttached('demo-takeover', 5678);

    const msg = makeMsg({ text: '/takeover demo-takeover', isTopLevel: true, userId: 'user-im' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(daemon.registry.get('demo-takeover')?.status).toBe('takeover_pending');
    expect((mockIM.sent[0].content as any).text).toContain('已请求接管会话 demo-takeover');
  });

  test('/takeover-force <sessionName> 强制释放 attached session', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';

    daemon.registry.create('demo-force', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.markAttached('demo-force', 999999999);

    const msg = makeMsg({ text: '/takeover-force demo-force', isTopLevel: true, userId: 'user-im' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    expect(daemon.registry.get('demo-force')?.status).toBe('idle');
    expect((mockIM.sent[0].content as any).text).toContain('已强制接管会话 demo-force');
  });

  test('普通文本在 channel 模式下自动建 session 时记录 channel 绑定', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPluginConfig = { spaceStrategy: 'channel', teamId: 'team-1' };

    const session = (daemon as any)._getOrCreateSessionForConversation('channel-main-1', 'mattermost', 'channel');
    expect(session).toBeTruthy();
    const binding = session.imBindings.find((item: any) => item.plugin === 'mattermost');
    expect(binding?.bindingKind).toBe('channel');
    expect(binding?.channelId).toBe('channel-main-1');
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
      'while IFS= read -r line; do',
      '  echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"hi"}]}}}\'',
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess1', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: 'FIXED-WRONG-THREAD' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
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
      'while IFS= read -r line; do',
      '  echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"reply"}]}}}\'',
      '  echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess-a', { workdir: tmpDir, cliPlugin: 'mock' });
    registry.create('sess-b', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
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

  test('dispatcher attached 状态下不消费 pending 消息', async () => {
    const mockCli = path.join(tmpDir, 'should-not-run.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\necho should-not-run\nexit 0\n', { mode: 0o755 });

    const session = registry.create('sess-attached', { workdir: tmpDir, cliPlugin: 'mock' });
    session.status = 'attached';

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-attached', {
      text: 'hello while attached',
      dedupeKey: 'dk-attached',
      plugin: 'mattermost',
      threadId: 'thread-attached',
      messageId: 'mid-attached',
      userId: 'u-attached',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    expect(mockIM.liveMessages.size).toBe(0);
    expect(registry.get('sess-attached')?.messageQueue[0].status).toBe('pending');
  }, 10000);

  test('dispatcher approval_pending 状态下冻结队列', async () => {
    const mockCli = path.join(tmpDir, 'should-not-run-approval.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\necho should-not-run\nexit 0\n', { mode: 0o755 });

    const session = registry.create('sess-approval', { workdir: tmpDir, cliPlugin: 'mock' });
    session.status = 'approval_pending';
    session.runtimeState = 'waiting_approval';

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-approval', {
      text: 'queued while approval',
      dedupeKey: 'dk-approval',
      plugin: 'mattermost',
      threadId: 'thread-approval',
      messageId: 'mid-approval',
      userId: 'u-approval',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    expect(mockIM.liveMessages.size).toBe(0);
    expect(registry.get('sess-approval')?.messageQueue[0].status).toBe('pending');
  }, 10000);

  test('dispatcher takeover_pending 状态下冻结队列', async () => {
    const mockCli = path.join(tmpDir, 'should-not-run-takeover.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\necho should-not-run\nexit 0\n', { mode: 0o755 });

    const session = registry.create('sess-takeover', { workdir: tmpDir, cliPlugin: 'mock' });
    session.status = 'takeover_pending';
    session.runtimeState = 'takeover_pending';

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 50,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-takeover', {
      text: 'queued while takeover',
      dedupeKey: 'dk-takeover',
      plugin: 'mattermost',
      threadId: 'thread-takeover',
      messageId: 'mid-takeover',
      userId: 'u-takeover',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    expect(mockIM.liveMessages.size).toBe(0);
    expect(registry.get('sess-takeover')?.messageQueue[0].status).toBe('pending');
  }, 10000);

  test('runtimeState=running 时按节流发送 typing，完成后停止续发', async () => {
    const mockCli = path.join(tmpDir, 'typing-running.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      "  printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"working\"}]}}'",
      '  sleep 0.35',
      "  printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}'",
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess-typing-running', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 20,
      typingIntervalMs: 100,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-typing-running', {
      text: 'long running',
      dedupeKey: 'dk-typing-running',
      plugin: 'mattermost',
      threadId: 'thread-typing-running',
      messageId: 'mid-typing-running',
      userId: 'u-typing-running',
    });

    await new Promise(resolve => setTimeout(resolve, 120));
    expect(registry.get('sess-typing-running')?.runtimeState).toBe('running');

    await new Promise(resolve => setTimeout(resolve, 260));
    expect(mockIM.typingCalls.length).toBeGreaterThan(1);
    expect(mockIM.typingCalls.every(call => call.target.threadId === 'thread-typing-running')).toBe(true);

    const callsAfterRunning = mockIM.typingCalls.length;
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(registry.get('sess-typing-running')?.runtimeState).toBe('ready');

    await new Promise(resolve => setTimeout(resolve, 300));
    expect(mockIM.typingCalls.length).toBe(callsAfterRunning);
  }, 10000);

  test('长时间无新流事件时应停止 typing 续发，避免误报持续输入', async () => {
    const mockCli = path.join(tmpDir, 'typing-quiet-window.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      "  printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"partial\"}]}}'",
      '  sleep 0.45',
      "  printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}'",
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess-typing-quiet', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 20,
      typingIntervalMs: 100,
      typingQuietWindowMs: 180,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-typing-quiet', {
      text: 'quiet window',
      dedupeKey: 'dk-typing-quiet',
      plugin: 'mattermost',
      threadId: 'thread-typing-quiet',
      messageId: 'mid-typing-quiet',
      userId: 'u-typing-quiet',
    });

    await new Promise(resolve => setTimeout(resolve, 140));
    expect(registry.get('sess-typing-quiet')?.runtimeState).toBe('running');
    const callsBeforeQuiet = mockIM.typingCalls.length;
    expect(callsBeforeQuiet).toBeGreaterThan(0);

    await new Promise(resolve => setTimeout(resolve, 220));
    expect(registry.get('sess-typing-quiet')?.runtimeState).toBe('running');
    expect(mockIM.typingCalls.length).toBe(callsBeforeQuiet);

    await new Promise(resolve => setTimeout(resolve, 260));
    expect(registry.get('sess-typing-quiet')?.runtimeState).toBe('ready');
    expect(registry.get('sess-typing-quiet')?.status).toBe('idle');
  }, 10000);

  test('error 事件不应结束当前 turn 或停止后续 typing 续发', async () => {
    const mockCli = path.join(tmpDir, 'typing-error-not-done.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      "  printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"working\"}]}}'",
      '  sleep 0.15',
      "  printf '%s\\n' '{\"type\":\"error\",\"payload\":{\"message\":\"transient\"}}'",
      '  sleep 0.35',
      "  printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}'",
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess-error-not-done', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 20,
      typingIntervalMs: 100,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-error-not-done', {
      text: 'error then result',
      dedupeKey: 'dk-error-not-done',
      plugin: 'mattermost',
      threadId: 'thread-error-not-done',
      messageId: 'mid-error-not-done',
      userId: 'u-error-not-done',
    });

    await new Promise(resolve => setTimeout(resolve, 260));
    expect(registry.get('sess-error-not-done')?.runtimeState).toBe('running');
    const callsAfterError = mockIM.typingCalls.length;
    expect(callsAfterError).toBeGreaterThan(0);

    await new Promise(resolve => setTimeout(resolve, 220));
    expect(mockIM.typingCalls.length).toBeGreaterThan(callsAfterError);
    expect(registry.get('sess-error-not-done')?.runtimeState).toBe('running');

    await new Promise(resolve => setTimeout(resolve, 350));
    expect(registry.get('sess-error-not-done')?.runtimeState).toBe('ready');
  }, 10000);

  test('同一 session 多条消息 FIFO 串行处理', async () => {
    const mockCli = path.join(tmpDir, 'serial.sh');
    const outFile = path.join(tmpDir, 'serial-order.log');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf "%s\\n" "$line" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const msg=JSON.parse(d);require("fs").appendFileSync(process.argv[1], msg.message.content[0].text+"\\n")})' "${outFile}"`,
      "  printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}'",
      "  printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}'",
      'done',
    ].join('\n'), { mode: 0o755 });

    registry.create('sess-serial', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(mockCli), registry),
      pollIntervalMs: 20,
    });
    dispatcher.start();

    registry.enqueueIMMessage('sess-serial', {
      text: 'first',
      dedupeKey: 'dk-first',
      plugin: 'mattermost',
      threadId: 'thread-serial',
      messageId: 'mid-first',
      userId: 'u-first',
    });
    registry.enqueueIMMessage('sess-serial', {
      text: 'second',
      dedupeKey: 'dk-second',
      plugin: 'mattermost',
      threadId: 'thread-serial',
      messageId: 'mid-second',
      userId: 'u-second',
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    const order = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(order).toEqual(['first', 'second']);
  }, 10000);

  test('Claude 非 0 退出时消息状态为 failed', async () => {
    const failCli = path.join(tmpDir, 'fail.sh');
    fs.writeFileSync(failCli, '#!/bin/sh\nif read line; then exit 1; fi\n', { mode: 0o755 });

    registry.create('sess-fail', { workdir: tmpDir, cliPlugin: 'mock' });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mattermost', channelId: 'ch1', threadId: '' },
      workerManager: new IMWorkerManager(new MockCLIPlugin(failCli), registry),
      pollIntervalMs: 20,
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
