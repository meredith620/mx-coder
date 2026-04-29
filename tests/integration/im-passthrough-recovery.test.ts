import { describe, test, expect } from 'vitest';
import { PersistenceStore } from '../../src/persistence.js';
import { SessionRegistry } from '../../src/session-registry.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('IM passthrough recovery', () => {
  test('passthrough 消息重启后保留 dedupeKey，并标记为 confirm 而非静默 replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-pass-recovery-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'pass-recovery',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-pass-recovery',
        messageQueue: [
          {
            messageId: 'm-pass-1',
            threadId: 't1',
            userId: 'u1',
            content: '/model sonnet',
            status: 'running',
            correlationId: 'c-pass-1',
            dedupeKey: 'mattermost:t1:m-pass-1',
            enqueuePolicy: 'auto_after_detach',
            isPassthrough: true,
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('pass-recovery')!.messageQueue;
    expect(queue[0]?.dedupeKey).toBe('mattermost:t1:m-pass-1');
    expect((queue[0] as any)?.isPassthrough).toBe(true);
    expect(queue[0]?.restoreAction).toBe('discard');
    expect(queue[0]?.replayOf).toBeUndefined();
  });

  test('passthrough 审计可与普通文本恢复区分', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-pass-recovery-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{
        name: 'pass-audit',
        status: 'im_processing',
        cliPlugin: 'claude-code',
        workdir: '/tmp',
        sessionId: 'sess-pass-audit',
        messageQueue: [
          {
            messageId: 'm-pass-2',
            threadId: 't1',
            userId: 'u1',
            content: '/compact',
            status: 'running',
            correlationId: 'c-pass-2',
            dedupeKey: 'mattermost:t1:m-pass-2',
            enqueuePolicy: 'auto_after_detach',
            isPassthrough: true,
          },
        ],
      }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const registry = new SessionRegistry(store);
    await store.load(registry);

    const queue = registry.get('pass-audit')!.messageQueue;
    expect((queue[0] as any)?.isPassthrough).toBe(true);
    expect(queue[0]?.restoreAction).toBe('discard');
  });
});
