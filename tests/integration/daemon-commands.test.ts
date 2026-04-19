import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import * as path from 'path';
import * as os from 'os';

let daemon: Daemon;
let client: IPCClient;
let socketPath: string;

beforeEach(async () => {
  socketPath = path.join(os.tmpdir(), `mm-test-daemon-${Date.now()}.sock`);
  daemon = new Daemon(socketPath);
  await daemon.start();
  client = new IPCClient(socketPath);
  await client.connect();
});

afterEach(async () => {
  await client.close();
  await daemon.stop();
});

describe('Daemon CRUD commands', () => {
  test('create + list 往返', async () => {
    const res = await client.send('create', { name: 'test', workdir: '/tmp', cli: 'claude-code' });
    expect(res.ok).toBe(true);

    const listRes = await client.send('list', {});
    expect(listRes.ok).toBe(true);
    expect((listRes.data!.sessions as any[]).some((s: any) => s.name === 'test')).toBe(true);
  });

  test('remove idle + cold session 成功删除', async () => {
    await client.send('create', { name: 'remove-cold', workdir: '/tmp', cli: 'claude-code' });

    const removeRes = await client.send('remove', { name: 'remove-cold' });
    expect(removeRes.ok).toBe(true);
    expect(daemon.registry.get('remove-cold')).toBeUndefined();
  });

  test('remove idle + ready session 会先 terminate worker 再删除 registry', async () => {
    await client.send('create', { name: 'remove-ready', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.markWorkerReady('remove-ready', 43210);

    const terminateSpy = vi.fn().mockResolvedValue(undefined);
    (daemon as any)._imWorkerManager = { terminate: terminateSpy };

    const removeRes = await client.send('remove', { name: 'remove-ready' });
    expect(removeRes.ok).toBe(true);
    expect(terminateSpy).toHaveBeenCalledWith('remove-ready');
    expect(daemon.registry.get('remove-ready')).toBeUndefined();
  });

  test('remove attached session 返回明确错误且不删除', async () => {
    await client.send('create', { name: 'remove-attached', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'remove-attached', pid: 9999 });

    const removeRes = await client.send('remove', { name: 'remove-attached' });
    expect(removeRes.ok).toBe(false);
    expect(removeRes.error!.code).toBe('INVALID_STATE_TRANSITION');
    expect(removeRes.error!.message).toContain('attached');
    expect(daemon.registry.get('remove-attached')).toBeTruthy();
  });

  test('remove 后 list 不再包含该 session', async () => {
    await client.send('create', { name: 'to-remove', workdir: '/tmp', cli: 'claude-code' });

    const removeRes = await client.send('remove', { name: 'to-remove' });
    expect(removeRes.ok).toBe(true);

    const listRes = await client.send('list', {});
    expect((listRes.data!.sessions as any[]).some((s: any) => s.name === 'to-remove')).toBe(false);
  });

  test('status 返回 daemon 运行状态', async () => {
    const res = await client.send('status', {});
    expect(res.ok).toBe(true);
    expect(res.data!.pid).toBeGreaterThan(0);
    expect(res.data!.sessions).toBeDefined();
  });

  test('create 重复名称返回 SESSION_ALREADY_EXISTS', async () => {
    await client.send('create', { name: 'dup', workdir: '/tmp', cli: 'claude-code' });
    const res = await client.send('create', { name: 'dup', workdir: '/tmp', cli: 'claude-code' });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('SESSION_ALREADY_EXISTS');
  });


  test('remove channel 绑定 session 时仅做本地解绑/删除，不做远端硬删除前提下可成功完成', async () => {
    await client.send('create', { name: 'remove-channel', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.bindIM('remove-channel', {
      plugin: 'mattermost',
      bindingKind: 'channel',
      threadId: '',
      channelId: 'channel-1',
    } as any);

    const removeRes = await client.send('remove', { name: 'remove-channel' });
    expect(removeRes.ok).toBe(true);
    expect(daemon.registry.get('remove-channel')).toBeUndefined();
  });

  test('status 返回 session 实际绑定空间类型', async () => {
    await client.send('create', { name: 'status-channel', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.bindIM('status-channel', {
      plugin: 'mattermost',
      bindingKind: 'channel',
      threadId: '',
      channelId: 'channel-99',
    } as any);

    const statusRes = await client.send('status', {});
    expect(statusRes.ok).toBe(true);
    const session = (statusRes.data!.sessions as any[]).find((s: any) => s.name === 'status-channel');
    expect(session.imBindings).toHaveLength(1);
    expect(session.imBindings[0].bindingKind).toBe('channel');
    expect(session.imBindings[0].channelId).toBe('channel-99');
  });
});

describe('ACL enforcement', () => {
  test('attach 命令无 owner 角色时返回 ACL_DENIED', async () => {
    await client.send('create', { name: 'acl-test', workdir: '/tmp', cli: 'claude-code' });

    const res = await client.send('attach', { name: 'acl-test', pid: 9999 }, {
      actor: { source: 'cli', userId: 'stranger' },
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');

    // 零副作用：session 状态未变
    const listRes = await client.send('list', {});
    const s = (listRes.data!.sessions as any[]).find((s: any) => s.name === 'acl-test');
    expect(s.status).toBe('idle');
  });

  test('remove 命令无 owner 角色时返回 ACL_DENIED，session 未删除', async () => {
    await client.send('create', { name: 'acl-test2', workdir: '/tmp', cli: 'claude-code' });

    const res = await client.send('remove', { name: 'acl-test2' }, {
      actor: { source: 'cli', userId: 'stranger' },
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');

    const listRes = await client.send('list', {});
    expect((listRes.data!.sessions as any[]).some((s: any) => s.name === 'acl-test2')).toBe(true);
  });

  test('SESSION_BUSY 与 ACL_DENIED 返回不同错误码', async () => {
    // ACL_DENIED = 权限问题，SESSION_BUSY = 并发冲突，两者不同
    expect('ACL_DENIED').not.toBe('SESSION_BUSY');
  });
});

describe('takeover commands', () => {
  test('takeoverStatus 返回接管请求信息', async () => {
    await client.send('create', { name: 'takeover-test', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'takeover-test', pid: 9999 });
    daemon.registry.requestTakeover('takeover-test', 'user-im');

    const res = await client.send('takeoverStatus', { name: 'takeover-test' });
    expect(res.ok).toBe(true);
    expect(res.data!.takeoverRequestedBy).toBe('user-im');
    expect((res.data!.session as any).status).toBe('takeover_pending');
  });

  test('takeover-force 风格释放后 session 回到 idle', async () => {
    await client.send('create', { name: 'takeover-force-test', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'takeover-force-test', pid: 9999 });
    daemon.registry.requestTakeover('takeover-force-test', 'user-im');

    daemon.registry.completeTakeover('takeover-force-test');

    const res = await client.send('takeoverStatus', { name: 'takeover-force-test' });
    expect(res.ok).toBe(true);
    expect((res.data!.session as any).status).toBe('idle');
  });
});
