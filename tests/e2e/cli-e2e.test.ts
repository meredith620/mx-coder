import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX = path.resolve(__dirname, '../../src/index.ts');
const TSX_CLI = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');

function runCLI(args: string[], opts: { socketPath?: string; pidFile?: string } = {}): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MX_CODER_SOCKET: opts.socketPath,
      MX_CODER_PID_FILE: opts.pidFile,
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

describe('mx-coder CLI E2E', () => {
  let tmpDir: string;
  let socketPath: string;
  let pidFile: string;
  let daemon: Daemon;
  let client: IPCClient;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-e2e-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    pidFile = path.join(tmpDir, 'daemon.pid');

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

  test('restart 会等待旧 daemon 停止后再启动新 daemon', async () => {
    const restartSocket = path.join(tmpDir, 'restart-daemon.sock');
    const restartPidFile = path.join(tmpDir, 'restart-daemon.pid');
    const restartSessions = path.join(tmpDir, 'restart-sessions.json');
    const restartLog = path.join(tmpDir, 'restart-daemon.log');

    const startResult = await runCLIWithSocket(['start'], restartSocket, restartPidFile, {
      MX_CODER_SESSIONS: restartSessions,
      MX_CODER_LOG: restartLog,
      MX_CODER_DISABLE_IM: '1',
    });
    expect(startResult.code).toBe(0);
    expect(startResult.stdout).toContain('Daemon started');

    const beforePid = fs.readFileSync(restartPidFile, 'utf8').trim();
    const { stdout, code } = await runCLIWithSocket(['restart'], restartSocket, restartPidFile, {
      MX_CODER_SESSIONS: restartSessions,
      MX_CODER_LOG: restartLog,
      MX_CODER_DISABLE_IM: '1',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('Restarting daemon...');
    expect(stdout).toContain('Stopping daemon');
    expect(stdout).toContain('Waiting for graceful shutdown');
    expect(stdout).toContain('Starting daemon');
    expect(stdout).toContain('Daemon stopped');
    expect(stdout).toContain('Daemon started');

    const afterPid = fs.readFileSync(restartPidFile, 'utf8').trim();
    expect(afterPid).not.toBe(beforePid);

    const stopResult = await runCLIWithSocket(['stop'], restartSocket, restartPidFile, {
      MX_CODER_SESSIONS: restartSessions,
      MX_CODER_LOG: restartLog,
      MX_CODER_DISABLE_IM: '1',
    });
    expect(stopResult.code).toBe(0);
  });

  test('restart 在 daemon 未运行时会直接启动新 daemon', async () => {
    const restartSocket = path.join(tmpDir, 'restart-stopped.sock');
    const restartPidFile = path.join(tmpDir, 'restart-stopped.pid');
    const restartSessions = path.join(tmpDir, 'restart-stopped-sessions.json');
    const restartLog = path.join(tmpDir, 'restart-stopped.log');

    const { stdout, code } = await runCLIWithSocket(['restart'], restartSocket, restartPidFile, {
      MX_CODER_SESSIONS: restartSessions,
      MX_CODER_LOG: restartLog,
      MX_CODER_DISABLE_IM: '1',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('Restarting daemon...');
    expect(stdout).toContain('Daemon is not running');
    expect(stdout).toContain('Starting daemon');
    expect(stdout).toContain('Daemon started');

    const stopResult = await runCLIWithSocket(['stop'], restartSocket, restartPidFile, {
      MX_CODER_SESSIONS: restartSessions,
      MX_CODER_LOG: restartLog,
      MX_CODER_DISABLE_IM: '1',
    });
    expect(stopResult.code).toBe(0);
  });

  test('completion bash 输出静态补全脚本', async () => {
    const { stdout, code } = await runCLIWithSocket(['completion', 'bash'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('complete -o bashdefault -o default -F');
    expect(stdout).toContain('create');
    expect(stdout).toContain('attach');
    expect(stdout).toContain('diagnose');
    expect(stdout).toContain('takeover-status');
    expect(stdout).toContain('takeover-cancel');
    expect(stdout).toContain('mx-coder completion sessions');
    expect(stdout).toContain('_mx_coder_session_completions');
    expect(stdout).toContain('commands_with_sessions');
    expect(stdout).toContain('im');
    expect(stdout).toContain('tui');
  });

  test('completion zsh 输出静态补全脚本', async () => {
    const { stdout, code } = await runCLIWithSocket(['completion', 'zsh'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('#compdef mx-coder');
    expect(stdout).toContain('create');
    expect(stdout).toContain('attach');
    expect(stdout).toContain('diagnose');
    expect(stdout).toContain('takeover-status');
    expect(stdout).toContain('takeover-cancel');
    expect(stdout).toContain('mx-coder completion sessions');
    expect(stdout).toContain('session_commands');
    expect(stdout).toContain('im');
    expect(stdout).toContain('tui');
  });

  test('无参数输出帮助信息', async () => {
    const { stdout, code } = await runCLIWithSocket([], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('mx-coder');
  });

  test('create 支持单次 spaceStrategy override 且不报错', async () => {
    const workdir = path.join(tmpDir, 'override-app');
    fs.mkdirSync(workdir, { recursive: true });

    const { stdout, code } = await runCLIWithSocket(
      ['create', 'override-demo', '--workdir', workdir, '--space-strategy', 'channel'],
      socketPath, pidFile,
    );
    expect(code).toBe(0);
    expect(stdout).toContain('override-demo');
  });

  test('setup systemd --user --dry-run 输出 service 预览', async () => {
    const { stdout, code } = await runCLIWithSocket(['setup', 'systemd', '--user', '--dry-run'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('[Unit]');
    expect(stdout).toContain('[Service]');
    expect(stdout).toContain('[Install]');
    expect(stdout).toContain('WantedBy=default.target');
  });

  test('setup systemd --user 输出 install 结果', async () => {
    const fakeBin = path.join(tmpDir, 'bin-systemd-install');
    fs.mkdirSync(fakeBin, { recursive: true });
    const argsFile = path.join(tmpDir, 'systemctl-install-args.txt');
    const fakeSystemctl = path.join(fakeBin, 'systemctl');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argsFile}"\nexit 0\n`, { mode: 0o755 });

    const { stdout, code } = await runCLIWithSocket(
      ['setup', 'systemd', '--user'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );
    expect(code).toBe(0);
    expect(stdout).toContain('daemon-reload');
    expect(stdout).toContain('enable --now');

    const recordedArgs = fs.readFileSync(argsFile, 'utf8');
    expect(recordedArgs).toContain('--user');
    expect(recordedArgs).toContain('daemon-reload');
    expect(recordedArgs).toContain('enable');
    expect(recordedArgs).toContain('--now');
  });

  test('setup systemd --user --status 输出当前服务状态', async () => {
    const fakeBin = path.join(tmpDir, 'bin-systemd-status');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeSystemctl = path.join(fakeBin, 'systemctl');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nif [ "$2" = "is-enabled" ]; then echo enabled; exit 0; fi\nif [ "$2" = "is-active" ]; then echo active; exit 0; fi\nexit 0\n`, { mode: 0o755 });

    const { stdout, code } = await runCLIWithSocket(
      ['setup', 'systemd', '--user', '--status'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );
    expect(code).toBe(0);
    expect(stdout).toContain('enabled');
    expect(stdout).toContain('active');
  });

  test('setup systemd --user --uninstall 卸载 user service', async () => {
    const fakeBin = path.join(tmpDir, 'bin-systemd-uninstall');
    fs.mkdirSync(fakeBin, { recursive: true });
    const argsFile = path.join(tmpDir, 'systemctl-uninstall-args.txt');
    const fakeSystemctl = path.join(fakeBin, 'systemctl');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argsFile}"\nexit 0\n`, { mode: 0o755 });

    const { stdout, code } = await runCLIWithSocket(
      ['setup', 'systemd', '--user', '--uninstall'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );
    expect(code).toBe(0);
    expect(stdout).toContain('uninstalled');

    const recordedArgs = fs.readFileSync(argsFile, 'utf8');
    expect(recordedArgs).toContain('daemon-reload');
  });

  test('setup systemd --user --status 在 unit 失配时输出 repair 提示', async () => {
    const fakeBin = path.join(tmpDir, 'bin-systemd-repair');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeSystemctl = path.join(fakeBin, 'systemctl');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nif [ "$2" = "is-enabled" ]; then echo disabled; exit 1; fi\nif [ "$2" = "is-active" ]; then echo inactive; exit 3; fi\nexit 0\n`, { mode: 0o755 });

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-systemd-repair-home-'));
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'mx-coder.service'), '[Unit]\nDescription=old\n');

    const { stdout, code } = await runCLIWithSocket(
      ['setup', 'systemd', '--user', '--status'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOME: homeDir },
    );
    expect(code).toBe(0);
    expect(stdout).toContain('needsRepair');
    expect(stdout).toContain('repairHint');
  });

  test('create bug-fix --workdir <dir> 创建 session', async () => {
    const workdir = path.join(tmpDir, 'myapp');
    fs.mkdirSync(workdir, { recursive: true });

    const { stdout, code } = await runCLIWithSocket(
      ['create', 'bug-fix', '--workdir', workdir],
      socketPath, pidFile,
    );
    expect(code).toBe(0);
    expect(stdout).toContain('bug-fix');

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

  test('attach CLI 退出后会回写 markDetached，避免残留 attached', async () => {
    await client.send('create', { name: 'attach-cleanup', workdir: tmpDir, cli: 'claude-code' });

    const fakeBin = path.join(tmpDir, 'bin-cleanup');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const { code } = await runCLIWithSocket(
      ['attach', 'attach-cleanup'],
      socketPath,
      pidFile,
      { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    );

    expect(code).toBe(0);
    expect(daemon.registry.get('attach-cleanup')?.status).toBe('idle');
  });

  test('open 支持单次 spaceStrategy override 且不回写全局配置', async () => {
    const originalImPlugin = (daemon as any)._imPlugin;
    const originalImPluginName = (daemon as any)._imPluginName;
    const originalImPlugins = new Map((daemon as any)._imPlugins);
    const mockIM = new (await import('../helpers/mock-im-plugin.js')).MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    try {
      const { stdout, code } = await runCLIWithSocket(
        ['open', 'bug-fix', '--space-strategy', 'channel'],
        socketPath, pidFile,
      );
      expect(code).toBe(0);
      expect(stdout).toContain('"spaceStrategy"');
      expect(stdout).toContain('channel');
    } finally {
      (daemon as any)._imPlugin = originalImPlugin;
      (daemon as any)._imPluginName = originalImPluginName;
      (daemon as any)._imPlugins = originalImPlugins;
    }
  });

  test('remove bug-fix 删除 session', async () => {
    const { stdout, code } = await runCLIWithSocket(['remove', 'bug-fix'], socketPath, pidFile);
    expect(code).toBe(0);
    expect(stdout).toContain('bug-fix');

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

describe('mx-coder CLI attach 完整流程 E2E', () => {
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
    await client.send('create', { name: 'resume-test', workdir: tmpDir, cli: 'claude-code' });

    const attach1 = await client.send('attach', { name: 'resume-test', pid: 1001 });
    expect(attach1.ok).toBe(true);
    expect(daemon.registry.get('resume-test')!.status).toBe('attached');

    daemon.registry.markDetached('resume-test', 'normal');
    expect(daemon.registry.get('resume-test')!.status).toBe('idle');

    const attach2 = await client.send('attach', { name: 'resume-test', pid: 1002 });
    expect(attach2.ok).toBe(true);
    expect(daemon.registry.get('resume-test')!.status).toBe('attached');

    daemon.registry.markDetached('resume-test', 'normal');
  });

  test('IM 处理中 → attach 请求 → waitRequired + attach_pending', async () => {
    await client.send('create', { name: 'im-wait-test', workdir: tmpDir, cli: 'claude-code' });

    daemon.registry.markImProcessing('im-wait-test');
    expect(daemon.registry.get('im-wait-test')!.status).toBe('im_processing');

    const attachRes = await client.send('attach', { name: 'im-wait-test', pid: 2001 });
    expect(attachRes.ok).toBe(true);
    expect(attachRes.data!.waitRequired).toBe(true);
    expect(daemon.registry.get('im-wait-test')!.status).toBe('attach_pending');

    daemon.registry.markImDone('im-wait-test');
    expect(daemon.registry.get('im-wait-test')!.status).toBe('attached');

    daemon.registry.markDetached('im-wait-test', 'normal');
  });
});

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
