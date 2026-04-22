import { v4 as uuidv4 } from 'uuid';
import type { PermissionConfig, Capability } from './types.js';

type ApprovalDecision = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface PendingApprovalCtx {
  sessionId: string;
  messageId?: string;
  toolUseId?: string;
  correlationId?: string;
  capability?: Capability;
  operatorId?: string;
}

export interface CreatedApproval {
  requestId: string;
  context: {
    sessionId: string;
    messageId: string;
    toolUseId: string;
    correlationId: string;
    capability?: Capability;
    operatorId?: string;
  };
}

export interface DecideInput {
  decision: 'approved' | 'denied';
  scope?: 'once' | 'session';
}

export interface DecideResult {
  status: ApprovalDecision | 'stale';
  cancelReason?: string;
}

export interface ApprovalState {
  requestId: string;
  sessionId: string;
  decision: ApprovalDecision;
  scope?: 'once' | 'session';
  operatorId?: string;
  capability?: Capability;
  cancelReason?: string;
  interactionMessageId?: string;
  lastReactionPollAt?: number;
  context: CreatedApproval['context'];
  // CAS lock: once decision is set away from 'pending', no further changes
  _decided: boolean;
}

interface Mutex {
  _locked: boolean;
  _queue: Array<() => void>;
}

function makeMutex(): Mutex {
  return { _locked: false, _queue: [] };
}

async function acquireMutex(m: Mutex): Promise<void> {
  if (!m._locked) { m._locked = true; return; }
  return new Promise<void>(resolve => m._queue.push(resolve));
}

function releaseMutex(m: Mutex): void {
  const next = m._queue.shift();
  if (next) { next(); } else { m._locked = false; }
}

export class ApprovalManager {
  private _config: PermissionConfig;
  private _states = new Map<string, ApprovalState>();
  // sessionId → set of requestIds
  private _sessionPending = new Map<string, Set<string>>();
  // scope=session cache: `${sessionId}:${operatorId}:${capability}` → true
  private _sessionScopeCache = new Set<string>();
  // per-requestId mutex for first-write-wins
  private _mutexes = new Map<string, Mutex>();

  constructor(config: PermissionConfig) {
    this._config = config;
  }

  async applyRules(
    toolName: string,
    toolInput: Record<string, unknown>,
    capability?: Capability,
    sessionCtx?: { sessionId?: string; operatorId?: string },
  ): Promise<'allow' | 'deny' | 'ask'> {
    // Check scope=session cache first
    if (capability && sessionCtx?.sessionId && sessionCtx?.operatorId) {
      const cacheKey = `${sessionCtx.sessionId}:${sessionCtx.operatorId}:${capability}`;
      if (this._sessionScopeCache.has(cacheKey)) return 'allow';
    }

    // autoDeny by capability
    if (capability && this._config.autoDenyCapabilities.includes(capability)) return 'deny';

    // autoDeny by pattern: format "ToolName:substring"
    for (const pattern of this._config.autoDenyPatterns) {
      const colonIdx = pattern.indexOf(':');
      if (colonIdx === -1) continue;
      const patternTool = pattern.slice(0, colonIdx);
      const patternSubstr = pattern.slice(colonIdx + 1);
      if (toolName === patternTool) {
        // Check toolInput for the substring
        const inputStr = JSON.stringify(toolInput);
        if (inputStr.includes(patternSubstr)) return 'deny';
      }
    }

    // autoAllow by capability
    if (capability && this._config.autoAllowCapabilities.includes(capability)) return 'allow';

    // autoAsk by capability
    if (capability && this._config.autoAskCapabilities.includes(capability)) return 'ask';

    return 'ask';
  }

  async createPendingApproval(
    ctx: PendingApprovalCtx,
    opts?: { timeoutSeconds?: number },
  ): Promise<CreatedApproval> {
    const { sessionId } = ctx;
    const messageId = ctx.messageId ?? '';
    const toolUseId = ctx.toolUseId ?? '';
    const correlationId = ctx.correlationId ?? uuidv4();
    const nonce = uuidv4();
    const requestId = `${sessionId}:${messageId}:${toolUseId}:${nonce}`;

    // Cancel existing pending for this session
    const existingPending = this._sessionPending.get(sessionId);
    if (existingPending) {
      for (const oldId of existingPending) {
        const old = this._states.get(oldId);
        if (old && old.decision === 'pending') {
          old.decision = 'cancelled';
          old._decided = true;
        }
      }
    }
    const pendingSet = new Set<string>([requestId]);
    this._sessionPending.set(sessionId, pendingSet);

    const state: ApprovalState = {
      requestId,
      sessionId,
      decision: 'pending',
      ...(ctx.capability !== undefined && { capability: ctx.capability }),
      ...(ctx.operatorId !== undefined && { operatorId: ctx.operatorId }),
      _decided: false,
      context: {
        sessionId,
        messageId,
        toolUseId,
        correlationId,
        ...(ctx.capability !== undefined && { capability: ctx.capability }),
        ...(ctx.operatorId !== undefined && { operatorId: ctx.operatorId }),
      },
    };
    this._states.set(requestId, state);
    this._mutexes.set(requestId, makeMutex());

    const timeoutMs = (opts?.timeoutSeconds ?? this._config.timeoutSeconds) * 1000;
    setTimeout(() => {
      const s = this._states.get(requestId);
      if (s && !s._decided) {
        s.decision = 'expired';
        s._decided = true;
      }
    }, timeoutMs);

    return {
      requestId,
      context: state.context,
    };
  }

  async decide(requestId: string, input: DecideInput): Promise<DecideResult> {
    const state = this._states.get(requestId);
    if (!state) return { status: 'stale' };

    const mutex = this._mutexes.get(requestId) ?? makeMutex();
    await acquireMutex(mutex);
    try {
      if (state._decided) {
        // Another decide already won
        return { status: 'cancelled' };
      }
      state.decision = input.decision;
      if (input.scope !== undefined) state.scope = input.scope;
      state._decided = true;

      // Handle scope=session cache
      if (input.scope === 'session' && state.capability && state.operatorId) {
        const cacheKey = `${state.sessionId}:${state.operatorId}:${state.capability}`;
        this._sessionScopeCache.add(cacheKey);
      }

      return { status: state.decision };
    } finally {
      releaseMutex(mutex);
    }
  }

  async decideByApprover(requestId: string, _approverId: string, input: DecideInput): Promise<DecideResult> {
    const state = this._states.get(requestId);
    if (!state) return { status: 'stale' };

    const mutex = this._mutexes.get(requestId) ?? makeMutex();
    await acquireMutex(mutex);
    try {
      if (state._decided) {
        return { status: 'stale' };
      }
      state.decision = input.decision;
      if (input.scope !== undefined) state.scope = input.scope;
      state._decided = true;

      if (input.scope === 'session' && state.capability && state.operatorId) {
        const cacheKey = `${state.sessionId}:${state.operatorId}:${state.capability}`;
        this._sessionScopeCache.add(cacheKey);
      }

      return { status: state.decision };
    } finally {
      releaseMutex(mutex);
    }
  }

  async cancel(requestId: string, reason = 'user_cancelled'): Promise<DecideResult> {
    const state = this._states.get(requestId);
    if (!state) return { status: 'stale' };

    const mutex = this._mutexes.get(requestId) ?? makeMutex();
    await acquireMutex(mutex);
    try {
      if (state._decided) {
        return { status: 'stale' };
      }
      state.decision = 'cancelled';
      state.cancelReason = reason;
      state._decided = true;
      return { status: 'cancelled', cancelReason: reason };
    } finally {
      releaseMutex(mutex);
    }
  }

  attachInteractionMessage(requestId: string, interactionMessageId: string): void {
    const state = this._states.get(requestId);
    if (!state) return;
    state.interactionMessageId = interactionMessageId;
  }

  markReactionPoll(requestId: string): void {
    const state = this._states.get(requestId);
    if (!state) return;
    state.lastReactionPollAt = Date.now();
  }

  getApprovalStateByInteractionMessageId(interactionMessageId: string): ApprovalState | undefined {
    for (const state of Array.from(this._states.values()).reverse()) {
      if (state.interactionMessageId === interactionMessageId) {
        return state;
      }
    }
    return undefined;
  }

  getPendingApprovalForSession(sessionId: string): ApprovalState | undefined {
    const pendingSet = this._sessionPending.get(sessionId);
    if (!pendingSet) return undefined;
    for (const requestId of Array.from(pendingSet).reverse()) {
      const state = this._states.get(requestId);
      if (state && !state._decided && state.decision === 'pending') {
        return state;
      }
    }
    return undefined;
  }

  getApprovalState(requestId: string): ApprovalState | undefined {
    return this._states.get(requestId);
  }

  getAllApprovalStates(): ApprovalState[] {
    return Array.from(this._states.values());
  }

  expirePendingOnRestart(): void {
    for (const state of this._states.values()) {
      if (!state._decided && state.decision === 'pending') {
        state.decision = 'expired';
        state._decided = true;
      }
    }
  }

  invalidateSessionCache(sessionId: string): void {
    for (const key of this._sessionScopeCache) {
      if (key.startsWith(`${sessionId}:`)) {
        this._sessionScopeCache.delete(key);
      }
    }
  }

  async cancelForTakeover(sessionId: string): Promise<void> {
    const pendingSet = this._sessionPending.get(sessionId);
    if (!pendingSet) return;

    for (const requestId of pendingSet) {
      const state = this._states.get(requestId);
      if (state && !state._decided && state.decision === 'pending') {
        state.decision = 'cancelled';
        state.cancelReason = 'takeover';
        state._decided = true;
      }
    }
  }
}
