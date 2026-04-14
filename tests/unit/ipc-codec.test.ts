import { describe, test, expect } from 'vitest';
import { encodeRequest, decodeMessage, encodeResponse, encodeError, encodeEvent } from '../../src/ipc/codec.js';

describe('IPC Codec', () => {
  test('encodeRequest 生成合法 JSON Lines 行', () => {
    const line = encodeRequest('create', { name: 'test' });
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe('request');
    expect(parsed.command).toBe('create');
    expect(parsed.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('decodeMessage 识别 response/error', () => {
    const okLine = JSON.stringify({ type: 'response', requestId: 'r1', ok: true, data: {} });
    const msg = decodeMessage(okLine);
    expect(msg.type).toBe('response');
    expect((msg as { ok: boolean }).ok).toBe(true);
  });

  test('encodeError 含标准错误码', () => {
    const line = encodeError('r1', 'SESSION_NOT_FOUND', "Session 'x' not found");
    const parsed = JSON.parse(line);
    expect(parsed.error.code).toBe('SESSION_NOT_FOUND');
  });

  // P1: server-push event 编码
  test('encodeEvent 生成合法 event 消息', () => {
    const line = encodeEvent('session_state_changed', { name: 'bug-fix', status: 'idle', revision: 3 });
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe('event');
    expect(parsed.event).toBe('session_state_changed');
    expect(parsed.data.name).toBe('bug-fix');
  });

  test('decodeMessage 识别 event 类型', () => {
    const eventLine = JSON.stringify({ type: 'event', event: 'attach_ready', data: { name: 'test' } });
    const msg = decodeMessage(eventLine);
    expect(msg.type).toBe('event');
    expect((msg as { event: string }).event).toBe('attach_ready');
  });

  test('encodeResponse 生成合法响应行', () => {
    const line = encodeResponse('req-1', { foo: 'bar' });
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe('response');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.ok).toBe(true);
    expect(parsed.data.foo).toBe('bar');
  });

  test('decodeMessage 对非法 JSON 抛出错误', () => {
    expect(() => decodeMessage('not json')).toThrow();
  });
});
