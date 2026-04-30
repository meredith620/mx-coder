import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeUserServiceUnit, installUserService } from '../../src/systemd.js';

describe('systemd install flow', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-systemd-install-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('install 顺序为 daemon-reload -> enable --now', () => {
    writeUserServiceUnit();
    const calls: string[] = [];

    const result = installUserService((args) => {
      calls.push(args.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      '--user daemon-reload',
      '--user enable --now mx-coder.service',
    ]);
  });

  test('install 失败时暴露具体 systemctl 错误', () => {
    writeUserServiceUnit();

    const result = installUserService((args) => {
      if (args.includes('enable')) {
        return { code: 1, stdout: '', stderr: 'Failed to enable unit' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to enable unit');
  });
});
