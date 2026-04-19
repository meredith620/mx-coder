import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX = path.resolve(__dirname, '../../src/index.ts');
const TSX_CLI = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');

function runCLI(args: string[], socketPath: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, SRC_INDEX, ...args], {
      env: { ...process.env, MM_CODER_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

describe('CLI completion 动态 session 名补全', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let client: IPCClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-completion-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
    client = new IPCClient(socketPath);
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('已有 session 时，completion sessions 输出对应名字', async () => {
    await client.send('create', { name: 'alpha', workdir: tmpDir, cli: 'claude-code' });
    await client.send('create', { name: 'beta', workdir: tmpDir, cli: 'claude-code' });

    const { stdout, code } = await runCLI(['completion', 'sessions'], socketPath);
    expect(code).toBe(0);
    expect(stdout).toContain('alpha');
    expect(stdout).toContain('beta');
  });

  test('无 session 时，completion sessions 输出为空但不报错', async () => {
    const { stdout, stderr, code } = await runCLI(['completion', 'sessions'], socketPath);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toBe('');
  });
});
