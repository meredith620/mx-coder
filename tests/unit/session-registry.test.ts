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

  test('新建 session 默认为 status=idle, runtimeState=cold', () => {
    registry.create('s0', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s0')!;
    expect(s.status).toBe('idle');
    expect(s.runtimeState).toBe('cold');
  });

  test('markAttached 更新 pid 和状态', () => {
    registry.create('s1', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markAttached('s1', 1234);
    const s = registry.get('s1')!;
    expect(s.status).toBe('attached');
    expect(s.attachedPid).toBe(1234);
    expect(s.runtimeState).toBe('attached_terminal');
  });

  test('worker 已就绪但未执行消息时保持 status=idle, runtimeState=ready', () => {
    registry.create('s-ready', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s-ready')!;
    s.imWorkerPid = 4321;
    s.runtimeState = 'ready';

    expect(s.status).toBe('idle');
    expect(s.runtimeState).toBe('ready');
  });

  test('markImProcessing 后为 status=im_processing, runtimeState=running', () => {
    registry.create('s-running', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markImProcessing('s-running', 2001);
    const s = registry.get('s-running')!;

    expect(s.status).toBe('im_processing');
    expect(s.runtimeState).toBe('running');
    expect(s.imWorkerPid).toBe(2001);
  });

  test('approval_pending 对应 runtimeState=waiting_approval', () => {
    registry.create('s-approval', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markImProcessing('s-approval', 2002);
    registry['_sessions'].get('s-approval')!.imWorkerPid = 2002;
    registry['_sessions'].get('s-approval')!.status = 'im_processing';
    registry['_sessions'].get('s-approval')!.runtimeState = 'running';
    registry['_applyTransition' as keyof SessionRegistry]?.call?.(registry, registry.get('s-approval'), 'tool_permission_required');
    const s = registry.get('s-approval')!;

    expect(s.status).toBe('approval_pending');
    expect(s.runtimeState).toBe('waiting_approval');
  });

  test('markImDone 后保留 worker 时回到 status=idle, runtimeState=ready', () => {
    registry.create('s-ready-done', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markImProcessing('s-ready-done', 5001);
    registry.markImDone('s-ready-done');
    const s = registry.get('s-ready-done')!;

    expect(s.status).toBe('idle');
    expect(s.runtimeState).toBe('ready');
    expect(s.imWorkerPid).toBe(5001);
  });

  test('markAttachPending 在 worker ready 时保持 attach_pending + ready', () => {
    registry.create('s-attach-pending-transition', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s-attach-pending-transition')!;
    s.imWorkerPid = 5002;
    s.runtimeState = 'ready';

    registry.markAttachPending('s-attach-pending-transition');

    expect(s.status).toBe('attach_pending');
    expect(s.runtimeState).toBe('ready');
    expect(s.imWorkerPid).toBe(5002);
  });

  test('markAttachPending 在 approval_pending 时进入 attach_pending + waiting_approval', () => {
    registry.create('s-attach-from-approval', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markImProcessing('s-attach-from-approval', 5003);
    registry['_applyTransition' as keyof SessionRegistry]?.call?.(registry, registry.get('s-attach-from-approval'), 'tool_permission_required');
    const s = registry.get('s-attach-from-approval')!;

    registry.markAttachPending('s-attach-from-approval');

    expect(s.status).toBe('attach_pending');
    expect(s.runtimeState).toBe('waiting_approval');
    expect(s.imWorkerPid).toBe(5003);
  });

  test('getByIMThread 按 plugin+threadId 查找', () => {
    registry.create('s2', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.bindIM('s2', { plugin: 'mattermost', threadId: 'thread-1' });
    const found = registry.getByIMThread('mattermost', 'thread-1');
    expect(found?.name).toBe('s2');
  });

  test('非法状态迁移时 markAttached 从 error 状态失败', () => {
    registry.create('s3', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry['_sessions'].get('s3')!.status = 'error';
    expect(() => registry.markAttached('s3', 999)).toThrow('INVALID_STATE_TRANSITION');
  });

  test('initState=uninitialized 时 attach 触发懒初始化（first-writer-wins）', async () => {
    registry.create('s4', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s4')!;
    expect(s.initState).toBe('uninitialized');

    const p1 = registry.beginInitAndAttach('s4', 1111);
    const p2 = registry.beginInitAndAttach('s4', 2222);

    const [r1, r2] = await Promise.allSettled([p1, p2]);
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

  test('lifecycleStatus=archived 时禁止进入运行态', () => {
    registry.create('s6', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.archive('s6');
    expect(() => registry.markAttached('s6', 999)).toThrow('SESSION_ARCHIVED');
  });

  test('lifecycleStatus 与 runtimeStatus 独立迁移', () => {
    registry.create('s7', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markStale('s7');
    const s = registry.get('s7')!;
    expect(s.lifecycleStatus).toBe('stale');
    expect(s.status).toBe('idle');
  });

  test('并发状态变更时 revision CAS 冲突返回 SESSION_BUSY', () => {
    registry.create('s8', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('s8')!;
    const rev = s.revision;

    registry.markAttached('s8', 1111);
    expect(() => registry.markAttachedWithRevision('s8', 2222, rev)).toThrow('SESSION_BUSY');
  });

  test('idle 态并发时 attach 优先，IM 入队', async () => {
    registry.create('s9', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const attachPromise = registry.beginAttach('s9', 1111);
    registry.enqueueIMMessage('s9', { text: 'hello', dedupeKey: 'k1' });

    await attachPromise;
    const s = registry.get('s9')!;
    expect(s.status).toBe('attached');
    expect(s.messageQueue).toHaveLength(1);
  });

  test('attach 期间 IM 入队（SPEC §3.9：attached 时默认入队）', () => {
    registry.create('s10', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markAttached('s10', 1111);
    registry.enqueueIMMessage('s10', { text: 'hello', dedupeKey: 'k2' });
    expect(registry.get('s10')!.messageQueue).toHaveLength(1);
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
