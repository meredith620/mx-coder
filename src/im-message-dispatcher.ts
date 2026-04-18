import * as readline from 'readline';
import type { ChildProcess } from 'child_process';
import type { SessionRegistry } from './session-registry.js';
import type { IMPlugin } from './plugins/types.js';
import type { MessageTarget, QueuedMessage, Session } from './types.js';
import { StreamToIM } from './stream-to-im.js';
import { IMWorkerManager } from './im-worker-manager.js';

function debugLog(payload: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ at: new Date().toISOString(), component: 'im-dispatcher', ...payload }));
  } catch {
    // ignore logging failure
  }
}

interface ActiveTurn {
  messageId: string;
  streamToIM: StreamToIM;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface IMMessageDispatcherOptions {
  registry: SessionRegistry;
  imPlugin: IMPlugin;
  imPluginResolver?: (message: QueuedMessage, session: Session) => IMPlugin;
  imTarget: MessageTarget;
  workerManager: IMWorkerManager;
  pollIntervalMs?: number;
  maxRetries?: number;
  onSessionImDone?: (sessionName: string) => void;
}

/**
 * Polls the session registry for pending IM messages and feeds them into
 * the resident worker one-by-one per session.
 */
export class IMMessageDispatcher {
  private _opts: IMMessageDispatcherOptions;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _processingSessions = new Set<string>();
  private _streamLoops = new Map<string, Promise<void>>();
  private _activeTurns = new Map<string, ActiveTurn>();

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
      if (session.status !== 'idle') {
        continue;
      }
      if (session.runtimeState !== 'cold' && session.runtimeState !== 'ready') {
        continue;
      }
      if (this._processingSessions.has(session.name)) {
        continue;
      }
      const pending = session.messageQueue.find(m => m.status === 'pending');
      if (!pending) continue;

      this._processingSessions.add(session.name);
      void this._processNextMessage(session.name).finally(() => {
        this._processingSessions.delete(session.name);
      });
    }
  }

  private _getNextPendingMessage(sessionName: string): { session: Session; message: QueuedMessage } | null {
    const session = this._opts.registry.get(sessionName);
    if (!session) return null;
    const message = session.messageQueue.find(m => m.status === 'pending');
    if (!message) return null;
    return { session, message };
  }

  private _buildTarget(message: QueuedMessage): MessageTarget {
    return {
      plugin: message.plugin ?? this._opts.imTarget.plugin,
      ...(message.channelId !== undefined || this._opts.imTarget.channelId !== undefined
        ? { channelId: message.channelId ?? this._opts.imTarget.channelId }
        : {}),
      threadId: message.threadId || this._opts.imTarget.threadId,
      ...(message.userId || this._opts.imTarget.userId
        ? { userId: message.userId || this._opts.imTarget.userId }
        : {}),
    };
  }

  private _resolveIMPlugin(message: QueuedMessage, session: Session): IMPlugin {
    if (this._opts.imPluginResolver) {
      return this._opts.imPluginResolver(message, session);
    }
    return this._opts.imPlugin;
  }

  private _markMessageStatus(sessionName: string, messageId: string, status: QueuedMessage['status']): void {
    const session = this._opts.registry.get(sessionName);
    if (!session) return;
    const message = session.messageQueue.find(m => m.messageId === messageId);
    if (message) {
      message.status = status;
    }
  }

  private _normalizeEvent(event: Record<string, unknown>): Record<string, unknown> {
    if ('payload' in event) {
      return event;
    }
    if ('message' in event) {
      return { ...event, payload: event.message };
    }
    return event;
  }

  private _notifyActiveTurn(sessionName: string, line: string): Promise<void> {
    const activeTurn = this._activeTurns.get(sessionName);
    if (!activeTurn) {
      return Promise.resolve();
    }

    try {
      const rawEvent = JSON.parse(line) as Record<string, unknown>;
      const event = this._normalizeEvent(rawEvent);
      return activeTurn.streamToIM.onEvent(event as Parameters<typeof activeTurn.streamToIM.onEvent>[0]).then(() => {
        if (event.type === 'result' || event.type === 'error') {
          this._activeTurns.delete(sessionName);
          activeTurn.resolve();
        }
      });
    } catch {
      debugLog({ event: 'stdout_non_json', sessionName, line });
      return Promise.resolve();
    }
  }

  private _ensureStreamLoop(sessionName: string, proc: ChildProcess): void {
    if (this._streamLoops.has(sessionName)) {
      return;
    }

    const loop = (async () => {
      const stdout = proc.stdout;
      if (!stdout) return;
      const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        debugLog({ event: 'stdout_line', sessionName, line });
        await this._notifyActiveTurn(sessionName, line);
      }
    })().finally(() => {
      const activeTurn = this._activeTurns.get(sessionName);
      if (activeTurn) {
        this._activeTurns.delete(sessionName);
        activeTurn.reject(new Error(`Worker stream closed before result for ${sessionName}`));
      }
      this._streamLoops.delete(sessionName);
    });

    this._streamLoops.set(sessionName, loop);
  }

  private async _processNextMessage(sessionName: string): Promise<void> {
    const next = this._getNextPendingMessage(sessionName);
    if (!next) return;

    const { session, message } = next;
    const streamToIM = new StreamToIM(this._resolveIMPlugin(message, session), this._buildTarget(message));
    const wasUninitialized = session.initState === 'uninitialized';

    debugLog({
      event: 'process_start',
      sessionName,
      messageId: message.messageId,
      threadId: message.threadId,
      channelId: message.channelId,
      content: message.content,
    });

    let turnResolved = false;
    const turnDone = new Promise<void>((resolve, reject) => {
      this._activeTurns.set(sessionName, {
        messageId: message.messageId,
        streamToIM,
        resolve: () => {
          turnResolved = true;
          resolve();
        },
        reject: (error) => {
          turnResolved = true;
          reject(error);
        },
      });
    });

    try {
      this._markMessageStatus(sessionName, message.messageId, 'running');
      this._opts.registry.markImProcessing(sessionName);
      await this._opts.workerManager.ensureRunning(sessionName);

      const proc = this._opts.workerManager.getProcess(sessionName);
      if (!proc) {
        throw new Error(`Worker process missing for session ${sessionName}`);
      }

      this._ensureStreamLoop(sessionName, proc);
      await this._opts.workerManager.sendMessage(sessionName, message.content);
      await turnDone;
      this._markMessageStatus(sessionName, message.messageId, 'completed');

      if (wasUninitialized) {
        try { this._opts.registry.updateSessionId(sessionName, session.sessionId); } catch {}
      }
    } catch (err) {
      this._markMessageStatus(sessionName, message.messageId, 'failed');
      debugLog({ event: 'process_failed', sessionName, messageId: message.messageId, error: (err as Error).message });
    } finally {
      const activeTurn = this._activeTurns.get(sessionName);
      if (activeTurn?.messageId === message.messageId) {
        this._activeTurns.delete(sessionName);
      }
      if (!turnResolved) {
        debugLog({ event: 'turn_incomplete', sessionName, messageId: message.messageId });
      }
      try {
        this._opts.registry.markImDone(sessionName);
        debugLog({ event: 'mark_im_done', sessionName, messageId: message.messageId, sessionStatus: this._opts.registry.get(sessionName)?.status });
        this._opts.onSessionImDone?.(sessionName);
      } catch (err) {
        debugLog({ event: 'mark_im_done_failed', sessionName, messageId: message.messageId, error: (err as Error).message });
      }

      const remaining = this._getNextPendingMessage(sessionName);
      if (this._running && remaining) {
        await this._processNextMessage(sessionName);
      }
    }
  }
}
