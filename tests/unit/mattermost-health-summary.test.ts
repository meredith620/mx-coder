import { describe, test, expect } from 'vitest';
import { renderTuiDiagnostics, createTuiStateStore } from '../../src/tui.js';

describe('S5.1: Mattermost health summary surfaces', () => {
  test('renderTuiDiagnostics 展示 ws/subscription 健康摘要', () => {
    const output = renderTuiDiagnostics([
      {
        name: 'mm-thread',
        status: 'idle',
        runtimeState: 'ready',
        workdir: '/tmp',
        lastActivityAt: new Date(),
        connectionHealth: { wsHealthy: true, subscriptionHealthy: false },
      },
    ] as any);

    expect(output).toContain('mm-thread');
    expect(output).toContain('ws=healthy');
    expect(output).toContain('subscription=down');
  });

  test('无 IM 健康摘要时 renderTuiDiagnostics 仍稳定', () => {
    const output = renderTuiDiagnostics([
      {
        name: 'no-im',
        status: 'idle',
        runtimeState: 'cold',
        workdir: '/tmp',
        lastActivityAt: new Date(),
      },
    ] as any);

    expect(output).toContain('no-im');
    expect(output).toContain('ws=down');
    expect(output).toContain('subscription=down');
  });

  test('state store 接收 session_state_changed 时保留 connectionHealth 字段', () => {
    const store = createTuiStateStore();
    store.applyEvent({
      event: 'session_state_changed',
      data: {
        name: 'health-store',
        status: 'idle',
        runtimeState: 'ready',
        workdir: '/tmp',
        lastActivityAt: new Date().toISOString(),
        connectionHealth: {
          wsHealthy: true,
          subscriptionHealthy: true,
        },
      },
    } as any);

    const session = store.list()[0]!;
    expect(session.connectionHealth).toEqual({ wsHealthy: true, subscriptionHealthy: true });
  });
});
