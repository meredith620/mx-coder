import type { IMPlugin, ChannelStatusResult } from './plugins/types.js';
import type { MessageTarget, StreamVisibility } from './types.js';

const DEBOUNCE_MS = 500;
const THINKING_MAX_CHARS = 2000;
const TOOL_RESULT_MAX_CHARS = 1200;

interface AssistantPayload {
  content?: Array<{ type: string; text?: string }>;
  message?: { content?: Array<{ type: string; text?: string }> };
}

interface AssistantEvent {
  type: 'assistant';
  messageId?: string;
  payload?: AssistantPayload;
  message?: { content?: Array<{ type: string; text?: string }> };
}

interface ResultEvent {
  type: 'result';
  messageId?: string;
  subtype?: string;
  result?: string;
}

interface ErrorEvent {
  type: 'error';
  messageId?: string;
  payload?: { message?: string };
}

type StreamEvent = AssistantEvent | ResultEvent | ErrorEvent | { type: string; messageId?: string; payload?: unknown };

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(已截断)` : text;
}

function collectPlainText(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPlainText(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('thinking' in record) return collectPlainText(record['thinking']);
    if ('text' in record) return collectPlainText(record['text']);
    if ('content' in record) return collectPlainText(record['content']);
    if ('result' in record) return collectPlainText(record['result']);
    if ('message' in record) return collectPlainText(record['message']);
    if ('stdout' in record) return collectPlainText(record['stdout']);
    if ('stderr' in record) return collectPlainText(record['stderr']);
    return Object.values(record).flatMap((item) => collectPlainText(item));
  }
  return [];
}

function extractPlainText(value: unknown): string {
  return collectPlainText(value).join('\n').trim();
}

export class StreamToIM {
  private _plugin: IMPlugin;
  private _target: MessageTarget;
  private _visibility: StreamVisibility;
  private _messageId: string | null = null;
  private _turnMessageId: string | null = null;
  private _buffer = '';
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _onTargetInvalid: ((target: MessageTarget, status: ChannelStatusResult) => Promise<void>) | undefined;

  constructor(plugin: IMPlugin, target: MessageTarget, visibility: StreamVisibility, onTargetInvalid?: (target: MessageTarget, status: ChannelStatusResult) => Promise<void>) {
    this._plugin = plugin;
    this._target = target;
    this._visibility = visibility;
    this._onTargetInvalid = onTargetInvalid;
  }

  async onEvent(event: StreamEvent): Promise<void> {
    if (event.type === 'assistant') {
      const turnId = event.messageId ?? 'unknown-turn';
      if (this._turnMessageId !== null && this._turnMessageId !== turnId) {
        await this._flush();
        this._messageId = null;
        this._buffer = '';
      }
      this._turnMessageId = turnId;

      const e = event as AssistantEvent;
      const content = e.payload?.content ?? e.payload?.message?.content ?? e.message?.content ?? [];
      const rendered = content
        .map((block) => this._renderAssistantBlock(block))
        .filter((block): block is string => Boolean(block))
        .join('');

      if (!rendered) return;

      if (!this._messageId) {
        try {
          this._messageId = await this._plugin.createLiveMessage(this._target, { kind: 'text', text: rendered });
        } catch (err) {
          await this._handleTargetError(err);
          return;
        }
        this._buffer = rendered;
      } else {
        this._buffer += rendered;
        this._scheduleFlush();
      }
      return;
    }

    if (event.type === 'result') {
      const result = (event as ResultEvent).result?.trim();
      if (this._visibility === 'verbose' && result) {
        this._buffer += `\n\n[result]\n${truncate(result, TOOL_RESULT_MAX_CHARS)}`;
      }
      await this._flush();
      this._messageId = null;
      this._turnMessageId = null;
      this._buffer = '';
      return;
    }

    if (event.type === 'error') {
      const message = (event as ErrorEvent).payload?.message?.trim();
      if (message) {
        this._buffer += `\n\n[error]\n${message}`;
      }
      await this._flush();
    }
  }

  private _renderAssistantBlock(block: { type: string; text?: string; [key: string]: unknown }): string {
    if (block.type === 'text') {
      return block.text ?? '';
    }
    if (block.type === 'thinking') {
      if (this._visibility === 'normal') return '';
      const thinking = truncate(extractPlainText(block['thinking'] ?? block.text), THINKING_MAX_CHARS);
      return thinking ? `\n\n[thinking]\n${thinking}` : '';
    }
    if (this._visibility !== 'verbose') {
      return '';
    }
    if (block.type === 'tool_use') {
      const input = block['input'] ?? block['tool_input'];
      const summary = truncate(extractPlainText(input), TOOL_RESULT_MAX_CHARS);
      return summary ? `\n\n[tool_use]\n${summary}` : '';
    }
    if (block.type === 'tool_result') {
      const content = block['content'] ?? block['result'] ?? block['stdout'] ?? block['stderr'] ?? block['text'];
      const summary = truncate(extractPlainText(content), TOOL_RESULT_MAX_CHARS);
      return summary ? `\n\n[tool_result]\n${summary}` : '';
    }
    return '';
  }

  private _scheduleFlush(): void {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._flush();
    }, DEBOUNCE_MS);
  }

  private async _handleTargetError(err: unknown): Promise<void> {
    if (!this._target.channelId || !this._plugin.checkChannelStatus || !this._onTargetInvalid) {
      throw err;
    }
    const status = await this._plugin.checkChannelStatus(this._target.channelId);
    if (status.kind === 'deleted' || status.kind === 'not_found' || status.kind === 'forbidden') {
      await this._onTargetInvalid(this._target, status);
      return;
    }
    throw err;
  }

  private async _flush(): Promise<void> {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._messageId !== null) {
      try {
        await this._plugin.updateMessage(this._messageId, { kind: 'text', text: this._buffer });
      } catch (err) {
        await this._handleTargetError(err);
      }
    }
  }
}
