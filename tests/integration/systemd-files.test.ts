import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUserSystemdUnitPath, renderUserServiceUnit, writeUserServiceUnit } from '../../src/systemd.js';

describe('systemd user unit files', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-systemd-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('unit 文件路径写入 ~/.config/systemd/user/mx-coder.service', () => {
    const unitPath = getUserSystemdUnitPath();
    expect(unitPath).toBe(path.join(homeDir, '.config', 'systemd', 'user', 'mx-coder.service'));
  });

  test('首次写入会创建目录并落盘 unit 文件', () => {
    const result = writeUserServiceUnit();
    expect(result.changed).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toContain('[Unit]');
    expect(fs.readFileSync(result.path, 'utf8')).toContain('WantedBy=default.target');
  });

  test('重复执行相同内容不产生副本且 changed=false', () => {
    const first = writeUserServiceUnit();
    const second = writeUserServiceUnit();

    expect(first.path).toBe(second.path);
    expect(second.changed).toBe(false);
    expect(fs.readdirSync(path.dirname(second.path))).toEqual(['mx-coder.service']);
  });

  test('已存在不同内容时覆盖并提示 reload', () => {
    const unitPath = getUserSystemdUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, '[Unit]\nDescription=old\n');

    const result = writeUserServiceUnit();
    expect(result.changed).toBe(true);
    expect(result.needsReload).toBe(true);
    expect(fs.readFileSync(unitPath, 'utf8')).toBe(renderUserServiceUnit());
  });

  test('非 Linux 场景报错', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(() => writeUserServiceUnit()).toThrow(/Linux/);
  });
});
