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
});
