import { describe, test, expect } from 'vitest';
import { renderSessionList } from '../../src/tui.js';

describe('TUI 渲染器', () => {
  test('renderSessionList 正确格式化 session 信息', () => {
    const output = renderSessionList([
      { name: 'bug-fix', status: 'idle', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'cold' },
      { name: 'review', status: 'im_processing', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'running' },
    ] as any);
    expect(output).toContain('bug-fix');
    expect(output).toContain('idle');
    expect(output).toContain('cold');
    expect(output).toContain('im_processing');
    expect(output).toContain('running');
    expect(output).toContain('review');
  });

  test('renderSessionList 空列表返回提示文本', () => {
    const output = renderSessionList([]);
    expect(output).toBeTruthy();
    expect(typeof output).toBe('string');
  });

  test('approval_pending 状态在输出中可识别', () => {
    const output = renderSessionList([
      { name: 'sess1', status: 'approval_pending', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'waiting_approval' },
    ] as any);
    expect(output).toContain('approval_pending');
    expect(output).toContain('waiting_approval');
    expect(output).toContain('sess1');
  });

  test('attached 状态在输出中可识别', () => {
    const output = renderSessionList([
      { name: 'sess2', status: 'attached', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'attached_terminal' },
    ] as any);
    expect(output).toContain('attached');
    expect(output).toContain('attached_terminal');
  });

  test('recovering 与 error 状态在输出中可识别', () => {
    const output = renderSessionList([
      { name: 'sess3', status: 'recovering', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'recovering' },
      { name: 'sess4', status: 'error', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'error' },
    ] as any);
    expect(output).toContain('recovering');
    expect(output).toContain('error');
  });
});
