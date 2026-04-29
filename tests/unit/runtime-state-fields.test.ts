import { describe, test, expect } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';

describe('S4.1: busy/idle 三层模型落地', () => {
  test('Session 可承载执行补充字段真值', () => {
    const registry = new SessionRegistry();
    registry.create('runtime-fields', { workdir: '/tmp', cliPlugin: 'claude-code' });
    const session = registry.get('runtime-fields')! as any;

    session.activeMessageId = 'msg-1';
    session.lastTurnOutcome = 'completed';
    session.interruptReason = 'takeover';
    session.lastResultAt = '2026-04-27T00:00:00.000Z';

    expect(session.activeMessageId).toBe('msg-1');
    expect(session.lastTurnOutcome).toBe('completed');
    expect(session.interruptReason).toBe('takeover');
    expect(session.lastResultAt).toBe('2026-04-27T00:00:00.000Z');
  });
});
