import * as readline from 'readline';
import type { ChildProcess } from 'child_process';
import type { SessionRegistry } from './session-registry.js';
import type { IMPlugin, ChannelStatusResult } from './plugins/types.js';
import type { MessageTarget, QueuedMessage, Session, StreamCursor } from './types.js';
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
  lastEventAt: number;
  userText: string;
  previousCursor: StreamCursor | undefined;
  cursorSatisfied: boolean;
  lastStreamMessageId: string | undefined;
}

export interface IMMessageDispatcherOptions {
  registry: SessionRegistry;
  imPlugin: IMPlugin;
  imPluginResolver?: (message: QueuedMessage, session: Session) => IMPlugin;
  imTarget: MessageTarget;
  workerManager: IMWorkerManager;
  pollIntervalMs?: number;
  typingIntervalMs?: number;
  typingQuietWindowMs?: number;
  maxRetries?: number;
  onSessionImDone?: (sessionName: string) => void;
}

/**
 * Polls the session registry for pending IM messages and feeds them into
 * the resident worker one-by-one per session.
 */
export class IMMessageDispatcher {
  private static readonly TYPING_INTERVAL_MS = 3000;
  private static readonly TYPING_QUIET_WINDOW_MS = 5000;
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

  private async _handleInvalidTarget(sessionName: string, target: MessageTarget, status: ChannelStatusResult): Promise<void> {
    if (!target.channelId) return;

    const session = this._opts.registry.get(sessionName);
    if (!session) return;

    const shouldRemove = status.kind === 'deleted' || status.kind === 'not_found' || status.kind === 'forbidden';
    if (!shouldRemove) {
      debugLog({ event: 'invalid_target_ignored', sessionName, channelId: target.channelId, status: status.kind, error: 'error' in status ? status.error : undefined });
      return;
    }

    const removed = this._opts.registry.removeIMBinding(sessionName, (binding) =>
      binding.plugin === target.plugin
      && binding.bindingKind === 'channel'
      && binding.channelId === target.channelId,
    );
    if (removed) {
      debugLog({ event: 'invalid_target_binding_removed', sessionName, channelId: target.channelId, status: status.kind });
    }
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
    const eventWithMessageId = event.messageId === undefined && typeof (event.message as { id?: unknown } | undefined)?.id === 'string'
      ? { ...event, messageId: (event.message as { id: string }).id }
      : event;
    if ('payload' in eventWithMessageId) {
      return eventWithMessageId;
    }
    if ('message' in eventWithMessageId) {
      return { ...eventWithMessageId, payload: eventWithMessageId.message };
    }
    return eventWithMessageId;
  }

  private _extractTextBlocks(event: Record<string, unknown>): string {
    const payload = event.payload as { content?: Array<{ type?: string; text?: string }>; message?: { content?: Array<{ type?: string; text?: string }> } } | undefined;
    const content = payload?.content ?? payload?.message?.content ?? [];
    return content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('');
  }

  private _notifyActiveTurn(sessionName: string, line: string): Promise<void> {
    const activeTurn = this._activeTurns.get(sessionName);
    if (!activeTurn) {
      return Promise.resolve();
    }

    try {
      const rawEvent = JSON.parse(line) as Record<string, unknown>;
      const event = this._normalizeEvent(rawEvent);
      activeTurn.lastEventAt = Date.now();

      if (event.type === 'system') {
        const payload = event.payload as { session_id?: unknown } | undefined;
        if (typeof payload?.session_id === 'string' && payload.session_id.trim()) {
          const session = this._opts.registry.get(sessionName);
          const nextSessionId = payload.session_id.trim();
          if (session && session.sessionId !== nextSessionId) {
            this._opts.registry.updateSessionId(sessionName, nextSessionId);
          }
        }
      }

      if (!activeTurn.cursorSatisfied && activeTurn.previousCursor) {
        if (event.messageId === activeTurn.previousCursor.lastMessageId) {
          if (event.type === 'result') {
            activeTurn.cursorSatisfied = true;
          }
          return Promise.resolve();
        }
        if (event.type === 'user' && this._extractTextBlocks(event) === activeTurn.userText) {
          activeTurn.cursorSatisfied = true;
          activeTurn.lastStreamMessageId = typeof event.messageId === 'string' ? event.messageId : activeTurn.lastStreamMessageId;
          return Promise.resolve();
        }
      }

      if (typeof event.messageId === 'string') {
        activeTurn.lastStreamMessageId = event.messageId;
      }

      return activeTurn.streamToIM.onEvent(event as Parameters<typeof activeTurn.streamToIM.onEvent>[0]).then(() => {
        if (event.type === 'result') {
          const completedSession = this._opts.registry.get(sessionName);
          if (completedSession && activeTurn.lastStreamMessageId) {
            completedSession.streamState = {
              ...(completedSession.streamState ?? {}),
              cursor: {
                sessionId: completedSession.sessionId,
                lastMessageId: activeTurn.lastStreamMessageId,
              },
            };
          }
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

  private _startTypingLoop(sessionName: string, message: QueuedMessage, session: Session): () => void {
    const plugin = this._resolveIMPlugin(message, session);
    if (typeof plugin.sendTyping !== 'function') {
      return () => {};
    }

    const target = this._buildTarget(message);
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      const current = this._opts.registry.get(sessionName);
      if (!current || current.runtimeState !== 'running') {
        return;
      }

      const activeTurn = this._activeTurns.get(sessionName);
      const quietWindowMs = this._opts.typingQuietWindowMs ?? IMMessageDispatcher.TYPING_QUIET_WINDOW_MS;
      if (!activeTurn || activeTurn.messageId !== message.messageId || Date.now() - activeTurn.lastEventAt > quietWindowMs) {
        return;
      }

      try {
        await plugin.sendTyping!(target);
      } catch (error) {
        debugLog({ event: 'typing_failed', sessionName, messageId: message.messageId, error: (error as Error).message });
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, this._opts.typingIntervalMs ?? IMMessageDispatcher.TYPING_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async _processNextMessage(sessionName: string): Promise<void> {
    const next = this._getNextPendingMessage(sessionName);
    if (!next) return;

    const { session, message } = next;
    const target = this._buildTarget(message);
    const streamToIM = new StreamToIM(
      this._resolveIMPlugin(message, session),
      target,
      session.streamVisibility,
      async (invalidTarget, status) => {
        await this._handleInvalidTarget(sessionName, invalidTarget, status);
      },
    );
    debugLog({
      event: 'process_start',
      sessionName,
      messageId: message.messageId,
      threadId: message.threadId,
      channelId: message.channelId,
      content: message.content,
    });

    let stopTyping = () => {};
    const previousCursor = session.streamState?.cursor;

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
        lastEventAt: Date.now(),
        userText: message.content,
        previousCursor,
        cursorSatisfied: previousCursor === undefined,
        lastStreamMessageId: undefined,
      });
    });

    try {
      session.activeOperatorId = message.userId;
      session.activeMessageId = message.messageId;
      this._markMessageStatus(sessionName, message.messageId, 'running');
      await this._opts.workerManager.ensureRunning(sessionName);
      if (previousCursor) {
        debugLog({ event: 'stream_cursor_active', sessionName, lastMessageId: previousCursor.lastMessageId, sessionId: previousCursor.sessionId });
      }
      this._opts.registry.markImProcessing(sessionName);

      const proc = this._opts.workerManager.getProcess(sessionName);
      if (!proc) {
        throw new Error(`Worker process missing for session ${sessionName}`);
      }

      this._ensureStreamLoop(sessionName, proc);
      stopTyping = this._startTypingLoop(sessionName, message, session);
      await this._opts.workerManager.sendMessage(sessionName, message.content);
      await turnDone;
      this._markMessageStatus(sessionName, message.messageId, 'completed');
      session.lastTurnOutcome = 'completed';
      session.lastResultAt = new Date().toISOString();
    } catch (err) {
      this._markMessageStatus(sessionName, message.messageId, 'failed');
      session.lastTurnOutcome = 'failed';
      session.lastResultAt = new Date().toISOString();
      debugLog({ event: 'process_failed', sessionName, messageId: message.messageId, error: (err as Error).message });
    } finally {
      stopTyping();
      const activeTurn = this._activeTurns.get(sessionName);
      if (activeTurn?.messageId === message.messageId) {
        this._activeTurns.delete(sessionName);
      }
      if (!turnResolved) {
        session.lastTurnOutcome = 'interrupted';
        session.interruptReason = 'worker_crash';
        debugLog({ event: 'turn_incomplete', sessionName, messageId: message.messageId });
      }
      try {
        this._opts.registry.markImDone(sessionName);
        const currentSession = this._opts.registry.get(sessionName);
        if (currentSession && currentSession.messageQueue.every(m => m.status !== 'running' && m.status !== 'waiting_approval')) {
          delete currentSession.activeOperatorId;
          delete currentSession.activeMessageId;
        }
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
