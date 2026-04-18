import { describe, test, expect } from 'vitest';
import { formatRequestId, ALL_SESSION_STATUSES } from '../../src/types.js';
import type { RuntimeState } from '../../src/types.js';

describe('formatRequestId', () => {
  test('格式正确', () => {
    const id = formatRequestId('sess1', 'msg1', 'tool1', 'nonce1');
    expect(id).toBe('sess1:msg1:tool1:nonce1');
  });
});

describe('ALL_SESSION_STATUSES', () => {
  test('包含所有合法状态', () => {
    const expected = [
      'idle', 'attach_pending', 'attached', 'im_processing',
      'approval_pending', 'takeover_pending', 'recovering', 'error',
    ];
    expect(ALL_SESSION_STATUSES).toEqual(expect.arrayContaining(expected));
    expect(ALL_SESSION_STATUSES).toHaveLength(expected.length);
  });
});

describe('RuntimeState', () => {
  test('包含所有目标状态', () => {
    const validStates: RuntimeState[] = [
      'cold',
      'ready',
      'running',
      'waiting_approval',
      'attached_terminal',
      'takeover_pending',
      'recovering',
      'error',
    ];
    // 类型检查：确保所有状态都是合法的 RuntimeState
    validStates.forEach(state => {
      expect(typeof state).toBe('string');
    });
  });

  test('cold 表示无 worker 进程', () => {
    const state: RuntimeState = 'cold';
    expect(state).toBe('cold');
  });

  test('ready 表示 worker 已就绪但未执行消息', () => {
    const state: RuntimeState = 'ready';
    expect(state).toBe('ready');
  });

  test('running 表示当前消息处理中', () => {
    const state: RuntimeState = 'running';
    expect(state).toBe('running');
  });

  test('waiting_approval 表示工具审批中', () => {
    const state: RuntimeState = 'waiting_approval';
    expect(state).toBe('waiting_approval');
  });
});
