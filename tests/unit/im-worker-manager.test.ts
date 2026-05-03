import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { SessionRegistry } from '../../src/session-registry.js';
import type { CommandSpec, LegacyIMMessageCLIPlugin } from '../../src/plugins/types.js';
import type { Session } from '../../src/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

class MockCLIPlugin implements LegacyIMMessageCLIPlugin {
  buildAttachCommand(_session: Session): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  buildIMWorkerCommand(_session: Session, _bridgeScriptPath: string): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  buildIMMessageCommand(_session: Session, _prompt: string): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  generateSessionId(): string {
    return 'mock-session-id';
  }
}

class ResidentCLIPlugin implements LegacyIMMessageCLIPlugin {
  constructor(private readonly outputPath: string) {}

  buildAttachCommand(_session: Session): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  buildIMWorkerCommand(_session: Session, _bridgeScriptPath: string): CommandSpec {
    return {
      command: 'bash',
      args: ['-lc', `cat > ${this.outputPath}`],
    };
  }

  buildIMMessageCommand(_session: Session, _prompt: string): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  generateSessionId(): string {
    return 'mock-session-id';
  }
}

class CrashingCLIPlugin implements LegacyIMMessageCLIPlugin {
  buildAttachCommand(_session: Session): CommandSpec {
    return { command: 'false', args: [] };
  }

  buildIMWorkerCommand(_session: Session, _bridgeScriptPath: string): CommandSpec {
    return { command: 'false', args: [] };
  }

  buildIMMessageCommand(_session: Session, _prompt: string): CommandSpec {
    return { command: 'false', args: [] };
  }

  generateSessionId(): string {
    return 'mock-session-id';
  }
}

describe('IMWorkerManager', () => {
  let registry: SessionRegistry;
  let mockPlugin: MockCLIPlugin;
  let crashingPlugin: CrashingCLIPlugin;

  beforeEach(() => {
    registry = new SessionRegistry();
    mockPlugin = new MockCLIPlugin();
    crashingPlugin = new CrashingCLIPlugin();
  });

  afterEach(async () => {
    for (const [name] of registry['_sessions']) {
      const session = registry.get(name);
      if (session?.imWorkerPid) {
        try {
          process.kill(session.imWorkerPid, 'SIGKILL');
        } catch {}
      }
    }
  });

  test('spawn 时会真实生成 mcp bridge 脚本', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bridge-gen-'));
    const session = registry.create('bridge-test', { workdir: '/tmp', cliPlugin: 'mock' });
    session.sessionId = 'bridge-session-id';
    const mgr = new IMWorkerManager(mockPlugin, registry);

    const bridgePath = path.join(os.tmpdir(), `mcp-bridge-${session.sessionId}.js`);
    try { fs.rmSync(bridgePath, { force: true }); } catch {}

    await mgr.spawn(session);

    expect(fs.existsSync(bridgePath)).toBe(true);
    const content = fs.readFileSync(bridgePath, 'utf8');
    expect(content).toContain('bridge-session-id');

    await mgr.terminate('bridge-test');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });


  test('ensureRunning 懒启动成功且不重复 spawn', async () => {
    const session = registry.create('ensure-test', { workdir: '/tmp', cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(mockPlugin, registry);

    await mgr.ensureRunning('ensure-test');
    const firstPid = registry.get('ensure-test')!.imWorkerPid;
    const firstGeneration = registry.get('ensure-test')!.spawnGeneration;

    await mgr.ensureRunning('ensure-test');
    const updated = registry.get('ensure-test')!;

    expect(updated.imWorkerPid).toBe(firstPid);
    expect(updated.spawnGeneration).toBe(firstGeneration);
    expect(updated.runtimeState).toBe('ready');

    await mgr.terminate('ensure-test');
  });

  test('sendMessage 多次调用时复用同一个 resident worker', async () => {
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-resident-worker-')), 'stdin.jsonl');
    const residentPlugin = new ResidentCLIPlugin(tmpFile);
    const session = registry.create('resident-test', { workdir: '/tmp', cliPlugin: 'resident' });
    const mgr = new IMWorkerManager(residentPlugin, registry);

    await mgr.sendMessage('resident-test', 'turn-1');
    const firstPid = registry.get('resident-test')!.imWorkerPid;

    await mgr.sendMessage('resident-test', 'turn-2');
    const secondPid = registry.get('resident-test')!.imWorkerPid;

    expect(firstPid).not.toBeNull();
    expect(secondPid).toBe(firstPid);

    await new Promise(resolve => setTimeout(resolve, 200));
    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    await mgr.terminate('resident-test');
  });

  test('terminate 后清理 pid 并回到 cold', async () => {
    const session = registry.create('test', { workdir: '/tmp', cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(mockPlugin, registry);

    await mgr.spawn(session);
    await mgr.terminate('test');
    await new Promise(resolve => setTimeout(resolve, 100));

    const updated = registry.get('test')!;
    expect(mgr.isAlive('test')).toBe(false);
    expect(updated.imWorkerPid).toBeNull();
    expect(updated.runtimeState).toBe('cold');
  });

  test('崩溃后进入 recovering 并在重启成功后回到 ready', async () => {
    const session = registry.create('test', { workdir: '/tmp', cliPlugin: 'crashing' });
    const mgr = new IMWorkerManager(crashingPlugin, registry);

    await mgr.spawn(session);
    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = registry.get('test')!;
    expect(updated.imWorkerCrashCount).toBeGreaterThan(0);
    expect(['recovering', 'error', 'ready']).toContain(updated.runtimeState);

    if (updated.imWorkerPid) {
      try {
        process.kill(updated.imWorkerPid, 'SIGKILL');
      } catch {}
    }
  }, 10000);

  test('超过 maxCrashCount 进入 error 状态', async () => {
    const session = registry.create('test', { workdir: '/tmp', cliPlugin: 'crashing' });
    const mgr = new IMWorkerManager(crashingPlugin, registry);

    await mgr.spawn(session);
    await new Promise(resolve => setTimeout(resolve, 5000));

    const updated = registry.get('test')!;
    expect(updated.status).toBe('error');
    expect(updated.runtimeState).toBe('error');
    expect(updated.imWorkerCrashCount).toBeGreaterThanOrEqual(3);
  }, 15000);

  test('成功处理一条消息后 resetCrashCountOnSuccess 清零', () => {
    registry.create('test', { workdir: '/tmp', cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(mockPlugin, registry);

    registry['_sessions'].get('test')!.imWorkerCrashCount = 2;
    mgr.resetCrashCountOnSuccess('test', 'correlation-1');

    expect(registry.get('test')!.imWorkerCrashCount).toBe(0);
  });

  test('spawnGeneration：并发 spawn 时仅有一个活跃 worker', async () => {
    const session = registry.create('gen-test', { workdir: '/tmp', cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(mockPlugin, registry);

    const spawn1 = mgr.spawn(session);
    const spawn2 = mgr.spawn(session);

    await Promise.allSettled([spawn1, spawn2]);

    const s = registry.get('gen-test')!;
    expect(mgr.isAlive(s.name)).toBe(true);
    expect(s.runtimeState).toBe('ready');

    await mgr.terminate('gen-test');
  });

  test('spawn 在 worker 存活时保持 resident 进程不变', async () => {
    const session = registry.create('test', { workdir: '/tmp', cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(mockPlugin, registry);

    await mgr.spawn(session);
    const firstPid = registry.get('test')!.imWorkerPid;

    await mgr.spawn(session);
    const secondPid = registry.get('test')!.imWorkerPid;

    expect(secondPid).toBe(firstPid);

    await mgr.terminate('test');
  });

  test('onDetach 不会启动 resident worker', async () => {
    registry.create('detach-test', { workdir: '/tmp', cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(mockPlugin, registry);

    await mgr.onDetach('detach-test');

    const updated = registry.get('detach-test')!;
    expect(updated.imWorkerPid).toBeNull();
    expect(updated.runtimeState).toBe('cold');
    expect(updated.status).toBe('idle');
  });
});
