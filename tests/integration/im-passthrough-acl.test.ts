import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Daemon } from '../../src/daemon.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import type { IncomingMessage } from '../../src/types.js';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-pass-acl-1',
    plugin: 'mattermost',
    channelId: 'ch1',
    threadId: 'thread-pass-acl-1',
    isTopLevel: false,
    userId: 'user-1',
    text: '//compact',
    createdAt: new Date().toISOString(),
    dedupeKey: 'dedup-pass-acl-1',
    ...overrides,
  };
}

describe('IM passthrough ACL', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let mockIM: MockIMPlugin;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pass-acl-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
    mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('无 operator 权限的 passthrough 不应入队', async () => {
    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '//compact', threadId: 'thread-pass-acl-deny' }), 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-pass-acl-deny');
    expect(session).toBeTruthy();
    expect(session!.messageQueue).toHaveLength(0);
    expect(mockIM.sent.at(-1)?.content && (mockIM.sent.at(-1)!.content as any).text).toContain('无权限');
  });

  test('attached 状态下 passthrough 与普通 IM 文本一样被拒绝', async () => {
    daemon.registry.create('attached-pass', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.markAttached('attached-pass', 1234);
    daemon.registry.bindIM('attached-pass', { plugin: 'mattermost', threadId: 'thread-attached-pass', channelId: 'ch1' } as any);
    (daemon as any)._acl.grantRole(daemon.registry.get('attached-pass')!.sessionId, 'user-pass', 'operator');

    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '//model sonnet', threadId: 'thread-attached-pass', userId: 'user-pass', messageId: 'msg-pass-acl-2', dedupeKey: 'dedup-pass-acl-2' }), 'ch1');

    expect(daemon.registry.get('attached-pass')?.messageQueue).toHaveLength(0);
    expect(mockIM.sent.at(-1)?.content && (mockIM.sent.at(-1)!.content as any).text).toContain('当前会话');
  });

  test('operator 角色可发起 passthrough 并按原生命令入队', async () => {
    const session = daemon.registry.create('operator-pass', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('operator-pass', { plugin: 'mattermost', threadId: 'thread-operator-pass', channelId: 'ch1' } as any);
    (daemon as any)._acl.grantRole(session.sessionId, 'operator-user', 'operator');

    await (daemon as any)._handleIncomingIMMessage(makeMsg({ text: '//model sonnet', threadId: 'thread-operator-pass', userId: 'operator-user', messageId: 'msg-pass-acl-3', dedupeKey: 'dedup-pass-acl-3' }), 'ch1');

    expect(session.messageQueue).toHaveLength(1);
    expect(session.messageQueue[0].content).toBe('/model sonnet');
  });
});
