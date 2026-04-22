import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import { ApprovalHandler } from '../../src/approval-handler.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let daemon: Daemon;
let client: IPCClient;
let socketPath: string;

beforeEach(async () => {
  socketPath = path.join(os.tmpdir(), `mm-test-daemon-${Date.now()}.sock`);
  daemon = new Daemon(socketPath);
  await daemon.start();
  client = new IPCClient(socketPath);
  await client.connect();
});

afterEach(async () => {
  await client.close();
  await daemon.stop();
});

describe('Daemon CRUD commands', () => {
  test('create + list 往返', async () => {
    const res = await client.send('create', { name: 'test', workdir: '/tmp', cli: 'claude-code' });
    expect(res.ok).toBe(true);

    const listRes = await client.send('list', {});
    expect(listRes.ok).toBe(true);
    expect((listRes.data!.sessions as any[]).some((s: any) => s.name === 'test')).toBe(true);
  });

  test('remove idle + cold session 成功删除', async () => {
    await client.send('create', { name: 'remove-cold', workdir: '/tmp', cli: 'claude-code' });

    const removeRes = await client.send('remove', { name: 'remove-cold' });
    expect(removeRes.ok).toBe(true);
    expect(daemon.registry.get('remove-cold')).toBeUndefined();
  });

  test('remove idle + ready session 会先 terminate worker 再删除 registry', async () => {
    await client.send('create', { name: 'remove-ready', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.markWorkerReady('remove-ready', 43210);

    const terminateSpy = vi.fn().mockResolvedValue(undefined);
    (daemon as any)._imWorkerManager = { terminate: terminateSpy };

    const removeRes = await client.send('remove', { name: 'remove-ready' });
    expect(removeRes.ok).toBe(true);
    expect(terminateSpy).toHaveBeenCalledWith('remove-ready');
    expect(daemon.registry.get('remove-ready')).toBeUndefined();
  });

  test('remove attached session 返回明确错误且不删除', async () => {
    await client.send('create', { name: 'remove-attached', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'remove-attached', pid: 9999 });

    const removeRes = await client.send('remove', { name: 'remove-attached' });
    expect(removeRes.ok).toBe(false);
    expect(removeRes.error!.code).toBe('INVALID_STATE_TRANSITION');
    expect(removeRes.error!.message).toContain('attached');
    expect(daemon.registry.get('remove-attached')).toBeTruthy();
  });

  test('remove 后 list 不再包含该 session', async () => {
    await client.send('create', { name: 'to-remove', workdir: '/tmp', cli: 'claude-code' });

    const removeRes = await client.send('remove', { name: 'to-remove' });
    expect(removeRes.ok).toBe(true);

    const listRes = await client.send('list', {});
    expect((listRes.data!.sessions as any[]).some((s: any) => s.name === 'to-remove')).toBe(false);
  });

  test('status 返回 daemon 运行状态', async () => {
    const res = await client.send('status', {});
    expect(res.ok).toBe(true);
    expect(res.data!.pid).toBeGreaterThan(0);
    expect(res.data!.sessions).toBeDefined();
  });

  test('create 重复名称返回 SESSION_ALREADY_EXISTS', async () => {
    await client.send('create', { name: 'dup', workdir: '/tmp', cli: 'claude-code' });
    const res = await client.send('create', { name: 'dup', workdir: '/tmp', cli: 'claude-code' });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('SESSION_ALREADY_EXISTS');
  });

  test('remove channel 绑定 session 时仅做本地解绑/删除，不做远端硬删除前提下可成功完成', async () => {
    await client.send('create', { name: 'remove-channel', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.bindIM('remove-channel', {
      plugin: 'mattermost',
      bindingKind: 'channel',
      threadId: '',
      channelId: 'channel-1',
    } as any);

    const removeRes = await client.send('remove', { name: 'remove-channel' });
    expect(removeRes.ok).toBe(true);
    expect(daemon.registry.get('remove-channel')).toBeUndefined();
  });

  test('status 返回 session 实际绑定空间类型', async () => {
    await client.send('create', { name: 'status-channel', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.bindIM('status-channel', {
      plugin: 'mattermost',
      bindingKind: 'channel',
      threadId: '',
      channelId: 'channel-99',
    } as any);

    const statusRes = await client.send('status', {});
    expect(statusRes.ok).toBe(true);
    const session = (statusRes.data!.sessions as any[]).find((s: any) => s.name === 'status-channel');
    expect(session.imBindings).toHaveLength(1);
    expect(session.imBindings[0].bindingKind).toBe('channel');
    expect(session.imBindings[0].channelId).toBe('channel-99');
  });

  test('list/status 会自动清理 attached 死 pid，避免残留 attached', async () => {
    await client.send('create', { name: 'stale-attached', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'stale-attached', pid: 9999 });
    const session = daemon.registry.get('stale-attached')!;
    session.attachedPid = 99999999;

    const listRes = await client.send('list', {});
    expect(listRes.ok).toBe(true);
    expect(daemon.registry.get('stale-attached')?.status).toBe('idle');
    expect(daemon.registry.get('stale-attached')?.attachedPid).toBeNull();

    const statusRes = await client.send('status', {});
    expect(statusRes.ok).toBe(true);
    const listed = (statusRes.data!.sessions as any[]).find((s: any) => s.name === 'stale-attached');
    expect(listed.status).toBe('idle');
  });
});

describe('ACL enforcement', () => {
  test('attach 命令无 owner 角色时返回 ACL_DENIED', async () => {
    await client.send('create', { name: 'acl-test', workdir: '/tmp', cli: 'claude-code' });

    const res = await client.send('attach', { name: 'acl-test', pid: 9999 }, {
      actor: { source: 'cli', userId: 'stranger' },
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');

    const listRes = await client.send('list', {});
    const s = (listRes.data!.sessions as any[]).find((s: any) => s.name === 'acl-test');
    expect(s.status).toBe('idle');
  });

  test('remove 命令无 owner 角色时返回 ACL_DENIED，session 未删除', async () => {
    await client.send('create', { name: 'acl-test2', workdir: '/tmp', cli: 'claude-code' });

    const res = await client.send('remove', { name: 'acl-test2' }, {
      actor: { source: 'cli', userId: 'stranger' },
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('ACL_DENIED');

    const listRes = await client.send('list', {});
    expect((listRes.data!.sessions as any[]).some((s: any) => s.name === 'acl-test2')).toBe(true);
  });

  test('IM 审批命令有 approver 角色时可批准并更新审批状态', async () => {
    await client.send('create', { name: 'approval-allow', workdir: '/tmp', cli: 'claude-code' }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });
    const session = daemon.registry.get('approval-allow')!;
    const created = await (daemon as any)._approvalManager?.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-2',
      toolUseId: 'tool-2',
      capability: 'file_write',
      operatorId: 'owner-user',
      correlationId: 'corr-2',
    });
    expect(created).toBeDefined();
    (daemon as any)._acl.grantRole(session.sessionId, 'approver-user', 'approver');

    await (daemon as any)._handleApprovalDecision({
      plugin: 'mattermost',
      threadId: 'thread-2',
      isTopLevel: false,
      userId: 'approver-user',
      text: `/approve ${created.requestId} session`,
      messageId: 'im-2',
      createdAt: new Date().toISOString(),
      dedupeKey: 'dk-im-2',
    }, 'ch1', 'approved');

    const state = (daemon as any)._approvalManager.getApprovalState(created.requestId);
    expect(state?.decision).toBe('approved');
    expect(state?.scope).toBe('session');
  });

  test('IM reaction 审批可按 interaction message 决策', async () => {
    const mockIM = new MockIMPlugin();
    const originalImPlugin = (daemon as any)._imPlugin;
    const originalImPluginName = (daemon as any)._imPluginName;
    const originalImPlugins = new Map((daemon as any)._imPlugins);
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    await client.send('create', { name: 'approval-reaction', workdir: '/tmp', cli: 'claude-code' }, {
      actor: { source: 'cli', userId: 'owner-user' },
    });
    const session = daemon.registry.get('approval-reaction')!;
    const created = await (daemon as any)._approvalManager?.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-r',
      toolUseId: 'tool-r',
      capability: 'file_write',
      operatorId: 'owner-user',
      correlationId: 'corr-r',
    });
    expect(created).toBeDefined();
    (daemon as any)._approvalManager.attachInteractionMessage(created.requestId, 'post-approval-1');
    (daemon as any)._acl.grantRole(session.sessionId, 'approver-user', 'approver');

    await (daemon as any)._handleIncomingIMMessage({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'post-approval-1',
      isTopLevel: false,
      userId: 'approver-user',
      text: '',
      messageId: 'reaction-1',
      createdAt: new Date().toISOString(),
      dedupeKey: 'reaction-1',
      reaction: { action: 'added', emoji: '✅', postId: 'post-approval-1' },
    }, 'ch1');

    const state = (daemon as any)._approvalManager.getApprovalState(created.requestId);
    expect(state?.decision).toBe('approved');
    expect(state?.scope).toBe('session');

    (daemon as any)._imPlugin = originalImPlugin;
    (daemon as any)._imPluginName = originalImPluginName;
    (daemon as any)._imPlugins = originalImPlugins;
  });

  test('IM 创建/命中会话时会为发起者初始化 owner role，审批 fallback 不再被 ACL 拒绝', async () => {
    const mockIM = new MockIMPlugin();
    const originalImPlugin = (daemon as any)._imPlugin;
    const originalImPluginName = (daemon as any)._imPluginName;
    const originalImPlugins = new Map((daemon as any)._imPlugins);
    (daemon as any)._imPlugin = mockIM;
    (daemon as any)._imPluginName = 'mattermost';
    (daemon as any)._imPlugins.set('mattermost', mockIM);

    await (daemon as any)._handleIncomingIMMessage({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-acl-init',
      isTopLevel: false,
      userId: 'im-owner',
      text: 'hello',
      messageId: 'im-owner-msg',
      createdAt: new Date().toISOString(),
      dedupeKey: 'im-owner-msg',
    }, 'ch1');

    const session = daemon.registry.list().find((s: any) => s.imBindings.some((b: any) => b.threadId === 'thread-acl-init'))!;
    expect((daemon as any)._acl.hasRole(session.sessionId, 'im-owner', 'owner')).toBe(true);

    const created = await (daemon as any)._approvalManager.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-acl-init',
      toolUseId: 'tool-acl-init',
      capability: 'file_write',
      operatorId: 'im-owner',
      correlationId: 'corr-acl-init',
    });

    await (daemon as any)._handleApprovalDecision({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-acl-init',
      isTopLevel: false,
      userId: 'im-owner',
      text: '/approve once',
      messageId: 'im-approve-last',
      createdAt: new Date().toISOString(),
      dedupeKey: 'im-approve-last',
    }, 'ch1', 'approved');

    const state = (daemon as any)._approvalManager.getApprovalState(created.requestId);
    expect(state?.decision).toBe('approved');

    (daemon as any)._imPlugin = originalImPlugin;
    (daemon as any)._imPluginName = originalImPluginName;
    (daemon as any)._imPlugins = originalImPlugins;
  });

  test('IM session approval 使用 /approve session 并命中 session scope 语义', async () => {
    const session = daemon.registry.create('approval-session-scope', { workdir: '/tmp', cliPlugin: 'claude-code' });
    daemon.registry.bindIM('approval-session-scope', {
      plugin: 'mattermost',
      bindingKind: 'thread',
      threadId: 'thread-session-scope',
      channelId: 'ch1',
    } as any);
    session.activeOperatorId = 'im-owner';
    (daemon as any)._ensureIMActorRoles(session, 'im-owner');

    const created = await (daemon as any)._approvalManager.createPendingApproval({
      sessionId: session.sessionId,
      messageId: 'msg-scope',
      toolUseId: 'tool-scope',
      capability: 'file_write',
      operatorId: 'im-owner',
      correlationId: 'corr-scope',
    });

    await (daemon as any)._handleApprovalDecision({
      plugin: 'mattermost',
      channelId: 'ch1',
      threadId: 'thread-session-scope',
      isTopLevel: false,
      userId: 'im-owner',
      text: '/approve session',
      messageId: 'im-approve-session',
      createdAt: new Date().toISOString(),
      dedupeKey: 'im-approve-session',
    }, 'ch1', 'approved');

    const result = await (daemon as any)._approvalManager.applyRules(
      'Bash',
      { command: 'sed -i s/a/b file' },
      'file_write',
      { sessionId: session.sessionId, operatorId: session.activeOperatorId },
    );
    expect(created.requestId).toBeDefined();
    expect(result).toBe('allow');
  });
});

describe('takeover commands', () => {
  test('takeoverStatus 返回接管请求信息', async () => {
    await client.send('create', { name: 'takeover-test', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'takeover-test', pid: 9999 });
    daemon.registry.requestTakeover('takeover-test', 'user-im');

    const res = await client.send('takeoverStatus', { name: 'takeover-test' });
    expect(res.ok).toBe(true);
    expect(res.data!.takeoverRequestedBy).toBe('user-im');
    expect((res.data!.session as any).status).toBe('takeover_pending');
  });

  test('takeover-force 风格释放后 session 回到 idle', async () => {
    await client.send('create', { name: 'takeover-force-test', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'takeover-force-test', pid: 9999 });
    daemon.registry.requestTakeover('takeover-force-test', 'user-im');

    daemon.registry.completeTakeover('takeover-force-test');

    const res = await client.send('takeoverStatus', { name: 'takeover-force-test' });
    expect(res.ok).toBe(true);
    expect((res.data!.session as any).status).toBe('idle');
  });
});

describe('daemon IM approval chain', () => {
  test('daemon 主链下审批通过后同一 worker 继续输出，不会停在单轮', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-daemon-approval-'));
    const mockIM = new MockIMPlugin();
    const approvalSocketPath = `${socketPath}.approval.sock`;
    const workerScript = path.join(tmpDir, 'mock-daemon-approval.sh');
    let approvalHandler: ApprovalHandler | undefined;
    let dispatcher: IMMessageDispatcher | undefined;
    let workerManager: IMWorkerManager | undefined;

    fs.writeFileSync(workerScript, [
      '#!/usr/bin/env node',
      "const { spawn } = require('child_process');",
      "const readline = require('readline');",
      'const bridgePath = process.argv[2];',
      "const bridge = spawn('node', [bridgePath], { stdio: ['pipe', 'pipe', 'inherit'] });",
      "process.on('SIGTERM', () => { try { bridge.kill('SIGKILL'); } catch {} process.exit(0); });",
      "process.on('exit', () => { try { bridge.kill('SIGKILL'); } catch {} });",
      "const bridgeRl = readline.createInterface({ input: bridge.stdout, crlfDelay: Infinity });",
      'let nextId = 1;',
      'const pending = new Map();',
      'bridgeRl.on("line", (line) => {',
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      '  const resolve = pending.get(msg.id);',
      '  if (resolve) { pending.delete(msg.id); resolve(msg); }',
      '});',
      'function rpc(method, params) {',
      '  const id = nextId++;',
      '  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");',
      '  return new Promise((resolve) => pending.set(id, resolve));',
      '}',
      'async function main() {',
      '  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "worker", version: "1.0.0" } });',
      '  await rpc("tools/list", {});',
      '  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
      '  rl.on("line", async () => {',
      '    const response = await rpc("tools/call", { name: "can_use_tool", arguments: { tool_name: "Edit", tool_input: { path: "/tmp/a.txt" }, capability: "file_write", message_id: "msg-daemon-1", tool_use_id: "tool-daemon-1" } });',
      '    const content = response.result && Array.isArray(response.result.content) ? response.result.content : [];',
      '    const text = content.find((block) => block && block.type === "text")?.text || "";',
      '    const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();',
      '    const allow = parsed && parsed.behavior === "allow";',
      '    if (allow) {',
      '      process.stdout.write(JSON.stringify({ type: "assistant", payload: { message: { content: [{ type: "text", text: "daemon step 1" }] } } }) + "\\n");',
      '      process.stdout.write(JSON.stringify({ type: "assistant", payload: { message: { content: [{ type: "text", text: "daemon step 2" }] } } }) + "\\n");',
      '      process.stdout.write(JSON.stringify({ type: "result", payload: { subtype: "success", result: "done" } }) + "\\n");',
      '      try { bridge.kill("SIGTERM"); } catch {}',
      '      rl.close();',
      '      process.exit(0);',
      '    }',
      '  });',
      '}',
      'main().catch((error) => { console.error(error); process.exit(1); });',
    ].join('\n'), { mode: 0o755 });

    try {
      (daemon as any)._imPlugin = mockIM;
      (daemon as any)._imPluginName = 'mattermost';
      (daemon as any)._imPlugins.set('mattermost', mockIM);

      approvalHandler = new ApprovalHandler({
        socketPath: approvalSocketPath,
        approvalManager: (daemon as any)._approvalManager,
        imPlugin: mockIM,
        imTarget: { plugin: 'mock', threadId: '' },
        resolveContext: (sessionId: string) => {
          const session = daemon.registry.list().find((item: any) => item.sessionId === sessionId);
          if (!session) return undefined;
          const binding = session.imBindings[0];
          return {
            target: { plugin: 'mock', threadId: binding?.threadId ?? '' },
            sessionName: session.name,
          };
        },
      });
      await approvalHandler.listen();

      workerManager = new IMWorkerManager(new MockCLIPlugin('node', [], {
        buildIMWorkerArgs: (_session, bridgeScriptPath) => [workerScript, bridgeScriptPath],
      }), daemon.registry, approvalSocketPath);
      dispatcher = new IMMessageDispatcher({
        registry: daemon.registry,
        imPlugin: mockIM,
        imTarget: { plugin: 'mock', threadId: '' },
        workerManager,
        pollIntervalMs: 50,
      });
      dispatcher.start();

      mockIM.onMessage((msg) => {
        void (daemon as any)._handleIncomingIMMessage({ ...msg, plugin: 'mattermost' }, msg.channelId ?? '');
      });

      mockIM.simulateMessage({ threadId: 'thread-daemon', userId: 'user-1', text: 'please continue' });

      await vi.waitFor(() => {
        expect(mockIM.approvalRequests).toHaveLength(1);
      }, { timeout: 3000 });
      expect(mockIM.reactionAdds.at(-1)?.emojis).toEqual(['👍', '✅', '👎', '⏹️']);

      const session = daemon.registry.list()[0]!;
      (daemon as any)._acl.grantRole(session.sessionId, 'approver-user', 'approver');
      await (daemon as any)._handleApprovalDecision({
        plugin: 'mattermost',
        threadId: 'thread-daemon',
        isTopLevel: false,
        userId: 'approver-user',
        text: `/approve ${mockIM.approvalRequests[0]!.requestId} once`,
        messageId: 'im-approve-1',
        createdAt: new Date().toISOString(),
        dedupeKey: 'dk-approve-1',
      }, '', 'approved');

      await vi.waitFor(() => {
        const messages = [...mockIM.liveMessages.values()];
        expect(messages.some(m => m.includes('daemon step 1'))).toBe(true);
        expect(messages.some(m => m.includes('daemon step 2'))).toBe(true);
      }, { timeout: 5000 });

      expect(daemon.registry.list()[0]?.messageQueue[0]?.status).toBe('completed');
      expect(daemon.registry.list()[0]?.status).toBe('idle');
      return;
    } finally {
      dispatcher?.stop();
      await workerManager?.terminate('im-thread-d');
      await approvalHandler?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20000);
});
