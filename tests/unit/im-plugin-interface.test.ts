import { describe, test, expect } from 'vitest';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import type { IncomingMessage } from '../../src/types.js';

describe('IMPlugin 接口', () => {
  test('MockIMPlugin 收到 onMessage 事件', async () => {
    const plugin = new MockIMPlugin();
    const received: IncomingMessage[] = [];
    plugin.onMessage(msg => received.push(msg));
    plugin.simulateMessage({ threadId: 'thread-1', userId: 'user1', text: 'hello' });
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hello');
  });

  test('MockIMPlugin.sendMessage 记录发送历史', async () => {
    const plugin = new MockIMPlugin();
    await plugin.sendMessage({ plugin: 'mock', threadId: 't1' }, { kind: 'text', text: 'reply' });
    expect(plugin.sent).toHaveLength(1);
    expect(plugin.sent[0].target.threadId).toBe('t1');
    expect(plugin.sent[0].content.kind).toBe('text');
  });

  test('MockIMPlugin.createLiveMessage 返回 messageId', async () => {
    const plugin = new MockIMPlugin();
    const msgId = await plugin.createLiveMessage({ plugin: 'mock', threadId: 't1' }, { kind: 'text', text: 'live' });
    expect(msgId).toBeTruthy();
    expect(plugin.liveMessages.has(msgId)).toBe(true);
  });

  test('MockIMPlugin.createLiveMessage 记录 target', async () => {
    const plugin = new MockIMPlugin();
    const target = { plugin: 'mock', threadId: 't1' };
    const msgId = await plugin.createLiveMessage(target, { kind: 'text', text: 'live' });
    expect(plugin.liveMessageTargets.get(msgId)?.threadId).toBe('t1');
  });

  test('MockIMPlugin.updateMessage 更新已存在的 live message', async () => {
    const plugin = new MockIMPlugin();
    const msgId = await plugin.createLiveMessage({ plugin: 'mock', threadId: 't1' }, { kind: 'text', text: 'v1' });
    await plugin.updateMessage(msgId, { kind: 'text', text: 'v2' });
    expect(plugin.liveMessages.get(msgId)).toBe('v2');
  });

  test('MockIMPlugin.requestApproval 记录审批请求', async () => {
    const plugin = new MockIMPlugin();
    await plugin.requestApproval({ plugin: 'mock', threadId: 't1' }, {
      requestId: 'req1',
      sessionName: 'sess1',
      messageId: 'msg1',
      toolName: 'bash',
      toolInputSummary: 'rm -rf /',
      riskLevel: 'high',
      capability: 'bash',
      scopeOptions: ['once', 'session'],
      timeoutSeconds: 60,
    });
    expect(plugin.approvalRequests).toHaveLength(1);
    expect(plugin.approvalRequests[0].requestId).toBe('req1');
  });
});
