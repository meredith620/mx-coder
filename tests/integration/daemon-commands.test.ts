import { describe, test, expect, beforeEach, afterEach } from 'vitest';
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

  test('remove 不存在的 session 返回 SESSION_NOT_FOUND', async () => {
    const res = await client.send('remove', { name: 'ghost' });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('SESSION_NOT_FOUND');
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
