import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeUserServiceUnit, getUserSystemdUnitPath, getUserServiceStatus, uninstallUserService } from '../../src/systemd.js';

describe('systemd status and uninstall', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-systemd-status-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('status 返回 unit 是否存在 / enabled / active', () => {
    writeUserServiceUnit();
    const status = getUserServiceStatus((args) => {
      const joined = args.join(' ');
      if (joined.includes('is-enabled')) return { code: 0, stdout: 'enabled\n', stderr: '' };
      if (joined.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    expect(status.exists).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.active).toBe(true);
    expect(status.unitPath).toBe(getUserSystemdUnitPath());
  });

  test('status 在 service 文件失配时给出 repair 建议', () => {
    const unitPath = getUserSystemdUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, '[Unit]\nDescription=old\n');

    const status = getUserServiceStatus(() => ({ code: 1, stdout: 'disabled\n', stderr: '' }));
    expect(status.exists).toBe(true);
    expect(status.needsRepair).toBe(true);
    expect(status.repairHint).toContain('setup systemd');
  });

  test('uninstall 仅移除 user service 文件', () => {
    const unitPath = getUserSystemdUnitPath();
    writeUserServiceUnit();
    const calls: string[] = [];

    const result = uninstallUserService((args) => {
      calls.push(args.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(calls).toEqual(['--user daemon-reload']);
  });
});
