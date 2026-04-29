import { describe, test, expect } from 'vitest';
import { PersistenceStore } from '../../src/persistence.js';
import { SessionRegistry } from '../../src/session-registry.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('S3.2: recovering 语义收缩与显式中断恢复', () => {
  test('approval_pending 重启后 fail-closed，并保留明确 restoreAction=confirm', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-approval-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'approval-restart',
        status: 'approval_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-approval-restart',
        messageQueue: [
          {
            messageId: 'm-approval-1',
            threadId: 't1',
            userId: 'u1',
            content: 'edit config',
            status: 'waiting_approval',
            approvalState: 'pending',
            correlationId: 'c-approval-1',
            dedupeKey: 'mm:t1:m-approval-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const session = registry.get('approval-restart')!;
    expect(session.status).toBe('idle');
    expect(session.runtimeState).toBe('cold');
    expect(session.needsRecovery).toBe(true);
    expect(session.recoveryReason).toBe('daemon_restart_during_approval');
    expect(session.messageQueue[0]?.approvalState).toBe('expired');
    expect(session.messageQueue[0]?.restoreAction).toBe('confirm');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('recovering 遗留态中的 waiting_approval 消息仍需显式恢复，不会静默消失', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-recovering-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'recovering-pending',
        status: 'recovering',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-recovering-pending',
        recoveryReason: 'daemon_restart_during_approval',
        messageQueue: [
          {
            messageId: 'm-recover-1',
            threadId: 't1',
            userId: 'u1',
            content: 'dangerous op',
            status: 'waiting_approval',
            approvalState: 'pending',
            correlationId: 'c-recover-1',
            dedupeKey: 'mm:t1:m-recover-1',
            enqueuePolicy: 'auto_after_detach',
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const session = registry.get('recovering-pending')!;
    expect(session.status).toBe('idle');
    expect(session.runtimeState).toBe('cold');
    expect(session.messageQueue).toHaveLength(1);
    expect(session.messageQueue[0]?.status).toBe('pending');
    expect(session.messageQueue[0]?.restoreAction).toBe('confirm');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('takeover_pending 重启后不残留 takeoverRequestedBy / takeoverRequestedAt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-s32-takeover-meta-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'takeover-meta',
        status: 'takeover_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-takeover-meta',
        takeoverRequestedBy: 'user-im',
        takeoverRequestedAt: new Date().toISOString(),
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const session = registry.get('takeover-meta')! as any;
    expect(session.status).toBe('idle');
    expect(session.runtimeState).toBe('cold');
    expect(session.takeoverRequestedBy).toBeUndefined();
    expect(session.takeoverRequestedAt).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
