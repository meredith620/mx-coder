import * as net from 'net';
import * as readline from 'readline';
import type { ApprovalManager } from './approval-manager.js';
import type { IMPlugin } from './plugins/types.js';
import type { MessageTarget } from './types.js';

export interface ApprovalHandlerOptions {
  socketPath: string;
  approvalManager: ApprovalManager;
  imPlugin: IMPlugin;
  imTarget: MessageTarget;
}

interface JsonRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

/**
 * Listens on a Unix socket for MCP can_use_tool requests from IM workers (via bridge).
 * Creates pending approvals, notifies the IM plugin, then responds with allow/deny.
 */
export class ApprovalHandler {
  private _opts: ApprovalHandlerOptions;
  private _server: net.Server | null = null;

  constructor(opts: ApprovalHandlerOptions) {
    this._opts = opts;
  }

  async listen(): Promise<net.Server> {
    this._server = net.createServer(socket => {
      void this._handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this._server!.listen(this._opts.socketPath, resolve);
      this._server!.on('error', reject);
    });

    return this._server;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
    });
    this._server = null;
  }

  private async _handleConnection(socket: net.Socket): Promise<void> {
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let req: JsonRPCRequest;
      try {
        req = JSON.parse(line) as JsonRPCRequest;
      } catch {
        continue;
      }

      if (req.method === 'tools/call' && req.params?.name === 'can_use_tool') {
        const toolArgs = req.params.arguments ?? {};
        const toolName = toolArgs['tool_name'] as string ?? '';
        const toolInput = toolArgs['tool_input'] as Record<string, unknown> ?? {};
        const sessionId = toolArgs['session_id'] as string ?? '';
        const messageId = toolArgs['message_id'] as string ?? '';
        const toolUseId = toolArgs['tool_use_id'] as string ?? '';

        // Apply rules first
        const ruleResult = await this._opts.approvalManager.applyRules(toolName, toolInput);

        if (ruleResult === 'allow') {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { allow: true } }) + '\n');
          continue;
        }

        if (ruleResult === 'deny') {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { allow: false } }) + '\n');
          continue;
        }

        // ruleResult === 'ask' — create pending approval and notify IM
        const created = await this._opts.approvalManager.createPendingApproval({
          sessionId,
          messageId,
          toolUseId,
        });

        // Notify IM plugin
        await this._opts.imPlugin.requestApproval(this._opts.imTarget, {
          requestId: created.requestId,
          sessionName: sessionId,
          messageId,
          toolName,
          toolInputSummary: JSON.stringify(toolInput).slice(0, 200),
          riskLevel: 'medium',
          capability: 'shell_dangerous',
          scopeOptions: ['once', 'session'],
          timeoutSeconds: 60,
        });

        // Poll for decision (with timeout handled by ApprovalManager)
        const result = await this._waitForDecision(created.requestId);
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { allow: result === 'approved' } }) + '\n');
      }
    }
  }

  private _waitForDecision(requestId: string): Promise<string> {
    return new Promise((resolve) => {
      const check = () => {
        const state = this._opts.approvalManager.getApprovalState(requestId);
        if (!state) return resolve('denied');
        if (state.decision !== 'pending') {
          return resolve(state.decision);
        }
        setTimeout(check, 50);
      };
      check();
    });
  }
}
