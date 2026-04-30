import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { encodeRequest, encodeResponse, decodeMessage, encodePing } from './ipc/codec.js';

export interface AttachOptions {
  socketPath: string;
  sessionName: string;
  cliCommand: string;
  cliArgs: string[];
  workdir?: string;
  sessionEnv?: Record<string, string>;
}

function appendAttachLog(payload: Record<string, unknown>): void {
  try {
    const logPath = process.env.MX_CODER_ATTACH_LOG ?? path.join(os.homedir(), '.mx-coder', 'attach.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, 'utf-8');
  } catch {
    // ignore logging errors
  }
}

/**
 * Attach to a session: notify daemon, wait if IM is processing, spawn CLI, then notify detach.
 */
export async function attachSession(opts: AttachOptions): Promise<void> {
  const { socketPath, sessionName, cliCommand, cliArgs, workdir, sessionEnv } = opts;

  // Connect to daemon
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('connect', () => resolve(s));
    s.on('error', reject);
  });

  const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
  const pending = new Map<string, (line: string) => void>();
  let resumeResolve: (() => void) | null = null;
  const pingTimer = setInterval(() => {
    try {
      if (!socket.destroyed) {
        socket.write(encodePing() + '\n');
      }
    } catch {
      // ignore ping failure; normal request path will surface hard failures
    }
  }, 15_000);

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = decodeMessage(line);
      if (msg.type === 'response') {
        const handler = pending.get(msg.requestId);
        if (handler) {
          pending.delete(msg.requestId);
          handler(line);
        }
      } else if (msg.type === 'event') {
        const ev = msg as { type: 'event'; event: string; data: Record<string, unknown> };
        if (ev.event === 'session_resume' && resumeResolve) {
          resumeResolve();
          resumeResolve = null;
        }
      }
    } catch { /* ignore */ }
  });

  function sendRequest(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error('SOCKET_CLOSED'));
        return;
      }
      const line = encodeRequest(command, args);
      const requestId = (JSON.parse(line) as { requestId: string }).requestId;
      pending.set(requestId, (responseLine) => {
        try {
          const msg = JSON.parse(responseLine) as { ok: boolean; data?: Record<string, unknown>; error?: unknown };
          if (msg.ok) resolve(msg.data ?? {});
          else reject(new Error(JSON.stringify(msg.error)));
        } catch (e) { reject(e); }
      });
      socket.write(line + '\n');
    });
  }

  try {
    appendAttachLog({ event: 'attach_start', sessionName, cliCommand, cliArgs, workdir, currentCwd: process.cwd() });
    // Send attach command
    const attachResult = await sendRequest('attach', { name: sessionName, pid: process.pid });
    appendAttachLog({ event: 'attach_ack', sessionName, attachResult });

    // If waitRequired, wait for resume event
    if (attachResult.waitRequired) {
      await new Promise<void>(resolve => { resumeResolve = resolve; });
    }

    // Spawn CLI
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(cliCommand, cliArgs, {
        stdio: 'inherit',
        ...(workdir ? { cwd: workdir } : {}),
        ...(sessionEnv && Object.keys(sessionEnv).length > 0 ? { env: { ...process.env, ...sessionEnv } } : {}),
      });
      appendAttachLog({ event: 'spawned', sessionName, pid: proc.pid, cliCommand, cliArgs, workdir });
      proc.on('close', (code) => resolve(code ?? 0));
      proc.on('error', () => resolve(1));
    });
    appendAttachLog({ event: 'attach_exit', sessionName, exitCode });

    // Notify daemon of detach
    await sendRequest('markDetached', {
      name: sessionName,
      exitReason: exitCode === 0 ? 'normal' : 'error',
      exitCode,
    });
    appendAttachLog({ event: 'mark_detached_ack', sessionName, exitCode });
  } catch (error) {
    appendAttachLog({ event: 'attach_error', sessionName, error: (error as Error).message });
    throw error;
  } finally {
    clearInterval(pingTimer);
    rl.close();
    socket.destroy();
  }
}
