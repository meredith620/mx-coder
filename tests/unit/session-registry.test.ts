import { describe, test, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';

let registry: SessionRegistry;
beforeEach(() => { registry = new SessionRegistry(); });

describe('SessionRegistry', () => {
  test('create 创建 session，name 唯一', () => {
    registry.create('bug-fix', { workdir: '/tmp', cliPlugin: 'claude-code' });
    expect(() => registry.create('bug-fix', { workdir: '/tmp', cliPlugin: 'claude-code' }))
      .toThrow('SESSION_ALREADY_EXISTS');
  });

  test('markAttached 更新 pid 和状态', () => {
    registry.create('s1', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markAttached('s1', 1234);
    const s = registry.get('s1')!;
    expect(s.status).toBe('attached');
    expect(s.attachedPid).toBe(1234);
  });

  test('getByIMThread 按 plugin+threadId 查找', () => {
    registry.create('s2', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.bindIM('s2', { plugin: 'mattermost', threadId: 'thread-1' });
    const found = registry.getByIMThread('mattermost', 'thread-1');
    expect(found?.name).toBe('s2');
  });

  test('非法状态迁移时 markAttached 从 error 状态失败', () => {
    registry.create('s3', { workdir: '/tmp', cliPlugin: 'claude-code' });
    // 手动设置 error 状态
    registry['_sessions'].get('s3')!.status = 'error';
    expect(() => registry.markAttached('s3', 999)).toThrow('INVALID_STATE_TRANSITION');
  });

  // P1: initState 懒初始化闭环
  test('initState=uninitialized 时 attach 触发懒初始化（first-writer-wins）', async () => {
    registry.create('s4', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s4')!;
    expect(s.initState).toBe('uninitialized');

    // 并发两个 attach 请求
    const p1 = registry.beginInitAndAttach('s4', 1111);
    const p2 = registry.beginInitAndAttach('s4', 2222);

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    // 一个成功，一个返回 SESSION_BUSY
    expect([r1.status, r2.status].filter(s => s === 'fulfilled')).toHaveLength(1);
    expect([r1.status, r2.status].filter(s => s === 'rejected')).toHaveLength(1);

    const updated = registry.get('s4')!;
    expect(updated.initState).toBe('initialized');
  });

  test('initState=initializing 时其他操作返回 SESSION_BUSY', () => {
    registry.create('s5', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry['_sessions'].get('s5')!.initState = 'initializing';
    expect(() => registry.markAttached('s5', 999)).toThrow('SESSION_BUSY');
  });

  // P1: lifecycleStatus 与 runtimeStatus 解耦
  test('lifecycleStatus=archived 时禁止进入运行态', () => {
    registry.create('s6', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.archive('s6');
    expect(() => registry.markAttached('s6', 999)).toThrow('SESSION_ARCHIVED');
  });

  test('lifecycleStatus 与 runtimeStatus 独立迁移', () => {
    registry.create('s7', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markStale('s7'); // lifecycleStatus: active → stale
    const s = registry.get('s7')!;
    expect(s.lifecycleStatus).toBe('stale');
    expect(s.status).toBe('idle'); // runtimeStatus 不受影响
  });

  // P1: session 锁 + revision CAS
  test('并发状态变更时 revision CAS 冲突返回 SESSION_BUSY', () => {
    registry.create('s8', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s8')!;
    const rev = s.revision;

    // 模拟并发：第一个操作成功，第二个基于旧 revision 失败
    registry.markAttached('s8', 1111); // revision++
    expect(() => registry.markAttachedWithRevision('s8', 2222, rev)).toThrow('SESSION_BUSY');
  });

  // P1: attach 优先于 IM
  test('idle 态并发时 attach 优先，IM 入队', async () => {
    registry.create('s9', { workdir: '/tmp', cliPlugin: 'claude-code' });

    // 并发 attach 和 IM 消息
    const attachPromise = registry.beginAttach('s9', 1111);
    const imPromise = registry.enqueueIMMessage('s9', { text: 'hello', dedupeKey: 'k1' });

    await attachPromise;
    const s = registry.get('s9')!;
    expect(s.status).toBe('attached');
    expect(s.messageQueue).toHaveLength(1); // IM 消息已入队
  });

  test('attach 期间 IM 不入队（直接返回 SESSION_BUSY）', () => {
    registry.create('s10', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markAttached('s10', 1111);
    expect(() => registry.enqueueIMMessage('s10', { text: 'hello', dedupeKey: 'k2' }))
      .toThrow('SESSION_BUSY');
  });

  test('get 不存在的 session 返回 undefined', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  test('list 返回所有 session', () => {
    registry.create('a', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.create('b', { workdir: '/tmp', cliPlugin: 'claude-code' });
    expect(registry.list()).toHaveLength(2);
  });

  test('remove 删除 session', () => {
    registry.create('del', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.remove('del');
    expect(registry.get('del')).toBeUndefined();
  });
});
