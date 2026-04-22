import { v4 as uuidv4 } from 'uuid';
import type { IMPlugin } from '../../src/plugins/types.js';
import type { MessageTarget, MessageContent, IncomingMessage, ApprovalRequest } from '../../src/types.js';

interface SentRecord {
  target: MessageTarget;
  content: MessageContent;
}

interface TypingRecord {
  target: MessageTarget;
  at: number;
}

interface CreatedConversationRecord {
  channelId: string;
  kind: 'thread' | 'channel';
  teamId?: string;
  isPrivate?: boolean;
}

interface ApprovalDecisionRecord {
  requestId: string;
  decision: 'approved' | 'denied' | 'cancelled';
  scope?: 'once' | 'session';
}

interface ApprovalInteractionRecord {
  requestId: string;
  messageId: string;
}

interface ReactionRecord {
  messageId: string;
  emojis: string[];
}

export class MockIMPlugin implements IMPlugin {
  private _handlers: Array<(msg: IncomingMessage) => void> = [];
  sent: SentRecord[] = [];
  liveMessages = new Map<string, string>(); // messageId → text content
  liveMessageTargets = new Map<string, MessageTarget>();
  approvalRequests: ApprovalRequest[] = [];
  approvalTargets: MessageTarget[] = [];
  approvalDecisions: ApprovalDecisionRecord[] = [];
  approvalInteractions: ApprovalInteractionRecord[] = [];
  reactionAdds: ReactionRecord[] = [];
  typingCalls: TypingRecord[] = [];
  createdConversations: CreatedConversationRecord[] = [];
  failCreateLiveMessage = false;
  createLiveMessageError = new Error('createLiveMessage failed');

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this._handlers.push(handler);
  }

  simulateMessage(partial: { threadId: string; userId: string; text: string }): void {
    const msg: IncomingMessage = {
      messageId: uuidv4(),
      plugin: 'mock',
      threadId: partial.threadId,
      isTopLevel: false,
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
    if (this.failCreateLiveMessage) {
      throw this.createLiveMessageError;
    }
    const msgId = uuidv4();
    const text = content.kind === 'text' ? content.text : content.kind === 'markdown' ? content.markdown : '';
    this.liveMessages.set(msgId, text);
    this.liveMessageTargets.set(msgId, target);
    this.createdConversations.push({ channelId: target.channelId ?? '', kind: 'thread' });
    return msgId;
  }

  async createChannelConversation(input: { channelId: string; teamId: string; isPrivate: boolean; }): Promise<string> {
    const conversationId = uuidv4();
    this.createdConversations.push({
      channelId: input.channelId,
      kind: 'channel',
      teamId: input.teamId,
      isPrivate: input.isPrivate,
    });
    return conversationId;
  }

  async updateMessage(messageId: string, content: MessageContent): Promise<void> {
    const text = content.kind === 'text' ? content.text : content.kind === 'markdown' ? content.markdown : '';
    this.liveMessages.set(messageId, text);
  }

  async addReactions(messageId: string, emojis: string[]): Promise<void> {
    this.reactionAdds.push({ messageId, emojis });
  }

  async listReactions(messageId: string): Promise<Array<{ userId: string; emoji: string }>> {
    const match = this.approvalInteractions.find((item) => item.messageId === messageId);
    if (!match) return [];
    const decision = this.approvalDecisions.find((item) => item.requestId === match.requestId && item.decision === 'approved');
    if (!decision) return [];
    return [{ userId: 'mock-user', emoji: decision.scope === 'session' ? '✅' : '👍' }];
  }

  async requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<string | undefined> {
    this.approvalTargets.push(target);
    this.approvalRequests.push(request);
    const messageId = uuidv4();
    this.approvalInteractions.push({ requestId: request.requestId, messageId });
    await this.addReactions(messageId, ['👍', '✅', '👎', '⏹️']);
    return messageId;
  }

  recordApprovalDecision(requestId: string, decision: 'approved' | 'denied' | 'cancelled', scope?: 'once' | 'session'): void {
    this.approvalDecisions.push({ requestId, decision, scope });
  }

  async sendTyping(target: MessageTarget): Promise<void> {
    this.typingCalls.push({ target, at: Date.now() });
  }
}
