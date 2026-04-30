import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Daemon } from '../../src/daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX = path.resolve(__dirname, '../../src/index.ts');
const TSX_CLI = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');

function runCLI(args: string[], opts: { socketPath?: string; pidFile?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
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

describe('mx-coder tui CLI E2E', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-tui-e2e-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('tui 命令不再报未实现，并输出 session 总览', async () => {
    daemon.registry.create('tui-demo', { workdir: tmpDir, cliPlugin: 'claude-code' });

    const child = spawn(process.execPath, [TSX_CLI, SRC_INDEX, 'tui'], {
      env: { ...process.env, MX_CODER_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    await new Promise(resolve => setTimeout(resolve, 800));
    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    expect(stdout).toContain('NAME');
    expect(stdout).toContain('tui-demo');
  }, 10000);

  test('tui 持续运行并接收 daemon 推送的状态更新', async () => {
    daemon.registry.create('live-session', { workdir: tmpDir, cliPlugin: 'claude-code' });

    const child = spawn(process.execPath, [TSX_CLI, SRC_INDEX, 'tui'], {
      env: { ...process.env, MX_CODER_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    await new Promise(resolve => setTimeout(resolve, 800));

    daemon.registry.markImProcessing('live-session', 9999);

    await new Promise(resolve => setTimeout(resolve, 800));

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    expect(stdout).toContain('live-session');
    expect(stdout).toContain('running');
  }, 10000);
});
