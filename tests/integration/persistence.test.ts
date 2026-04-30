import { describe, test, expect } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';
import { PersistenceStore } from '../../src/persistence.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('PersistenceStore', () => {
  test('写入后重新加载可恢复 session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r1 = new SessionRegistry(store);
    r1.create('test', { workdir: '/tmp', cliPlugin: 'claude-code' });
    await store.flush();

    const store2 = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r2 = new SessionRegistry(store2);
    await store2.load(r2);
    expect(r2.get('test')?.name).toBe('test');
  });

  test('重启后 attached/im_processing 状态重置为 idle+cold 并带 recovery metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    // 手动写入非干净状态
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ name: 'broken', status: 'im_processing', cliPlugin: 'claude-code', workdir: '/tmp' }],
    }));
    const store2 = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r2 = new SessionRegistry(store2);
    await store2.load(r2);
    expect(r2.get('broken')?.status).toBe('idle');
    expect(r2.get('broken')?.runtimeState).toBe('cold');
    expect(r2.get('broken')?.needsRecovery).toBe(true);
    expect(r2.get('broken')?.recoveryReason).toBe('daemon_restart_during_im');
  });

  test('重启后 ready worker 不恢复为 ready，而是 cold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'ready-session',
        status: 'idle',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-ready',
        initState: 'initialized',
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r = new SessionRegistry(store);
    await store.load(r);

    expect(r.get('ready-session')?.status).toBe('idle');
    expect(r.get('ready-session')?.runtimeState).toBe('cold');
    expect(r.get('ready-session')?.imWorkerPid).toBeNull();
  });

  test('approval_pending 重启后 fail-closed 为 idle+cold，并保留 recovery metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ name: 'approval-broken', status: 'approval_pending', cliPlugin: 'claude-code', workdir: '/tmp', sessionId: 'sess-approval' }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r = new SessionRegistry(store);
    await store.load(r);

    expect(r.get('approval-broken')?.status).toBe('idle');
    expect(r.get('approval-broken')?.runtimeState).toBe('cold');
    expect(r.get('approval-broken')?.needsRecovery).toBe(true);
    expect(r.get('approval-broken')?.recoveryReason).toBe('daemon_restart_during_approval');
    expect(r.get('approval-broken')?.imWorkerPid).toBeNull();
  });

  test('重启后 running/waiting_approval 消息恢复为 pending，waiting_approval 同时标记 approvalState=expired', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'replay-broken',
        status: 'approval_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-replay',
        messageQueue: [
          { messageId: 'm1', threadId: 't1', userId: 'u1', content: 'a', status: 'running', correlationId: 'c1', dedupeKey: 'd1', enqueuePolicy: 'auto_after_detach' },
          { messageId: 'm2', threadId: 't1', userId: 'u1', content: 'b', status: 'waiting_approval', correlationId: 'c2', dedupeKey: 'd2', enqueuePolicy: 'auto_after_detach' },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r = new SessionRegistry(store);
    await store.load(r);

    const queue = r.get('replay-broken')!.messageQueue;
    expect(queue[0]?.status).toBe('pending');
    expect(queue[1]?.status).toBe('pending');
    expect(queue[1]?.approvalState).toBe('expired');
  });

  test('持久化后保留 session 实际绑定空间类型', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    registry.create('thread-sess', { workdir: '/tmp/thread', cliPlugin: 'claude-code' });
    registry.bindIM('thread-sess', {
      plugin: 'mattermost',
      bindingKind: 'thread',
      threadId: 'thread-1',
      channelId: 'channel-root',
    } as any);

    registry.create('channel-sess', { workdir: '/tmp/channel', cliPlugin: 'claude-code' });
    registry.bindIM('channel-sess', {
      plugin: 'mattermost',
      bindingKind: 'channel',
      threadId: '',
      channelId: 'channel-1',
    } as any);

    await store.flush();

    const restoredStore = new PersistenceStore(path.join(dir, 'sessions.json'));
    const restoredRegistry = new SessionRegistry(restoredStore);
    await restoredStore.load(restoredRegistry);

    expect((restoredRegistry.get('thread-sess')!.imBindings[0] as any).bindingKind).toBe('thread');
    expect((restoredRegistry.get('channel-sess')!.imBindings[0] as any).bindingKind).toBe('channel');
  });

  test('S3.1: 低风险中断消息恢复后应标记 restoreAction=replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'restore-replay',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-restore-replay',
        messageQueue: [
          {
            messageId: 'm-replay-1',
            threadId: 't1',
            userId: 'u1',
            content: 'list files',
            status: 'running',
            correlationId: 'c-replay-1',
            dedupeKey: 'mattermost:t1:m-replay-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('restore-replay')!.messageQueue;
    expect(queue[0]?.status).toBe('pending');
    expect(queue[0]?.restoreAction).toBe('replay');
  });

  test('S3.1: 带审批上下文的中断消息恢复后应标记 restoreAction=confirm', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'restore-confirm',
        status: 'approval_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-restore-confirm',
        messageQueue: [
          {
            messageId: 'm-confirm-1',
            threadId: 't1',
            userId: 'u1',
            content: 'edit config',
            status: 'waiting_approval',
            approvalState: 'pending',
            correlationId: 'c-confirm-1',
            dedupeKey: 'mattermost:t1:m-confirm-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('restore-confirm')!.messageQueue;
    expect(queue[0]?.status).toBe('pending');
    expect(queue[0]?.approvalState).toBe('expired');
    expect(queue[0]?.restoreAction).toBe('confirm');
  });

  test('S3.1: 明确拒绝的中断审批恢复后应标记 restoreAction=discard', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'restore-discard',
        status: 'approval_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-restore-discard',
        messageQueue: [
          {
            messageId: 'm-discard-1',
            threadId: 't1',
            userId: 'u1',
            content: 'dangerous shell op',
            status: 'waiting_approval',
            approvalState: 'denied',
            correlationId: 'c-discard-1',
            dedupeKey: 'mattermost:t1:m-discard-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('restore-discard')!.messageQueue;
    expect(queue[0]?.status).toBe('pending');
    expect(queue[0]?.restoreAction).toBe('discard');
  });

  test('S3.1: replay 恢复必须写入 replayOf 且保持 dedupe 唯一', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'restore-replay-pointer',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-restore-pointer',
        messageQueue: [
          {
            messageId: 'm-replay-pointer-1',
            threadId: 't1',
            userId: 'u1',
            content: 'safe replay message',
            status: 'running',
            correlationId: 'c-replay-pointer-1',
            dedupeKey: 'mattermost:t1:m-replay-pointer-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('restore-replay-pointer')!.messageQueue;
    const original = queue.find((item) => item.dedupeKey === 'mattermost:t1:m-replay-pointer-1');
    const replayed = queue.find((item) => item.replayOf === 'mattermost:t1:m-replay-pointer-1');

    expect(original).toBeTruthy();
    expect(replayed).toBeTruthy();
    expect(replayed?.restoreAction).toBe('replay');
    expect(replayed?.dedupeKey).toBe('mattermost:t1:m-replay-pointer-1');
    expect(queue.filter((item) => item.replayOf === 'mattermost:t1:m-replay-pointer-1')).toHaveLength(1);
  });
});
