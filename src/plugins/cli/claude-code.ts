import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import type { Readable } from 'stream';
import type { Session, CLIEvent, StreamCursor } from '../../types.js';
import type { CLIPlugin, CommandSpec } from '../types.js';

export function getClaudeProjectPath(workdir: string): string {
  const normalizedWorkdir = path.resolve(workdir).replace(/[\\/]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', normalizedWorkdir);
}

export function getClaudeSessionPath(workdir: string, sessionId: string): string {
  return path.join(getClaudeProjectPath(workdir), `${sessionId}.jsonl`);
}

export function hasClaudeSession(workdir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  return fs.existsSync(getClaudeSessionPath(workdir, sessionId));
}

export class ClaudeCodePlugin implements CLIPlugin {
  /**
   * 真实恢复依据不是 initState，而是 Claude 本地 session 文件是否存在。
   * 这样可覆盖“打开 TUI 但未产生任何可恢复对话”这类场景。
   */
  private _resumeArgs(session: Session): string[] {
    if (hasClaudeSession(session.workdir, session.sessionId)) {
      return ['--resume', session.sessionId];
    }
    return ['--session-id', session.sessionId];
  }

  buildAttachCommand(session: Session): CommandSpec {
    return {
      command: 'claude',
      args: this._resumeArgs(session),
    };
  }

  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec {
    return {
      command: 'claude',
      args: [
        '-p',
        ...this._resumeArgs(session),
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-prompt-tool', `node ${bridgeScriptPath}`,
      ],
    };
  }

  generateSessionId(): string {
    return randomUUID();
  }
}

export async function* parseStream(
  stream: Readable,
  cursor?: StreamCursor
): AsyncGenerator<CLIEvent> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // 先收集所有原始行
  const raws: any[] = [];
  let sessionId: string | null = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw.type === 'system' && raw.message?.session_id) {
      sessionId = raw.message.session_id;
    }
    raws.push(raw);
  }

  if (!cursor) {
    // 无 cursor：全量输出
    for (const raw of raws) {
      yield parseRawEvent(raw, sessionId || 'unknown');
    }
    return;
  }

  // cursor miss 检测 1：sessionId 不一致 → 全量输出
  if (sessionId && cursor.sessionId !== sessionId) {
    for (const raw of raws) {
      yield parseRawEvent(raw, sessionId);
    }
    return;
  }

  // cursor miss 检测 2：lastMessageId 不在流中 → 全量输出
  const messageIds = raws.map(r => r.message?.id).filter(Boolean);
  if (!messageIds.includes(cursor.lastMessageId)) {
    for (const raw of raws) {
      yield parseRawEvent(raw, sessionId || 'unknown');
    }
    return;
  }

  // 正常 cursor 过滤：跳过 waterline 及之前的事件
  let foundWaterline = false;
  for (const raw of raws) {
    const messageId = raw.message?.id;
    if (!foundWaterline) {
      if (messageId === cursor.lastMessageId) {
        foundWaterline = true;
      }
      continue; // 跳过 waterline 本身及之前
    }
    yield parseRawEvent(raw, sessionId || 'unknown');
  }
}

function parseRawEvent(raw: any, sessionId: string): CLIEvent {
  const messageId = raw.message?.id || 'unknown';
  const type = raw.type;

  switch (type) {
    case 'system':
      return {
        type: 'system',
        sessionId,
        messageId,
        payload: raw.message || {},
      };

    case 'assistant':
      return {
        type: 'assistant',
        sessionId,
        messageId,
        payload: raw.message || {},
      };

    case 'user':
      return {
        type: 'user',
        sessionId,
        messageId,
        payload: raw.message || {},
      };

    case 'result':
      return {
        type: 'result',
        sessionId,
        messageId,
        subtype: raw.subtype || 'success',
        is_error: raw.is_error || false,
        result: raw.result || '',
      };

    case 'attachment':
      return {
        type: 'attachment',
        sessionId,
        messageId,
        payload: raw.message || {},
      };

    case 'last-prompt':
      return {
        type: 'last-prompt',
        sessionId,
        messageId,
        payload: raw.message || {},
      };

    case 'queue-operation':
      return {
        type: 'queue-operation',
        sessionId,
        messageId,
        payload: raw.message || {},
      };

    default:
      return {
        type: 'unknown',
        sessionId,
        messageId,
        rawType: type,
        payload: raw.message || {},
      };
  }
}
