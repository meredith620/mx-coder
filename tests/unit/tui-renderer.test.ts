import { describe, test, expect } from 'vitest';
import { renderSessionList } from '../../src/tui.js';

describe('TUI 渲染器', () => {
  test('renderSessionList 正确格式化 session 信息', () => {
    const output = renderSessionList([
      { name: 'bug-fix', status: 'idle', workdir: '/tmp', lastActivityAt: new Date() },
      { name: 'review', status: 'im_processing', workdir: '/tmp', lastActivityAt: new Date() },
    ]);
    expect(output).toContain('bug-fix');
    expect(output).toContain('idle');
    expect(output).toContain('im_processing');
    expect(output).toContain('review');
  });

  test('renderSessionList 空列表返回提示文本', () => {
    const output = renderSessionList([]);
    expect(output).toBeTruthy();
    expect(typeof output).toBe('string');
  });

  test('approval_pending 状态在输出中可识别', () => {
    const output = renderSessionList([
      { name: 'sess1', status: 'approval_pending', workdir: '/tmp', lastActivityAt: new Date() },
    ]);
    expect(output).toContain('approval_pending');
    expect(output).toContain('sess1');
  });

  test('attached 状态在输出中可识别', () => {
    const output = renderSessionList([
      { name: 'sess2', status: 'attached', workdir: '/tmp', lastActivityAt: new Date() },
    ]);
    expect(output).toContain('attached');
  });
});
