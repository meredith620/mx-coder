import * as readline from 'readline';
import type { IMPlugin } from '../types.js';
import type { MessageTarget, MessageContent, IncomingMessage, ApprovalRequest } from '../../types.js';

/**
 * StdioIMPlugin — reads incoming messages from stdin (one JSON per line),
 * writes outgoing messages to stdout (one JSON per line).
 *
 * Incoming line format (stdin):
 *   { "type": "message", "messageId": "...", "threadId": "...", "userId": "...", "text": "...", "dedupeKey": "..." }
 *
 * Outgoing line format (stdout):
 *   { "type": "send",   "target": {...}, "text": "..." }
 *   { "type": "live",   "messageId": "...", "target": {...}, "text": "..." }
 *   { "type": "update", "messageId": "...", "text": "..." }
 *   { "type": "approval", "target": {...}, "requestId": "...", "toolName": "...", "summary": "..." }
 */
export class StdioIMPlugin implements IMPlugin {
  private _handlers: Array<(msg: IncomingMessage) => void> = [];
  private _rl: readline.Interface | null = null;
  private _liveCounter = 0;
  private _input: NodeJS.ReadableStream;
  private _output: NodeJS.WritableStream;

  constructor(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
    this._input = input;
    this._output = output;
  }

  /** Start listening on stdin for incoming messages */
  start(): void {
    if (this._rl) return;
    this._rl = readline.createInterface({ input: this._input, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === 'message') {
          const incoming: IncomingMessage = {
            messageId: String(msg.messageId ?? ''),
            plugin: 'stdio',
            threadId: String(msg.threadId ?? ''),
            isTopLevel: !msg.threadId || msg.threadId === msg.messageId,
            userId: String(msg.userId ?? ''),
            text: String(msg.text ?? ''),
            createdAt: String(msg.createdAt ?? new Date().toISOString()),
            dedupeKey: String(msg.dedupeKey ?? msg.messageId ?? ''),
          };
          for (const h of this._handlers) h(incoming);
        }
      } catch { /* ignore non-JSON */ }
    });
  }

  stop(): void {
    this._rl?.close();
    this._rl = null;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this._handlers.push(handler);
  }

  private _write(obj: Record<string, unknown>): void {
    this._output.write(JSON.stringify(obj) + '\n');
  }

  private _toText(content: MessageContent): string {
    if (content.kind === 'text') return content.text;
    if (content.kind === 'markdown') return content.markdown;
    return content.url;
  }

  async sendMessage(target: MessageTarget, content: MessageContent): Promise<void> {
    this._write({ type: 'send', target, text: this._toText(content) });
  }

  async createLiveMessage(target: MessageTarget, content: MessageContent): Promise<string> {
    const messageId = `live-${++this._liveCounter}`;
    this._write({ type: 'live', messageId, target, text: this._toText(content) });
    return messageId;
  }

  async updateMessage(messageId: string, content: MessageContent): Promise<void> {
    this._write({ type: 'update', messageId, text: this._toText(content) });
  }

  async addReactions(messageId: string, emojis: string[]): Promise<void> {
    this._write({ type: 'reactions', messageId, emojis });
  }

  async listReactions(_messageId: string): Promise<Array<{ userId: string; emoji: string }>> {
    return [];
  }

  async requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<string | undefined> {
    const messageId = `approval-${++this._liveCounter}`;
    this._write({
      type: 'approval',
      messageId,
      target,
      requestId: request.requestId,
      toolName: request.toolName,
      summary: request.toolInputSummary,
      riskLevel: request.riskLevel,
      scopeOptions: request.scopeOptions,
    });
    return messageId;
  }
}
