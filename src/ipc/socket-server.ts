import * as net from 'net';
import * as fs from 'fs';
import * as readline from 'readline';
import {
  decodeMessage,
  encodeResponse,
  encodeError,
  encodePong,
  encodeEvent,
  type IPCEvent,
  type IPCRequest,
  type ErrorCode,
} from './codec.js';

type Actor = IPCRequest['actor'];
type Handler = (args: Record<string, unknown>, actor?: Actor, socket?: net.Socket) => Promise<Record<string, unknown>>;

const PING_TIMEOUT_MS = 45_000;

export class IPCServer {
  private _socketPath: string;
  private _server: net.Server | null = null;
  private _handlers: Map<string, Handler> = new Map();
  private _subscribers: Set<net.Socket> = new Set();
  private _attachWaiters: Map<string, net.Socket> = new Map();

  constructor(socketPath: string) {
    this._socketPath = socketPath;
  }

  handle(command: string, fn: Handler): void {
    this._handlers.set(command, fn);
  }

  async listen(): Promise<void> {
    // Clean up stale socket file
    if (fs.existsSync(this._socketPath)) {
      fs.unlinkSync(this._socketPath);
    }

    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => this._handleConnection(socket));
      this._server.on('error', reject);
      this._server.listen(this._socketPath, () => {
        try {
          fs.chmodSync(this._socketPath, 0o600);
        } catch { /* ignore on platforms that don't support it */ }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const sub of this._subscribers) {
      try { sub.destroy(); } catch { /* ignore */ }
    }
    this._subscribers.clear();
    this._attachWaiters.clear();

    return new Promise((resolve) => {
      if (!this._server) { resolve(); return; }
      this._server.close(() => {
        try { fs.unlinkSync(this._socketPath); } catch { /* ignore */ }
        resolve();
      });
    });
  }

  registerAttachWaiter(sessionName: string, socket: net.Socket): void {
    this._attachWaiters.set(sessionName, socket);
    socket.on('close', () => {
      if (this._attachWaiters.get(sessionName) === socket) {
        this._attachWaiters.delete(sessionName);
      }
    });
  }

  pushEvent(event: IPCEvent): void {
    const line = encodeEvent(event.event, event.data) + '\n';
    for (const sub of this._subscribers) {
      try { sub.write(line); } catch { this._subscribers.delete(sub); }
    }
  }

  pushEventToAttachWaiter(sessionName: string, event: IPCEvent): void {
    const socket = this._attachWaiters.get(sessionName);
    if (!socket) return;
    try {
      socket.write(encodeEvent(event.event, event.data) + '\n');
    } catch { /* ignore */ }
  }

  private _handleConnection(socket: net.Socket): void {
    let pingTimer: ReturnType<typeof setTimeout> | null = null;

    const resetTimer = () => {
      if (pingTimer) clearTimeout(pingTimer);
      pingTimer = setTimeout(() => socket.destroy(), PING_TIMEOUT_MS);
    };
    resetTimer();

    socket.on('close', () => {
      if (pingTimer) clearTimeout(pingTimer);
      this._subscribers.delete(socket);
    });

    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    rl.on('line', async (line) => {
      resetTimer();
      let msg: ReturnType<typeof decodeMessage>;
      try {
        msg = decodeMessage(line);
      } catch {
        socket.write(encodeError('', 'INVALID_REQUEST', 'Malformed JSON') + '\n');
        return;
      }

      if (msg.type === 'ping') {
        socket.write(encodePong() + '\n');
        return;
      }

      if (msg.type !== 'request') return;

      const { requestId, command, args, actor } = msg;

      // Built-in subscribe command
      if (command === 'subscribe') {
        this._subscribers.add(socket);
        socket.write(encodeResponse(requestId, { subscribed: true }) + '\n');
        return;
      }

      const handler = this._handlers.get(command);
      if (!handler) {
        socket.write(encodeError(requestId, 'UNKNOWN_COMMAND', `Unknown command: ${command}`) + '\n');
        return;
      }

      try {
        const result = await handler(args, actor, socket);
        socket.write(encodeResponse(requestId, result) + '\n');
      } catch (err) {
        const code: ErrorCode = err instanceof Error && 'code' in err
          ? (err as { code: ErrorCode }).code
          : 'INTERNAL_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        socket.write(encodeError(requestId, code, message) + '\n');
      }
    });
  }
}
