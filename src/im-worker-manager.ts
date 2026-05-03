import { spawn, ChildProcess } from 'child_process';
import type { SessionRegistry } from './session-registry.js';
import type { CLIPlugin } from './plugins/types.js';
import type { Session } from './types.js';
import { Writable } from 'stream';
import { generateBridgeScript } from './mcp-bridge.js';

const MAX_CRASH_COUNT = 3;
const RESTART_DELAYS = [1000, 3000, 10000]; // ms

type CLIPluginResolver = CLIPlugin | ((session: Session) => CLIPlugin);

export class IMWorkerManager {
  private _pluginResolver: CLIPluginResolver;
  private _registry: SessionRegistry;
  private _processes = new Map<string, ChildProcess>();
  private _restartTimers = new Map<string, NodeJS.Timeout>();
  private _spawnPromises = new Map<string, Promise<void>>();
  private _terminating = new Set<string>();
  private _approvalSocketPath: string | undefined;

  constructor(pluginResolver: CLIPluginResolver, registry: SessionRegistry, approvalSocketPath?: string) {
    this._pluginResolver = pluginResolver;
    this._registry = registry;
    this._approvalSocketPath = approvalSocketPath;
  }

  private _resolvePlugin(session: Session): CLIPlugin {
    return typeof this._pluginResolver === 'function'
      ? this._pluginResolver(session)
      : this._pluginResolver;
  }

  async spawn(session: Session): Promise<void> {
    const name = session.name;

    const existingSpawn = this._spawnPromises.get(name);
    if (existingSpawn) {
      return existingSpawn;
    }

    const spawnPromise = (async () => {
      const existingProc = this._processes.get(name);
      if (existingProc && this.isAlive(name)) {
        return;
      }

      if (existingProc) {
        this._processes.delete(name);
      }

      const currentSession = this._registry.get(name);
      if (!currentSession) {
        throw new Error('SESSION_NOT_FOUND');
      }

      const nextGeneration = currentSession.spawnGeneration + 1;
      this._registry['_sessions'].get(name)!.spawnGeneration = nextGeneration;

      const bridgePath = await generateBridgeScript(
        currentSession.sessionId,
        this._approvalSocketPath ?? `/tmp/mx-coder-approval-${currentSession.sessionId}.sock`,
      );
      const { command, args } = this._resolvePlugin(currentSession).buildIMWorkerCommand(currentSession, bridgePath);
      const proc = spawn(command, args, {
        cwd: currentSession.workdir,
        env: { ...process.env, ...currentSession.sessionEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (!proc.pid) {
        throw new Error(`Failed to spawn IM worker for session ${name}`);
      }

      const pid = proc.pid;
      this._processes.set(name, proc);

      const registeredSession = this._registry.get(name);
      if (!registeredSession || registeredSession.spawnGeneration !== nextGeneration) {
        this._terminating.add(name);
        proc.kill('SIGKILL');
        this._processes.delete(name);
        return;
      }

      this._registry.markWorkerReady(name, pid);

      proc.once('exit', (code, signal) => {
        const active = this._processes.get(name);
        if (active === proc) {
          this._processes.delete(name);
        }

        const wasTerminating = this._terminating.delete(name);
        const s = this._registry.get(name);
        if (!s || s.imWorkerPid !== pid) return;

        if (wasTerminating) {
          this._registry.markWorkerStopped(name);
          return;
        }

        if ((code !== 0 && code !== null) || signal !== null) {
          this._registry.markRecovering(name);
          this._registry['_sessions'].get(name)!.imWorkerPid = null;
          this._handleCrash(name);
          return;
        }

        this._registry.markWorkerStopped(name);
      });

      proc.once('error', () => {
        const active = this._processes.get(name);
        if (active === proc) {
          this._processes.delete(name);
        }

        const wasTerminating = this._terminating.delete(name);
        const s = this._registry.get(name);
        if (!s || s.imWorkerPid !== pid) return;

        if (wasTerminating) {
          this._registry.markWorkerStopped(name);
          return;
        }

        this._registry.markRecovering(name);
        this._registry['_sessions'].get(name)!.imWorkerPid = null;
        this._handleCrash(name);
      });
    })();

    this._spawnPromises.set(name, spawnPromise);
    try {
      await spawnPromise;
    } finally {
      this._spawnPromises.delete(name);
    }
  }

  async ensureRunning(name: string): Promise<void> {
    const session = this._registry.get(name);
    if (!session) throw new Error('SESSION_NOT_FOUND');

    const proc = this._processes.get(name);
    if (proc && this.isAlive(name)) {
      return;
    }

    await this.spawn(session);
  }

  async terminate(name: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const proc = this._processes.get(name);
    if (proc) {
      this._terminating.add(name);
      proc.kill(signal);
      this._processes.delete(name);
    }

    const timer = this._restartTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this._restartTimers.delete(name);
    }

    if (this._registry.get(name)) {
      this._registry.markWorkerStopped(name);
    }
  }

  getProcess(name: string): ChildProcess | undefined {
    return this._processes.get(name);
  }

  isAlive(name: string): boolean {
    const session = this._registry.get(name);
    if (!session?.imWorkerPid) return false;

    try {
      process.kill(session.imWorkerPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  resetCrashCountOnSuccess(name: string, _correlationId: string): void {
    const session = this._registry.get(name);
    if (session) {
      this._registry['_sessions'].get(name)!.imWorkerCrashCount = 0;
    }
  }

  async sendMessage(name: string, text: string): Promise<void> {
    const session = this._registry.get(name);
    if (!session) throw new Error('SESSION_NOT_FOUND');

    await this.ensureRunning(name);

    const proc = this._processes.get(name);
    if (!proc?.stdin) return;

    const stdin = proc.stdin as Writable;
    if (stdin.writableEnded || stdin.destroyed) {
      throw new Error(`IM worker stdin unavailable for session ${name}`);
    }

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        if (proc.exitCode !== null) {
          reject(new Error(`IM worker exited before write for session ${name}`));
          return;
        }

        const onError = (err: Error & { code?: string }) => {
          stdin.off('error', onError);
          reject(err.code === 'EPIPE' ? new Error(`IM worker pipe closed for session ${name}`) : err);
        };

        stdin.once('error', onError);
        try {
          stdin.write(payload + '\n', (err) => {
            stdin.off('error', onError);
            if (err) {
              const typedErr = err as Error & { code?: string };
              reject(typedErr.code === 'EPIPE' ? new Error(`IM worker pipe closed for session ${name}`) : typedErr);
            } else {
              resolve();
            }
          });
        } catch (err) {
          stdin.off('error', onError);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
        throw new Error(`IM worker pipe closed for session ${name}`);
      }
      throw err;
    }
  }

  async onDetach(name: string): Promise<void> {
    // Attach lifecycle does not own resident backend startup.
    void name;
  }

  private _handleCrash(name: string): void {
    const session = this._registry.get(name);
    if (!session) return;

    const crashCount = session.imWorkerCrashCount + 1;
    this._registry['_sessions'].get(name)!.imWorkerCrashCount = crashCount;

    if (crashCount >= MAX_CRASH_COUNT) {
      this._registry.markError(name, 'IM worker crashed too many times');
      return;
    }

    const delay = RESTART_DELAYS[crashCount - 1] || RESTART_DELAYS[RESTART_DELAYS.length - 1];
    const timer = setTimeout(async () => {
      this._restartTimers.delete(name);
      const currentSession = this._registry.get(name);
      if (currentSession) {
        await this.spawn(currentSession);
      }
    }, delay);

    this._restartTimers.set(name, timer);
  }
}
