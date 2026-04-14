import { describe, test, expect } from 'vitest';
import { formatRequestId, ALL_SESSION_STATUSES } from '../../src/types.js';

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
