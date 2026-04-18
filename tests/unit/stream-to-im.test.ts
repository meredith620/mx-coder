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
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'Hello' }] } } as any);
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: ' World' }] } } as any);

    vi.advanceTimersByTime(499);
    expect(mockIM.liveMessages.size).toBe(1);
    const msgId = [...mockIM.liveMessages.keys()][0];
    expect(mockIM.liveMessages.get(msgId)).toBe('Hello');

    vi.advanceTimersByTime(1);
    expect(mockIM.liveMessages.get(msgId)).toBe('Hello World');
  });

  test('result 事件立即 flush（不等防抖）', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'Hello' }] } } as any);
    const msgId = [...mockIM.liveMessages.keys()][0];

    await handler.onEvent({ type: 'result', messageId: 'turn-1', subtype: 'success', result: 'Done' } as any);
    expect(mockIM.liveMessages.get(msgId)).toBe('Hello');
  });

  test('首个 assistant 事件调用 createLiveMessage', async () => {
    expect(mockIM.liveMessages.size).toBe(0);
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'Hi' }] } } as any);
    expect(mockIM.liveMessages.size).toBe(1);
  });

  test('多个 assistant 事件只调用一次 createLiveMessage', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'A' }] } } as any);
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'B' }] } } as any);
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'C' }] } } as any);
    expect(mockIM.liveMessages.size).toBe(1);
  });

  test('createLiveMessage 使用构造时传入的 thread target', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'Hi' }] } } as any);
    const msgId = [...mockIM.liveMessages.keys()][0];
    expect(mockIM.liveMessageTargets.get(msgId)?.threadId).toBe('t1');
  });

  test('兼容 Claude 实际 assistant.message.content 结构', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'Hi from payload shape' }] } } as any);
    expect(mockIM.liveMessages.size).toBe(1);
    const msgId = [...mockIM.liveMessages.keys()][0];
    expect(mockIM.liveMessages.get(msgId)).toBe('Hi from payload shape');
  });

  test('error 事件立即 flush', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'partial' }] } } as any);
    const msgId = [...mockIM.liveMessages.keys()][0];

    await handler.onEvent({ type: 'error', messageId: 'turn-1', payload: { message: 'something went wrong' } } as any);
    expect(mockIM.liveMessages.get(msgId)).toBe('partial');
  });

  test('第二轮 assistant 不会串到第一轮 live message', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'one' }] } } as any);
    const firstMsgId = [...mockIM.liveMessages.keys()][0];
    await handler.onEvent({ type: 'result', messageId: 'turn-1', subtype: 'success', result: 'done-1' } as any);

    await handler.onEvent({ type: 'assistant', messageId: 'turn-2', payload: { content: [{ type: 'text', text: 'two' }] } } as any);
    const ids = [...mockIM.liveMessages.keys()];

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(firstMsgId);
    expect(mockIM.liveMessages.get(ids[0])).toBe('one');
    expect(mockIM.liveMessages.get(ids[1])).toBe('two');
  });

  test('未知和跨轮事件不会破坏当前轮缓冲', async () => {
    await handler.onEvent({ type: 'assistant', messageId: 'turn-1', payload: { content: [{ type: 'text', text: 'hello' }] } } as any);
    const firstMsgId = [...mockIM.liveMessages.keys()][0];

    await handler.onEvent({ type: 'attachment', messageId: 'turn-1', payload: { file: 'a.txt' } } as any);
    await handler.onEvent({ type: 'queue-operation', messageId: 'turn-1', payload: { op: 'enqueue' } } as any);
    await handler.onEvent({ type: 'result', messageId: 'turn-1', subtype: 'success', result: 'done' } as any);

    expect(mockIM.liveMessages.get(firstMsgId)).toBe('hello');
  });
});
