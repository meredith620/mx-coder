import type { IMPlugin } from './plugins/types.js';
import type { MessageTarget } from './types.js';

const DEBOUNCE_MS = 500;

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

export class StreamToIM {
  private _plugin: IMPlugin;
  private _target: MessageTarget;
  private _messageId: string | null = null;
  private _turnMessageId: string | null = null;
  private _buffer = '';
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: IMPlugin, target: MessageTarget) {
    this._plugin = plugin;
    this._target = target;
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
      const text = content
        .filter((c: { type: string; text?: string }) => c.type === 'text')
        .map((c: { type: string; text?: string }) => c.text ?? '')
        .join('');

      if (!text) return;

      if (!this._messageId) {
        this._messageId = await this._plugin.createLiveMessage(this._target, { kind: 'text', text });
        this._buffer = text;
      } else {
        this._buffer += text;
        this._scheduleFlush();
      }
      return;
    }

    if (event.type === 'result') {
      await this._flush();
      this._messageId = null;
      this._turnMessageId = null;
      this._buffer = '';
      return;
    }

    if (event.type === 'error') {
      await this._flush();
    }
  }

  private _scheduleFlush(): void {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._flush();
    }, DEBOUNCE_MS);
  }

  private async _flush(): Promise<void> {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._messageId !== null) {
      await this._plugin.updateMessage(this._messageId, { kind: 'text', text: this._buffer });
    }
  }
}
