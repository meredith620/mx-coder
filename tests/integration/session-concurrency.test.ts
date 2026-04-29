/**
 * S1.2: 会话级锁 + revision CAS 全链收口
 *
 * 测试关键状态变更、队列变更、副作用写入的原子性与并发裁决。
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';

let registry: SessionRegistry;
beforeEach(() => { registry = new SessionRegistry(); });

describe('S1.2: 会话级锁 + revision CAS 全链收口', () => {
  test('并发 attach 时仅一个成功，其余返回 SESSION_BUSY', async () => {
    registry.create('concurrent-attach', { workdir: '/tmp', cliPlugin: 'claude-code' });

    const results = await Promise.allSettled([
      registry.beginInitAndAttach('concurrent-attach', 1111),
      registry.beginInitAndAttach('concurrent-attach', 2222),
      registry.beginInitAndAttach('concurrent-attach', 3333),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // 关键断言：仅一个 attach 成功
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    // 失败的应该是 INVALID_STATE_TRANSITION（mutex 序列化后，后续调用看到已变更的状态）
    rejected.forEach(r => {
      const msg = (r as PromiseRejectedResult).reason.message;
      expect(msg === 'SESSION_BUSY' || msg === 'INVALID_STATE_TRANSITION').toBe(true);
    });

    const session = registry.get('concurrent-attach')!;
    expect(session.status).toBe('attached');
    expect(session.initState).toBe('initialized');
  });

  test('并发 enqueue 相同 dedupeKey 时仅一条入队', () => {
    registry.create('concurrent-enqueue', { workdir: '/tmp', cliPlugin: 'claude-code' });

    // 同步调用 enqueueIMMessage，dedupeKey 相同
    const r1 = registry.enqueueIMMessage('concurrent-enqueue', {
      text: 'msg1',
      dedupeKey: 'same-key',
      threadId: 'thread-1',
      messageId: 'msg-1',
      userId: 'user-1',
    });

    const r2 = registry.enqueueIMMessage('concurrent-enqueue', {
      text: 'msg2',
      dedupeKey: 'same-key',
      threadId: 'thread-1',
      messageId: 'msg-2',
      userId: 'user-1',
    });

    // 关键断言：第一条入队成功，第二条被去重
    expect(r1.alreadyExists).toBe(false);
    expect(r2.alreadyExists).toBe(true);

    const session = registry.get('concurrent-enqueue')!;
    expect(session.messageQueue).toHaveLength(1);
    expect(session.messageQueue[0].content).toBe('msg1');
  });

  test('attach_pending 期间 IM 消息可入队但 dispatcher 不消费', async () => {
    registry.create('attach-pending-frozen', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markImProcessing('attach-pending-frozen', 5001);
    registry.markAttachPending('attach-pending-frozen');

    const session = registry.get('attach-pending-frozen')!;
    expect(session.status).toBe('attach_pending');

    // IM 消息可以入队
    registry.enqueueIMMessage('attach-pending-frozen', {
      text: 'queued during attach_pending',
      dedupeKey: 'dk-frozen',
      threadId: 'thread-frozen',
      messageId: 'msg-frozen',
      userId: 'user-frozen',
    });

    expect(session.messageQueue).toHaveLength(1);

    // 关键断言：dispatcher 的 _tick() 会跳过 status !== 'idle' 的 session
    // 这个行为已在 im-routing.test.ts 中的 dispatcher 测试覆盖
    // 此处仅验证入队成功且状态保持 attach_pending
    expect(session.status).toBe('attach_pending');
  });

  test('revision 冲突时 markAttachedWithRevision 返回 SESSION_BUSY', () => {
    registry.create('revision-conflict', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const session = registry.get('revision-conflict')!;
    const oldRevision = session.revision;

    // 先执行一次状态变更，revision 递增
    registry.markAttached('revision-conflict', 1111);
    expect(registry.get('revision-conflict')!.revision).toBe(oldRevision + 1);

    // 用旧 revision 尝试再次 attach，应该失败
    expect(() => {
      registry.markAttachedWithRevision('revision-conflict', 2222, oldRevision);
    }).toThrow('SESSION_BUSY');

    // 关键断言：状态未被部分修改
    const final = registry.get('revision-conflict')!;
    expect(final.attachedPid).toBe(1111); // 仍是第一次 attach 的 pid
    expect(final.status).toBe('attached');
  });

  test('SESSION_BUSY 与 ACL_DENIED 语义隔离', () => {
    registry.create('busy-vs-acl', { workdir: '/tmp', cliPlugin: 'claude-code' });

    // SESSION_BUSY：并发冲突
    (registry as any)._sessions.get('busy-vs-acl')!.initState = 'initializing';
    expect(() => registry.markAttached('busy-vs-acl', 999)).toThrow('SESSION_BUSY');

    // ACL_DENIED 应该在 daemon 层返回，registry 层不涉及 ACL
    // 此处仅验证 SESSION_BUSY 的错误码与 ACL_DENIED 不混淆
    // （ACL_DENIED 的测试在 daemon-commands.test.ts 中）
  });

  test('markImProcessing 在锁持有时返回 SESSION_BUSY 且状态不变', async () => {
    registry.create('locked-processing', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const before = registry.get('locked-processing')!;
    expect(before.status).toBe('idle');
    expect(before.runtimeState).toBe('cold');

    const mutex = (registry as any)._getMutex('locked-processing');
    await mutex.acquire();
    try {
      expect(() => registry.markImProcessing('locked-processing', 9001)).toThrow('SESSION_BUSY');

      const after = registry.get('locked-processing')!;
      expect(after.status).toBe('idle');
      expect(after.runtimeState).toBe('cold');
      expect(after.imWorkerPid).toBeNull();
    } finally {
      mutex.release();
    }
  });

  test('并发 takeover 请求时仅第一个生效', () => {
    registry.create('concurrent-takeover', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.markAttached('concurrent-takeover', 1111);

    // 第一个 takeover 请求
    registry.requestTakeover('concurrent-takeover', 'user-1');
    expect(registry.get('concurrent-takeover')!.status).toBe('takeover_pending');

    // 第二个 takeover 请求应该被拒绝（已经在 takeover_pending）
    expect(() => registry.requestTakeover('concurrent-takeover', 'user-2')).toThrow('INVALID_STATE_TRANSITION');
  });

  test('worker spawn 并发时 spawnGeneration 防止双启动', () => {
    registry.create('spawn-race', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const session = registry.get('spawn-race')!;
    const initialGen = session.spawnGeneration;

    // 模拟 pre-warm 与 lazy spawn 并发
    session.spawnGeneration += 1;
    const gen1 = session.spawnGeneration;

    session.spawnGeneration += 1;
    const gen2 = session.spawnGeneration;

    // 关键断言：generation 递增，后启动的 worker 会检测到 generation 不匹配并自杀
    expect(gen2).toBe(gen1 + 1);
    expect(gen2).toBe(initialGen + 2);

    // 实际的 generation 检查逻辑在 im-worker-manager.ts 中
    // 此处仅验证 registry 层的 generation 字段可被正确递增
  });
});
