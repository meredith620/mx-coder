import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
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
const SRC_INDEX = path.resolve(__dirname, '../../src/index.ts');
const TSX_CLI = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');

/** Run mm-coder CLI via src/index.ts, return { stdout, stderr, code } */
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

  test('非 git 目录也能正常执行 list', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-outside-'));
    const originalCwd = process.cwd();
    process.chdir(outsideDir);
    try {
      const { code } = await runCLIWithSocket(['list'], socketPath, pidFile);
      expect(code).toBe(0);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('takeover-status 和 takeover-cancel 命令可用', async () => {
    await client.send('create', { name: 'take-cli', workdir: tmpDir, cli: 'claude-code' });
    await client.send('attach', { name: 'take-cli', pid: 1001 });
    (daemon.registry as any).requestTakeover('take-cli', 'user-im');

    const statusResult = await runCLIWithSocket(['takeover-status', 'take-cli'], socketPath, pidFile);
    expect(statusResult.code).toBe(0);
    expect(statusResult.stdout).toContain('takeover_pending');

    const cancelResult = await runCLIWithSocket(['takeover-cancel', 'take-cli'], socketPath, pidFile);
    expect(cancelResult.code).toBe(0);
    expect(cancelResult.stdout).toContain("Takeover for 'take-cli' cancelled");
  });

  test('status 输出带 runtimeState 与 busy/idle 派生', async () => {
    await client.send('create', { name: 'busy-test', workdir: tmpDir, cli: 'claude-code' });
    daemon.registry.markImProcessing('busy-test');

    const { stdout, code } = await runCLIWithSocket(['status'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('busy-test');
    expect(stdout).toContain('runtime=running');
    expect(stdout).toContain('busy');
  });

  test('status <name> 显示单个 session 详情', async () => {
    const { stdout, code } = await runCLIWithSocket(['status', 'bug-fix'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('bug-fix');
    expect(stdout).toContain('idle');
    expect(stdout).toContain('runtimeState');
    expect(stdout).toContain('busy');
  });

  test('diagnose bug-fix 输出本地 Claude session 诊断信息', async () => {
    const { stdout, code } = await runCLIWithSocket(['diagnose', 'bug-fix'], socketPath, pidFile);
    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.name).toBe('bug-fix');
    expect(typeof data.localClaudeSessionPath).toBe('string');
    expect(typeof data.localClaudeSessionExists).toBe('boolean');
    expect(['--resume', '--session-id']).toContain(data.nextAttachMode);
  });

  test('attach bug-fix 调用真实 CLI attach 路径并在退出后 session 回到 idle', async () => {

    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const argsFile = path.join(tmpDir, 'claude-args.txt');
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\n' "$@" > "${argsFile}"\nexit 0\n`, { mode: 0o755 });

    const statusRes = await client.send('status', {});
    const sessions = statusRes.data!.sessions as Array<Record<string, unknown>>;
    const session = sessions.find(s => s.name === 'bug-fix');
    expect(session).toBeTruthy();

    const { code, stderr } = await runCLIWithSocket(
      ['attach', 'bug-fix'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );

    expect(code).toBe(0);
    expect(stderr).toBe('');

    const recordedArgs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(recordedArgs.some(arg => arg === '--session-id' || arg === '--resume')).toBe(true);
    expect(recordedArgs).toContain(String(session!.sessionId));

    const updated = daemon.registry.get('bug-fix')!;
    expect(updated.status).toBe('idle');
  });

  test('takeover-status 和 takeover-cancel 命令可用', async () => {
    await client.send('create', { name: 'take-cli', workdir: tmpDir, cli: 'claude-code' });
    await client.send('attach', { name: 'take-cli', pid: 1001 });
    (daemon.registry as any).requestTakeover('take-cli', 'user-im');

    const statusResult = await runCLIWithSocket(['takeover-status', 'take-cli'], socketPath, pidFile);
    expect(statusResult.code).toBe(0);
    expect(statusResult.stdout).toContain('takeover_pending');

    const cancelResult = await runCLIWithSocket(['takeover-cancel', 'take-cli'], socketPath, pidFile);
    expect(cancelResult.code).toBe(0);
    expect(cancelResult.stdout).toContain("Takeover for 'take-cli' cancelled");
  });

  test('--version 在非 git 目录不崩溃', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-version-outside-'));
    const originalCwd = process.cwd();
    process.chdir(outsideDir);
    try {
      const { code, stdout } = await runCLI(['--version'], { socketPath, pidFile });
      expect(code).toBe(0);
      expect(stdout).toContain('mm-coder 0.1.0');
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
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
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MM_CODER_SOCKET: socketPath,
      ...(pidFile && { MM_CODER_PID_FILE: pidFile }),
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
