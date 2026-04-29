import * as net from 'net';
import * as fs from 'fs';
import * as readline from 'readline';
import type { ApprovalManager } from './approval-manager.js';
import type { IMPlugin, ChannelStatusResult } from './plugins/types.js';
import type { MessageTarget, Capability } from './types.js';

interface PermissionResultPayload {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

function encodePermissionResult(result: PermissionResultPayload): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

export interface ApprovalHandlerOptions {
  socketPath: string;
  approvalManager: ApprovalManager;
  imPlugin: IMPlugin;
  imTarget: MessageTarget;
  resolveContext?: (sessionId: string) => { target: MessageTarget; sessionName: string; operatorId?: string; message?: { approvalState?: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'; approvalScope?: 'once' | 'session' } } | undefined;
  onInvalidTarget?: (sessionId: string, target: MessageTarget, status: ChannelStatusResult) => Promise<void>;
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

function deriveCapability(toolName: string, toolInput: Record<string, unknown>): Capability | undefined {
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'WebSearch' || toolName === 'WebFetch') {
    return 'read_only';
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return 'file_write';
  }
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (/\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|poweroff|iptables|systemctl\s+stop|killall|kill\s+-9)\b/.test(command)) {
      return 'shell_dangerous';
    }
    return 'file_write';
  }
  return undefined;
}

function toRiskLevel(capability?: Capability): 'low' | 'medium' | 'high' {
  switch (capability) {
    case 'read_only':
      return 'low';
    case 'file_write':
      return 'medium';
    case 'shell_dangerous':
    case 'network_destructive':
      return 'high';
    default:
      return 'medium';
  }
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
    // Clean up stale socket file before binding
    try {
      fs.unlinkSync(this._opts.socketPath);
    } catch {
      // ignore if file doesn't exist
    }

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
        const toolInput = (toolArgs['input'] as Record<string, unknown> | undefined)
          ?? (toolArgs['tool_input'] as Record<string, unknown> | undefined)
          ?? {};
        const sessionId = toolArgs['session_id'] as string ?? '';
        const messageId = toolArgs['message_id'] as string ?? '';
        const toolUseId = toolArgs['tool_use_id'] as string ?? '';
        const rawCapability = toolArgs['capability'] as Capability | undefined;
        const capability = rawCapability ?? deriveCapability(toolName, toolInput);
        const operatorId = toolArgs['operator_id'] as string | undefined;
        const correlationId = toolArgs['correlation_id'] as string | undefined;

        const resolvedContext = this._opts.resolveContext?.(sessionId);
        const target = resolvedContext?.target ?? this._opts.imTarget;
        const sessionName = resolvedContext?.sessionName ?? sessionId;
        const effectiveOperatorId = operatorId ?? resolvedContext?.operatorId;
        const previousApproval = resolvedContext?.message?.approvalState;
        const previousScope = resolvedContext?.message?.approvalScope;

        const ruleResult = previousApproval === 'approved' && previousScope === 'session'
          ? 'allow'
          : await this._opts.approvalManager.applyRules(
              toolName,
              toolInput,
              capability,
              sessionId && effectiveOperatorId ? { sessionId, operatorId: effectiveOperatorId } : undefined,
            );

        console.log(JSON.stringify({
          at: new Date().toISOString(),
          component: 'approval-handler',
          event: 'permission_resolution',
          sessionId,
          toolName,
          capability,
          rawCapability,
          effectiveOperatorId,
          previousApproval,
          previousScope,
          ruleResult,
        }));

        if (ruleResult === 'allow') {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: encodePermissionResult({ behavior: 'allow', updatedInput: toolInput }) }) + '\n');
          continue;
        }

        if (ruleResult === 'deny') {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: encodePermissionResult({ behavior: 'deny', message: 'Denied by policy' }) }) + '\n');
          continue;
        }

        // ruleResult === 'ask' — create pending approval and notify IM
        const created = await this._opts.approvalManager.createPendingApproval({
          sessionId,
          messageId,
          toolUseId,
          ...(correlationId ? { correlationId } : {}),
          ...(capability ? { capability } : {}),
          ...(effectiveOperatorId ? { operatorId: effectiveOperatorId } : {}),
        });


        const interactionMessageId = await this._opts.imPlugin.requestApproval(target, {
          requestId: created.requestId,
          sessionName,
          messageId,
          toolName,
          toolInputSummary: JSON.stringify(toolInput).slice(0, 200),
          riskLevel: toRiskLevel(capability),
          capability: capability ?? 'file_write',
          scopeOptions: ['once', 'session'],
          timeoutSeconds: 60,
        }).catch(async (err) => {
          if (target.channelId && this._opts.imPlugin.checkChannelStatus && this._opts.onInvalidTarget) {
            const status = await this._opts.imPlugin.checkChannelStatus(target.channelId);
            if (status.kind === 'deleted' || status.kind === 'not_found' || status.kind === 'forbidden') {
              await this._opts.onInvalidTarget(sessionId, target, status);
            }
          }
          throw err;
        });
        if (interactionMessageId) {
          this._opts.approvalManager.attachInteractionMessage(created.requestId, interactionMessageId);
        }

        // Poll for decision (with timeout handled by ApprovalManager)
        const result = await this._waitForDecision(created.requestId);
        socket.write(JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: encodePermissionResult(
            result === 'approved'
              ? { behavior: 'allow', updatedInput: toolInput }
              : { behavior: 'deny', message: result === 'cancelled' ? 'Cancelled by user' : result === 'expired' ? 'Approval timeout' : 'Denied by user' },
          ),
        }) + '\n');
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
