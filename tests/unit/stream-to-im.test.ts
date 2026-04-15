import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamToIM } from '../../src/stream-to-im.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';

describe('StreamToIM — 流式输出防抖', () => {
  let mockIM: MockIMPlugin;
  let handler: StreamToIM;

  beforeEach(() => {
    vi.useFakeTimers();
    mockIM = new MockIMPlugin();
    handler = new StreamToIM(mockIM, { plugin: 'mock', threadId: 't1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('500ms 内多次 token 合并为一次 updateMessage', async () => {
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Hello' }] } } });
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: ' World' }] } } });

    vi.advanceTimersByTime(499);
    expect(mockIM.liveMessages.size).toBe(1); // createLiveMessage called
    const msgId = [...mockIM.liveMessages.keys()][0];
    // 还没 flush
    expect(mockIM.liveMessages.get(msgId)).toBe('Hello'); // only first token so far

    vi.advanceTimersByTime(1);
    // 防抖触发，updateMessage 应该被调用
    expect(mockIM.liveMessages.get(msgId)).toBe('Hello World');
  });

  test('result 事件立即 flush（不等防抖）', async () => {
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Hello' }] } } });
    const msgId = [...mockIM.liveMessages.keys()][0];

    await handler.onEvent({ type: 'result', payload: { subtype: 'success', result: 'Done' } });
    // result 应立即 flush，不需要 advanceTimersByTime
    expect(mockIM.liveMessages.get(msgId)).toBe('Hello');
  });

  test('首个 assistant 事件调用 createLiveMessage', async () => {
    expect(mockIM.liveMessages.size).toBe(0);
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Hi' }] } } });
    expect(mockIM.liveMessages.size).toBe(1);
  });

  test('多个 assistant 事件只调用一次 createLiveMessage', async () => {
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'A' }] } } });
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'B' }] } } });
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'C' }] } } });
    expect(mockIM.liveMessages.size).toBe(1);
  });

  test('createLiveMessage 使用构造时传入的 thread target', async () => {
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Hi' }] } } });
    const msgId = [...mockIM.liveMessages.keys()][0];
    expect(mockIM.liveMessageTargets.get(msgId)?.threadId).toBe('t1');
  });

  test('error 事件立即 flush', async () => {
    await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'partial' }] } } });
    const msgId = [...mockIM.liveMessages.keys()][0];

    await handler.onEvent({ type: 'error', payload: { message: 'something went wrong' } });
    expect(mockIM.liveMessages.get(msgId)).toBe('partial');
  });
});
