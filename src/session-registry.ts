import { v4 as uuidv4 } from 'uuid';
import type { Session, QueuedMessage, IMBinding } from './types.js';
import { SessionStateMachine, INVALID_STATE_TRANSITION } from './session-state-machine.js';
import type { PersistenceStore } from './persistence.js';

function debugLog(payload: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ at: new Date().toISOString(), component: 'session-registry', ...payload }));
  } catch {
    // ignore logging failure
  }
}

class Mutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>(resolve => {
      this._queue.push(resolve);
    });
  }

  tryAcquire(): boolean {
    if (this._locked) {
      return false;
    }
    this._locked = true;
    return true;
  }

  isLocked(): boolean {
    return this._locked;
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

export interface CreateOptions {
  workdir: string;
  cliPlugin: string;
}

export interface EnqueueOptions {
  text: string;
  dedupeKey?: string;
  plugin?: string;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  userId?: string;
  receivedAt?: string;
  isPassthrough?: boolean;
}

export class SessionRegistry {
  // exposed for tests via ['_sessions']
  _sessions: Map<string, Session> = new Map();
  private _mutexes: Map<string, Mutex> = new Map();
  private _store: PersistenceStore | null;

  constructor(store?: PersistenceStore) {
    this._store = store ?? null;
    if (this._store) this._store.attach(this);
  }

  private _getMutex(name: string): Mutex {
    let m = this._mutexes.get(name);
    if (!m) {
      m = new Mutex();
      this._mutexes.set(name, m);
    }
    return m;
  }

  private _getOrThrow(name: string): Session {
    const s = this._sessions.get(name);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    return s;
  }

  private _guardSessionUnlocked(name: string): void {
    const mutex = this._getMutex(name);
    if (mutex.isLocked()) {
      throw new Error('SESSION_BUSY');
    }
  }

  private _withSessionLock<T>(name: string, fn: (session: Session) => T): T {
    const mutex = this._getMutex(name);
    if (!mutex.tryAcquire()) {
      throw new Error('SESSION_BUSY');
    }
    try {
      const session = this._getOrThrow(name);
      return fn(session);
    } finally {
      mutex.release();
    }
  }

  private _isPidAlive(pid: number | null): boolean {
    if (pid == null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private _guardLifecycle(s: Session): void {
    if (s.lifecycleStatus === 'archived') throw new Error('SESSION_ARCHIVED');
  }

  private _guardInitState(s: Session): void {
    if (s.initState === 'initializing') throw new Error('SESSION_BUSY');
  }

  private _syncIdleRuntimeState(s: Session): void {
    if (s.status !== 'idle' && s.status !== 'attach_pending') {
      return;
    }

    if (s.status === 'attach_pending') {
      if (s.imWorkerPid == null) {
        s.runtimeState = 'cold';
      } else if (s.runtimeState === 'waiting_approval' || s.runtimeState === 'running' || s.runtimeState === 'ready') {
        // keep current attach_pending sub-state
      } else {
        s.runtimeState = 'ready';
      }
      return;
    }

    s.runtimeState = s.imWorkerPid == null ? 'cold' : 'ready';
  }

  private _applyTransition(s: Session, event: Parameters<SessionStateMachine['transition']>[0]): void {
    const sm = new SessionStateMachine(s.status);
    const from = s.status;
    const previousRuntimeState = s.runtimeState;
    try {
      sm.transition(event);
    } catch {
      debugLog({ event: 'transition_failed', sessionName: s.name, from, trigger: event });
      throw new Error(INVALID_STATE_TRANSITION);
    }
    s.status = sm.current;
    s.runtimeState = this._runtimeStateForStatus(s.status, previousRuntimeState);
    s.revision += 1;
    s.lastActivityAt = new Date();
    debugLog({ event: 'transition', sessionName: s.name, from, to: s.status, trigger: event, revision: s.revision });
  }

  private _runtimeStateForStatus(status: Session['status'], previousRuntimeState?: Session['runtimeState']): Session['runtimeState'] {
    switch (status) {
      case 'im_processing':
        return 'running';
      case 'approval_pending':
        return 'waiting_approval';
      case 'attached':
        return 'attached_terminal';
      case 'takeover_pending':
        return 'takeover_pending';
      case 'error':
        return 'error';
      case 'attach_pending':
        if (previousRuntimeState === 'waiting_approval') return 'waiting_approval';
        if (previousRuntimeState === 'running' || previousRuntimeState === 'recovering') return 'running';
        return 'ready';
      default:
        return 'cold';
    }
  }

  reconcileProcessLiveness(name?: string): void {
    const sessions = name ? [this._getOrThrow(name)] : this.list();
    for (const s of sessions) {
      if (s.status === 'attached' && !this._isPidAlive(s.attachedPid)) {
        const from = s.status;
        s.attachedPid = null;
        s.status = 'idle';
        this._syncIdleRuntimeState(s);
        s.revision += 1;
        s.lastActivityAt = new Date();
        debugLog({ event: 'reconcile_attached_dead_pid', sessionName: s.name, from, to: s.status, revision: s.revision });
        continue;
      }

      if (s.status === 'attach_pending' && !this._isPidAlive(s.attachedPid)) {
        const from = s.status;
        s.attachedPid = null;
        if (s.runtimeState === 'running' && s.imWorkerPid != null) {
          s.status = 'im_processing';
          s.runtimeState = 'running';
        } else if (s.runtimeState === 'waiting_approval' && s.imWorkerPid != null) {
          s.status = 'approval_pending';
          s.runtimeState = 'waiting_approval';
        } else {
          s.status = 'idle';
          this._syncIdleRuntimeState(s);
        }
        s.revision += 1;
        s.lastActivityAt = new Date();
        debugLog({ event: 'reconcile_attach_pending_dead_pid', sessionName: s.name, from, to: s.status, runtimeState: s.runtimeState, revision: s.revision });
        continue;
      }

      if (s.status === 'takeover_pending' && !this._isPidAlive(s.attachedPid)) {
        const from = s.status;
        s.attachedPid = null;
        s.status = 'idle';
        this._syncIdleRuntimeState(s);
        delete s.takeoverRequestedBy;
        delete s.takeoverRequestedAt;
        s.revision += 1;
        s.lastActivityAt = new Date();
        debugLog({ event: 'reconcile_takeover_pending_dead_pid', sessionName: s.name, from, to: s.status, revision: s.revision });
      }
    }
  }

  create(name: string, opts: CreateOptions): Session {
    if (this._sessions.has(name)) throw new Error('SESSION_ALREADY_EXISTS');
    const now = new Date();
    const session: Session = {
      name,
      sessionId: uuidv4(),
      cliPlugin: opts.cliPlugin,
      workdir: opts.workdir,
      status: 'idle',
      lifecycleStatus: 'active',
      initState: 'uninitialized',
      runtimeState: 'cold',
      revision: 0,
      spawnGeneration: 0,
      attachedPid: null,
      imWorkerPid: null,
      imWorkerCrashCount: 0,
      streamVisibility: 'normal',
      imBindings: [],
      messageQueue: [],
      streamState: {},
      createdAt: now,
      lastActivityAt: now,
    };
    this._sessions.set(name, session);
    return session;
  }

  importSession(sessionId: string, name: string, opts: CreateOptions): Session {
    if (this._sessions.has(name)) throw new Error('SESSION_ALREADY_EXISTS');
    // Check for duplicate sessionId
    for (const s of this._sessions.values()) {
      if (s.sessionId === sessionId) throw new Error('SESSION_ALREADY_EXISTS');
    }
    const now = new Date();
    const session: Session = {
      name,
      sessionId,
      cliPlugin: opts.cliPlugin,
      workdir: opts.workdir,
      status: 'idle',
      lifecycleStatus: 'active',
      initState: 'initialized', // external session already initialized
      runtimeState: 'cold',
      revision: 0,
      spawnGeneration: 0,
      attachedPid: null,
      imWorkerPid: null,
      imWorkerCrashCount: 0,
      streamVisibility: 'normal',
      imBindings: [],
      messageQueue: [],
      streamState: {},
      createdAt: now,
      lastActivityAt: now,
    };
    this._sessions.set(name, session);
    return session;
  }

  get(name: string): Session | undefined {
    return this._sessions.get(name);
  }

  list(): Session[] {
    return Array.from(this._sessions.values());
  }

  remove(name: string): void {
    this._sessions.delete(name);
    this._mutexes.delete(name);
  }

  // Synchronous mark — no CAS check, acquires lock internally (blocking callers must hold lock)
  /** Update sessionId (e.g. after first CLI run returns real conversation ID) */
  updateSessionId(name: string, newSessionId: string): void {
    const s = this._getOrThrow(name);
    const sessionIdChanged = s.sessionId !== newSessionId;
    s.sessionId = newSessionId;
    if (sessionIdChanged) {
      s.streamState = {};
    }
    if (s.initState === 'uninitialized') {
      s.initState = 'initialized';
    }
    s.revision += 1;
    s.lastActivityAt = new Date();
  }

  markAttached(name: string, pid: number): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    this._guardInitState(s);
    this._applyTransition(s, 'attach_start');
    s.attachedPid = pid;
    if (s.initState === 'uninitialized') {
      s.initState = 'initialized';
    }
  }

  markAttachedWithRevision(name: string, pid: number, expectedRevision: number): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    this._guardInitState(s);
    if (s.revision !== expectedRevision) throw new Error('SESSION_BUSY');
    this._applyTransition(s, 'attach_start');
    s.attachedPid = pid;
  }

  bindIM(name: string, binding: Omit<IMBinding, 'createdAt' | 'bindingKind'> & { bindingKind?: IMBinding['bindingKind'] }): void {
    const s = this._getOrThrow(name);
    const entry: IMBinding = {
      ...binding,
      bindingKind: binding.bindingKind ?? 'thread',
      createdAt: new Date().toISOString(),
    };
    s.imBindings.push(entry);
  }

  getByIMThread(plugin: string, threadId: string): Session | undefined {
    for (const s of this._sessions.values()) {
      if (s.imBindings.some(b => b.plugin === plugin && b.bindingKind === 'thread' && b.threadId === threadId)) {
        return s;
      }
    }
    return undefined;
  }

  archive(name: string): void {
    const s = this._getOrThrow(name);
    s.lifecycleStatus = 'archived';
  }

  markStale(name: string): void {
    const s = this._getOrThrow(name);
    s.lifecycleStatus = 'stale';
  }

  markWorkerReady(name: string, workerPid: number): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    s.imWorkerPid = workerPid;
    s.status = 'idle';
    s.runtimeState = 'ready';
    delete s.needsRecovery;
    delete s.recoveryReason;
    s.revision += 1;
    s.lastActivityAt = new Date();
    debugLog({ event: 'worker_ready', sessionName: s.name, pid: workerPid, revision: s.revision });
  }

  markWorkerStopped(name: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    s.imWorkerPid = null;
    if (s.status === 'error') {
      s.runtimeState = 'error';
    } else {
      s.status = 'idle';
      s.runtimeState = 'cold';
    }
    s.revision += 1;
    s.lastActivityAt = new Date();
    debugLog({ event: 'worker_stopped', sessionName: s.name, revision: s.revision });
  }

  markRecovering(name: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    s.runtimeState = 'recovering';
    s.needsRecovery = true;
    s.recoveryReason = 'worker_crash';
    s.revision += 1;
    s.lastActivityAt = new Date();
    debugLog({ event: 'worker_recovering', sessionName: s.name, revision: s.revision });
  }

  markError(name: string, _reason?: string): void {
    const s = this._getOrThrow(name);
    // Force to error state regardless of current state
    s.status = 'error';
    s.runtimeState = 'error';
    s.revision += 1;
    s.lastActivityAt = new Date();
  }

  // P1: first-writer-wins lazy init + attach
  async beginInitAndAttach(name: string, pid: number): Promise<void> {
    const mutex = this._getMutex(name);
    await mutex.acquire();
    try {
      const s = this._getOrThrow(name);
      this._guardLifecycle(s);
      if (s.initState === 'initializing') throw new Error('SESSION_BUSY');
      if (s.initState === 'uninitialized') {
        s.initState = 'initializing';
      }
      this._applyTransition(s, 'attach_start');
      s.attachedPid = pid;
      s.initState = 'initialized';
    } finally {
      mutex.release();
    }
  }

  // P1: attach with mutex — gives attach priority over IM
  async beginAttach(name: string, pid: number): Promise<void> {
    const mutex = this._getMutex(name);
    await mutex.acquire();
    try {
      const s = this._getOrThrow(name);
      this._guardLifecycle(s);
      this._guardInitState(s);
      this._applyTransition(s, 'attach_start');
      s.attachedPid = pid;
    } finally {
      mutex.release();
    }
  }

  // P1: enqueue IM message — queued when attached (SPEC §3.9), queue frozen when attach_pending
  enqueueIMMessage(name: string, opts: EnqueueOptions): { alreadyExists: boolean; existingStatus?: string } {
    const s = this._getOrThrow(name);
    const dedupeKey = opts.dedupeKey ?? `${opts.plugin ?? ''}:${opts.threadId ?? ''}:${opts.messageId ?? ''}`;

    const existing = s.messageQueue.find(m => m.dedupeKey === dedupeKey);
    if (existing) {
      return { alreadyExists: true, existingStatus: existing.status };
    }

    const msg: QueuedMessage = {
      messageId: opts.messageId ?? uuidv4(),
      ...(opts.plugin !== undefined ? { plugin: opts.plugin } : {}),
      ...(opts.channelId !== undefined ? { channelId: opts.channelId } : {}),
      ...(opts.isPassthrough !== undefined ? { isPassthrough: opts.isPassthrough as any } : {}),
      threadId: opts.threadId ?? '',
      userId: opts.userId ?? '',
      content: opts.text,
      status: 'pending',
      correlationId: uuidv4(),
      dedupeKey,
      enqueuePolicy: 'auto_after_detach',
    };
    s.messageQueue.push(msg);
    debugLog({ event: 'enqueue_message', sessionName: name, messageId: msg.messageId, threadId: msg.threadId, channelId: msg.channelId, dedupeKey });
    return { alreadyExists: false };
  }

  updateStreamVisibility(name: string, visibility: Session['streamVisibility']): void {
    const s = this._getOrThrow(name);
    if (s.streamVisibility === visibility) return;
    s.streamVisibility = visibility;
    s.revision += 1;
    s.lastActivityAt = new Date();
  }

  markDetached(name: string, _exitReason?: 'normal' | 'error'): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    this._applyTransition(s, 'attach_exit_normal');
    s.attachedPid = null;
    this._syncIdleRuntimeState(s);
  }

  markImProcessing(name: string, workerPid?: number): void {
    this._withSessionLock(name, (s) => {
      this._guardLifecycle(s);
      if (workerPid !== undefined) s.imWorkerPid = workerPid;
      this._applyTransition(s, 'im_message_received');
    });
  }

  markImDone(name: string): void {
    this._withSessionLock(name, (s) => {
      this._guardLifecycle(s);
      if (s.status === 'im_processing') {
        this._applyTransition(s, 'message_completed');
        this._syncIdleRuntimeState(s);
      } else if (s.status === 'attach_pending') {
        const hadWorker = s.imWorkerPid != null;
        this._applyTransition(s, 'im_message_completed_and_worker_stopped');
        s.imWorkerPid = null;
        if (hadWorker) {
          s.runtimeState = 'attached_terminal';
        }
      }
    });
  }

  markAttachPending(name: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);

    if (s.status === 'idle') {
      s.status = 'attach_pending';
      s.runtimeState = s.imWorkerPid == null ? 'cold' : 'ready';
      s.revision += 1;
      s.lastActivityAt = new Date();
      debugLog({ event: 'transition', sessionName: s.name, from: 'idle', to: s.status, trigger: 'attach_start', revision: s.revision });
      return;
    }

    if (s.runtimeState === 'recovering' && (s.status === 'im_processing' || s.status === 'approval_pending')) {
      const previousStatus = s.status;
      s.status = 'attach_pending';
      s.runtimeState = previousStatus === 'approval_pending' ? 'waiting_approval' : 'running';
      s.revision += 1;
      s.lastActivityAt = new Date();
      debugLog({ event: 'transition', sessionName: s.name, from: previousStatus, to: s.status, trigger: 'attach_start', revision: s.revision });
      return;
    }

    this._applyTransition(s, 'attach_start');
    this._syncIdleRuntimeState(s);
  }

  markAttachResumed(name: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    if (s.status === 'attach_pending') {
      this._applyTransition(s, 'im_message_completed_and_worker_stopped');
      s.imWorkerPid = null;
      s.runtimeState = 'attached_terminal';
    }
  }

  requestTakeover(name: string, requestedBy?: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    this._applyTransition(s, 'takeover_requested');
    if (requestedBy !== undefined) {
      s.takeoverRequestedBy = requestedBy;
    } else {
      delete s.takeoverRequestedBy;
    }
    s.takeoverRequestedAt = new Date().toISOString();
  }

  cancelTakeover(name: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    if (s.status === 'takeover_pending') {
      this._applyTransition(s, 'takeover_cancelled');
    }
    delete s.takeoverRequestedBy;
    delete s.takeoverRequestedAt;
  }

  completeTakeover(name: string): void {
    const s = this._getOrThrow(name);
    this._guardLifecycle(s);
    if (s.status === 'takeover_pending') {
      this._applyTransition(s, 'terminal_sigterm_exited');
    }
    s.attachedPid = null;
    delete s.takeoverRequestedBy;
    delete s.takeoverRequestedAt;
  }

  replayMessage(name: string, originalDedupeKey: string): QueuedMessage {
    const s = this._getOrThrow(name);
    const original = s.messageQueue.find(m => m.dedupeKey === originalDedupeKey);
    if (!original) throw new Error('MESSAGE_NOT_FOUND');

    const newMsg: QueuedMessage = {
      messageId: uuidv4(),
      ...(original.plugin !== undefined ? { plugin: original.plugin } : {}),
      ...(original.channelId !== undefined ? { channelId: original.channelId } : {}),
      threadId: original.threadId,
      userId: original.userId,
      content: original.content,
      status: 'pending',
      correlationId: uuidv4(),
      dedupeKey: uuidv4(),
      enqueuePolicy: original.enqueuePolicy,
      replayOf: originalDedupeKey,
    };
    s.messageQueue.push(newMsg);
    return newMsg;
  }
}
