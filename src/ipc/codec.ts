import { v4 as uuidv4 } from 'uuid';

// Error codes from SPEC §3.7
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNKNOWN_COMMAND',
  'SESSION_ALREADY_EXISTS',
  'SESSION_NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'WORKER_NOT_RUNNING',
  'WORKER_SPAWN_FAILED',
  'APPROVAL_TIMEOUT',
  'ACL_DENIED',
  'SESSION_BUSY',
  'SESSION_ARCHIVED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export interface IPCRequest {
  type: 'request';
  requestId: string;
  command: string;
  args: Record<string, unknown>;
  actor?: { source: string; userId?: string };
}

export interface IPCResponse {
  type: 'response';
  requestId: string;
  ok: true;
  data: Record<string, unknown>;
}

export interface IPCError {
  type: 'response';
  requestId: string;
  ok: false;
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export interface IPCPing {
  type: 'ping';
}

export interface IPCPong {
  type: 'pong';
}

export interface IPCEvent {
  type: 'event';
  event: string;
  data: Record<string, unknown>;
}

export type IPCMessage = IPCRequest | IPCResponse | IPCError | IPCPing | IPCPong | IPCEvent;

export function encodeRequest(
  command: string,
  args: Record<string, unknown> = {},
  actor?: IPCRequest['actor'],
): string {
  const msg: IPCRequest = { type: 'request', requestId: uuidv4(), command, args };
  if (actor) msg.actor = actor;
  return JSON.stringify(msg);
}

export function encodeResponse(requestId: string, data: Record<string, unknown>): string {
  const msg: IPCResponse = { type: 'response', requestId, ok: true, data };
  return JSON.stringify(msg);
}

export function encodeError(
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): string {
  const msg: IPCError = { type: 'response', requestId, ok: false, error: { code, message } };
  if (details) msg.error.details = details;
  return JSON.stringify(msg);
}

export function encodePing(): string {
  return JSON.stringify({ type: 'ping' } satisfies IPCPing);
}

export function encodePong(): string {
  return JSON.stringify({ type: 'pong' } satisfies IPCPong);
}

export function encodeEvent(event: string, data: Record<string, unknown>): string {
  const msg: IPCEvent = { type: 'event', event, data };
  return JSON.stringify(msg);
}

export function decodeMessage(line: string): IPCMessage {
  const parsed = JSON.parse(line) as IPCMessage;
  return parsed;
}
