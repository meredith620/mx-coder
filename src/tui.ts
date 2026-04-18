import type { SessionStatus, RuntimeState } from './types.js';

export interface SessionSummary {
  name: string;
  status: SessionStatus;
  workdir: string;
  lastActivityAt: Date;
  runtimeState?: RuntimeState;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: 'idle',
  attach_pending: 'attach_pending',
  attached: 'attached',
  im_processing: 'im_processing',
  approval_pending: 'approval_pending',
  takeover_pending: 'takeover_pending',
  recovering: 'recovering',
  error: 'error',
};

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
