import { describe, test, expect } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';
import { PersistenceStore } from '../../src/persistence.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('PersistenceStore', () => {
  test('写入后重新加载可恢复 session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r1 = new SessionRegistry(store);
    r1.create('test', { workdir: '/tmp', cliPlugin: 'claude-code' });
    await store.flush();

    const store2 = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r2 = new SessionRegistry(store2);
    await store2.load(r2);
    expect(r2.get('test')?.name).toBe('test');
  });

  test('重启后 attached/im_processing 状态重置为 recovering', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    // 手动写入非干净状态
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ name: 'broken', status: 'im_processing', cliPlugin: 'claude-code', workdir: '/tmp' }],
    }));
    const store2 = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r2 = new SessionRegistry(store2);
    await store2.load(r2);
    expect(r2.get('broken')?.status).toBe('recovering');
  });

  test('重启后 ready worker 不恢复为 ready，而是 cold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
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

  test('approval_pending 重启后 fail-closed 为 recovering + cold worker pid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ name: 'approval-broken', status: 'approval_pending', cliPlugin: 'claude-code', workdir: '/tmp', sessionId: 'sess-approval' }],
    }));

    const store = new PersistenceStore(path.join(dir, 'sessions.json'));
    const r = new SessionRegistry(store);
    await store.load(r);

    expect(r.get('approval-broken')?.status).toBe('recovering');
    expect(r.get('approval-broken')?.runtimeState).toBe('recovering');
    expect(r.get('approval-broken')?.imWorkerPid).toBeNull();
  });

  test('持久化后保留 session 实际绑定空间类型', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
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
});
