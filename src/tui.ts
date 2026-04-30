import type { SessionStatus, RuntimeState, Session } from './types.js';
import type { IPCEvent } from './ipc/codec.js';
import type { IPCClient } from './ipc/client.js';

export interface SessionSummary {
  name: string;
  status: SessionStatus;
  workdir: string;
  lastActivityAt: Date;
  runtimeState?: RuntimeState;
  queueLength?: number;
  bindingKind?: 'thread' | 'channel';
  connectionHealth?: {
    wsHealthy?: boolean;
    subscriptionHealthy?: boolean;
  };
}

export interface TuiStateStore {
  list(): SessionSummary[];
  applyEvent(event: IPCEvent): void;
}

export interface TuiActions {
  createSession(input: { name: string; workdir: string; cli: string; spaceStrategy?: 'thread' | 'channel' }): Promise<Record<string, unknown>>;
  openSession(input: { name: string; spaceStrategy?: 'thread' | 'channel' }): Promise<Record<string, unknown>>;
  getStatus(name: string): Promise<Record<string, unknown>>;
  removeSession(name: string): Promise<void>;
  importSession(input: { sessionId: string; name: string; workdir: string; cli: string }): Promise<Record<string, unknown>>;
  diagnoseSession(name: string): Promise<Record<string, unknown>>;
  getTakeoverStatus(name: string): Promise<Record<string, unknown>>;
  cancelTakeover(name: string): Promise<Record<string, unknown>>;
  getSessionEnv(name: string): Promise<Record<string, unknown>>;
  setSessionEnv(input: { name: string; key: string; value: string }): Promise<Record<string, unknown>>;
  unsetSessionEnv(input: { name: string; key: string }): Promise<Record<string, unknown>>;
  clearSessionEnv(name: string): Promise<Record<string, unknown>>;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: 'idle',
  attach_pending: 'attach_pending',
  attached: 'attached',
  im_processing: 'im_processing',
  approval_pending: 'approval_pending',
  takeover_pending: 'takeover_pending',
  error: 'error',
};

export function createTuiStateStore(initialSessions: SessionSummary[] = []): TuiStateStore {
  const sessions = new Map<string, SessionSummary>();

  for (const session of initialSessions) {
    sessions.set(session.name, { ...session });
  }

  return {
    list(): SessionSummary[] {
      return Array.from(sessions.values());
    },
    applyEvent(event: IPCEvent): void {
      if (event.event !== 'session_state_changed') {
        return;
      }

      const name = typeof event.data.name === 'string' ? event.data.name : '';
      if (!name) {
        return;
      }

      const previous = sessions.get(name);
      const status = event.data.status as SessionStatus | undefined;
      const runtimeState = event.data.runtimeState as RuntimeState | undefined;
      const workdir = typeof event.data.workdir === 'string'
        ? event.data.workdir
        : previous?.workdir ?? '';
      const lastActivityAtRaw = event.data.lastActivityAt;
      const lastActivityAt = typeof lastActivityAtRaw === 'string' || lastActivityAtRaw instanceof Date
        ? new Date(lastActivityAtRaw)
        : previous?.lastActivityAt ?? new Date();
      const queueLengthRaw = event.data.queueLength;
      const queueLength = typeof queueLengthRaw === 'number'
        ? queueLengthRaw
        : previous?.queueLength;
      const connectionHealthRaw = event.data.connectionHealth;
      const connectionHealth = typeof connectionHealthRaw === 'object' && connectionHealthRaw !== null
        ? (() => {
            const next: { wsHealthy?: boolean; subscriptionHealthy?: boolean } = {};
            if (typeof (connectionHealthRaw as { wsHealthy?: unknown }).wsHealthy === 'boolean') {
              next.wsHealthy = (connectionHealthRaw as { wsHealthy: boolean }).wsHealthy;
            } else if (previous?.connectionHealth?.wsHealthy !== undefined) {
              next.wsHealthy = previous.connectionHealth.wsHealthy;
            }
            if (typeof (connectionHealthRaw as { subscriptionHealthy?: unknown }).subscriptionHealthy === 'boolean') {
              next.subscriptionHealthy = (connectionHealthRaw as { subscriptionHealthy: boolean }).subscriptionHealthy;
            } else if (previous?.connectionHealth?.subscriptionHealthy !== undefined) {
              next.subscriptionHealthy = previous.connectionHealth.subscriptionHealthy;
            }
            return Object.keys(next).length > 0 ? next : undefined;
          })()
        : previous?.connectionHealth;
      const bindingKindRaw = event.data.bindingKind;
      const bindingKind = bindingKindRaw === 'thread' || bindingKindRaw === 'channel'
        ? bindingKindRaw
        : previous?.bindingKind;

      const nextSession: SessionSummary = {
        name,
        status: status ?? previous?.status ?? 'idle',
        workdir,
        lastActivityAt,
      };
      if (runtimeState ?? previous?.runtimeState) {
        nextSession.runtimeState = (runtimeState ?? previous?.runtimeState)!;
      }
      if (queueLength !== undefined) {
        nextSession.queueLength = queueLength;
      }
      if (connectionHealth !== undefined) {
        nextSession.connectionHealth = connectionHealth;
      }
      if (bindingKind !== undefined) {
        nextSession.bindingKind = bindingKind;
      }

      sessions.set(name, nextSession);
    },
  };
}

export function createTuiActions(client: IPCClient): TuiActions {
  return {
    async createSession(input) {
      const response = await client.send('create', {
        name: input.name,
        workdir: input.workdir,
        cli: input.cli,
        ...(input.spaceStrategy ? { spaceStrategy: input.spaceStrategy } : {}),
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data.session as Record<string, unknown>;
    },
    async openSession(input) {
      const response = await client.send('open', {
        name: input.name,
        ...(input.spaceStrategy ? { spaceStrategy: input.spaceStrategy } : {}),
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
    async getStatus(name) {
      const response = await client.send('status', {});
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      const sessions = response.data.sessions as Array<Record<string, unknown>>;
      const session = sessions.find((item) => item.name === name);
      if (!session) {
        throw new Error(`Session not found: ${name}`);
      }
      return session;
    },
    async removeSession(name) {
      const response = await client.send('remove', { name });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
    },
    async importSession(input) {
      const response = await client.send('import', {
        sessionId: input.sessionId,
        name: input.name,
        workdir: input.workdir,
        cli: input.cli,
      });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data.session as Record<string, unknown>;
    },
    async diagnoseSession(name) {
      return this.getStatus(name);
    },
    async getTakeoverStatus(name) {
      const response = await client.send('takeoverStatus', { name });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
    async cancelTakeover(name) {
      const response = await client.send('takeoverCancel', { name });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
    async getSessionEnv(name) {
      const response = await client.send('sessionEnvGet', { name });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
    async setSessionEnv(input) {
      const response = await client.send('sessionEnvSet', input);
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
    async unsetSessionEnv(input) {
      const response = await client.send('sessionEnvUnset', input);
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
    async clearSessionEnv(name) {
      const response = await client.send('sessionEnvClear', { name });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data as Record<string, unknown>;
    },
  };
}

function isBusyRuntimeState(runtimeState: RuntimeState | undefined): boolean {
  return runtimeState === 'running'
    || runtimeState === 'waiting_approval'
    || runtimeState === 'attached_terminal'
    || runtimeState === 'takeover_pending'
    || runtimeState === 'recovering';
}

export function renderTuiDiagnostics(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return 'No sessions found.\n';
  }

  const lines: string[] = [];
  for (const s of sessions) {
    const runtimeLabel = s.runtimeState ?? (s.status === 'attached' ? 'attached_terminal' : 'cold');
    const busyLabel = isBusyRuntimeState(runtimeLabel) ? 'busy' : 'idle';
    const wsLabel = s.connectionHealth?.wsHealthy ? 'ws=healthy' : 'ws=down';
    const subscriptionLabel = s.connectionHealth?.subscriptionHealthy ? 'subscription=healthy' : 'subscription=down';
    lines.push(`  ${s.name.padEnd(24)} ${busyLabel.padEnd(6)} ${runtimeLabel.padEnd(20)} ${wsLabel} ${subscriptionLabel}`);
  }

  return ['NAME                     BUSY   RUNTIME              CONNECTION', ...lines, ''].join('\n');
}

export function renderTuiOverview(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return 'No sessions found.\n';
  }

  const lines: string[] = [];
  for (const s of sessions) {
    const runtimeLabel = s.runtimeState ?? (s.status === 'attached' ? 'attached_terminal' : 'cold');
    const queueLabel = String(s.queueLength ?? 0).padEnd(5);
    const markers: string[] = [];
    if (s.status === 'approval_pending') markers.push('[APPROVAL]');
    if (s.status === 'attached') markers.push('[ATTACHED]');
    if (s.runtimeState === 'recovering') markers.push('[RECOVERING]');
    if (s.bindingKind) markers.push(`[${s.bindingKind}]`);
    const markerLabel = markers.join(' ');
    lines.push(`  ${s.name.padEnd(24)} ${runtimeLabel.padEnd(20)} ${queueLabel} ${markerLabel}`.trimEnd());
  }

  return ['NAME                     RUNTIME              QUEUE FLAGS', ...lines, ''].join('\n');
}

/**
 * Render a list of sessions as a formatted string for terminal display.
 */
export function renderSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return 'No sessions found.\n';
  }

  const lines: string[] = [];
  for (const s of sessions) {
    const statusLabel = STATUS_LABELS[s.status] ?? s.status;
    const runtimeLabel = s.runtimeState ?? (s.status === 'attached' ? 'attached_terminal' : 'cold');
    lines.push(`  ${s.name.padEnd(24)} ${statusLabel.padEnd(20)} ${runtimeLabel.padEnd(20)} ${s.workdir}`);
  }

  return ['NAME                     STATUS               RUNTIME              WORKDIR', ...lines, ''].join('\n');
}
