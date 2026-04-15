import { v4 as uuidv4 } from 'uuid';
import type { IMPlugin } from '../../src/plugins/types.js';
import type { MessageTarget, MessageContent, IncomingMessage, ApprovalRequest } from '../../src/types.js';

interface SentRecord {
  target: MessageTarget;
  content: MessageContent;
}

export class MockIMPlugin implements IMPlugin {
  private _handlers: Array<(msg: IncomingMessage) => void> = [];
  sent: SentRecord[] = [];
  liveMessages = new Map<string, string>(); // messageId → text content
  liveMessageTargets = new Map<string, MessageTarget>();
  approvalRequests: ApprovalRequest[] = [];

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this._handlers.push(handler);
  }

  simulateMessage(partial: { threadId: string; userId: string; text: string }): void {
    const msg: IncomingMessage = {
      messageId: uuidv4(),
      plugin: 'mock',
      threadId: partial.threadId,
      userId: partial.userId,
      text: partial.text,
      createdAt: new Date().toISOString(),
      dedupeKey: uuidv4(),
    };
    for (const h of this._handlers) h(msg);
  }

  async sendMessage(target: MessageTarget, content: MessageContent): Promise<void> {
    this.sent.push({ target, content });
  }

  async createLiveMessage(target: MessageTarget, content: MessageContent): Promise<string> {
    const msgId = uuidv4();
    const text = content.kind === 'text' ? content.text : content.kind === 'markdown' ? content.markdown : '';
    this.liveMessages.set(msgId, text);
    this.liveMessageTargets.set(msgId, target);
    return msgId;
  }

  async updateMessage(messageId: string, content: MessageContent): Promise<void> {
    const text = content.kind === 'text' ? content.text : content.kind === 'markdown' ? content.markdown : '';
    this.liveMessages.set(messageId, text);
  }

  async requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<void> {
    this.approvalRequests.push(request);
  }
}
