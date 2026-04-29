import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import * as path from 'path';
import * as os from 'os';

let daemon: Daemon;
let socketPath: string;

beforeEach(async () => {
  socketPath = path.join(os.tmpdir(), `mm-approval-reaction-${Date.now()}.sock`);
  daemon = new Daemon(socketPath);
  await daemon.start();
});

afterEach(async () => {
  await daemon.stop();
});

describe('Mattermost approval reaction flow', () => {
  test('REST fallback 读取 reaction 后可完成审批决策', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    const session = daemon.registry.create('approval-fallback', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('approval-fallback', {
      plugin: 'mattermost',
      bindingKind: 'thread',
      threadId: 'thread-fallback',
      channelId: 'ch1',
    } as any);
    (daemon as any)._ensureIMActorRoles(session, 'operator-user');
    (daemon as any)._acl.grantRole(session.sessionId, 'approver-user', 'approver');

    const created = await (daemon as any)._approvalManager.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-fallback',
      toolUseId: 'tool-fallback',
      capability: 'file_write',
      operatorId: 'operator-user',
      correlationId: 'corr-fallback',
    });
    const interactionMessageId = await mockIM.requestApproval({ plugin: 'mattermost', threadId: 'thread-fallback' }, {
      requestId: created.requestId,
      sessionName: 'approval-fallback',
      messageId: 'msg-fallback',
      toolName: 'Edit',
      toolInputSummary: '{"path":"/tmp/a.txt"}',
      riskLevel: 'medium',
      capability: 'file_write',
      scopeOptions: ['once', 'session'],
      timeoutSeconds: 60,
    } as any);
    (daemon as any)._approvalManager.attachInteractionMessage(created.requestId, interactionMessageId!);

    mockIM.approvalDecisions.push({ requestId: created.requestId, decision: 'approved', scope: 'session' });

    const reaction = await mockIM.listReactions(interactionMessageId!);
    expect(reaction).toEqual([{ userId: 'mock-user', emoji: '✅' }]);

    await (daemon as any)._handleIncomingIMMessage({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-fallback',
      isTopLevel: false,
      userId: 'approver-user',
      text: '',
      messageId: 'reaction-fallback-1',
      createdAt: new Date().toISOString(),
      dedupeKey: 'reaction-fallback-1',
      reaction: { action: 'added', emoji: '✅', postId: interactionMessageId! },
    }, 'ch1');

    const state = (daemon as any)._approvalManager.getApprovalState(created.requestId);
    expect(state?.decision).toBe('approved');
    expect(state?.scope).toBe('session');
  });

  test('bot 自身 reaction 不会触发审批决策', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    const session = daemon.registry.create('approval-bot-filter', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('approval-bot-filter', {
      plugin: 'mattermost',
      bindingKind: 'thread',
      threadId: 'thread-bot-filter',
      channelId: 'ch1',
    } as any);

    const created = await (daemon as any)._approvalManager.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-bot',
      toolUseId: 'tool-bot',
      capability: 'file_write',
      operatorId: 'operator-user',
      correlationId: 'corr-bot',
    });
    (daemon as any)._approvalManager.attachInteractionMessage(created.requestId, 'post-bot-1');

    await (daemon as any)._handleIncomingIMMessage({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-bot-filter',
      isTopLevel: false,
      userId: 'bot-user',
      text: '',
      messageId: 'reaction-bot-1',
      createdAt: new Date().toISOString(),
      dedupeKey: 'reaction-bot-1',
      reaction: { action: 'added', emoji: '👍', postId: 'post-bot-1' },
    }, 'ch1');

    const state = (daemon as any)._approvalManager.getApprovalState(created.requestId);
    expect(state?.decision).toBe('pending');
  });
});
