import { describe, test, expect } from 'vitest';
import { renderSessionList, renderTuiOverview, renderTuiDiagnostics } from '../../src/tui.js';

describe('S4.2: runtimeState 文案统一', () => {
  test('renderSessionList 优先展示 runtimeState，而不是把旧 status 当运行态文案', () => {
    const output = renderSessionList([
      { name: 'sess-runtime', status: 'approval_pending', runtimeState: 'waiting_approval', workdir: '/tmp', lastActivityAt: new Date() },
    ] as any);

    expect(output).toContain('approval_pending');
    expect(output).toContain('waiting_approval');
    expect(output).not.toContain('runtime=recovering');
  });

  test('renderTuiOverview 对外统一使用 runtimeState 术语', () => {
    const output = renderTuiOverview([
      { name: 'sess-cold', status: 'idle', runtimeState: 'cold', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
      { name: 'sess-ready', status: 'idle', runtimeState: 'ready', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
      { name: 'sess-running', status: 'im_processing', runtimeState: 'running', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 1 },
      { name: 'sess-wait', status: 'approval_pending', runtimeState: 'waiting_approval', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 1 },
      { name: 'sess-attached', status: 'attached', runtimeState: 'attached_terminal', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
      { name: 'sess-takeover', status: 'takeover_pending', runtimeState: 'takeover_pending', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
      { name: 'sess-recover', status: 'idle', runtimeState: 'recovering', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
      { name: 'sess-error', status: 'error', runtimeState: 'error', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
    ] as any);

    for (const runtimeLabel of ['cold', 'ready', 'running', 'waiting_approval', 'attached_terminal', 'takeover_pending', 'recovering', 'error']) {
      expect(output).toContain(runtimeLabel);
    }
  });

  test('renderTuiDiagnostics busy/idle 文案基于 runtimeState 统一派生', () => {
    const output = renderTuiDiagnostics([
      { name: 'busy-runtime', status: 'attached', runtimeState: 'attached_terminal', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 'idle-runtime', status: 'idle', runtimeState: 'ready', workdir: '/tmp', lastActivityAt: new Date() },
    ] as any);

    expect(output).toContain('busy-runtime');
    expect(output).toContain('attached_terminal');
    expect(output).toContain('busy');
    expect(output).toContain('idle-runtime');
    expect(output).toContain('ready');
    expect(output).toContain('idle');
  });
});
