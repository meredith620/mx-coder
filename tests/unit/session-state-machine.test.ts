import { describe, test, expect } from 'vitest';
import { SessionStateMachine, INVALID_STATE_TRANSITION } from '../../src/session-state-machine.js';
import type { StateEvent } from '../../src/session-state-machine.js';
import type { SessionStatus } from '../../src/types.js';

describe('SessionStateMachine', () => {
  test('idle + attach_start → attached', () => {
    const sm = new SessionStateMachine('idle');
    sm.transition('attach_start');
    expect(sm.current).toBe('attached');
  });

  test('im_processing + attach_start → attach_pending', () => {
    const sm = new SessionStateMachine('im_processing');
    sm.transition('attach_start');
    expect(sm.current).toBe('attach_pending');
  });

  test('非法迁移抛出 INVALID_STATE_TRANSITION', () => {
    const sm = new SessionStateMachine('idle');
    expect(() => sm.transition('approval_approved'))
      .toThrow(INVALID_STATE_TRANSITION);
  });

  test('非法迁移后状态保持不变', () => {
    const sm = new SessionStateMachine('idle');
    try { sm.transition('approval_approved'); } catch {}
    expect(sm.current).toBe('idle');
  });

  test('canTransition 合法事件返回 true', () => {
    const sm = new SessionStateMachine('idle');
    expect(sm.canTransition('attach_start')).toBe(true);
  });

  test('canTransition 非法事件返回 false', () => {
    const sm = new SessionStateMachine('idle');
    expect(sm.canTransition('approval_approved')).toBe(false);
  });

  // 覆盖 SPEC §3.6 中所有合法迁移行（共 19 行，新增 approval_pending 的两条迁移）
  test.each([
    ['idle',            'attach_start',                        'attached'],
    ['im_processing',   'attach_start',                        'attach_pending'],
    ['attach_pending',  'im_message_completed_and_worker_stopped', 'attached'],
    ['attach_pending',  'attach_cancelled',                    'idle'],
    ['idle',            'im_message_received',                 'im_processing'],
    ['attached',        'attach_exit_normal',                  'idle'],
    ['attached',        'takeover_requested',                  'takeover_pending'],
    ['takeover_pending','takeover_cancelled',                 'attached'],
    ['takeover_pending','terminal_sigterm_exited',             'idle'],
    ['im_processing',   'tool_permission_required',            'approval_pending'],
    ['approval_pending','approval_approved',                   'im_processing'],
    ['approval_pending','approval_denied',                     'im_processing'],
    ['approval_pending','approval_timeout_or_restart',         'idle'],
    ['approval_pending','attach_start',                        'attach_pending'],
    ['approval_pending','worker_crash',                        'recovering'],
    ['im_processing',   'message_completed',                   'idle'],
    ['im_processing',   'worker_crash',                        'recovering'],
    ['recovering',      'worker_restarted',                    'idle'],
    ['recovering',      'restart_failed_over_limit',           'error'],
    ['error',           'manual_reset',                        'idle'],
  ] as [SessionStatus, StateEvent, SessionStatus][])(
    '%s + %s → %s',
    (from, event, to) => {
      const sm = new SessionStateMachine(from);
      sm.transition(event);
      expect(sm.current).toBe(to);
    },
  );
});
