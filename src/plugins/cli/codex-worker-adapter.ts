import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

interface AdapterConfig {
  sessionId: string;
  workdir: string;
  bridgeScriptPath?: string;
}

type JsonRecord = Record<string, unknown>;

interface Transport {
  request<T = unknown>(method: string, params?: JsonRecord): Promise<T>;
  notify(method: string, params?: JsonRecord): void;
  onNotification(handler: (message: JsonRecord) => void): void;
  close(): Promise<void>;
}

interface Deps {
  spawnAppServer?: (socketPath: string) => ChildProcess;
  connectTransport?: (socketPath: string) => Promise<Transport>;
  createSocketPath?: (sessionId: string) => string;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

interface ThreadResult {
  id: string;
  payload: JsonRecord;
}

interface TurnResult {
  id: string;
  payload: JsonRecord;
}

function writeJsonLine(value: JsonRecord, write: (line: string) => void = (line) => process.stdout.write(line)): void {
  write(`${JSON.stringify(value)}\n`);
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeMethodName(value: unknown): string {
  return (asString(value) ?? '').replace(/\//g, '.');
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => textFromContent(entry))
      .filter(Boolean)
      .join('');
  }
  const record = asRecord(value);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.command === 'string') return record.command;
  if (typeof record.stdout === 'string') return record.stdout;
  if (typeof record.stderr === 'string') return record.stderr;
  if ('content' in record) return textFromContent(record.content);
  if ('result' in record) return textFromContent(record.result);
  if ('summary' in record) return textFromContent(record.summary);
  if ('output' in record) return textFromContent(record.output);
  if ('thinking' in record) return textFromContent(record.thinking);
  return Object.values(record).map((entry) => textFromContent(entry)).filter(Boolean).join('\n');
}

function summarizeItem(item: JsonRecord): string {
  for (const key of ['text', 'message', 'command', 'stdout', 'stderr', 'summary', 'output']) {
    const text = textFromContent(item[key]);
    if (text) return text;
  }
  return textFromContent(item.result) || textFromContent(item.content) || textFromContent(item.thinking);
}

function extractThread(result: unknown): ThreadResult | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  const thread = asRecord(record.thread) ?? record;
  const id = asString(thread.id);
  if (!id) return undefined;
  return { id, payload: thread };
}

function extractTurn(result: unknown): TurnResult | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  const turn = asRecord(record.turn) ?? record;
  const id = asString(turn.id);
  if (!id) return undefined;
  return { id, payload: turn };
}

function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread.*(not found|unknown|missing|invalid|does not exist)/i.test(message);
}

function normalizeItem(item: JsonRecord, turnId: string): JsonRecord | undefined {
  const type = asString(item.type) ?? '';
  if (type === 'agent_message' || type === 'agentMessage') {
    const text = summarizeItem(item);
    if (!text) return undefined;
    return { type: 'assistant', message: { id: turnId, content: [{ type: 'text', text }] } };
  }
  if (type === 'reasoning') {
    const text = summarizeItem(item);
    if (!text) return undefined;
    return { type: 'assistant', message: { id: turnId, content: [{ type: 'thinking', thinking: text }] } };
  }
  const text = summarizeItem(item);
  if (!text) return undefined;
  return { type: 'assistant', message: { id: turnId, content: [{ type: 'text', text }] } };
}

function normalizeEvent(raw: JsonRecord, fallbackThreadId: string, fallbackTurnId?: string): JsonRecord | undefined {
  const method = normalizeMethodName(raw.method ?? raw.type);
  const params = asRecord(raw.params);
  const result = asRecord(raw.result);

  if (method === 'thread.started') {
    const thread = extractThread(params ?? result);
    const threadId = thread?.id;
    if (!threadId) return undefined;
    return {
      type: 'system',
      message: {
        id: threadId,
        session_id: threadId,
        thread_id: threadId,
        tools: [],
        payload: thread?.payload ?? {},
      },
    };
  }

  if (method === 'turn.started') {
    const turn = extractTurn(params ?? result);
    const threadId = asString(params?.threadId) ?? asString(params?.thread_id) ?? asString(result?.threadId) ?? asString(result?.thread_id);
    const turnId = turn?.id ?? fallbackTurnId;
    if (!turnId || !threadId) return undefined;
    if (!turnId) return undefined;
    return {
      type: 'system',
      message: {
        id: turnId,
        session_id: threadId,
        thread_id: threadId,
        turn_id: turnId,
        tools: [],
        payload: turn?.payload ?? {},
      },
    };
  }

  if (method === 'item.started' || method === 'item.updated' || method === 'item.completed') {
    const item = asRecord(params?.item ?? raw.item);
    if (!item) return undefined;
    const turnId = asString(params?.turnId) ?? asString(params?.turn_id) ?? asString(item.turnId) ?? asString(item.turn_id) ?? fallbackTurnId ?? fallbackThreadId;
    if (!turnId) return undefined;
    return normalizeItem(item, turnId);
  }

  if (method === 'turn.completed' || method === 'turn.failed') {
    const turn = extractTurn(params?.turn ?? result ?? params);
    const turnId = asString(params?.turnId) ?? asString(params?.turn_id) ?? turn?.id ?? fallbackTurnId ?? fallbackThreadId;
    if (!turnId) return undefined;
    const status = asString(turn?.payload.status) ?? (method === 'turn.failed' ? 'failed' : 'completed');
    const error = asRecord(params?.error ?? result?.error);
    const message = asString(error?.message) ?? (status === 'failed' ? 'Codex turn failed' : '');
    return {
      type: 'result',
      message: { id: turnId },
      subtype: status === 'failed' ? 'error' : 'success',
      is_error: status === 'failed',
      result: message,
    };
  }

  if (method === 'warning') {
    const threadId = asString(params?.threadId) ?? asString(params?.thread_id) ?? asString(result?.threadId) ?? asString(result?.thread_id);
    if (!threadId) return undefined;
    return {
      type: 'system',
      message: {
        id: threadId,
        session_id: threadId,
        thread_id: threadId,
        tools: [],
        warning: asString(params?.message) ?? 'Codex warning',
      },
    };
  }

  if (method === 'error') {
    const turnId = fallbackTurnId ?? fallbackThreadId;
    return {
      type: 'result',
      message: { id: turnId },
      subtype: 'error',
      is_error: true,
      result: asString(params?.message) ?? asString(raw.message) ?? 'Codex error',
    };
  }

  return undefined;
}

function defaultSocketPath(sessionId: string): string {
  return path.join(os.tmpdir(), `mx-coder-codex-${sessionId}-${process.pid}.sock`);
}

class JsonLineTransport implements Transport {
  private readonly _socket: net.Socket;
  private readonly _handlers = new Set<(message: JsonRecord) => void>();
  private readonly _pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private _buffer = '';
  private _nextId = 1;

  constructor(socket: net.Socket) {
    this._socket = socket;
    this._socket.on('data', (chunk) => {
      this._buffer += chunk.toString('utf8');
      this._drain();
    });
    this._socket.on('error', (error) => {
      for (const pending of this._pending.values()) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this._pending.clear();
    });
  }

  onNotification(handler: (message: JsonRecord) => void): void {
    this._handlers.add(handler);
  }

  async request<T = unknown>(method: string, params?: JsonRecord): Promise<T> {
    const id = String(this._nextId++);
    const payload = { jsonrpc: '2.0', id, method, params };
    return await new Promise<T>((resolve, reject) => {
      this._pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this._socket.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (error) {
          this._pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params?: JsonRecord): void {
    const payload = { jsonrpc: '2.0', method, params };
    this._socket.write(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this._socket.once('close', () => resolve());
      this._socket.end();
    });
  }

  private _drain(): void {
    let newlineIndex = this._buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this._buffer.slice(0, newlineIndex).trim();
      this._buffer = this._buffer.slice(newlineIndex + 1);
      newlineIndex = this._buffer.indexOf('\n');
      if (!line) continue;

      let message: JsonRecord;
      try {
        message = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (typeof message.id === 'string' || typeof message.id === 'number') {
        const pending = this._pending.get(String(message.id));
        if (!pending) continue;
        this._pending.delete(String(message.id));
        if ('error' in message && message.error) {
          const error = asRecord(message.error);
          pending.reject(new Error(asString(error?.message) ?? 'JSON-RPC request failed'));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      const method = asString(message.method);
      if (!method) continue;
      const notification: JsonRecord = { method, params: asRecord(message.params) ?? {} };
      for (const handler of this._handlers) {
        handler(notification);
      }
    }
  }
}

function defaultSpawnAppServer(socketPath: string): ChildProcess {
  return spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function defaultConnectTransport(socketPath: string): Promise<Transport> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const socket = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return new JsonLineTransport(socket);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function extractPromptFromWorkerInput(line: string): string {
  const parsed = JSON.parse(line) as { message?: { content?: unknown }; content?: unknown };
  return textFromContent(parsed.message?.content ?? parsed.content);
}

export function normalizeCodexExecEvent(raw: JsonRecord, fallbackMessageId: string): JsonRecord | undefined {
  return normalizeEvent(raw, fallbackMessageId);
}

export class CodexResidentBridge {
  private readonly _config: AdapterConfig;
  private readonly _deps: Required<Deps>;
  private readonly _socketPath: string;
  private _backend: ChildProcess | null = null;
  private _transport: Transport | null = null;
  private _threadId: string | null = null;
  private _turnId: string | null = null;
  private _resumeAttempted = false;
  private _turnCompletion: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private _closing = false;

  constructor(config: AdapterConfig, deps: Deps = {}) {
    this._config = config;
    this._deps = {
      spawnAppServer: deps.spawnAppServer ?? defaultSpawnAppServer,
      connectTransport: deps.connectTransport ?? defaultConnectTransport,
      createSocketPath: deps.createSocketPath ?? defaultSocketPath,
      writeStdout: deps.writeStdout ?? ((line) => process.stdout.write(line)),
      writeStderr: deps.writeStderr ?? ((line) => process.stderr.write(line)),
    };
    this._socketPath = this._deps.createSocketPath(config.sessionId);
  }

  async close(): Promise<void> {
    this._closing = true;
    if (this._transport) {
      try {
        await this._transport.close();
      } catch {
        // ignore transport shutdown errors
      }
      this._transport = null;
    }
    if (this._backend && this._backend.exitCode === null) {
      this._backend.kill('SIGTERM');
    }
    this._backend = null;
  }

  async processPrompt(prompt: string): Promise<void> {
    const transport = await this._ensureTransport();
    const completion = new Promise<void>((resolve, reject) => {
      this._turnCompletion = { resolve, reject };
    });

    try {
      const threadId = await this._ensureThread(transport);
      const turnId = await this._startTurn(transport, threadId, prompt);
      await completion;
      if (this._turnId === turnId) {
        this._turnId = null;
      }
    } catch (error) {
      this._turnCompletion = null;
      this._turnId = null;
      throw error;
    }
  }

  private async _ensureTransport(): Promise<Transport> {
    if (this._transport) return this._transport;

    try {
      this._transport = await this._deps.connectTransport(this._socketPath);
    } catch {
      this._backend = this._deps.spawnAppServer(this._socketPath);
      if (this._backend.stdout) {
        this._backend.stdout.on('data', (chunk) => this._deps.writeStdout(chunk.toString('utf8')));
      }
      if (this._backend.stderr) {
        this._backend.stderr.on('data', (chunk) => this._deps.writeStderr(chunk.toString('utf8')));
      }
      this._backend.once('exit', (code) => {
        if (this._closing) return;
        if (code !== 0 && code !== null) {
          this._fatal(new Error(`codex app-server exited with code ${code}`));
        }
      });
      this._transport = await this._deps.connectTransport(this._socketPath);
    }

    this._transport.onNotification((message) => this._handleNotification(message));
    await this._transport.request('initialize', {
      clientInfo: { name: 'mx-coder', title: 'mx-coder', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this._transport.notify('notifications/initialized', {});
    return this._transport;
  }

  private async _ensureThread(transport: Transport): Promise<string> {
    if (this._threadId) return this._threadId;

    if (!this._resumeAttempted) {
      this._resumeAttempted = true;
      try {
        const response = await transport.request<JsonRecord>('thread/resume', { threadId: this._config.sessionId });
        const thread = extractThread(response);
        if (thread?.id) {
          this._announceThread(thread.id, thread.payload);
          return thread.id;
        }
      } catch (error) {
        if (!isMissingThreadError(error)) {
          throw error;
        }
      }
    }

    const response = await transport.request<JsonRecord>('thread/start', {
      cwd: this._config.workdir,
      sessionStartSource: 'startup',
    });
    const thread = extractThread(response);
    if (!thread?.id) {
      throw new Error('thread/start did not return a thread id');
    }
    this._announceThread(thread.id, thread.payload);
    return thread.id;
  }

  private async _startTurn(transport: Transport, threadId: string, prompt: string): Promise<string> {
    const response = await transport.request<JsonRecord>('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
    });
    const turn = extractTurn(response);
    const turnId = turn?.id ?? `${threadId}:turn`;
    this._turnId = turnId;
    this._announceTurn(turnId, threadId, turn?.payload ?? {});
    return turnId;
  }

  private _announceThread(threadId: string, payload: JsonRecord): void {
    this._threadId = threadId;
    writeJsonLine({
      type: 'system',
      message: {
        id: threadId,
        session_id: threadId,
        thread_id: threadId,
        tools: [],
        payload,
      },
    }, this._deps.writeStdout);
  }

  private _announceTurn(turnId: string, threadId: string, payload: JsonRecord): void {
    writeJsonLine({
      type: 'system',
      message: {
        id: turnId,
        session_id: threadId,
        thread_id: threadId,
        turn_id: turnId,
        tools: [],
        payload,
      },
    }, this._deps.writeStdout);
  }

  private _handleNotification(message: JsonRecord): void {
    const fallbackThreadId = this._threadId ?? this._config.sessionId;
    const fallbackTurnId = this._turnId ?? undefined;
    const normalized = normalizeEvent(message, fallbackThreadId, fallbackTurnId);
    if (!normalized) return;

    if (normalized.type === 'system') {
      const normalizedMessage = asRecord(normalized.message);
      const payload = asRecord(normalizedMessage?.payload);
      const sessionId = asString(normalizedMessage?.session_id);
      if (sessionId && sessionId !== this._threadId) {
        this._threadId = sessionId;
      }
      if (payload && asString(normalizedMessage?.turn_id) && asString(normalizedMessage?.turn_id) === this._turnId) {
        // ignore duplicate turn started notifications when we already announced the turn from the response
        return;
      }
      if (sessionId && asString(normalizedMessage?.turn_id)) {
        return;
      }
      writeJsonLine(normalized, this._deps.writeStdout);
      return;
    }

    if (normalized.type === 'assistant') {
      writeJsonLine(normalized, this._deps.writeStdout);
      return;
    }

    if (normalized.type === 'result') {
      writeJsonLine(normalized, this._deps.writeStdout);
      const normalizedMessage = asRecord(normalized.message);
      if (this._turnCompletion && asString(normalizedMessage?.id) === this._turnId) {
        const completion = this._turnCompletion;
        this._turnCompletion = null;
        if (normalized.is_error) {
          completion.reject(new Error(asString(normalized.result) ?? 'Codex turn failed'));
        } else {
          completion.resolve();
        }
      }
    }
  }

  private _fatal(error: Error): never {
    this._deps.writeStderr(`${error.message}\n`);
    process.exit(1);
  }
}

export async function runAdapter(config: AdapterConfig, deps: Deps = {}): Promise<void> {
  const bridge = new CodexResidentBridge(config, deps);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let prompt: string;
      try {
        prompt = extractPromptFromWorkerInput(line);
      } catch (error) {
        writeJsonLine({
          type: 'result',
          message: { id: `codex-result-${Date.now()}` },
          subtype: 'error',
          is_error: true,
          result: `Invalid worker input: ${(error as Error).message}`,
        });
        continue;
      }

      if (!prompt.trim()) {
        writeJsonLine({
          type: 'result',
          message: { id: `codex-result-${Date.now()}` },
          subtype: 'error',
          is_error: true,
          result: 'Empty prompt',
        });
        continue;
      }

      await bridge.processPrompt(prompt);
    }
  } finally {
    rl.close();
    await bridge.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const rawConfig = process.argv[2];
  if (!rawConfig) {
    console.error('codex-worker-adapter requires a JSON config argument');
    process.exit(1);
  }

  let config: AdapterConfig;
  try {
    config = JSON.parse(rawConfig) as AdapterConfig;
  } catch (error) {
    console.error(`invalid codex-worker-adapter config: ${(error as Error).message}`);
    process.exit(1);
  }

  runAdapter(config).catch((error) => {
    console.error(`codex-worker-adapter failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
