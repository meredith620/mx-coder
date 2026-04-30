import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachSession } from '../../src/attach.js';
import { encodeResponse } from '../../src/ipc/codec.js';
import { PersistenceStore } from '../../src/persistence.js';
import { SessionRegistry } from '../../src/session-registry.js';

describe('attach 流程', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: net.Server;
  let receivedCommands: Array<{ command: string; args: Record<string, unknown> }>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-attach-test-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    receivedCommands = [];

    server = net.createServer(socket => {
      let buf = '';
      socket.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { type: string; requestId: string; command: string; args: Record<string, unknown> };
            if (msg.type === 'request') {
              receivedCommands.push({ command: msg.command, args: msg.args });
              // Respond with ok
              socket.write(encodeResponse(msg.requestId, { ok: true, waitRequired: false }) + '\n');
            }
          } catch { /* ignore */ }
        }
      });
    });

    await new Promise<void>(resolve => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('attach spawn 时使用 session.workdir 作为 cwd', async () => {
    const markerDir = fs.mkdtempSync(path.join(tmpDir, 'cwd-marker-'));
    const markerFile = path.join(markerDir, 'pwd.txt');
    const mockCli = path.join(tmpDir, 'mock-cwd.sh');
    fs.writeFileSync(mockCli, `#!/bin/sh\npwd > "${markerFile}"\nexit 0\n`, { mode: 0o755 });

    await attachSession({
      socketPath,
      sessionName: 'test-session',
      cliCommand: mockCli,
      cliArgs: [],
      workdir: markerDir,
    });

    expect(fs.readFileSync(markerFile, 'utf-8').trim()).toBe(markerDir);
  }, 10000);

  test('attach 完整流程：通知 daemon → spawn → 退出 → 通知 detach', async () => {
    // Create a mock CLI script that exits immediately
    const mockCli = path.join(tmpDir, 'mock-cli.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await attachSession({
      socketPath,
      sessionName: 'test-session',
      cliCommand: mockCli,
      cliArgs: [],
    });

    // Should have sent 'attach' and 'markDetached'
    const commands = receivedCommands.map(r => r.command);
    expect(commands).toContain('attach');
    expect(commands).toContain('markDetached');

    const detachCmd = receivedCommands.find(r => r.command === 'markDetached');
    expect(detachCmd?.args.exitReason).toBe('normal');
  }, 10000);

  test('attach spawn 时注入 sessionEnv 并覆盖同名外部 env', async () => {
    const captureFile = path.join(tmpDir, 'env-capture.json');
    const mockCli = path.join(tmpDir, 'mock-env.sh');
    fs.writeFileSync(mockCli, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({`,
      '  MY_SESSION_VAR: process.env.MY_SESSION_VAR,',
      '  PATH: process.env.PATH,',
      '  OVERRIDE_ME: process.env.OVERRIDE_ME,',
      '}));',
      'process.exit(0);',
    ].join('\n'), { mode: 0o755 });

    // Set an env var that sessionEnv should override
    const originalOverride = process.env.OVERRIDE_ME;
    process.env.OVERRIDE_ME = 'from-parent';

    try {
      await attachSession({
        socketPath,
        sessionName: 'env-test',
        cliCommand: mockCli,
        cliArgs: [],
        workdir: tmpDir,
        sessionEnv: { MY_SESSION_VAR: 'injected-value', OVERRIDE_ME: 'from-session' },
      });

      const data = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
      expect(data.MY_SESSION_VAR).toBe('injected-value');
      expect(data.OVERRIDE_ME).toBe('from-session');
      expect(data.PATH).toBeTruthy();
    } finally {
      if (originalOverride === undefined) {
        delete process.env.OVERRIDE_ME;
      } else {
        process.env.OVERRIDE_ME = originalOverride;
      }
    }
  }, 10000);

  test('attach 期间 IM 正在处理：waitRequired 为 true 时等待 resume', async () => {
    // Override server to return waitRequired: true for attach, then send resume event
    server.removeAllListeners('connection');
    server.on('connection', socket => {
      let buf = '';
      let attachHandled = false;
      socket.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { type: string; requestId: string; command: string; args: Record<string, unknown> };
            if (msg.type === 'request') {
              receivedCommands.push({ command: msg.command, args: msg.args });
              if (msg.command === 'attach' && !attachHandled) {
                attachHandled = true;
                socket.write(encodeResponse(msg.requestId, { ok: true, waitRequired: true }) + '\n');
                // Send resume event after short delay
                setTimeout(() => {
                  socket.write(JSON.stringify({ type: 'event', event: 'session_resume', data: { name: 'wait-session' } }) + '\n');
                }, 50);
              } else {
                socket.write(encodeResponse(msg.requestId, { ok: true }) + '\n');
              }
            }
          } catch { /* ignore */ }
        }
      });
    });

    const mockCli = path.join(tmpDir, 'mock-cli2.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await attachSession({
      socketPath,
      sessionName: 'wait-session',
      cliCommand: mockCli,
      cliArgs: [],
    });

    const commands = receivedCommands.map(r => r.command);
    expect(commands).toContain('attach');
    expect(commands).toContain('markDetached');
  }, 10000);

  test('持久化回归：persistence 加载后 sessionEnv 仍存在，attach spawn 能读到', async () => {
    // 1. 构造一个带 sessionEnv 的持久化文件
    const persistFile = path.join(tmpDir, 'sessions.json');
    const sessionEnv = { PERSIST_VAR: 'survived-restart', ANOTHER_VAR: 'also-here' };
    fs.writeFileSync(persistFile, JSON.stringify({
      version: 1,
      sessions: [{
        name: 'persist-env-test',
        sessionId: 'sess-persist-env',
        cliPlugin: 'claude-code',
        workdir: tmpDir,
        status: 'idle',
        lifecycleStatus: 'active',
        initState: 'initialized',
        revision: 1,
        spawnGeneration: 0,
        imBindings: [],
        messageQueue: [],
        sessionEnv,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      }],
    }));

    // 2. 用 PersistenceStore 加载，验证 sessionEnv 被正确恢复
    const registry = new SessionRegistry();
    const store = new PersistenceStore(persistFile);
    await store.load(registry);

    const loaded = registry.get('persist-env-test');
    expect(loaded).toBeDefined();
    expect(loaded!.sessionEnv).toEqual(sessionEnv);

    // 3. 用恢复出的 sessionEnv 调用 attachSession，验证子进程能读到
    const captureFile = path.join(tmpDir, 'persist-env-capture.json');
    const mockCli = path.join(tmpDir, 'mock-persist-env.sh');
    fs.writeFileSync(mockCli, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({`,
      '  PERSIST_VAR: process.env.PERSIST_VAR,',
      '  ANOTHER_VAR: process.env.ANOTHER_VAR,',
      '}));',
      'process.exit(0);',
    ].join('\n'), { mode: 0o755 });

    await attachSession({
      socketPath,
      sessionName: 'persist-env-test',
      cliCommand: mockCli,
      cliArgs: [],
      workdir: tmpDir,
      sessionEnv: loaded!.sessionEnv,
    });

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
    expect(captured.PERSIST_VAR).toBe('survived-restart');
    expect(captured.ANOTHER_VAR).toBe('also-here');
  }, 10000);
});
