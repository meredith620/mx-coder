import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { ApprovalManager } from '../../src/approval-manager.js';
import type { PermissionConfig } from '../../src/types.js';

const config: PermissionConfig = {
  autoAllowCapabilities: ['read_only'],
  autoAskCapabilities: ['file_write'],
  autoDenyCapabilities: ['shell_dangerous'],
  autoDenyPatterns: ['Bash:rm -rf'],
  timeoutSeconds: 300,
};

describe('ApprovalManager — rule matching', () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    mgr = new ApprovalManager(config);
  });

  test('read_only 工具 autoAllow', async () => {
    const result = await mgr.applyRules('Read', { path: '/tmp/a.txt' }, 'read_only');
    expect(result).toBe('allow');
  });

  test('shell_dangerous 工具 autoDeny', async () => {
    const result = await mgr.applyRules('Bash', { command: 'ls' }, 'shell_dangerous');
    expect(result).toBe('deny');
  });

  test('autoDenyPatterns 兜底匹配', async () => {
    const result = await mgr.applyRules('Bash', { command: 'rm -rf /tmp/test' });
    expect(result).toBe('deny');
  });

  test('file_write 工具返回 ask', async () => {
    const result = await mgr.applyRules('Edit', { path: '/tmp/b.txt' }, 'file_write');
    expect(result).toBe('ask');
  });

  test('未知 capability 返回 ask', async () => {
    const result = await mgr.applyRules('UnknownTool', {});
    expect(result).toBe('ask');
  });
});

describe('ApprovalManager — pending/state machine', () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    mgr = new ApprovalManager(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('createPendingApproval 返回含 requestId 的请求', async () => {
    const ctx = {
      sessionId: 'sess1',
      messageId: 'msg1',
      toolUseId: 'tool-use-1',
      correlationId: 'corr-1',
      capability: 'file_write' as const,
      operatorId: 'user-123',
    };
    const req = await mgr.createPendingApproval(ctx);
    expect(req.requestId).toContain('sess1');
    expect(req.requestId).toContain('msg1');
    expect(req.requestId).toContain('tool-use-1');
    expect(req.context.correlationId).toBe('corr-1');
  });

  test('decide approved 改变状态', async () => {
    const req = await mgr.createPendingApproval({
      sessionId: 's1', messageId: 'm1', toolUseId: 't1',
    });
    const result = await mgr.decide(req.requestId, { decision: 'approved', scope: 'once' });
    expect(result.status).toBe('approved');
    expect(mgr.getApprovalState(req.requestId)?.decision).toBe('approved');
  });

  test('decide denied 改变状态', async () => {
    const req = await mgr.createPendingApproval({
      sessionId: 's1', messageId: 'm1', toolUseId: 't1',
    });
    const result = await mgr.decide(req.requestId, { decision: 'denied', scope: 'once' });
    expect(result.status).toBe('denied');
  });

  test('新请求 cancel 同 session 旧 pending', async () => {
    const req1 = await mgr.createPendingApproval({ sessionId: 'sess1', messageId: 'msg1', toolUseId: 'tool1' });
    await mgr.createPendingApproval({ sessionId: 'sess1', messageId: 'msg2', toolUseId: 'tool2' });
    expect(mgr.getApprovalState(req1.requestId)?.decision).toBe('cancelled');
  });

  test('超时后状态变为 expired', async () => {
    vi.useFakeTimers();
    const req = await mgr.createPendingApproval(
      { sessionId: 'sess1', messageId: 'msg1', toolUseId: 'tool1' },
      { timeoutSeconds: 1 },
    );
    vi.advanceTimersByTime(1001);
    expect(mgr.getApprovalState(req.requestId)?.decision).toBe('expired');
  });

  test('审批结果不匹配 requestId 时标记 stale', async () => {
    const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });
    const wrongId = `${req.requestId}-wrong`;
    const result = await mgr.decide(wrongId, { decision: 'approved', scope: 'once' });
    expect(result.status).toBe('stale');
  });

  test('expirePendingOnRestart 批量 expire 所有 pending', async () => {
    await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });
    await mgr.createPendingApproval({ sessionId: 's2', messageId: 'm2', toolUseId: 't2' });
    mgr.expirePendingOnRestart();
    // Both should be expired (no more pending)
    const states = mgr.getAllApprovalStates();
    expect(states.every(s => s.decision !== 'pending')).toBe(true);
  });
});

describe('ApprovalManager — first-write-wins', () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    mgr = new ApprovalManager(config);
  });

  test('同一 session 并发审批时 first-write-wins', async () => {
    const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });

    const p1 = mgr.decide(req.requestId, { decision: 'approved', scope: 'once' });
    const p2 = mgr.decide(req.requestId, { decision: 'denied', scope: 'once' });

    const [r1, r2] = await Promise.all([p1, p2]);

    const decided = [r1.status, r2.status].filter(s => s === 'approved' || s === 'denied');
    const cancelled = [r1.status, r2.status].filter(s => s === 'cancelled');
    expect(decided).toHaveLength(1);
    expect(cancelled).toHaveLength(1);
  });

  test('多 approver 并发时 first-write-wins，其余标记 stale', async () => {
    const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });

    const p1 = mgr.decideByApprover(req.requestId, 'approver-1', { decision: 'approved', scope: 'once' });
    const p2 = mgr.decideByApprover(req.requestId, 'approver-2', { decision: 'approved', scope: 'once' });
    const p3 = mgr.decideByApprover(req.requestId, 'approver-3', { decision: 'denied', scope: 'once' });

    const results = await Promise.all([p1, p2, p3]);
    const winners = results.filter(r => r.status === 'approved' || r.status === 'denied');
    expect(winners).toHaveLength(1);
  });
});

describe('ApprovalManager — scope=session cache', () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    mgr = new ApprovalManager(config);
  });

  test('scope=session 时缓存键 = sessionId + operatorId + capability', async () => {
    const ctx = { sessionId: 's1', messageId: 'm1', toolUseId: 't1', operatorId: 'op1', capability: 'file_write' as const };
    const req = await mgr.createPendingApproval(ctx);
    await mgr.decide(req.requestId, { decision: 'approved', scope: 'session' });

    const result = await mgr.applyRules('Edit', { path: '/tmp/b.txt' }, 'file_write', { sessionId: 's1', operatorId: 'op1' });
    expect(result).toBe('allow');
  });

  test('scope=session 缓存在 session 结束时失效', async () => {
    const ctx = { sessionId: 's1', messageId: 'm1', toolUseId: 't1', operatorId: 'op1', capability: 'file_write' as const };
    const req = await mgr.createPendingApproval(ctx);
    await mgr.decide(req.requestId, { decision: 'approved', scope: 'session' });

    mgr.invalidateSessionCache('s1');

    const result = await mgr.applyRules('Edit', { path: '/tmp/b.txt' }, 'file_write', { sessionId: 's1', operatorId: 'op1' });
    expect(result).toBe('ask');
  });
});

describe('ApprovalManager — takeover priority', () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    mgr = new ApprovalManager(config);
  });

  test('approval_pending 收到 takeover 时先 cancel approval', async () => {
    const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });

    await mgr.cancelForTakeover('s1');

    const state = mgr.getApprovalState(req.requestId);
    expect(state?.decision).toBe('cancelled');
    expect(state?.cancelReason).toBe('takeover');
  });

  test('cancelForTakeover 不清理 session scope cache，由 completeTakeover/结束时失效', async () => {
    const ctx = { sessionId: 's-cache', messageId: 'm1', toolUseId: 't1', operatorId: 'op1', capability: 'file_write' as const };
    const req = await mgr.createPendingApproval(ctx);
    await mgr.decide(req.requestId, { decision: 'approved', scope: 'session' });

    await mgr.cancelForTakeover('s-cache');

    const result = await mgr.applyRules('Edit', { path: '/tmp/b.txt' }, 'file_write', { sessionId: 's-cache', operatorId: 'op1' });
    expect(result).toBe('allow');

    mgr.invalidateSessionCache('s-cache');
    const afterInvalidation = await mgr.applyRules('Edit', { path: '/tmp/b.txt' }, 'file_write', { sessionId: 's-cache', operatorId: 'op1' });
    expect(afterInvalidation).toBe('ask');
  });
});
