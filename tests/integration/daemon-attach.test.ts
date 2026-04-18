import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import * as path from 'path';
import * as os from 'os';

let daemon: Daemon;
let client: IPCClient;
let socketPath: string;

beforeEach(async () => {
  socketPath = path.join(os.tmpdir(), `mm-test-attach-${Date.now()}.sock`);
  daemon = new Daemon(socketPath);
  await daemon.start();
  client = new IPCClient(socketPath);
  await client.connect();
});

afterEach(async () => {
  await client.close();
  await daemon.stop();
});

describe('attach command', () => {
  test('attach idle session 成功', async () => {
    await client.send('create', { name: 'a1', workdir: '/tmp', cli: 'claude-code' });
    const res = await client.send('attach', { name: 'a1', pid: 9999 });
    expect(res.ok).toBe(true);

    const listRes = await client.send('list', {});
    const s = (listRes.data!.sessions as any[]).find((s: any) => s.name === 'a1');
    expect(s.status).toBe('attached');
  });

  test('attach approval_pending session 返回 waitRequired + attach_pending', async () => {
    await client.send('create', { name: 'a-approval', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.markImProcessing('a-approval', 1234);
    daemon.registry['_applyTransition' as keyof typeof daemon.registry]?.call?.(daemon.registry, daemon.registry.get('a-approval'), 'tool_permission_required');

    const res = await client.send('attach', { name: 'a-approval', pid: 9999 });
    expect(res.ok).toBe(true);
    expect(res.data!.waitRequired).toBe(true);
    expect(daemon.registry.get('a-approval')?.status).toBe('attach_pending');
    expect(daemon.registry.get('a-approval')?.runtimeState).toBe('waiting_approval');
  });

  test('attach nonexistent session 返回 SESSION_NOT_FOUND', async () => {
    const res = await client.send('attach', { name: 'ghost', pid: 9999 });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('SESSION_NOT_FOUND');
  });

  test('attach uninitialized session 触发懒初始化', async () => {
    await client.send('create', { name: 'a3', workdir: '/tmp', cli: 'claude-code' });
    const s1 = daemon.registry.get('a3')!;
    expect(s1.initState).toBe('uninitialized');

    const res = await client.send('attach', { name: 'a3', pid: 9999 });
    expect(res.ok).toBe(true);

    const s2 = daemon.registry.get('a3')!;
    expect(s2.initState).toBe('initialized');
    expect(s2.status).toBe('attached');
  });

  test('attach initializing session 返回 SESSION_BUSY', async () => {
    await client.send('create', { name: 'a4', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry['_sessions'].get('a4')!.initState = 'initializing';

    const res = await client.send('attach', { name: 'a4', pid: 9999 });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('SESSION_BUSY');
  });

  test('attach 优先：idle 态 attach 后 IM 消息入队', async () => {
    await client.send('create', { name: 'a5', workdir: '/tmp', cli: 'claude-code' });

    // attach first
    await client.send('attach', { name: 'a5', pid: 9999 });

    // then IM message arrives — should be queued, not rejected
    const s = daemon.registry.get('a5')!;
    expect(s.status).toBe('attached');
    // enqueueIMMessage should queue when attached
    daemon.registry.enqueueIMMessage('a5', {
      plugin: 'mock',
      threadId: 't1',
      messageId: 'm1',
      userId: 'u1',
      text: 'hello',
      receivedAt: new Date().toISOString(),
    });
    expect(daemon.registry.get('a5')!.messageQueue).toHaveLength(1);
  });

  test('markDetached 将 attached session 转为 idle', async () => {
    await client.send('create', { name: 'a6', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'a6', pid: 9999 });

    const s1 = daemon.registry.get('a6')!;
    expect(s1.status).toBe('attached');

    // Send markDetached via IPC handler
    const res = await client.send('markDetached', { name: 'a6', exitReason: 'normal' });
    expect(res.ok).toBe(true);

    const s2 = daemon.registry.get('a6')!;
    expect(s2.status).toBe('idle');
  });

  test('attach ready worker 时不等待，直接 attached', async () => {
    await client.send('create', { name: 'a-ready', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.markWorkerReady('a-ready', 12345);

    const res = await client.send('attach', { name: 'a-ready', pid: 9999 });
    expect(res.ok).toBe(true);
    expect(res.data!.waitRequired).toBeUndefined();
    expect(daemon.registry.get('a-ready')?.status).toBe('attached');
  });

  test('IM 完成后向 attach waiter 推送 session_resume', async () => {
    await client.send('create', { name: 'a8', workdir: '/tmp', cli: 'claude-code' });
    daemon.registry.markImProcessing('a8');

    const waiter = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });

    const chunks: string[] = [];
    waiter.on('data', chunk => chunks.push(chunk.toString()));

    waiter.write(`${JSON.stringify({
      type: 'request',
      requestId: 'req-a8',
      command: 'attach',
      args: { name: 'a8', pid: 9999 },
    })}\n`);

    await new Promise(resolve => setTimeout(resolve, 50));
    daemon.registry.markImDone('a8');
    (daemon as any)._server.pushEventToAttachWaiter('a8', {
      type: 'event',
      event: 'session_resume',
      data: { name: 'a8' },
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(chunks.join('')).toContain('session_resume');
    waiter.destroy();
  });

  test('takeover_pending 状态下 markDetached 释放为 idle', async () => {
    await client.send('create', { name: 'a9', workdir: '/tmp', cli: 'claude-code' });
    await client.send('attach', { name: 'a9', pid: 9999 });
    daemon.registry.requestTakeover('a9', 'user-im');

    const res = await client.send('markDetached', { name: 'a9', exitReason: 'normal' });
    expect(res.ok).toBe(true);
    expect(daemon.registry.get('a9')?.status).toBe('idle');
  });
});
