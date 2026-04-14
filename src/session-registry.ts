import { v4 as uuidv4 } from 'uuid';
import type { Session, QueuedMessage, IMBinding } from './types.js';
import { SessionStateMachine, INVALID_STATE_TRANSITION } from './session-state-machine.js';

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
  dedupeKey: string;
}

export class SessionRegistry {
  // exposed for tests via ['_sessions']
  _sessions: Map<string, Session> = new Map();
  private _mutexes: Map<string, Mutex> = new Map();

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

  private _guardLifecycle(s: Session): void {
    if (s.lifecycleStatus === 'archived') throw new Error('SESSION_ARCHIVED');
  }

  private _guardInitState(s: Session): void {
    if (s.initState === 'initializing') throw new Error('SESSION_BUSY');
  }

  private _applyTransition(s: Session, event: Parameters<SessionStateMachine['transition']>[0]): void {
    const sm = new SessionStateMachine(s.status);
    try {
      sm.transition(event);
    } catch {
      throw new Error(INVALID_STATE_TRANSITION);
    }
    s.status = sm.current;
    s.revision += 1;
    s.lastActivityAt = new Date();
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
      revision: 0,
      spawnGeneration: 0,
      attachedPid: null,
      imWorkerPid: null,
      imWorkerCrashCount: 0,
      imBindings: [],
      messageQueue: [],
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

  bindIM(name: string, binding: Omit<IMBinding, 'createdAt'>): void {
    const s = this._getOrThrow(name);
    const entry: IMBinding = { ...binding, createdAt: new Date().toISOString() };
    s.imBindings.push(entry);
  }

  getByIMThread(plugin: string, threadId: string): Session | undefined {
    for (const s of this._sessions.values()) {
      if (s.imBindings.some(b => b.plugin === plugin && b.threadId === threadId)) {
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

  // P1: enqueue IM message — rejected when session is attached
  enqueueIMMessage(name: string, opts: EnqueueOptions): void {
    const s = this._getOrThrow(name);
    if (s.status === 'attached' || s.status === 'attach_pending') {
      throw new Error('SESSION_BUSY');
    }
    const msg: QueuedMessage = {
      messageId: uuidv4(),
      threadId: '',
      userId: '',
      content: opts.text,
      status: 'pending',
      correlationId: uuidv4(),
      dedupeKey: opts.dedupeKey,
      enqueuePolicy: 'auto_after_detach',
    };
    s.messageQueue.push(msg);
  }
}
