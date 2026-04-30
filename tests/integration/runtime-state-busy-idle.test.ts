import { describe, test, expect } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';
import { renderTuiDiagnostics } from '../../src/tui.js';

describe('S4.1: runtime state busy/idle consistency', () => {
  test('busy 派生覆盖 running / waiting_approval / attached_terminal / takeover_pending / recovering', () => {
    const output = renderTuiDiagnostics([
      { name: 's-running', status: 'im_processing', runtimeState: 'running', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 's-approval', status: 'approval_pending', runtimeState: 'waiting_approval', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 's-attached', status: 'attached', runtimeState: 'attached_terminal', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 's-takeover', status: 'takeover_pending', runtimeState: 'takeover_pending', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 's-recovering', status: 'idle', runtimeState: 'recovering', workdir: '/tmp', lastActivityAt: new Date() },
    ] as any);

    expect(output).toContain('s-running');
    expect(output).toContain('s-approval');
    expect(output).toContain('s-attached');
    expect(output).toContain('s-takeover');
    expect(output).toContain('s-recovering');
    expect(output.match(/busy/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  test('idle 派生覆盖 cold / ready', () => {
    const output = renderTuiDiagnostics([
      { name: 's-cold', status: 'idle', runtimeState: 'cold', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 's-ready', status: 'idle', runtimeState: 'ready', workdir: '/tmp', lastActivityAt: new Date() },
    ] as any);

    expect(output).toContain('s-cold');
    expect(output).toContain('s-ready');
    expect(output.match(/idle/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('IM turn 完成后 activeMessageId 清空，但保留 lastTurnOutcome / lastResultAt', () => {
    const registry = new SessionRegistry();
    registry.create('turn-finished', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const session = registry.get('turn-finished')! as any;

    session.activeMessageId = 'msg-finished';
    session.lastTurnOutcome = 'completed';
    session.lastResultAt = '2026-04-28T00:00:00.000Z';
    delete session.activeMessageId;

    expect(session.activeMessageId).toBeUndefined();
    expect(session.lastTurnOutcome).toBe('completed');
    expect(session.lastResultAt).toBe('2026-04-28T00:00:00.000Z');
  });

  test('中断 turn 可记录 interruptReason', () => {
    const registry = new SessionRegistry();
    registry.create('turn-interrupted', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const session = registry.get('turn-interrupted')! as any;

    session.lastTurnOutcome = 'interrupted';
    session.interruptReason = 'worker_crash';

    expect(session.lastTurnOutcome).toBe('interrupted');
    expect(session.interruptReason).toBe('worker_crash');
  });
});
