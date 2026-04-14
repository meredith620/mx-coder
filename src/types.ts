// Core domain types for mm-coder

export type SessionStatus =
  | 'idle'
  | 'attach_pending'
  | 'attached'
  | 'im_processing'
  | 'approval_pending'
  | 'takeover_pending'
  | 'recovering'
  | 'error';

export type LifecycleStatus = 'active' | 'stale' | 'archived';

export type InitState = 'uninitialized' | 'initializing' | 'initialized' | 'init_failed';

export type Capability = 'read_only' | 'file_write' | 'shell_dangerous' | 'network_destructive';

export const ALL_SESSION_STATUSES: readonly SessionStatus[] = [
  'idle',
  'attach_pending',
  'attached',
  'im_processing',
  'approval_pending',
  'takeover_pending',
  'recovering',
  'error',
] as const;

export interface IMBinding {
  plugin: string;
  threadId: string;
  channelId?: string;
  createdAt: string;
}

export interface QueuedMessage {
  messageId: string;
  threadId: string;
  userId: string;
  content: string;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed';
  correlationId: string;
  dedupeKey: string;
  enqueuePolicy: 'auto_after_detach' | 'manual_retry';
  restoreAction?: 'replay' | 'discard' | 'confirm';
  replayOf?: string;
  approvalState?: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
}

export interface Session {
  name: string;
  sessionId: string;
  cliPlugin: string;
  workdir: string;

  status: SessionStatus;
  lifecycleStatus: LifecycleStatus;
  initState: InitState;

  revision: number;
  spawnGeneration: number;

  lastExitReason?: 'normal' | 'taken_over' | 'cli_crash' | 'recovered';
  attachedPid: number | null;
  imWorkerPid: number | null;
  imWorkerCrashCount: number;
  imBindings: IMBinding[];
  messageQueue: QueuedMessage[];
  createdAt: Date;
  lastActivityAt: Date;
}

export interface StreamCursor {
  lastMessageId: string;
  sessionId: string;
}

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'file'; name: string; mime: string; url: string };

export interface MessageTarget {
  plugin: string;
  channelId?: string;
  threadId: string;
  userId?: string;
}

export interface IncomingMessage {
  messageId: string;
  plugin: string;
  channelId?: string;
  threadId: string;
  userId: string;
  text: string;
  createdAt: string;
  dedupeKey: string;
}

export interface ApprovalContext {
  sessionId: string;
  sessionName: string;
  messageId: string;
  correlationId: string;
  toolUseId: string;
  toolName: string;
  capability: Capability;
  operatorId: string;
  requestId: string;
}

export interface ApprovalRequest {
  requestId: string;
  sessionName: string;
  messageId: string;
  toolName: string;
  toolInputSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  capability: Capability;
  scopeOptions: Array<'once' | 'session'>;
  timeoutSeconds: number;
}

export interface ApprovalResult {
  requestId: string;
  decision: 'approved' | 'denied' | 'expired' | 'cancelled';
  scope: 'once' | 'session';
  operatorId?: string;
  decidedAt?: string;
  reason?: string;
}

export interface PermissionConfig {
  autoAllowCapabilities: Capability[];
  autoAskCapabilities: Capability[];
  autoDenyCapabilities: Capability[];
  autoDenyPatterns: string[];
  timeoutSeconds: number;
}

// CLIEvent types (stream-json output from claude -p)
export interface CLISystemEvent {
  type: 'system';
  sessionId: string;
  messageId: string;
  payload: { session_id: string; tools: unknown[]; [key: string]: unknown };
}

export interface CLIAssistantEvent {
  type: 'assistant';
  sessionId: string;
  messageId: string;
  payload: { content: CLIBlock[]; [key: string]: unknown };
}

export interface CLIUserEvent {
  type: 'user';
  sessionId: string;
  messageId: string;
  payload: { content: CLIBlock[]; [key: string]: unknown };
}

export interface CLIResultEvent {
  type: 'result';
  sessionId: string;
  messageId: string;
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
}

export interface CLIAttachmentEvent {
  type: 'attachment';
  sessionId: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export interface CLILastPromptEvent {
  type: 'last-prompt';
  sessionId: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export interface CLIQueueOpEvent {
  type: 'queue-operation';
  sessionId: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export interface CLIUnknownEvent {
  type: 'unknown';
  sessionId: string;
  messageId: string;
  rawType: string;
  payload: Record<string, unknown>;
}

export type CLIEvent =
  | CLISystemEvent
  | CLIAssistantEvent
  | CLIUserEvent
  | CLIResultEvent
  | CLIAttachmentEvent
  | CLILastPromptEvent
  | CLIQueueOpEvent
  | CLIUnknownEvent;

export interface CLIBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  [key: string]: unknown;
}

/**
 * Format a requestId for approval correlation.
 * Format: <sessionId>:<messageId>:<toolUseId>:<nonce>
 */
export function formatRequestId(
  sessionId: string,
  messageId: string,
  toolUseId: string,
  nonce: string,
): string {
  return `${sessionId}:${messageId}:${toolUseId}:${nonce}`;
}
