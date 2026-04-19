import * as fs from 'fs';
import * as path from 'path';
import type { Session, SessionStatus, RuntimeState } from './types.js';
import type { SessionRegistry } from './session-registry.js';

function deriveRuntimeStateFromStatus(status: SessionStatus): RuntimeState {
  switch (status) {
    case 'im_processing':     return 'running';
    case 'approval_pending':  return 'waiting_approval';
    case 'attached':          return 'attached_terminal';
    case 'takeover_pending':  return 'takeover_pending';
    case 'recovering':        return 'recovering';
    case 'error':             return 'error';
    default:                  return 'cold';
  }
}

// States that cannot survive a daemon restart cleanly
const RECOVER_STATES = new Set<SessionStatus>([
  'attached',
  'im_processing',
  'approval_pending',
  'takeover_pending',
]);

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
  createdAt?: string;
  lastActivityAt?: string;
}

interface PersistenceFile {
  version: number;
  sessions: PersistedSession[];
}

export class PersistenceStore {
  private _filePath: string;
  private _registry: SessionRegistry | null = null;

  constructor(filePath: string) {
    this._filePath = filePath;
  }

  attach(registry: SessionRegistry): void {
    this._registry = registry;
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
      let status = (p.status ?? 'idle') as SessionStatus;
      if (RECOVER_STATES.has(status)) {
        status = 'recovering';
      }

      const session: Session = {
        name: p.name,
        sessionId: p.sessionId ?? crypto.randomUUID(),
        cliPlugin: p.cliPlugin,
        workdir: p.workdir,
        status,
        lifecycleStatus: (p.lifecycleStatus as Session['lifecycleStatus']) ?? 'active',
        initState: (p.initState as Session['initState']) ?? 'uninitialized',
        runtimeState: deriveRuntimeStateFromStatus(status),
        revision: p.revision ?? 0,
        spawnGeneration: p.spawnGeneration ?? 0,
        attachedPid: null,
        imWorkerPid: null,
        imWorkerCrashCount: 0,
        imBindings: (p.imBindings ?? []).map((binding) => ({
          ...binding,
          bindingKind: binding.bindingKind ?? 'thread',
        })),
        messageQueue: p.messageQueue ?? [],
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
