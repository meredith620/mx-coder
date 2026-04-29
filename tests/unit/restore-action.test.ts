import { describe, test, expect } from 'vitest';
import { determineRestoreAction } from '../../src/restore-action.js';

describe('restore action', () => {
  test('低风险且无审批上下文时返回 replay', () => {
    const result = determineRestoreAction({
      messageId: 'm1',
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      status: 'pending',
      correlationId: 'c1',
      dedupeKey: 'd1',
      enqueuePolicy: 'auto_after_detach',
    } as any, {
      hasApprovalContext: false,
      isHighRisk: false,
    });

    expect(result).toBe('replay');
  });

  test('带审批上下文时返回 confirm', () => {
    const result = determineRestoreAction({
      messageId: 'm2',
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      status: 'pending',
      correlationId: 'c2',
      dedupeKey: 'd2',
      enqueuePolicy: 'auto_after_detach',
      approvalState: 'pending',
    } as any, {
      hasApprovalContext: true,
      isHighRisk: false,
    });

    expect(result).toBe('confirm');
  });

  test('高风险且无审批上下文时返回 discard', () => {
    const result = determineRestoreAction({
      messageId: 'm3',
      threadId: 't1',
      userId: 'u1',
      content: 'rm -rf /tmp/x',
      status: 'pending',
      correlationId: 'c3',
      dedupeKey: 'd3',
      enqueuePolicy: 'auto_after_detach',
    } as any, {
      hasApprovalContext: false,
      isHighRisk: true,
    });

    expect(result).toBe('discard');
  });
});
