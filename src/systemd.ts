import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type CommandResult = { code: number; stdout: string; stderr: string };

type ServiceStatus = {
  unitPath: string;
  exists: boolean;
  enabled: boolean;
  active: boolean;
  needsRepair: boolean;
  repairHint?: string;
};

export function renderUserServiceUnit(): string {
  return [
    '[Unit]',
    'Description=mx-coder daemon',
    '',
    '[Service]',
    `ExecStart=${process.execPath} ${path.join(process.cwd(), 'dist', 'daemon-main.js')}`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function getUserSystemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'mx-coder.service');
}

export function writeUserServiceUnit(): { path: string; changed: boolean; needsReload: boolean } {
  if (process.platform !== 'linux') {
    throw new Error('systemd setup is only supported on Linux');
  }
  const filePath = getUserSystemdUnitPath();
  const content = renderUserServiceUnit();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
    return { path: filePath, changed: true, needsReload: false };
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing === content) {
    return { path: filePath, changed: false, needsReload: false };
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return { path: filePath, changed: true, needsReload: true };
}

export function installUserService(runCommand: (args: string[]) => CommandResult): { ok: true } | { ok: false; error: string } {
  const reload = runCommand(['--user', 'daemon-reload']);
  if (reload.code !== 0) {
    return { ok: false, error: reload.stderr || reload.stdout || 'systemctl --user daemon-reload failed' };
  }

  const enableNow = runCommand(['--user', 'enable', '--now', 'mx-coder.service']);
  if (enableNow.code !== 0) {
    return { ok: false, error: enableNow.stderr || enableNow.stdout || 'systemctl --user enable --now failed' };
  }

  return { ok: true };
}

export function getUserServiceStatus(runCommand: (args: string[]) => CommandResult): ServiceStatus {
  const unitPath = getUserSystemdUnitPath();
  const exists = fs.existsSync(unitPath);
  const enabled = exists && runCommand(['--user', 'is-enabled', 'mx-coder.service']).code === 0;
  const active = exists && runCommand(['--user', 'is-active', 'mx-coder.service']).code === 0;
  const needsRepair = exists && fs.readFileSync(unitPath, 'utf8') !== renderUserServiceUnit();
  return {
    unitPath,
    exists,
    enabled,
    active,
    needsRepair,
    ...(needsRepair ? { repairHint: 'Run mx-coder setup systemd --user to repair the unit file.' } : {}),
  };
}

export function uninstallUserService(runCommand: (args: string[]) => CommandResult): { ok: true } | { ok: false; error: string } {
  const unitPath = getUserSystemdUnitPath();
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
  }
  const reload = runCommand(['--user', 'daemon-reload']);
  if (reload.code !== 0) {
    return { ok: false, error: reload.stderr || reload.stdout || 'systemctl --user daemon-reload failed' };
  }
  return { ok: true };
}
