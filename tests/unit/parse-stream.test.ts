import { describe, test, expect } from 'vitest';
import { parseStream } from '../../src/plugins/cli/claude-code.js';
import type { CLIEvent, StreamCursor } from '../../src/types.js';
import { Readable } from 'stream';

function makeStream(lines: string[]): Readable {
  return Readable.from(lines.map(l => l + '\n'));
}

describe('parseStream', () => {
  test('基础事件解析：system/assistant/result', async () => {
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'result', message: { id: 'msg1' }, subtype: 'success', result: 'done' }),
    ]);
    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream)) {
      events.push(e);
    }
    expect(events.map(e => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(events[2].messageId).toBe('msg1');
  });

  test('result 事件是单轮完成边界，即使 worker 不退出也可继续下一轮', async () => {
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-1', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'result', message: { id: 'turn-1' }, subtype: 'success', result: 'done-1' }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-2', content: [{ type: 'text', text: 'again' }] } }),
      JSON.stringify({ type: 'result', message: { id: 'turn-2' }, subtype: 'success', result: 'done-2' }),
    ]);

    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream)) {
      events.push(e);
    }

    expect(events.filter(e => e.type === 'result').map(e => e.messageId)).toEqual(['turn-1', 'turn-2']);
  });

  test('cursor 过滤：跳过已处理的 messageId', async () => {
    const cursor: StreamCursor = { sessionId: 'sess1', lastMessageId: 'msg1' };
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [] } }),
      JSON.stringify({ type: 'result', message: { id: 'msg1' }, subtype: 'success', result: 'done-1' }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg2', content: [] } }),
      JSON.stringify({ type: 'result', message: { id: 'msg2' }, subtype: 'success', result: 'done-2' }),
    ]);
    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream, cursor)) {
      events.push(e);
    }

    expect(events.map(e => `${e.type}:${e.messageId}`)).toEqual(['result:msg1', 'assistant:msg2', 'result:msg2']);
  });

  test('多轮连续流不会把第二轮 assistant 串到第一轮', async () => {
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-1', content: [{ type: 'text', text: 'A1' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-1', content: [{ type: 'text', text: 'A2' }] } }),
      JSON.stringify({ type: 'result', message: { id: 'turn-1' }, subtype: 'success', result: 'done-1' }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-2', content: [{ type: 'text', text: 'B1' }] } }),
      JSON.stringify({ type: 'result', message: { id: 'turn-2' }, subtype: 'success', result: 'done-2' }),
    ]);

    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream)) {
      events.push(e);
    }

    const assistants = events.filter(e => e.type === 'assistant');
    expect(assistants.map(e => e.messageId)).toEqual(['turn-1', 'turn-1', 'turn-2']);
  });

  test('未知和跨轮事件不会打乱边界', async () => {
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-1', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'attachment', message: { id: 'turn-1', file: 'a.txt' } }),
      JSON.stringify({ type: 'queue-operation', message: { id: 'turn-1', op: 'enqueue' } }),
      JSON.stringify({ type: 'result', message: { id: 'turn-1' }, subtype: 'success', result: 'done' }),
      JSON.stringify({ type: 'last-prompt', message: { id: 'turn-2', value: 'prompt' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'turn-2', content: [{ type: 'text', text: 'world' }] } }),
      JSON.stringify({ type: 'result', message: { id: 'turn-2' }, subtype: 'success', result: 'done-2' }),
    ]);

    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream)) {
      events.push(e);
    }

    expect(events.filter(e => e.type === 'result').map(e => e.messageId)).toEqual(['turn-1', 'turn-2']);
  });

  test('cursor miss：sessionId 不一致时清空 cursor 全量输出', async () => {
    const cursor: StreamCursor = { sessionId: 'old-sess', lastMessageId: 'msg1' };
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'new-sess' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [] } }),
      JSON.stringify({ type: 'result', message: { id: 'msg1' }, subtype: 'success', result: 'done' }),
    ]);
    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream, cursor)) {
      events.push(e);
    }
    expect(events.map(e => e.type)).toEqual(['system', 'assistant', 'result']);
  });

  test('cursor miss：sessionId 一致但 lastMessageId 不在历史中', async () => {
    const cursor: StreamCursor = { sessionId: 'sess1', lastMessageId: 'msg-unknown' };
    const stream = makeStream([
      JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [] } }),
      JSON.stringify({ type: 'result', message: { id: 'msg1' }, subtype: 'success', result: 'done' }),
    ]);
    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream, cursor)) {
      events.push(e);
    }
    expect(events.map(e => e.type)).toEqual(['system', 'assistant', 'result']);
  });

  test('未知事件类型不报错（兼容性）', async () => {
    const stream = makeStream([
      JSON.stringify({ type: 'unknown-future-type', message: { id: 'u1' }, data: {} }),
    ]);
    const events: CLIEvent[] = [];
    for await (const e of parseStream(stream)) {
      events.push(e);
    }
    expect(events[0].type).toBe('unknown');
    expect((events[0] as { rawType: string }).rawType).toBe('unknown-future-type');
  });
});
