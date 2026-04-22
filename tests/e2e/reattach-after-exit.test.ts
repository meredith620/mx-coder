import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { IPCClient } from '../../src/ipc/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.resolve(__dirname, '../../src/daemon-main.ts');

describe('Re-attach after CLI exit E2E', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemonProc: ChildProcess | null = null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-reattach-test-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    const persistencePath = path.join(tmpDir, 'sessions.json');

    daemonProc = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath], {
      stdio: 'ignore',
      detached: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Daemon socket timeout')), 5000);
      const check = setInterval(() => {
        if (fs.existsSync(socketPath)) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });
  });

  afterEach(async () => {
    if (daemonProc) {
      daemonProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (!daemonProc) { resolve(); return; }
        daemonProc.on('exit', () => resolve());
        setTimeout(() => resolve(), 1000);
      });
      daemonProc = null;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('daemon 重启后 list/status 会清理残留 attached 死 pid', async () => {
    const persistencePath = path.join(tmpDir, 'sessions.json');

    if (daemonProc) {
      daemonProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    fs.writeFileSync(persistencePath, JSON.stringify({
      version: 1,
      sessions: [{
        name: 'stale-attached',
        sessionId: 'sess-stale-attached',
        cliPlugin: 'claude-code',
        workdir: tmpDir,
        status: 'attached',
        lifecycleStatus: 'active',
        initState: 'initialized',
        revision: 1,
        spawnGeneration: 0,
        imBindings: [],
        messageQueue: [],
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      }],
    }));

    daemonProc = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath], {
      stdio: 'ignore',
      detached: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Daemon socket timeout after restart')), 5000);
      const check = setInterval(() => {
        if (fs.existsSync(socketPath)) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    const client = new IPCClient(socketPath);
    await client.connect();
    const listRes = await client.send('list', {});
    expect(listRes.ok).toBe(true);
    const session = (listRes.data?.sessions as Array<{ name: string; status: string }>).find(s => s.name === 'stale-attached');
    expect(session?.status).toBe('idle');
    await client.close();
  });

  it('attach → CLI exits → markDetached → re-attach succeeds', async () => {
    const client = new IPCClient(socketPath);
    await client.connect();

    const createRes = await client.send('create', {
      name: 'test-session',
      workdir: tmpDir,
      cli: 'claude-code',
    });
    if (!createRes.ok) {
      throw new Error(`Create failed: ${createRes.error?.message}`);
    }
    expect(createRes.ok).toBe(true);

    const attach1Res = await client.send('attach', {
      name: 'test-session',
      pid: process.pid,
    });
    expect(attach1Res.ok).toBe(true);
    expect(attach1Res.data?.session.status).toBe('attached');

    const markDetachedRes = await client.send('markDetached', {
      name: 'test-session',
      exitReason: 'normal',
    });
    expect(markDetachedRes.ok).toBe(true);

    const statusRes = await client.send('status', {});
    expect(statusRes.ok).toBe(true);
    const sessions = statusRes.data?.sessions as Array<{ name: string; status: string }>;
    const session = sessions.find(s => s.name === 'test-session');
    expect(session?.status).toBe('idle');

    const attach2Res = await client.send('attach', {
      name: 'test-session',
      pid: process.pid + 1,
    });
    expect(attach2Res.ok).toBe(true);
    expect(attach2Res.data?.session.status).toBe('attached');

    await client.close();
  });

  it('attach → CLI exits → persistence flush → daemon restart → re-attach succeeds', async () => {
    const persistencePath = path.join(tmpDir, 'sessions.json');

    if (daemonProc) {
      daemonProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    daemonProc = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath], {
      stdio: 'ignore',
      detached: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Daemon socket timeout')), 5000);
      const check = setInterval(() => {
        if (fs.existsSync(socketPath)) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    const client = new IPCClient(socketPath);
    await client.connect();

    const createRes = await client.send('create', {
      name: 'persist-session',
      workdir: tmpDir,
      cli: 'claude-code',
    });
    expect(createRes.ok).toBe(true);

    const attachRes = await client.send('attach', {
      name: 'persist-session',
      pid: process.pid,
    });
    expect(attachRes.ok).toBe(true);

    await client.send('markDetached', {
      name: 'persist-session',
      exitReason: 'normal',
    });

    await client.close();
    expect(fs.existsSync(persistencePath)).toBe(true);

    daemonProc!.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));

    daemonProc = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath], {
      stdio: 'ignore',
      detached: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Daemon socket timeout after restart')), 5000);
      const check = setInterval(() => {
        if (fs.existsSync(socketPath)) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    const client2 = new IPCClient(socketPath);
    await client2.connect();

    const listRes = await client2.send('list', {});
    expect(listRes.ok).toBe(true);
    const sessions = listRes.data?.sessions as Array<{ name: string; status: string }>;
    const session = sessions.find(s => s.name === 'persist-session');
    expect(session).toBeDefined();
    expect(session?.status).toBe('idle');

    const reattachRes = await client2.send('attach', {
      name: 'persist-session',
      pid: process.pid + 2,
    });
    expect(reattachRes.ok).toBe(true);
    expect(reattachRes.data?.session.status).toBe('attached');

    await client2.close();
  });
});
