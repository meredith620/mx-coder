import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodePlugin, getClaudeSessionPath } from '../../src/plugins/cli/claude-code.js';
import type { Session } from '../../src/types.js';

const plugin = new ClaudeCodePlugin();
let tmpWorkdir: string;
const session = {
  name: 'test',
  sessionId: 'uuid-123',
  cliPlugin: 'claude-code',
  workdir: '/tmp',
  status: 'idle',
  lifecycleStatus: 'active',
  initState: 'initialized',
  runtimeState: 'cold',
  revision: 0,
  spawnGeneration: 0,
  attachedPid: null,
  imWorkerPid: null,
  imWorkerCrashCount: 0,
  imBindings: [],
  messageQueue: [],
  createdAt: new Date(),
  lastActivityAt: new Date(),
} as Session;

describe('ClaudeCodePlugin', () => {
  beforeEach(() => {
    tmpWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-claude-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkdir, { recursive: true, force: true });
  });

  test('buildAttachCommand 对存在本地 session 的 session 生成 claude --resume', () => {
    const localSession = { ...session, workdir: tmpWorkdir } as Session;
    const sessionPath = getClaudeSessionPath(tmpWorkdir, localSession.sessionId);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{}\n', 'utf8');

    const { command, args } = plugin.buildAttachCommand(localSession);
    expect(command).toBe('claude');
    expect(args).toContain('--resume');
    expect(args).toContain('uuid-123');
  });

  test('buildAttachCommand 对不存在本地 session 的 session 生成 claude --session-id', () => {
    const { args } = plugin.buildAttachCommand({ ...session, workdir: tmpWorkdir, initState: 'initialized' } as Session);
    expect(args).toContain('--session-id');
    expect(args).toContain('uuid-123');
    expect(args).not.toContain('--resume');
  });

  test('buildAttachCommand 对 uninitialized session 生成 claude --session-id', () => {
    const { args } = plugin.buildAttachCommand({ ...session, workdir: tmpWorkdir, initState: 'uninitialized' } as Session);
    expect(args).toContain('--session-id');
    expect(args).toContain('uuid-123');
    expect(args).not.toContain('--resume');
  });

  test('buildIMWorkerCommand 包含常驻 worker 所需标志', () => {
    const bridgePath = '/tmp/mm-coder-mcp-bridge-uuid-123.js';
    const { command, args } = plugin.buildIMWorkerCommand(session, bridgePath);
    expect(command).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
  });

  test('buildIMWorkerCommand 通过 node bridge 脚本注入 permission prompt tool', () => {
    const bridgePath = '/tmp/mm-coder-mcp-bridge-uuid-123.js';
    const { args } = plugin.buildIMWorkerCommand(session, bridgePath);
    const ptIdx = args.indexOf('--permission-prompt-tool');

    expect(ptIdx).toBeGreaterThan(-1);
    expect(args[ptIdx + 1]).toBe(`node ${bridgePath}`);
  });

  test('buildIMMessageCommand 已从主插件契约退役', () => {
    expect('buildIMMessageCommand' in plugin).toBe(false);
    expect((plugin as { buildIMMessageCommand?: unknown }).buildIMMessageCommand).toBeUndefined();
  });

  test('generateSessionId 生成 UUID 格式', () => {
    const id = plugin.generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
