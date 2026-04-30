import { describe, test, expect } from 'vitest';
import { PersistenceStore } from '../../src/persistence.js';
import { SessionRegistry } from '../../src/session-registry.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('S3.2: recovering 语义收缩与显式中断恢复', () => {
  test('takeover_pending 重启后回到 idle+cold 并带 recovery metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'takeover-broken',
        status: 'takeover_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-takeover',
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const s = registry.get('takeover-broken')!;
    expect(s.status).toBe('idle');
    expect(s.runtimeState).toBe('cold');
    expect(s.needsRecovery).toBe(true);
    expect(s.recoveryReason).toBe('daemon_restart_during_takeover');
    expect(s.attachedPid).toBeNull();
    expect(s.imWorkerPid).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('旧 recovering 持久化状态重启后不再停留在 recovering，而是回到 idle+cold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'stale-recovering',
        status: 'recovering',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-recovering',
        recoveryReason: 'worker_crash',
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const s = registry.get('stale-recovering')!;
    expect(s.status).toBe('idle');
    expect(s.runtimeState).toBe('cold');
    expect(s.needsRecovery).toBe(true);
    expect(s.recoveryReason).toBe('worker_crash');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('attached 重启后回到 idle+cold 并带 recovery metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'attached-broken',
        status: 'attached',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-attached',
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const s = registry.get('attached-broken')!;
    expect(s.status).toBe('idle');
    expect(s.runtimeState).toBe('cold');
    expect(s.needsRecovery).toBe(true);
    expect(s.recoveryReason).toBe('daemon_restart_during_attach');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('markWorkerReady 清除 needsRecovery / recoveryReason', () => {
    const registry = new SessionRegistry();
    registry.create('recover-clear', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const s = registry.get('recover-clear')!;
    s.needsRecovery = true;
    s.recoveryReason = 'daemon_restart_during_im';

    registry.markWorkerReady('recover-clear', 1234);

    expect(s.needsRecovery).toBeUndefined();
    expect(s.recoveryReason).toBeUndefined();
    expect(s.runtimeState).toBe('ready');
  });

  test('中断的 running 消息恢复后带 restoreAction 标记，不会被静默重放', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'explicit-restore',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-explicit',
        messageQueue: [
          { messageId: 'm1', threadId: 't1', userId: 'u1', content: 'hello', status: 'running', correlationId: 'c1', dedupeKey: 'dk1', enqueuePolicy: 'auto_after_detach' },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('explicit-restore')!.messageQueue;
    expect(queue[0]?.restoreAction).toBeDefined();
    expect(['replay', 'confirm', 'discard']).toContain(queue[0]?.restoreAction);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
