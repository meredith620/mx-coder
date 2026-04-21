import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { SessionRegistry } from '../../src/session-registry.js';
import { determineRestoreAction } from '../../src/restore-action.js';
import type { CommandSpec, LegacyIMMessageCLIPlugin } from '../../src/plugins/types.js';
import type { Session, QueuedMessage } from '../../src/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock CLI plugin that writes stdin to a temp file
class EchoCLIPlugin implements LegacyIMMessageCLIPlugin {
  tmpFile: string;

  constructor(tmpFile: string) {
    this.tmpFile = tmpFile;
  }

  buildAttachCommand(session: Session): CommandSpec {
    return { command: 'cat', args: [] };
  }

  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec {
    // Write stdin to tmpFile
    return {
      command: 'bash',
      args: ['-c', `cat > ${this.tmpFile}`],
    };
  }

  buildIMMessageCommand(session: Session, prompt: string): CommandSpec {
    return { command: 'cat', args: [] };
  }

  generateSessionId(): string {
    return 'mock-session-id';
  }
}

class SleepCLIPlugin implements LegacyIMMessageCLIPlugin {
  buildAttachCommand(session: Session): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  buildIMMessageCommand(session: Session, prompt: string): CommandSpec {
    return { command: 'sleep', args: ['60'] };
  }

  generateSessionId(): string {
    return 'mock-session-id';
  }
}

describe('message delivery', () => {
  let registry: SessionRegistry;
  let tmpDir: string;

  beforeEach(() => {
    registry = new SessionRegistry();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sendMessage 写入正确 JSONL 格式到 stdin', async () => {
    const tmpFile = path.join(tmpDir, 'stdin.jsonl');
    const plugin = new EchoCLIPlugin(tmpFile);
    const session = registry.create('test', { workdir: tmpDir, cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(plugin, registry);

    await mgr.spawn(session);
    await mgr.sendMessage('test', 'Hello, Claude');

    // Wait for write to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    const content = fs.readFileSync(tmpFile, 'utf8').trim();
    const written = JSON.parse(content);
    expect(written.type).toBe('user');
    expect(written.message.content[0].text).toBe('Hello, Claude');

    await mgr.terminate('test');
  });

  test('懒启动：首条消息时 spawn IM worker', async () => {
    const plugin = new SleepCLIPlugin();
    const session = registry.create('test', { workdir: tmpDir, cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(plugin, registry);

    expect(registry.get('test')!.imWorkerPid).toBeNull();

    await mgr.sendMessage('test', 'Hello');

    expect(registry.get('test')!.imWorkerPid).not.toBeNull();

    await mgr.terminate('test');
  });


  test('pre-warm：attach 退出后立即 spawn IM worker', async () => {
    const plugin = new SleepCLIPlugin();
    const session = registry.create('test', { workdir: tmpDir, cliPlugin: 'mock' });
    const mgr = new IMWorkerManager(plugin, registry);

    // Simulate detach event
    await mgr.onDetach('test');

    // After detach, imWorkerPid should be set (pre-warm)
    expect(registry.get('test')!.imWorkerPid).not.toBeNull();

    await mgr.terminate('test');
  });
});

describe('dedupeKey dedup', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.create('test', { workdir: '/tmp', cliPlugin: 'mock' });
  });

  test('相同 dedupeKey 的消息不重复入队', () => {
    const msg = { text: 'hello', dedupeKey: 'mattermost:thread-1:msg-abc' };
    registry.enqueueIMMessage('test', msg);
    registry.enqueueIMMessage('test', msg); // same dedupeKey

    const s = registry.get('test')!;
    expect(s.messageQueue).toHaveLength(1);
  });

  test('相同 dedupeKey 的消息在执行中时返回已存在状态引用', () => {
    const existing: QueuedMessage = {
      messageId: 'msg-1',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'hello',
      status: 'running',
      correlationId: 'corr-1',
      dedupeKey: 'mattermost:thread-1:msg-abc',
      enqueuePolicy: 'auto_after_detach',
    };
    registry['_sessions'].get('test')!.messageQueue.push(existing);

    const result = registry.enqueueIMMessage('test', {
      text: 'hello',
      dedupeKey: 'mattermost:thread-1:msg-abc',
    });

    expect(result.alreadyExists).toBe(true);
    expect(result.existingStatus).toBe('running');
  });
});

describe('restore action matrix', () => {
  test('低风险+无审批+未完成消息 → restoreAction=replay', () => {
    const msg: Partial<QueuedMessage> = {
      messageId: 'm1',
      dedupeKey: 'k1',
      status: 'running',
      enqueuePolicy: 'auto_after_detach',
    };
    const action = determineRestoreAction(msg as QueuedMessage, { hasApprovalContext: false, isHighRisk: false });
    expect(action).toBe('replay');
  });

  test('带审批上下文的消息 → restoreAction=confirm', () => {
    const msg: Partial<QueuedMessage> = {
      messageId: 'm2',
      dedupeKey: 'k2',
      status: 'waiting_approval',
      enqueuePolicy: 'auto_after_detach',
    };
    const action = determineRestoreAction(msg as QueuedMessage, { hasApprovalContext: true, isHighRisk: false });
    expect(action).toBe('confirm');
  });

  test('高风险消息 → restoreAction=discard', () => {
    const msg: Partial<QueuedMessage> = {
      messageId: 'm3',
      dedupeKey: 'k3',
      status: 'running',
      enqueuePolicy: 'auto_after_detach',
    };
    const action = determineRestoreAction(msg as QueuedMessage, { hasApprovalContext: false, isHighRisk: true });
    expect(action).toBe('discard');
  });
});

describe('replayMessage', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.create('test', { workdir: '/tmp', cliPlugin: 'mock' });
    const original: QueuedMessage = {
      messageId: 'm1',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'hello',
      status: 'failed',
      correlationId: 'corr-1',
      dedupeKey: 'k1',
      enqueuePolicy: 'auto_after_detach',
    };
    registry['_sessions'].get('test')!.messageQueue.push(original);
  });

  test('replay 时写入 replayOf 指针', () => {
    const replayed = registry.replayMessage('test', 'k1');
    expect(replayed.replayOf).toBe('k1');
    expect(replayed.dedupeKey).not.toBe('k1'); // new dedupeKey
  });
});
