import { describe, test, expect } from 'vitest';
import { renderSessionList, createTuiStateStore, renderTuiOverview, renderTuiDiagnostics } from '../../src/tui.js';

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


  test('state store 可根据 session_state_changed 更新本地快照', () => {
    const store = createTuiStateStore([
      { name: 'demo', status: 'idle', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'cold' } as any,
    ]);

    store.applyEvent({
      event: 'session_state_changed',
      data: {
        name: 'demo',
        status: 'im_processing',
        runtimeState: 'running',
        workdir: '/tmp',
        lastActivityAt: new Date().toISOString(),
      },
    });

    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('demo');
    expect(sessions[0].status).toBe('im_processing');
    expect(sessions[0].runtimeState).toBe('running');
  });



  test('renderTuiOverview 显示 session 实际空间类型', () => {
    const output = renderTuiOverview([
      {
        name: 'thread-sess',
        status: 'idle',
        runtimeState: 'ready',
        workdir: '/tmp/a',
        lastActivityAt: new Date(),
        queueLength: 0,
        bindingKind: 'thread',
      },
      {
        name: 'channel-sess',
        status: 'idle',
        runtimeState: 'ready',
        workdir: '/tmp/b',
        lastActivityAt: new Date(),
        queueLength: 0,
        bindingKind: 'channel',
      },
    ] as any);

    expect(output).toContain('thread');
    expect(output).toContain('channel');
  });


  test('renderTuiDiagnostics 显示 busy/idle 派生与 Mattermost 健康摘要', () => {
    const output = renderTuiDiagnostics([
      {
        name: 'busy-session',
        status: 'im_processing',
        runtimeState: 'running',
        workdir: '/tmp/a',
        lastActivityAt: new Date(),
        queueLength: 1,
        connectionHealth: { wsHealthy: true, subscriptionHealthy: true },
      },
      {
        name: 'idle-session',
        status: 'idle',
        runtimeState: 'ready',
        workdir: '/tmp/b',
        lastActivityAt: new Date(),
        queueLength: 0,
        connectionHealth: { wsHealthy: false, subscriptionHealthy: false },
      },
    ] as any);

    expect(output).toContain('busy-session');
    expect(output).toContain('busy');
    expect(output).toContain('idle-session');
    expect(output).toContain('idle');
    expect(output).toContain('ws=healthy');
    expect(output).toContain('subscription=healthy');
    expect(output).toContain('ws=down');
    expect(output).toContain('subscription=down');
  });

  test('state store 连续多次事件更新后保持最新状态', () => {
    const store = createTuiStateStore([
      { name: 'sess-a', status: 'idle', workdir: '/tmp', lastActivityAt: new Date(), runtimeState: 'cold' } as any,
    ]);

    store.applyEvent({
      event: 'session_state_changed',
      data: { name: 'sess-a', status: 'im_processing', runtimeState: 'running', workdir: '/tmp', lastActivityAt: new Date().toISOString() },
    });

    store.applyEvent({
      event: 'session_state_changed',
      data: { name: 'sess-a', status: 'approval_pending', runtimeState: 'waiting_approval', workdir: '/tmp', lastActivityAt: new Date().toISOString() },
    });

    store.applyEvent({
      event: 'session_state_changed',
      data: { name: 'sess-a', status: 'idle', runtimeState: 'ready', workdir: '/tmp', lastActivityAt: new Date().toISOString() },
    });

    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('idle');
    expect(sessions[0].runtimeState).toBe('ready');
  });

  test('state store 新增 session 事件能正确添加到列表', () => {
    const store = createTuiStateStore();

    store.applyEvent({
      event: 'session_state_changed',
      data: { name: 'new-sess', status: 'idle', runtimeState: 'cold', workdir: '/tmp/new', lastActivityAt: new Date().toISOString() },
    });

    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('new-sess');
    expect(sessions[0].status).toBe('idle');
  });

  test('state store 更新事件时保留 connection health 摘要', () => {
    const store = createTuiStateStore();

    store.applyEvent({
      event: 'session_state_changed',
      data: {
        name: 'diag',
        status: 'idle',
        runtimeState: 'ready',
        workdir: '/tmp',
        queueLength: 0,
        connectionHealth: {
          wsHealthy: true,
          subscriptionHealthy: false,
        },
        lastActivityAt: new Date().toISOString(),
      },
    });

    const sessions = store.list();
    expect(sessions[0].connectionHealth).toEqual({ wsHealthy: true, subscriptionHealthy: false });
  });
});
