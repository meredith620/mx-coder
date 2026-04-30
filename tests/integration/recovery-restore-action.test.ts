import { describe, test, expect } from 'vitest';
import { PersistenceStore } from '../../src/persistence.js';
import { SessionRegistry } from '../../src/session-registry.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('recovery restore action integration', () => {
  test('重启后低风险 running message 标记为 replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-recovery-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'replay-session',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-replay',
        messageQueue: [
          { messageId: 'm1', threadId: 't1', userId: 'u1', content: 'hello', status: 'running', correlationId: 'c1', dedupeKey: 'plugin:t1:m1', enqueuePolicy: 'auto_after_detach' },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('replay-session')!.messageQueue;
    expect(queue[0]?.status).toBe('pending');
    expect(queue[0]?.restoreAction).toBe('replay');
    expect(queue[0]?.replayOf).toBe('plugin:t1:m1');
  });

  test('重启后带审批上下文消息标记为 confirm', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-recovery-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'confirm-session',
        status: 'approval_pending',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-confirm',
        messageQueue: [
          { messageId: 'm2', threadId: 't1', userId: 'u1', content: 'edit file', status: 'waiting_approval', correlationId: 'c2', dedupeKey: 'plugin:t1:m2', enqueuePolicy: 'auto_after_detach', approvalState: 'pending' },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('confirm-session')!.messageQueue;
    expect(queue[0]?.status).toBe('pending');
    expect(queue[0]?.restoreAction).toBe('confirm');
    expect(queue[0]?.approvalState).toBe('expired');

    const audit = store.getAuditRecords().find((item) => item.action === 'restore_confirm');
    expect(audit).toEqual({
      dedupeKey: 'plugin:t1:m2',
      replayOf: null,
      requestId: null,
      operatorId: 'u1',
      action: 'restore_confirm',
      result: 'scheduled',
    });
  });

  test('重启后高风险消息标记为 discard', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-recovery-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'discard-session',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-discard',
        messageQueue: [
          { messageId: 'm3', threadId: 't1', userId: 'u1', content: 'rm -rf /tmp/demo', status: 'running', correlationId: 'c3', dedupeKey: 'plugin:t1:m3', enqueuePolicy: 'auto_after_detach' },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('discard-session')!.messageQueue;
    expect(queue[0]?.restoreAction).toBe('discard');
    expect(queue[0]?.replayOf).toBeUndefined();

    const audit = store.getAuditRecords().find((item) => item.action === 'restore_discard');
    expect(audit).toEqual({
      dedupeKey: 'plugin:t1:m3',
      replayOf: null,
      requestId: null,
      operatorId: 'u1',
      action: 'restore_discard',
      result: 'scheduled',
    });
  });
});
