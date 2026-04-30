import type { Session, MessageTarget, MessageContent, IncomingMessage, ApprovalRequest } from '../types.js';

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface CLIPlugin {
  buildAttachCommand(session: Session): CommandSpec;
  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec;
  generateSessionId(): string;

  /**
   * Get the name of this CLI plugin (e.g., "claude-code")
   */
  readonly name: string;

  /**
   * Get supported native commands in pipe mode
   * Returns array of command names that work with // prefix passthrough
   */
  getSupportedNativeCommands(): string[];
}

export interface LegacyIMMessageCLIPlugin extends CLIPlugin {
  buildIMMessageCommand(session: Session, prompt: string): CommandSpec;
}

export function hasLegacyIMMessageCommand(plugin: CLIPlugin): plugin is LegacyIMMessageCLIPlugin {
  return 'buildIMMessageCommand' in plugin && typeof (plugin as LegacyIMMessageCLIPlugin).buildIMMessageCommand === 'function';
}

export type ChannelStatusResult =
  | { kind: 'ok' }
  | { kind: 'deleted'; error: string }
  | { kind: 'forbidden'; error: string }
  | { kind: 'not_found'; error: string }
  | { kind: 'unknown_error'; error: string };

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
   * Create a dedicated conversation space when the platform supports channel-style session binding
   */
  createChannelConversation?(input: { channelId: string; teamId: string; isPrivate: boolean; userId?: string; sessionName?: string }): Promise<string>;

  /**
   * Update an existing live message
   */
  updateMessage(messageId: string, content: MessageContent): Promise<void>;

  /**
   * Send an approval request to the IM platform
   * Returns the interactive message id when the platform exposes one.
   */
  requestApproval(target: MessageTarget, request: ApprovalRequest): Promise<string | undefined>;

  /**
   * Add candidate reactions to an existing message when the platform supports it.
   */
  addReactions?(messageId: string, emojis: string[]): Promise<void>;

  /**
   * Read reactions for an existing message when the platform supports it.
   */
  listReactions?(messageId: string): Promise<Array<{ userId: string; emoji: string }>>;

  /**
   * Send a typing indicator when the IM platform supports it
   */
  sendTyping?(target: MessageTarget): Promise<void>;

  /**
   * Check if a channel is valid (exists and not deleted)
   */
  checkChannelStatus?(channelId: string): Promise<ChannelStatusResult>;

  /**
   * Graceful shutdown — close connections and release resources
   */
  disconnect?(): Promise<void>;
}
