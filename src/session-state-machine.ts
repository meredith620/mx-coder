import type { SessionStatus } from './types.js';

export type StateEvent =
  | 'attach_start'
  | 'im_message_completed_and_worker_stopped'
  | 'attach_cancelled'
  | 'im_message_received'
  | 'attach_exit_normal'
  | 'takeover_requested'
  | 'takeover_cancelled'
  | 'terminal_sigterm_exited'
  | 'tool_permission_required'
  | 'approval_approved'
  | 'approval_denied'
  | 'approval_timeout_or_restart'
  | 'message_completed'
  | 'worker_crash'
  | 'worker_restarted'
  | 'restart_failed_over_limit'
  | 'manual_reset';

export const INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION';

// Direct encoding of SPEC §3.6 transition table
export const TRANSITION_TABLE: Record<SessionStatus, Partial<Record<StateEvent, SessionStatus>>> = {
  idle: {
    attach_start:         'attached',
    im_message_received:  'im_processing',
  },
  attach_pending: {
    im_message_completed_and_worker_stopped: 'attached',
    attach_cancelled:     'idle',
  },
  attached: {
    attach_exit_normal:   'idle',
    takeover_requested:   'takeover_pending',
  },
  im_processing: {
    attach_start:         'attach_pending',
    tool_permission_required: 'approval_pending',
    message_completed:    'idle',
    worker_crash:         'recovering',
  },
  approval_pending: {
    approval_approved:    'im_processing',
    approval_denied:      'im_processing',
    approval_timeout_or_restart: 'idle',
    attach_start:         'attach_pending',
    worker_crash:         'recovering',
  },
  takeover_pending: {
    terminal_sigterm_exited: 'idle',
    takeover_cancelled: 'attached',
  },
  recovering: {
    worker_restarted:     'idle',
    restart_failed_over_limit: 'error',
  },
  error: {
    manual_reset:         'idle',
  },
};

export class SessionStateMachine {
  current: SessionStatus;

  constructor(initial: SessionStatus) {
    this.current = initial;
  }

  canTransition(event: StateEvent): boolean {
    return event in TRANSITION_TABLE[this.current];
  }

  transition(event: StateEvent): void {
    const next = TRANSITION_TABLE[this.current][event];
    if (next === undefined) {
      throw new Error(INVALID_STATE_TRANSITION);
    }
    this.current = next;
  }
}
