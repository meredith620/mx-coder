import type { Session, MessageTarget, MessageContent, IncomingMessage, ApprovalRequest } from '../types.js';

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface CLIPlugin {
  buildAttachCommand(session: Session): CommandSpec;
  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec;
  generateSessionId(): string;
}

export interface LegacyIMMessageCLIPlugin extends CLIPlugin {
  buildIMMessageCommand(session: Session, prompt: string): CommandSpec;
}

export function hasLegacyIMMessageCommand(plugin: CLIPlugin): plugin is LegacyIMMessageCLIPlugin {
  return 'buildIMMessageCommand' in plugin && typeof (plugin as LegacyIMMessageCLIPlugin).buildIMMessageCommand === 'function';
}

export interface IMPlugin {
  /**
   * Register a callback to receive incoming messages from the IM platform
   */
  onMessage(handler: (msg: IncomingMessage) => void): void;

  /**
   * Send a message to the IM platform
   */
  sendMessage(target: MessageTarget, content: MessageContent): Promise<void>;

  /**
   * Create a live message that can be updated later (for streaming output)
   * Returns the messageId for subsequent updates
   */
  createLiveMessage(target: MessageTarget, content: MessageContent): Promise<string>;

  /**
   * Update an existing live message
   */
  updateMessage(messageId: string, content: MessageContent): Promise<void>;

  /**
   * Send an approval request to the IM platform
   */
  requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<void>;

  /**
   * Graceful shutdown — close connections and release resources
   */
  disconnect?(): Promise<void>;
}
