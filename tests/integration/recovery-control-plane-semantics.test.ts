import { describe, test, expect } from 'vitest';
import { PersistenceStore } from '../../src/persistence.js';
import { SessionRegistry } from '../../src/session-registry.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('S3.2: recovery control plane semantics', () => {
  test('attached / im_processing / approval_pending / takeover_pending 重启后统一回到 idle+cold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-matrix-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [
        { name: 's-attached', status: 'attached', cliPlugin: 'claude-code', workdir: '/tmp', sessionId: 'sess-attached' },
        { name: 's-running', status: 'im_processing', cliPlugin: 'claude-code', workdir: '/tmp', sessionId: 'sess-running' },
        { name: 's-approval', status: 'approval_pending', cliPlugin: 'claude-code', workdir: '/tmp', sessionId: 'sess-approval' },
        { name: 's-takeover', status: 'takeover_pending', cliPlugin: 'claude-code', workdir: '/tmp', sessionId: 'sess-takeover' },
      ],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    for (const name of ['s-attached', 's-running', 's-approval', 's-takeover']) {
      const session = registry.get(name)!;
      expect(session.status).toBe('idle');
      expect(session.runtimeState).toBe('cold');
      expect(session.needsRecovery).toBe(true);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('旧 recovering 持久化状态重启后不再停留在 recovering', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-stale-recovering-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'stale-recovering-2',
        status: 'recovering',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-recovering-2',
        recoveryReason: 'daemon_restart_during_im',
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const session = registry.get('stale-recovering-2')!;
    expect(session.status).toBe('idle');
    expect(session.runtimeState).toBe('cold');
    expect(session.runtimeState).not.toBe('recovering');
    expect(session.needsRecovery).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('带恢复动作的中断消息保留在队列中，等待显式 replay/confirm/discard', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-explicit-queue-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'explicit-queue',
        status: 'approval_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-explicit-queue',
        messageQueue: [
          {
            messageId: 'm-explicit-1',
            threadId: 't1',
            userId: 'u1',
            content: 'edit config',
            status: 'waiting_approval',
            approvalState: 'pending',
            correlationId: 'c-explicit-1',
            dedupeKey: 'mm:t1:m-explicit-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const session = registry.get('explicit-queue')!;
    expect(session.messageQueue).toHaveLength(1);
    expect(session.messageQueue[0]?.status).toBe('pending');
    expect(session.messageQueue[0]?.restoreAction).toBe('confirm');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
