import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import * as path from 'path';
import * as os from 'os';

let daemon: Daemon;
let client: IPCClient;
let socketPath: string;

beforeEach(async () => {
  socketPath = path.join(os.tmpdir(), `mm-test-import-${Date.now()}.sock`);
  daemon = new Daemon(socketPath);
  await daemon.start();
  client = new IPCClient(socketPath);
  await client.connect();
});

afterEach(async () => {
  await client.close();
  await daemon.stop();
});

describe('import command', () => {
  test('import 创建 session 并绑定外部 sessionId', async () => {
    const res = await client.send('import', {
      sessionId: 'external-uuid-123',
      name: 'imported',
      workdir: '/tmp',
      cli: 'claude-code',
    });
    expect(res.ok).toBe(true);

    const listRes = await client.send('list', {});
    const sessions = (listRes.data!.sessions as any[]);
    const s = sessions.find((s: any) => s.name === 'imported');
    expect(s).toBeDefined();
    expect(s.sessionId).toBe('external-uuid-123');
  });

  test('import 不指定 name 时自动生成名称', async () => {
    const res = await client.send('import', {
      sessionId: 'external-uuid-456',
      workdir: '/tmp',
      cli: 'claude-code',
    });
    expect(res.ok).toBe(true);

    const listRes = await client.send('list', {});
    const sessions = (listRes.data!.sessions as any[]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBeTruthy();
    expect(sessions[0].sessionId).toBe('external-uuid-456');
  });

  test('import 重复 sessionId 返回 SESSION_ALREADY_EXISTS', async () => {
    await client.send('import', {
      sessionId: 'dup-uuid',
      name: 'first',
      workdir: '/tmp',
      cli: 'claude-code',
    });

    const res2 = await client.send('import', {
      sessionId: 'dup-uuid',
      name: 'second',
      workdir: '/tmp',
      cli: 'claude-code',
    });
    expect(res2.ok).toBe(false);
    expect(res2.error!.code).toBe('SESSION_ALREADY_EXISTS');
  });

  test('import 重复 name 返回 SESSION_ALREADY_EXISTS', async () => {
    await client.send('import', {
      sessionId: 'uuid-a',
      name: 'samename',
      workdir: '/tmp',
      cli: 'claude-code',
    });

    const res2 = await client.send('import', {
      sessionId: 'uuid-b',
      name: 'samename',
      workdir: '/tmp',
      cli: 'claude-code',
    });
    expect(res2.ok).toBe(false);
    expect(res2.error!.code).toBe('SESSION_ALREADY_EXISTS');
  });
});
