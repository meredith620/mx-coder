import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Session } from '../../types.js';
import type { CLIPlugin, CommandSpec } from '../types.js';

const MAX_ROLLOUT_FILES_TO_SCAN = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_ID_RE = /(?:^|\/)rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexSessionMatch {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME;
  if (configured && configured.trim()) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.codex');
}

export function getCodexSessionsRoot(codexHome = getCodexHome()): string {
  return path.join(codexHome, 'sessions');
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function walkRolloutFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_ROLLOUT_FILES_TO_SCAN) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
        if (files.length >= MAX_ROLLOUT_FILES_TO_SCAN) break;
      }
    }
  }
  return files;
}

export function extractCodexSessionIdFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  const match = ROLLOUT_ID_RE.exec(normalized);
  return match?.[1];
}

export function getCodexSessionPath(sessionId: string, codexHome = getCodexHome()): string | undefined {
  if (!UUID_RE.test(sessionId)) return undefined;
  const root = getCodexSessionsRoot(codexHome);
  return walkRolloutFiles(root).find((filePath) => extractCodexSessionIdFromPath(filePath) === sessionId);
}

export function hasCodexSession(sessionId: string, codexHome = getCodexHome()): boolean {
  return getCodexSessionPath(sessionId, codexHome) !== undefined;
}

function readRolloutCwd(filePath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }

  let cwd: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as { type?: unknown; payload?: unknown };
      if (!record.payload || typeof record.payload !== 'object') continue;
      const payload = record.payload as Record<string, unknown>;
      if ((record.type === 'session_meta' || record.type === 'turn_context') && typeof payload.cwd === 'string') {
        cwd = payload.cwd;
      }
    } catch {
      continue;
    }
  }
  return cwd;
}

export function findLatestCodexSession(workdir: string, since: Date, codexHome = getCodexHome()): CodexSessionMatch | undefined {
  const root = getCodexSessionsRoot(codexHome);
  const sinceMs = since.getTime();
  let best: CodexSessionMatch | undefined;

  for (const filePath of walkRolloutFiles(root)) {
    const sessionId = extractCodexSessionIdFromPath(filePath);
    if (!sessionId) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.mtimeMs + 1000 < sinceMs) continue;

    const rolloutCwd = readRolloutCwd(filePath);
    if (rolloutCwd && !samePath(rolloutCwd, workdir)) continue;

    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { sessionId, path: filePath, mtimeMs: stat.mtimeMs };
    }
  }

  return best;
}

function resolveResidentBridgeInvocation(): CommandSpec {
  const currentPath = fileURLToPath(import.meta.url);
  const currentExt = path.extname(currentPath) || '.js';
  const adapterPath = path.join(path.dirname(currentPath), `codex-worker-adapter${currentExt}`);

  if (currentExt === '.ts') {
    const localTsx = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    if (fs.existsSync(localTsx)) {
      return { command: localTsx, args: [adapterPath] };
    }
  }

  return { command: process.execPath, args: [...process.execArgv, adapterPath] };
}

export class CodexCLIPlugin implements CLIPlugin {
  readonly name = 'codex-cli';

  getSupportedNativeCommands(): string[] {
    return [];
  }

  buildAttachCommand(session: Session): CommandSpec {
    if (hasCodexSession(session.sessionId)) {
      return { command: 'codex', args: ['resume', session.sessionId] };
    }
    return { command: 'codex', args: [] };
  }

  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec {
    const adapter = resolveResidentBridgeInvocation();
    return {
      command: adapter.command,
      args: [
        ...adapter.args,
        JSON.stringify({
          sessionId: session.sessionId,
          workdir: session.workdir,
          bridgeScriptPath,
        }),
      ],
    };
  }

  generateSessionId(): string {
    return randomUUID();
  }

  getSessionDiagnostics(session: Session): Record<string, unknown> {
    const codexHome = getCodexHome();
    const sessionPath = getCodexSessionPath(session.sessionId, codexHome);
    const hasLocalSession = sessionPath !== undefined;
    return {
      codexHome,
      localCodexSessionPath: sessionPath ?? null,
      localCodexSessionExists: hasLocalSession,
      nextAttachMode: hasLocalSession ? 'resume' : 'new',
    };
  }

  findLatestSessionId(session: Session, since: Date): string | undefined {
    return findLatestCodexSession(session.workdir, since)?.sessionId;
  }
}
