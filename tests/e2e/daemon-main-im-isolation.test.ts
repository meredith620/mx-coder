import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.resolve(__dirname, '../../src/daemon-main.ts');

async function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Daemon socket timeout: ${socketPath}`)), timeoutMs);
    const check = setInterval(() => {
      if (fs.existsSync(socketPath)) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });
}

describe('daemon-main IM isolation', () => {
  const spawned: ChildProcess[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const proc of spawned.splice(0)) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        setTimeout(() => resolve(), 1000);
      });
    }
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空 imConfigPath 时不会 fallback 到 HOME 下真实默认配置', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-daemon-main-no-fallback-'));
    tmpDirs.push(tmpDir);
    const tmpHome = path.join(tmpDir, 'home');
    const socketPath = path.join(tmpDir, 'daemon.sock');
    const persistencePath = path.join(tmpDir, 'sessions.json');
    const defaultConfigDir = path.join(tmpHome, '.mx-coder');
    const defaultConfigPath = path.join(defaultConfigDir, 'config.json');

    fs.mkdirSync(defaultConfigDir, { recursive: true });
    fs.writeFileSync(defaultConfigPath, '{invalid-json', 'utf-8');

    const child = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath, ''], {
      stdio: 'ignore',
      env: { ...process.env, HOME: tmpHome },
      detached: false,
    });
    spawned.push(child);

    await waitForSocket(socketPath);
    expect(child.exitCode).toBeNull();
  });

  it('MX_CODER_DISABLE_IM=1 时即使显式传配置路径也不会读取配置', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-coder-daemon-main-disable-im-'));
    tmpDirs.push(tmpDir);
    const socketPath = path.join(tmpDir, 'daemon.sock');
    const persistencePath = path.join(tmpDir, 'sessions.json');
    const explicitConfigPath = path.join(tmpDir, 'mattermost.json');

    fs.writeFileSync(explicitConfigPath, '{invalid-json', 'utf-8');

    const child = spawn(process.execPath, ['--import', 'tsx', DAEMON_ENTRY, socketPath, '', persistencePath, explicitConfigPath], {
      stdio: 'ignore',
      env: { ...process.env, MX_CODER_DISABLE_IM: '1' },
      detached: false,
    });
    spawned.push(child);

    await waitForSocket(socketPath);
    expect(child.exitCode).toBeNull();
  });
});
