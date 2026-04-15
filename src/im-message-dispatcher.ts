import { spawn } from 'child_process';
import * as readline from 'readline';
import type { SessionRegistry } from './session-registry.js';
import type { IMPlugin } from './plugins/types.js';
import type { MessageTarget } from './types.js';
import { StreamToIM } from './stream-to-im.js';

export interface IMMessageDispatcherOptions {
  registry: SessionRegistry;
  imPlugin: IMPlugin;
  imTarget: MessageTarget;
  cliCommand: string;
  cliArgs: string[];
  pollIntervalMs?: number;
  maxRetries?: number;
  onSessionImDone?: (sessionName: string) => void;
}

/**
 * Polls the session registry for pending IM messages, spawns the CLI for each,
 * pipes stdout through StreamToIM, and updates the IM plugin with the response.
 */
export class IMMessageDispatcher {
  private _opts: IMMessageDispatcherOptions;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _processing = new Set<string>(); // sessionName:messageId

  constructor(opts: IMMessageDispatcherOptions) {
    this._opts = opts;
  }

  start(): void {
    this._running = true;
    this._poll();
  }

  stop(): void {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _poll(): void {
    if (!this._running) return;
    void this._tick().finally(() => {
      if (this._running) {
        this._timer = setTimeout(() => this._poll(), this._opts.pollIntervalMs ?? 100);
      }
    });
  }

  private async _tick(): Promise<void> {
    const sessions = this._opts.registry.list();
    for (const session of sessions) {
      const pending = session.messageQueue.filter(m => m.status === 'pending');
      for (const msg of pending) {
        const key = `${session.name}:${msg.messageId}`;
        if (this._processing.has(key)) continue;
        this._processing.add(key);
        void this._processMessage(session.name, msg.messageId).finally(() => {
          this._processing.delete(key);
        });
      }
    }
  }

  private async _processMessage(sessionName: string, messageId: string, attempt = 0): Promise<void> {
    const maxRetries = this._opts.maxRetries ?? 1;
    const streamToIM = new StreamToIM(this._opts.imPlugin, this._opts.imTarget);
    const registry = this._opts.registry;

    // Update session status to im_processing
    try {
      registry.markImProcessing(sessionName);
    } catch { /* session may not exist or invalid transition */ }

    try {
      const exitCode = await new Promise<number>((resolve) => {
        const proc = spawn(this._opts.cliCommand, this._opts.cliArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line) as { type: string; payload: unknown };
            void streamToIM.onEvent(event as Parameters<typeof streamToIM.onEvent>[0]);
          } catch { /* ignore non-JSON */ }
        });

        proc.on('close', (code) => resolve(code ?? 0));
        proc.on('error', () => resolve(1));
      });

      if (exitCode !== 0 && attempt < maxRetries) {
        // Retry after short delay
        await new Promise(resolve => setTimeout(resolve, 200));
        return this._processMessage(sessionName, messageId, attempt + 1);
      }
    } catch {
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 200));
        return this._processMessage(sessionName, messageId, attempt + 1);
      }
    } finally {
      // Mark message as completed and update session status
      const session = registry.get(sessionName);
      if (session) {
        const msg = session.messageQueue.find(m => m.messageId === messageId);
        if (msg) msg.status = 'completed';
      }
      try {
        registry.markImDone(sessionName);
        this._opts.onSessionImDone?.(sessionName);
      } catch { /* ignore invalid transitions */ }
    }
  }
}
