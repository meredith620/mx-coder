import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('session env IPC', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let client: IPCClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-session-env-ipc-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
    client = new IPCClient(socketPath);
    await client.connect();
    await client.send('create', { name: 'env-demo', workdir: '/tmp', cli: 'claude-code' });
  });

  afterEach(async () => {
    await client.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('set/get/unset/clear env', async () => {
    let res = await client.send('sessionEnvSet', { name: 'env-demo', key: 'API_KEY', value: 'secret123' });
    expect(res.ok).toBe(true);

    res = await client.send('sessionEnvGet', { name: 'env-demo' });
    expect(res.ok).toBe(true);
    expect((res.data!.env as Record<string, string>).API_KEY).toContain('***');

    res = await client.send('sessionEnvUnset', { name: 'env-demo', key: 'API_KEY' });
    expect(res.ok).toBe(true);

    res = await client.send('sessionEnvSet', { name: 'env-demo', key: 'FOO', value: 'bar' });
    expect(res.ok).toBe(true);
    res = await client.send('sessionEnvClear', { name: 'env-demo' });
    expect(res.ok).toBe(true);
    expect(daemon.registry.get('env-demo')!.sessionEnv).toEqual({});
  });

  test('非法 env key 被拒绝', async () => {
    const res = await client.send('sessionEnvSet', { name: 'env-demo', key: 'bad-key', value: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('INVALID_REQUEST');
  });

  test('sessionEnvImport 批量导入', async () => {
    const entries = [
      { key: 'API_KEY', value: 'secret123' },
      { key: 'DB_HOST', value: 'localhost' },
      { key: 'PORT', value: '3000' },
    ];
    const res = await client.send('sessionEnvImport', { name: 'env-demo', entries });
    expect(res.ok).toBe(true);
    const session = daemon.registry.get('env-demo')!;
    expect(session.sessionEnv.API_KEY).toBe('secret123');
    expect(session.sessionEnv.DB_HOST).toBe('localhost');
    expect(session.sessionEnv.PORT).toBe('3000');
  });

  test('sessionEnvImport 同名 key 覆盖旧值', async () => {
    await client.send('sessionEnvSet', { name: 'env-demo', key: 'API_KEY', value: 'old' });
    const entries = [{ key: 'API_KEY', value: 'new' }];
    const res = await client.send('sessionEnvImport', { name: 'env-demo', entries });
    expect(res.ok).toBe(true);
    expect(daemon.registry.get('env-demo')!.sessionEnv.API_KEY).toBe('new');
  });

  test('sessionEnvImport 持久化：重启 daemon 后保留', async () => {
    const persistPath = path.join(tmpDir, 'sessions.json');
    await client.close();
    await daemon.stop();

    // 使用带持久化的 daemon
    daemon = new Daemon(socketPath, { persistencePath: persistPath });
    await daemon.start();
    client = new IPCClient(socketPath);
    await client.connect();
    await client.send('create', { name: 'persist-demo', workdir: '/tmp', cli: 'claude-code' });

    const entries = [{ key: 'SECRET', value: 'keep-me' }];
    await client.send('sessionEnvImport', { name: 'persist-demo', entries });

    // 重启 daemon
    await client.close();
    await daemon.stop();
    daemon = new Daemon(socketPath, { persistencePath: persistPath });
    await daemon.start();
    client = new IPCClient(socketPath);
    await client.connect();

    const session = daemon.registry.get('persist-demo')!;
    expect(session.sessionEnv.SECRET).toBe('keep-me');
  });

  test('sessionEnvList 输出多变量并脱敏', async () => {
    await client.send('sessionEnvSet', { name: 'env-demo', key: 'API_KEY', value: 'sk-abcdef1234' });
    await client.send('sessionEnvSet', { name: 'env-demo', key: 'SHORT', value: 'ab' });
    await client.send('sessionEnvSet', { name: 'env-demo', key: 'EMPTY', value: '' });

    const res = await client.send('sessionEnvList', { name: 'env-demo' });
    expect(res.ok).toBe(true);
    const entries = res.data!.entries as Array<{ key: string; maskedValue: string }>;
    expect(entries.length).toBe(3);

    const byKey = Object.fromEntries(entries.map(e => [e.key, e.maskedValue]));
    expect(byKey.API_KEY).toBe('****1234');
    expect(byKey.SHORT).toBe('****');
    expect(byKey.EMPTY).toBe('****');
  });

  test('sessionEnvList clear 后为空', async () => {
    await client.send('sessionEnvSet', { name: 'env-demo', key: 'FOO', value: 'bar' });
    await client.send('sessionEnvClear', { name: 'env-demo' });

    const res = await client.send('sessionEnvList', { name: 'env-demo' });
    expect(res.ok).toBe(true);
    const entries = res.data!.entries as Array<{ key: string; maskedValue: string }>;
    expect(entries).toEqual([]);
  });
});
