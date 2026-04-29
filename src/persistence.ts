import * as fs from 'fs';
import * as path from 'path';
import type { Session, SessionStatus, RuntimeState, QueuedMessage } from './types.js';
import type { SessionRegistry } from './session-registry.js';
import { determineRestoreAction } from './restore-action.js';

function deriveRuntimeStateFromStatus(status: SessionStatus): RuntimeState {
  switch (status) {
    case 'im_processing':     return 'running';
    case 'approval_pending':  return 'waiting_approval';
    case 'attached':          return 'attached_terminal';
    case 'takeover_pending':  return 'takeover_pending';
    case 'error':             return 'error';
    default:                  return 'cold';
  }
}

function deriveRestoreContext(message: QueuedMessage): { hasApprovalContext: boolean; isHighRisk: boolean } {
  const approvalState = message.approvalState;
  const hasApprovalContext = approvalState !== undefined && approvalState !== 'denied';
  const content = message.content.toLowerCase();
  const isHighRisk =
    message.isPassthrough === true
    || approvalState === 'denied'
    || /\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bpoweroff\b|\biptables\b|\bsystemctl\s+stop\b|\bkillall\b|\bkill\s+-9\b/.test(content);
  return { hasApprovalContext, isHighRisk };
}

function applyRestoreAction(message: QueuedMessage): QueuedMessage[] {
  const restoreAction = determineRestoreAction(message, deriveRestoreContext(message));
  if (restoreAction === 'replay') {
    return [{ ...message, status: 'pending', restoreAction, replayOf: message.dedupeKey }];
  }
  return [{ ...message, status: 'pending', restoreAction }];
}

function toAuditRecord(message: QueuedMessage): AuditRecord | null {
  if (!message.restoreAction) return null;
  return {
    dedupeKey: message.dedupeKey,
    replayOf: message.restoreAction === 'replay' ? message.replayOf ?? message.dedupeKey : null,
    requestId: null,
    operatorId: message.userId || null,
    action: message.restoreAction === 'replay'
      ? 'restore_replay'
      : message.restoreAction === 'confirm'
        ? 'restore_confirm'
        : 'restore_discard',
    result: 'scheduled',
  };
}

// States that cannot survive a daemon restart cleanly
const RECOVER_STATE_REASON: Partial<Record<SessionStatus, NonNullable<Session['recoveryReason']>>> = {
  attached: 'daemon_restart_during_attach',
  im_processing: 'daemon_restart_during_im',
  approval_pending: 'daemon_restart_during_approval',
  takeover_pending: 'daemon_restart_during_takeover',
};

interface PersistedSession {
  name: string;
  sessionId?: string;
  cliPlugin: string;
  workdir: string;
  status: string;
  lifecycleStatus?: string;
  initState?: string;
  revision?: number;
  spawnGeneration?: number;
  imBindings?: Session['imBindings'];
  messageQueue?: Session['messageQueue'];
  streamVisibility?: Session['streamVisibility'];
  needsRecovery?: boolean;
  recoveryReason?: Session['recoveryReason'];
  createdAt?: string;
  lastActivityAt?: string;
}

interface PersistenceFile {
  version: number;
  sessions: PersistedSession[];
}

type AuditRecord = {
  dedupeKey: string | null;
  replayOf: string | null;
  requestId: string | null;
  operatorId: string | null;
  action: 'restore_replay' | 'restore_confirm' | 'restore_discard';
  result: 'scheduled';
};

export class PersistenceStore {
  private _filePath: string;
  private _registry: SessionRegistry | null = null;
  private _auditRecords: AuditRecord[] = [];

  constructor(filePath: string) {
    this._filePath = filePath;
  }

  attach(registry: SessionRegistry): void {
    this._registry = registry;
  }

  getAuditRecords(): AuditRecord[] {
    return [...this._auditRecords];
  }

  async load(registry: SessionRegistry): Promise<void> {
    this._registry = registry;
    if (!fs.existsSync(this._filePath)) return;

    const raw = fs.readFileSync(this._filePath, 'utf-8');
    let data: PersistenceFile;
    try {
      data = JSON.parse(raw) as PersistenceFile;
    } catch {
      return; // corrupt file — start fresh
    }

    const now = new Date();
    for (const p of data.sessions ?? []) {
      const persistedStatus = (p.status ?? 'idle') as SessionStatus | 'recovering';
      const recoveredReason = persistedStatus === 'recovering'
        ? (p.recoveryReason ?? 'daemon_restart_during_im')
        : RECOVER_STATE_REASON[persistedStatus as SessionStatus];
      const needsRecovery = persistedStatus === 'recovering' || recoveredReason !== undefined;
      const status: SessionStatus = needsRecovery ? 'idle' : (persistedStatus as SessionStatus);
      const runtimeState: RuntimeState = status === 'idle' ? 'cold' : deriveRuntimeStateFromStatus(status);
      const messageQueue: Session['messageQueue'] = (p.messageQueue ?? []).flatMap((message) => {
        if (!needsRecovery) return [message];
        if (message.status === 'running') {
          return applyRestoreAction({ ...message, status: 'running' });
        }
        if (message.status === 'waiting_approval') {
          return applyRestoreAction({ ...message, status: 'waiting_approval', approvalState: message.approvalState === 'denied' ? 'denied' : 'expired' });
        }
        return [message];
      });
      for (const message of messageQueue) {
        const audit = toAuditRecord(message);
        if (audit) this._auditRecords.push(audit);
      }

      const session: Session = {
        name: p.name,
        sessionId: p.sessionId ?? crypto.randomUUID(),
        cliPlugin: p.cliPlugin,
        workdir: p.workdir,
        status,
        lifecycleStatus: (p.lifecycleStatus as Session['lifecycleStatus']) ?? 'active',
        initState: (p.initState as Session['initState']) ?? 'uninitialized',
        runtimeState,
        ...(needsRecovery ? { needsRecovery: true } : {}),
        ...(recoveredReason ? { recoveryReason: recoveredReason } : {}),
        revision: p.revision ?? 0,
        spawnGeneration: p.spawnGeneration ?? 0,
        attachedPid: null,
        imWorkerPid: null,
        imWorkerCrashCount: 0,
        streamVisibility: p.streamVisibility ?? 'normal',
        imBindings: (p.imBindings ?? []).map((binding) => ({
          ...binding,
          bindingKind: binding.bindingKind ?? 'thread',
        })),
        messageQueue,
        createdAt: p.createdAt ? new Date(p.createdAt) : now,
        lastActivityAt: p.lastActivityAt ? new Date(p.lastActivityAt) : now,
      };
      registry['_sessions'].set(p.name, session);
    }
  }

  async flush(): Promise<void> {
    if (!this._registry) return;

    const sessions: PersistedSession[] = this._registry.list().map(s => ({
      name: s.name,
      sessionId: s.sessionId,
      cliPlugin: s.cliPlugin,
      workdir: s.workdir,
      status: s.status,
      lifecycleStatus: s.lifecycleStatus,
      initState: s.initState,
      revision: s.revision,
      spawnGeneration: s.spawnGeneration,
      imBindings: s.imBindings,
      messageQueue: s.messageQueue,
      streamVisibility: s.streamVisibility,
      ...(s.needsRecovery !== undefined ? { needsRecovery: s.needsRecovery } : {}),
      ...(s.recoveryReason !== undefined ? { recoveryReason: s.recoveryReason } : {}),
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
    }));

    const data: PersistenceFile = { version: 1, sessions };
    const tmp = this._filePath + '.tmp';

    // Atomic write: write to .tmp then rename
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this._filePath);
  }
}
