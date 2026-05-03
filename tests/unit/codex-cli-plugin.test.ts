import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodexCLIPlugin,
  extractCodexSessionIdFromPath,
  findLatestCodexSession,
  getCodexSessionPath,
  hasCodexSession,
} from '../../src/plugins/cli/codex-cli.js';
import type { Session } from '../../src/types.js';

const plugin = new CodexCLIPlugin();
const sessionId = '123e4567-e89b-12d3-a456-426614174000';
let tmpHome: string;
let tmpWorkdir: string;
let previousCodexHome: string | undefined;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    name: 'codex-demo',
    sessionId,
    cliPlugin: 'codex-cli',
    workdir: tmpWorkdir,
    sessionEnv: {},
    status: 'idle',
    lifecycleStatus: 'active',
    initState: 'initialized',
    runtimeState: 'cold',
    revision: 0,
    spawnGeneration: 0,
    attachedPid: null,
    imWorkerPid: null,
    imWorkerCrashCount: 0,
    streamVisibility: 'normal',
    imBindings: [],
    messageQueue: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

function writeRollout(id: string, cwd: string, mtime = new Date()): string {
  const dir = path.join(tmpHome, 'sessions', '2026', '05', '03');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-05-03T12-00-00-${id}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: 'session_meta',
      payload: { id, cwd },
    }),
    JSON.stringify({
      type: 'turn_context',
      payload: { cwd, model: 'gpt-5.2-codex' },
    }),
  ].join('\n') + '\n');
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

describe('CodexCLIPlugin', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-codex-home-'));
    tmpWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-codex-workdir-'));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpWorkdir, { recursive: true, force: true });
  });

  test('buildAttachCommand 对没有本地 rollout 的会话启动新 codex TUI', () => {
    const command = plugin.buildAttachCommand(makeSession());

    expect(command.command).toBe('codex');
    expect(command.args).toEqual([]);
  });

  test('buildAttachCommand 对存在本地 rollout 的会话使用 codex resume', () => {
    writeRollout(sessionId, tmpWorkdir);

    const command = plugin.buildAttachCommand(makeSession());

    expect(command.command).toBe('codex');
    expect(command.args).toEqual(['resume', sessionId]);
  });

  test('buildIMWorkerCommand 启动 resident bridge 而不是单次 exec wrapper', () => {
    const command = plugin.buildIMWorkerCommand(makeSession(), '/tmp/mx-coder-bridge.js');
    const rawConfig = command.args[command.args.length - 1];

    expect(command.command).toBeTruthy();
    expect(command.args.some((arg) => arg.includes('codex-worker-adapter'))).toBe(true);
    expect(command.args.join(' ')).not.toContain('exec');
    expect(typeof rawConfig).toBe('string');
    expect(JSON.parse(rawConfig!)).toMatchObject({
      sessionId,
      workdir: tmpWorkdir,
      bridgeScriptPath: '/tmp/mx-coder-bridge.js',
    });
  });

  test('rollout path lookup 根据 UUID 查找 Codex 本地会话', () => {
    const rolloutPath = writeRollout(sessionId, tmpWorkdir);

    expect(extractCodexSessionIdFromPath(rolloutPath)).toBe(sessionId);
    expect(getCodexSessionPath(sessionId, tmpHome)).toBe(rolloutPath);
    expect(hasCodexSession(sessionId, tmpHome)).toBe(true);
  });

  test('findLatestSessionId 只回填当前 workdir 中 attach 后产生的最新会话', () => {
    const oldId = '123e4567-e89b-12d3-a456-426614174001';
    const newId = '123e4567-e89b-12d3-a456-426614174002';
    writeRollout(oldId, tmpWorkdir, new Date('2026-05-03T00:00:00Z'));
    const latestPath = writeRollout(newId, tmpWorkdir, new Date('2026-05-03T01:00:00Z'));

    const match = findLatestCodexSession(tmpWorkdir, new Date('2026-05-03T00:30:00Z'), tmpHome);

    expect(match).toEqual({
      sessionId: newId,
      path: latestPath,
      mtimeMs: expect.any(Number),
    });
    expect(plugin.findLatestSessionId?.(makeSession(), new Date('2026-05-03T00:30:00Z'))).toBe(newId);
  });

  test('getSessionDiagnostics 返回 Codex 本地持久化状态', () => {
    const rolloutPath = writeRollout(sessionId, tmpWorkdir);

    expect(plugin.getSessionDiagnostics(makeSession())).toMatchObject({
      codexHome: tmpHome,
      localCodexSessionPath: rolloutPath,
      localCodexSessionExists: true,
      nextAttachMode: 'resume',
    });
  });

  test('generateSessionId 返回 UUID 格式的新 session id', () => {
    const generated = plugin.generateSessionId();

    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(generated).not.toBe(sessionId);
  });
});
