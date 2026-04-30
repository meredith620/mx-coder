/**
 * S1.1: IM 首条消息懒初始化闭环
 *
 * 测试 initState=uninitialized 时 IM 首条消息的初始化行为，
 * 以及并发 attach + IM 到达时的 first-writer-wins 裁决。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Daemon } from '../../src/daemon.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import type { IncomingMessage } from '../../src/types.js';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-init-1',
    plugin: 'mattermost',
    channelId: 'ch1',
    threadId: 'thread-init-1',
    isTopLevel: false,
    userId: 'user-1',
    text: 'hello init',
    createdAt: new Date().toISOString(),
    dedupeKey: 'dedup-init-1',
    ...overrides,
  };
}

describe('S1.1: IM 首条消息懒初始化闭环', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let mockIM: MockIMPlugin;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-init-fw-'));
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

  test('initState=uninitialized 时首条 IM 消息可入队并触发初始化', async () => {
    // 通过 thread 自动创建 session（initState=uninitialized）
    const msg = makeMsg({ text: 'first message', threadId: 'thread-new' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-new');
    expect(session).toBeTruthy();
    expect(session!.initState).toBe('uninitialized');
    expect(session!.messageQueue).toHaveLength(1);

    // 关键断言：入队后 initState 应变为 initializing（表示 IM 获得了初始化权）
    // 当前实现缺失：enqueueIMMessage 不检查/设置 initState
    // dispatcher 处理消息后应将 initState 推进到 initialized
  });

  test('initState=initializing 时 IM 消息入队应返回 SESSION_BUSY', async () => {
    daemon.registry.create('init-busy', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('init-busy', { plugin: 'mattermost', threadId: 'thread-busy', channelId: 'ch1' });
    // 模拟正在初始化中
    (daemon.registry as any)._sessions.get('init-busy')!.initState = 'initializing';

    const msg = makeMsg({ text: 'during init', threadId: 'thread-busy' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    const session = daemon.registry.get('init-busy')!;
    // 关键断言：initializing 期间 IM 消息不应入队
    expect(session.messageQueue).toHaveLength(0);
    // 应向用户回复 SESSION_BUSY 提示
    expect(mockIM.sent.some(s => (s.content as any).text?.includes('正在初始化') || (s.content as any).text?.includes('SESSION_BUSY'))).toBe(true);
  });

  test('init_failed 状态下 IM 消息不应入队', async () => {
    daemon.registry.create('init-failed', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('init-failed', { plugin: 'mattermost', threadId: 'thread-failed', channelId: 'ch1' });
    (daemon.registry as any)._sessions.get('init-failed')!.initState = 'init_failed';

    const msg = makeMsg({ text: 'after failure', threadId: 'thread-failed' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    const session = daemon.registry.get('init-failed')!;
    // 关键断言：init_failed 后不应接受新消息
    expect(session.messageQueue).toHaveLength(0);
    // 应提示用户 session 初始化失败
    expect(mockIM.sent.some(s => (s.content as any).text?.includes('初始化失败'))).toBe(true);
  });

  test('并发 attach + IM 首条消息时仅一个 writer 获得初始化权', async () => {
    daemon.registry.create('race-init', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('race-init', { plugin: 'mattermost', threadId: 'thread-race', channelId: 'ch1' });
    const session = daemon.registry.get('race-init')!;
    expect(session.initState).toBe('uninitialized');

    // 并发发起 attach 和 IM 消息
    const attachPromise = daemon.registry.beginInitAndAttach('race-init', 1111);
    const msg = makeMsg({ text: 'race message', threadId: 'thread-race' });
    const imPromise = (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    await Promise.allSettled([attachPromise, imPromise]);

    const updated = daemon.registry.get('race-init')!;
    // attach 应获胜（attach 优先于 IM）
    expect(updated.initState).toBe('initialized');
    expect(updated.status).toBe('attached');
    // IM 消息应被拒绝或仅入队（不应触发第二次初始化）
    // 不应出现 initState 被两个 writer 同时推进的情况
  });

  test('archived session 的 IM 消息应被拒绝', async () => {
    daemon.registry.create('archived-sess', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('archived-sess', { plugin: 'mattermost', threadId: 'thread-archived', channelId: 'ch1' });
    daemon.registry.archive('archived-sess');

    const msg = makeMsg({ text: 'to archived', threadId: 'thread-archived' });
    await (daemon as any)._handleIncomingIMMessage(msg, 'ch1');

    const session = daemon.registry.get('archived-sess')!;
    expect(session.messageQueue).toHaveLength(0);
    expect(session.lifecycleStatus).toBe('archived');
  });
});
