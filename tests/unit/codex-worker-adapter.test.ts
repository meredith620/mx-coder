import type { ChildProcess } from 'child_process';
import { describe, test, expect, vi } from 'vitest';
import {
  CodexResidentBridge,
  extractPromptFromWorkerInput,
  normalizeCodexExecEvent,
} from '../../src/plugins/cli/codex-worker-adapter.js';

describe('codex-worker-adapter', () => {
  test('extractPromptFromWorkerInput 读取 mx-coder worker JSONL 中的用户文本', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello codex' }],
      },
    });

    expect(extractPromptFromWorkerInput(line)).toBe('hello codex');
  });

  test('normalizeCodexExecEvent 将 thread.started 映射为 system session_id', () => {
    const event = normalizeCodexExecEvent({
      method: 'thread.started',
      params: {
        thread: {
          id: '123e4567-e89b-12d3-a456-426614174000',
        },
      },
    }, 'result-1');

    expect(event).toEqual({
      type: 'system',
      message: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        session_id: '123e4567-e89b-12d3-a456-426614174000',
        thread_id: '123e4567-e89b-12d3-a456-426614174000',
        tools: [],
        payload: {
          id: '123e4567-e89b-12d3-a456-426614174000',
        },
      },
    });
  });

  test('normalizeCodexExecEvent 将 item.completed 的 agent_message 映射为 assistant 文本块', () => {
    const event = normalizeCodexExecEvent({
      method: 'item.completed',
      params: {
        turnId: 'turn-1',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'done',
        },
      },
    }, 'result-1');

    expect(event).toEqual({
      type: 'assistant',
      message: {
        id: 'turn-1',
        content: [{ type: 'text', text: 'done' }],
      },
    });
  });

  test('normalizeCodexExecEvent 将 turn.completed 映射为 result 边界', () => {
    const event = normalizeCodexExecEvent({
      method: 'turn.completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
        },
      },
    }, 'result-1');

    expect(event).toEqual({
      type: 'result',
      message: { id: 'turn-1' },
      subtype: 'success',
      is_error: false,
      result: '',
    });
  });

  test('normalizeCodexExecEvent 将 turn.failed 映射为 error result', () => {
    const event = normalizeCodexExecEvent({
      method: 'turn.failed',
      params: {
        turnId: 'turn-err',
        error: { message: 'boom' },
      },
    }, 'result-1');

    expect(event).toEqual({
      type: 'result',
      message: { id: 'turn-err' },
      subtype: 'error',
      is_error: true,
      result: 'boom',
    });
  });

  test('resident bridge 先启动 backend，再用 thread/resume / thread/start / turn/start 驱动 turn', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let notificationHandler: ((msg: { method: string; params?: Record<string, unknown> }) => void) | null = null;
    const transport = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'initialize') {
          return {};
        }
        if (method === 'thread/resume') {
          throw new Error('thread not found');
        }
        if (method === 'thread/start') {
          return { thread: { id: 'thr_123' } };
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn_456', status: 'inProgress' } };
        }
        return {};
      }),
      notify: vi.fn((method: string, params?: Record<string, unknown>) => {
        notifications.push({ method, params });
      }),
      onNotification: vi.fn((handler: (msg: { method: string; params?: Record<string, unknown> }) => void) => {
        notificationHandler = handler;
      }),
      close: vi.fn(async () => {}),
    };

    const bridge = new CodexResidentBridge(
      { sessionId: 'session-uuid', workdir: '/tmp/workdir' },
      {
        spawnAppServer: vi.fn(() => ({ pid: 123 } as unknown as ChildProcess)),
        connectTransport: vi.fn(async () => transport),
        createSocketPath: () => '/tmp/codex.sock',
        writeStdout: (line) => stdout.push(line.trim()),
        writeStderr: (line) => stderr.push(line.trim()),
      },
    );

    const run = bridge.processPrompt('hello codex');
    await new Promise((resolve) => setImmediate(resolve));

    expect(requests.map((req) => req.method)).toEqual([
      'initialize',
      'thread/resume',
      'thread/start',
      'turn/start',
    ]);
    expect(notifications).toEqual([
      { method: 'notifications/initialized', params: {} },
    ]);

    notificationHandler?.({
      method: 'item.completed',
      params: {
        turnId: 'turn_456',
        item: { id: 'item_1', type: 'agent_message', text: 'hello back' },
      },
    });
    notificationHandler?.({
      method: 'turn.completed',
      params: {
        turn: { id: 'turn_456', status: 'completed' },
      },
    });

    await run;

    expect(stdout).toContainEqual(expect.stringContaining('"type":"system"'));
    expect(stdout).toContainEqual(expect.stringContaining('"type":"assistant"'));
    expect(stdout).toContainEqual(expect.stringContaining('"type":"result"'));
    expect(stderr).toEqual([]);

    requests.length = 0;
    const secondRun = bridge.processPrompt('second codex turn');
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests.map((req) => req.method)).toEqual([
      'turn/start',
    ]);

    notificationHandler?.({
      method: 'turn.completed',
      params: {
        turn: { id: 'turn_456', status: 'completed' },
      },
    });

    await secondRun;
  });

  test('resident bridge 在 turn.failed 时向上抛出失败并仍归一化为 result error', async () => {
    const stdout: string[] = [];
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let notificationHandler: ((msg: { method: string; params?: Record<string, unknown> }) => void) | null = null;
    const transport = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'initialize') return {};
        if (method === 'thread/resume') {
          throw new Error('thread not found');
        }
        if (method === 'thread/start') {
          return { thread: { id: 'thr_999' } };
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn_999', status: 'inProgress' } };
        }
        return {};
      }),
      notify: vi.fn(),
      onNotification: vi.fn((handler: (msg: { method: string; params?: Record<string, unknown> }) => void) => {
        notificationHandler = handler;
      }),
      close: vi.fn(async () => {}),
    };

    const bridge = new CodexResidentBridge(
      { sessionId: 'session-fail', workdir: '/tmp/workdir' },
      {
        spawnAppServer: vi.fn(() => ({ pid: 124 } as unknown as ChildProcess)),
        connectTransport: vi.fn(async () => transport),
        createSocketPath: () => '/tmp/codex-fail.sock',
        writeStdout: (line) => stdout.push(line.trim()),
        writeStderr: vi.fn(),
      },
    );

    const run = bridge.processPrompt('fail please');
    await new Promise((resolve) => setImmediate(resolve));
    notificationHandler?.({
      method: 'turn.failed',
      params: {
        turnId: 'turn_999',
        error: { message: 'boom' },
      },
    });

    await expect(run).rejects.toThrow('boom');
    expect(stdout).toContainEqual(expect.stringContaining('"type":"result"'));
    expect(requests.map((req) => req.method)).toEqual([
      'initialize',
      'thread/resume',
      'thread/start',
      'turn/start',
    ]);
  });
});
