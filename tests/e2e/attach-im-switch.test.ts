import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMMessageDispatcher } from '../../src/im-message-dispatcher.js';
import { MockIMPlugin } from '../helpers/mock-im-plugin.js';
import { IPCServer } from '../../src/ipc/socket-server.js';
import { attachSession } from '../../src/attach.js';

/**
 * E2E: attach + IM 切换场景
 *
 * 场景 1：attach 期间 IM 消息入队 → attach 退出 → IM 消息被处理
 * 场景 2：IM 处理中 → attach 请求 → attach 等待 → IM 完成 → attach 继续
 */
describe('attach + IM 切换 E2E', () => {
  let tmpDir: string;
  let socketPath: string;
  let registry: SessionRegistry;
  let mockIM: MockIMPlugin;
  let dispatcher: IMMessageDispatcher;
  let ipcServer: IPCServer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-attach-im-e2e-'));
    socketPath = path.join(tmpDir, 'daemon.sock');

    registry = new SessionRegistry();
    mockIM = new MockIMPlugin();

    ipcServer = new IPCServer(socketPath);

    // Register daemon commands
    ipcServer.handle('create', async (args) => {
      const name = args.name as string;
      const workdir = args.workdir as string;
      const cliPlugin = args.cliPlugin as string ?? 'mock';
      registry.create(name, { workdir, cliPlugin });
      return { ok: true };
    });

    ipcServer.handle('attach', async (args, _actor, socket) => {
      const name = args.name as string;
      const pid = args.pid as number;
      const session = registry.get(name);
      if (!session) throw new Error('SESSION_NOT_FOUND');

      // Check if IM is processing
      const waitRequired = session.status === 'im_processing';

      await registry.beginAttach(name, pid);

      if (waitRequired && socket) {
        ipcServer.registerAttachWaiter(name, socket);
      }

      return { ok: true, waitRequired };
    });

    ipcServer.handle('markDetached', async (args) => {
      const name = args.name as string;
      const exitReason = args.exitReason as 'normal' | 'error';
      registry.markDetached(name, exitReason);

      // Trigger session_resume event for any waiting attach
      ipcServer.pushEventToAttachWaiter(name, {
        type: 'event',
        event: 'session_resume',
        data: { name },
      });

      return { ok: true };
    });

    await ipcServer.listen();
  });

  afterEach(async () => {
    dispatcher?.stop();
    await ipcServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('attach 期间 IM 消息入队 → attach 退出 → IM 消息被处理', async () => {
    // Create session
    registry.create('attach-im-session', { workdir: tmpDir, cliPlugin: 'mock' });

    // Create mock CLI that exits after 500ms
    const mockCli = path.join(tmpDir, 'mock-cli-delay.sh');
    fs.writeFileSync(mockCli, '#!/bin/sh\nsleep 0.5\nexit 0\n', { mode: 0o755 });

    // Start attach in background (non-blocking)
    const attachPromise = attachSession({
      socketPath,
      sessionName: 'attach-im-session',
      cliCommand: mockCli,
      cliArgs: [],
    });

    // Wait for attach to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Session should be in 'attached' state
    const s1 = registry.get('attach-im-session');
    expect(s1?.status).toBe('attached');

    // IM message arrives during attach → should be queued
    registry.enqueueIMMessage('attach-im-session', {
      plugin: 'mock',
      threadId: 'thread-1',
      messageId: 'msg-during-attach',
      userId: 'user-1',
      text: 'hello during attach',
      dedupeKey: 'dedup-during-attach',
    });

    const s2 = registry.get('attach-im-session');
    expect(s2?.messageQueue.length).toBe(1);
    expect(s2?.messageQueue[0]?.status).toBe('pending');

    // Wait for attach to complete
    await attachPromise;

    // Session should be detached
    const s3 = registry.get('attach-im-session');
    expect(s3?.status).toBe('idle');

    // Now start dispatcher to process queued IM message
    const mockCliIM = path.join(tmpDir, 'mock-cli-im.sh');
    fs.writeFileSync(mockCliIM, [
      '#!/bin/sh',
      'echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"processed queued message"}]}}}\'',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-1' },
      cliCommand: mockCliIM,
      cliArgs: [],
      pollIntervalMs: 50,
    });

    dispatcher.start();

    // Wait for message processing
    await new Promise(resolve => setTimeout(resolve, 1500));

    // IM should have received the response
    const messages = [...mockIM.liveMessages.values()];
    expect(messages.some(m => m.includes('processed queued message'))).toBe(true);

    // Message should be marked as completed
    const s4 = registry.get('attach-im-session');
    expect(s4?.messageQueue[0]?.status).toBe('completed');
  }, 15000);

  test('IM 处理中 → attach 请求 → attach 等待 → IM 完成 → attach 继续', async () => {
    // Create session
    registry.create('im-attach-wait', { workdir: tmpDir, cliPlugin: 'mock' });

    // Start IM processing (long-running mock CLI)
    const mockCliIM = path.join(tmpDir, 'mock-cli-long.sh');
    fs.writeFileSync(mockCliIM, [
      '#!/bin/sh',
      'sleep 1',
      'echo \'{"type":"assistant","payload":{"message":{"content":[{"type":"text","text":"IM processing done"}]}}}\'',
      'echo \'{"type":"result","payload":{"subtype":"success","result":"done"}}\'',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    dispatcher = new IMMessageDispatcher({
      registry,
      imPlugin: mockIM,
      imTarget: { plugin: 'mock', threadId: 'thread-2' },
      cliCommand: mockCliIM,
      cliArgs: [],
      pollIntervalMs: 50,
      onSessionImDone: (name) => {
        // When IM finishes, push session_resume so waiting attach can proceed
        ipcServer.pushEventToAttachWaiter(name, {
          type: 'event',
          event: 'session_resume',
          data: { name },
        });
      },
    });

    dispatcher.start();

    // Enqueue IM message
    registry.enqueueIMMessage('im-attach-wait', {
      plugin: 'mock',
      threadId: 'thread-2',
      messageId: 'msg-im-first',
      userId: 'user-1',
      text: 'IM message first',
      dedupeKey: 'dedup-im-first',
    });

    // Wait for IM processing to start
    await new Promise(resolve => setTimeout(resolve, 200));

    const s1 = registry.get('im-attach-wait');
    expect(s1?.status).toBe('im_processing');

    // Now try to attach → should get waitRequired: true
    const mockCliAttach = path.join(tmpDir, 'mock-cli-attach.sh');
    fs.writeFileSync(mockCliAttach, '#!/bin/sh\necho "attach executed"\nexit 0\n', { mode: 0o755 });

    // Attach in background
    const attachPromise = attachSession({
      socketPath,
      sessionName: 'im-attach-wait',
      cliCommand: mockCliAttach,
      cliArgs: [],
    });

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 200));

    // Session should be in attach_pending
    const s2 = registry.get('im-attach-wait');
    expect(s2?.status).toBe('attach_pending');

    // Wait for IM processing to complete (dispatcher will call markDetached → triggers session_resume)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Attach should have completed
    await attachPromise;

    // Session should be idle after attach exits
    const s3 = registry.get('im-attach-wait');
    expect(s3?.status).toBe('idle');
  }, 15000);
});
