import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import * as path from 'path';
import * as os from 'os';

let daemon: Daemon;
let client: IPCClient;
let socketPath: string;

beforeEach(async () => {
  socketPath = path.join(os.tmpdir(), `mm-acl-entry-${Date.now()}.sock`);
  daemon = new Daemon(socketPath);
  await daemon.start();
  client = new IPCClient(socketPath);
  await client.connect();
});

afterEach(async () => {
  await client.close();
  await daemon.stop();
});

describe('ACL entrypoints', () => {
  test('open 命令无 session owner 权限时返回 ACL_DENIED 且不创建绑定', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    await client.send('create', { name: 'acl-open', workdir: '/tmp', cli: 'claude-code' }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });

    const res = await client.send('open', {
      name: 'acl-open',
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: '',
    }, {
      actor: { source: 'cli', userId: 'stranger' },
    });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');
    expect(daemon.registry.get('acl-open')?.imBindings).toHaveLength(0);
  });

  test('takeoverStatus 无 owner 权限时返回 ACL_DENIED', async () => {
    await client.send('create', { name: 'acl-takeover-status', workdir: '/tmp', cli: 'claude-code' }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });
    await client.send('attach', { name: 'acl-takeover-status', pid: 9999 }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });

    const res = await client.send('takeoverStatus', { name: 'acl-takeover-status' }, {
      actor: { source: 'cli', userId: 'stranger' },
    });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');
  });

  test('takeoverCancel 无 owner 权限时返回 ACL_DENIED 且不改变状态', async () => {
    await client.send('create', { name: 'acl-takeover-cancel', workdir: '/tmp', cli: 'claude-code' }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });
    await client.send('attach', { name: 'acl-takeover-cancel', pid: 9999 }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });
    daemon.registry.requestTakeover('acl-takeover-cancel', 'user-im');

    const res = await client.send('takeoverCancel', { name: 'acl-takeover-cancel' }, {
      actor: { source: 'cli', userId: 'stranger' },
    });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');
    expect(daemon.registry.get('acl-takeover-cancel')?.status).toBe('takeover_pending');
  });

  test('import 当前实现仍允许普通 CLI actor 导入，会话被创建出来（记录为待收口缺口）', async () => {
    const res = await client.send('import', {
      sessionId: 'sess-import-acl',
      workdir: '/tmp',
      cli: 'claude-code',
      name: 'acl-import',
    }, {
      actor: { source: 'cli', userId: 'stranger' },
    });

    expect(res.ok).toBe(true);
    expect(daemon.registry.get('acl-import')).toBeTruthy();
  });

  test('IM 无 approver 权限执行 /approve 时返回无权限且不改审批状态', async () => {
    const mockIM = new MockIMPlugin();
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    await (daemon as any)._handleIncomingIMMessage({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-acl-approve',
      isTopLevel: false,
      userId: 'im-owner',
      text: 'hello',
      messageId: 'msg-owner',
      createdAt: new Date().toISOString(),
      dedupeKey: 'dk-owner',
    }, 'ch1');

    const session = daemon.registry.getByIMThread('mattermost', 'thread-acl-approve')!;
    const roleStore = (daemon as any)._acl['_roleStore'];
    roleStore.get(session.sessionId)?.delete('im-owner');
    const created = await (daemon as any)._approvalManager.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-approve',
      toolUseId: 'tool-approve',
      capability: 'file_write',
      operatorId: 'im-owner',
      correlationId: 'corr-approve',
    });

    (daemon as any)._acl.revokeRole(session.sessionId, 'im-owner', 'approver');

    await (daemon as any)._handleApprovalDecision({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-acl-approve',
      isTopLevel: false,
      userId: 'im-owner',
      text: '/approve once',
      messageId: 'msg-approve-denied',
      createdAt: new Date().toISOString(),
      dedupeKey: 'dk-approve-denied',
    }, 'ch1', 'approved');

    expect((daemon as any)._approvalManager.getApprovalState(created.requestId)?.decision).toBe('pending');
    expect(mockIM.sent.at(-1)?.content && (mockIM.sent.at(-1)!.content as any).text).toContain('无权限处理审批');
  });
});
