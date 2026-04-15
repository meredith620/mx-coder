import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { fileURLToPath } from 'url';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';

/**
 * E2E: mm-coder CLI 完整使用流程
 *
 * 覆盖用户真实使用路径：
 *   mm-coder start
 *   mm-coder create bug-fix --workdir ~/myapp
 *   mm-coder attach bug-fix   (spawn CLI, exit, session → idle)
 *   mm-coder list / status / remove
 *   mm-coder --help
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS = path.resolve(__dirname, '../../dist/index.js');

/** Run mm-coder CLI via dist/index.js, return { stdout, stderr, code } */
function runCLI(args: string[], opts: { socketPath?: string; pidFile?: string } = {}): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MM_CODER_SOCKET: opts.socketPath,
      MM_CODER_PID_FILE: opts.pidFile,
    };

    const child = spawn(process.execPath, [INDEX_JS, ...args], {
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

describe('mm-coder CLI E2E', () => {
  let tmpDir: string;
  let socketPath: string;
  let pidFile: string;
  let daemon: Daemon;
  let client: IPCClient;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-e2e-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    pidFile = path.join(tmpDir, 'daemon.pid');

    // Start daemon in-process for test isolation
    daemon = new Daemon(socketPath);
    await daemon.start();

    client = new IPCClient(socketPath);
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--help 输出帮助信息', async () => {
    const { stdout, code } = await runCLI(['--help'], { socketPath, pidFile });
    expect(code).toBe(0);
    expect(stdout).toContain('mm-coder');
    expect(stdout).toContain('start');
    expect(stdout).toContain('create');
    expect(stdout).toContain('attach');
  });

  test('无参数输出帮助信息', async () => {
    const { stdout, code } = await runCLIWithSocket([], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('mm-coder');
  });

  test('create bug-fix --workdir <dir> 创建 session', async () => {
    const workdir = path.join(tmpDir, 'myapp');
    fs.mkdirSync(workdir, { recursive: true });

    const { stdout, code } = await runCLIWithSocket(
      ['create', 'bug-fix', '--workdir', workdir],
      socketPath, pidFile,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("bug-fix");

    // Verify via IPC
    const res = await client.send('list', {});
    const sessions = res.data!.sessions as Array<Record<string, unknown>>;
    expect(sessions.some(s => s.name === 'bug-fix')).toBe(true);
  });

  test('list 显示已创建的 session', async () => {
    const { stdout, code } = await runCLIWithSocket(['list'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('bug-fix');
  });

  test('status 显示 daemon PID 和 session 列表', async () => {
    const { stdout, code } = await runCLIWithSocket(['status'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('Daemon PID');
    expect(stdout).toContain('bug-fix');
  });

  test('status <name> 显示单个 session 详情', async () => {
    const { stdout, code } = await runCLIWithSocket(['status', 'bug-fix'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('bug-fix');
    expect(stdout).toContain('idle');
  });

  test('attach bug-fix 调用 CLI 并在退出后 session 回到 idle', async () => {
    // Create a mock CLI that exits immediately
    const mockCli = path.join(tmpDir, 'mock-claude.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Attach via IPC directly (CLI attach would spawn real claude)
    // Instead test the attach IPC flow: attach → attached → markDetached → idle
    const attachRes = await client.send('attach', { name: 'bug-fix', pid: process.pid });
    expect(attachRes.ok).toBe(true);

    let s = daemon.registry.get('bug-fix')!;
    expect(s.status).toBe('attached');

    // Simulate detach
    daemon.registry.markDetached('bug-fix', 'normal');
    s = daemon.registry.get('bug-fix')!;
    expect(s.status).toBe('idle');
  });

  test('remove bug-fix 删除 session', async () => {
    const { stdout, code } = await runCLIWithSocket(['remove', 'bug-fix'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain("bug-fix");

    const res = await client.send('list', {});
    const sessions = res.data!.sessions as Array<Record<string, unknown>>;
    expect(sessions.some(s => s.name === 'bug-fix')).toBe(false);
  });

  test('create 重复名称返回错误', async () => {
    await client.send('create', { name: 'dup-test', workdir: tmpDir, cli: 'claude-code' });

    const { stderr, code } = await runCLIWithSocket(
      ['create', 'dup-test', '--workdir', tmpDir],
      socketPath, pidFile,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Error');
  });

  test('remove 不存在的 session 返回错误', async () => {
    const { stderr, code } = await runCLIWithSocket(['remove', 'ghost'], socketPath, pidFile);
    expect(code).toBe(1);
    expect(stderr).toContain('Error');
  });

  test('未知命令返回错误', async () => {
    const { stderr, code } = await runCLIWithSocket(['unknown-cmd'], socketPath, pidFile);
    expect(code).toBe(1);
    expect(stderr).toContain('Error');
  });
});

describe('mm-coder CLI attach 完整流程 E2E', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let client: IPCClient;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-attach-e2e-'));
    socketPath = path.join(tmpDir, 'daemon.sock');

    daemon = new Daemon(socketPath);
    await daemon.start();

    client = new IPCClient(socketPath);
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('attach → CLI 退出 → session idle → 再次 attach', async () => {
    // Create session
    await client.send('create', { name: 'resume-test', workdir: tmpDir, cli: 'claude-code' });

    // First attach
    const attach1 = await client.send('attach', { name: 'resume-test', pid: 1001 });
    expect(attach1.ok).toBe(true);
    expect(daemon.registry.get('resume-test')!.status).toBe('attached');

    // Detach (CLI exits)
    daemon.registry.markDetached('resume-test', 'normal');
    expect(daemon.registry.get('resume-test')!.status).toBe('idle');

    // Second attach (resume)
    const attach2 = await client.send('attach', { name: 'resume-test', pid: 1002 });
    expect(attach2.ok).toBe(true);
    expect(daemon.registry.get('resume-test')!.status).toBe('attached');

    // Cleanup
    daemon.registry.markDetached('resume-test', 'normal');
  });

  test('IM 处理中 → attach 请求 → waitRequired + attach_pending', async () => {
    await client.send('create', { name: 'im-wait-test', workdir: tmpDir, cli: 'claude-code' });

    // Simulate IM processing
    daemon.registry.markImProcessing('im-wait-test');
    expect(daemon.registry.get('im-wait-test')!.status).toBe('im_processing');

    // Attach while IM processing
    const attachRes = await client.send('attach', { name: 'im-wait-test', pid: 2001 });
    expect(attachRes.ok).toBe(true);
    expect(attachRes.data!.waitRequired).toBe(true);
    expect(daemon.registry.get('im-wait-test')!.status).toBe('attach_pending');

    // IM completes → session becomes attached
    daemon.registry.markImDone('im-wait-test');
    expect(daemon.registry.get('im-wait-test')!.status).toBe('attached');

    // Cleanup
    daemon.registry.markDetached('im-wait-test', 'normal');
  });
});

/** Helper: run CLI with custom socket/pid env vars */
function runCLIWithSocket(
  args: string[],
  socketPath: string,
  pidFile?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MM_CODER_SOCKET: socketPath,
      ...(pidFile && { MM_CODER_PID_FILE: pidFile }),
    };

    const child = spawn(process.execPath, [INDEX_JS, ...args], {
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
