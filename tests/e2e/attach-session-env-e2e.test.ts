import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { IPCClient } from '../../src/ipc/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX = path.resolve(__dirname, '../../src/index.ts');
const TSX_CLI = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
const DAEMON_ENTRY = path.resolve(__dirname, '../../src/daemon-main.ts');

function runCLIWithSocket(
  args: string[],
  socketPath: string,
  pidFile?: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MX_CODER_SOCKET: socketPath,
      ...(pidFile && { MX_CODER_PID_FILE: pidFile }),
      ...extraEnv,
    };

    const child = spawn(process.execPath, [TSX_CLI, SRC_INDEX, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Daemon socket timeout')), timeoutMs);
    const check = setInterval(() => {
      if (fs.existsSync(socketPath)) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });
}

describe('attach session env E2E — daemon IPC → env set → attach → 子进程读到 env', () => {
  let tmpDir: string;
  let socketPath: string;
  let pidFile: string;
  let persistencePath: string;
  let daemonProc: ChildProcess | null = null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-attach-env-e2e-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    pidFile = path.join(tmpDir, 'daemon.pid');
    persistencePath = path.join(tmpDir, 'sessions.json');

    daemonProc = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath], {
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, MX_CODER_DISABLE_IM: '1' },
    });

    await waitForSocket(socketPath);
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

  it('IPC 设置 env → CLI attach → 子进程读到正确的 session env', async () => {
    const client = new IPCClient(socketPath);
    await client.connect();

    // 1. 创建 session
    const createRes = await client.send('create', {
      name: 'env-e2e',
      workdir: tmpDir,
      cli: 'claude-code',
    });
    expect(createRes.ok).toBe(true);

    // 2. 通过 IPC 设置 session env
    const setRes1 = await client.send('sessionEnvSet', {
      name: 'env-e2e',
      key: 'MY_E2E_VAR',
      value: 'hello-from-ipc',
    });
    expect(setRes1.ok).toBe(true);

    const setRes2 = await client.send('sessionEnvSet', {
      name: 'env-e2e',
      key: 'ANOTHER_E2E_VAR',
      value: 'second-value',
    });
    expect(setRes2.ok).toBe(true);

    await client.close();

    // 3. 创建一个 fake CLI 脚本，输出 env 到文件
    const captureFile = path.join(tmpDir, 'env-capture.json');
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // 脚本忽略所有参数，只把关键 env 写入文件
    fs.writeFileSync(fakeClaude, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({`,
      '  MY_E2E_VAR: process.env.MY_E2E_VAR || null,',
      '  ANOTHER_E2E_VAR: process.env.ANOTHER_E2E_VAR || null,',
      '  PATH: process.env.PATH ? "present" : null,',
      '}));',
      'process.exit(0);',
    ].join('\n'), { mode: 0o755 });

    // 4. 通过 CLI attach 命令触发完整链路
    const { code, stderr } = await runCLIWithSocket(
      ['attach', 'env-e2e'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );

    expect(code).toBe(0);
    expect(stderr).toBe('');

    // 5. 验证子进程读到了正确的 session env
    expect(fs.existsSync(captureFile)).toBe(true);
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
    expect(captured.MY_E2E_VAR).toBe('hello-from-ipc');
    expect(captured.ANOTHER_E2E_VAR).toBe('second-value');
    expect(captured.PATH).toBe('present');
  }, 30000);

  it('daemon 重启后 session env 仍可在 attach 生效（持久化回归）', async () => {
    const client = new IPCClient(socketPath);
    await client.connect();

    // 1. 创建 session 并设置 env
    await client.send('create', { name: 'persist-e2e', workdir: tmpDir, cli: 'claude-code' });
    await client.send('sessionEnvSet', { name: 'persist-e2e', key: 'PERSIST_KEY', value: 'survive-restart' });

    await client.close();

    // 2. 停止 daemon
    daemonProc!.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));

    // 3. 验证持久化文件包含 sessionEnv
    expect(fs.existsSync(persistencePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(persistencePath, 'utf-8'));
    const persistedSession = persisted.sessions.find((s: any) => s.name === 'persist-e2e');
    expect(persistedSession).toBeDefined();
    expect(persistedSession.sessionEnv).toEqual({ PERSIST_KEY: 'survive-restart' });

    // 4. 重启 daemon
    daemonProc = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath], {
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, MX_CODER_DISABLE_IM: '1' },
    });
    await waitForSocket(socketPath);

    // 5. 验证 daemon 恢复后 session env 仍在
    const client2 = new IPCClient(socketPath);
    await client2.connect();
    const statusRes = await client2.send('status', {});
    expect(statusRes.ok).toBe(true);
    const sessions = statusRes.data?.sessions as Array<Record<string, unknown>>;
    const session = sessions.find(s => s.name === 'persist-e2e');
    expect(session).toBeDefined();
    expect(session!.sessionEnv).toEqual({ PERSIST_KEY: 'survive-restart' });
    await client2.close();

    // 6. attach 并验证子进程能读到持久化的 env
    const captureFile = path.join(tmpDir, 'persist-env-capture.json');
    const fakeBin = path.join(tmpDir, 'bin-persist');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({`,
      '  PERSIST_KEY: process.env.PERSIST_KEY || null,',
      '}));',
      'process.exit(0);',
    ].join('\n'), { mode: 0o755 });

    const { code } = await runCLIWithSocket(
      ['attach', 'persist-e2e'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );

    expect(code).toBe(0);
    expect(fs.existsSync(captureFile)).toBe(true);
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
    expect(captured.PERSIST_KEY).toBe('survive-restart');
  }, 30000);
});
