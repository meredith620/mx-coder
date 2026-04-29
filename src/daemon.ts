import { IPCServer } from './ipc/socket-server.js';
import { SessionRegistry } from './session-registry.js';
import { AclManager } from './acl-manager.js';
import { PersistenceStore } from './persistence.js';
import { IMMessageDispatcher } from './im-message-dispatcher.js';
import { IMWorkerManager } from './im-worker-manager.js';
import { ApprovalManager } from './approval-manager.js';
import { ApprovalHandler } from './approval-handler.js';
import { getIMPluginFactory, getDefaultIMPluginName } from './plugins/im/registry.js';
import { getCLIPlugin, getDefaultCLIPluginName } from './plugins/cli/registry.js';
import type { IMPlugin } from './plugins/types.js';
import type { IncomingMessage, MessageTarget, Session, StreamVisibility } from './types.js';
import type { AclAction, Actor } from './acl-manager.js';
import type { ErrorCode } from './ipc/codec.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

function mockApprovalDecision(imPlugin: IMPlugin, requestId: string, decision: 'approved' | 'denied' | 'cancelled', scope: 'once' | 'session'): void {
  const maybeRecorder = imPlugin as IMPlugin & { recordApprovalDecision?: (requestId: string, decision: 'approved' | 'denied' | 'cancelled', scope?: 'once' | 'session') => void };
  maybeRecorder.recordApprovalDecision?.(requestId, decision, scope);
}

function approvalCommandHelp(): string {
  return 'fallback：`/approve once` `/approve session` `/deny` `/cancel`';
}

function reactionToApprovalDecision(emoji: string): { decision: 'approved' | 'denied' | 'cancelled'; scope: 'once' | 'session' } | undefined {
  if (emoji === '👍') return { decision: 'approved', scope: 'once' };
  if (emoji === '✅') return { decision: 'approved', scope: 'session' };
  if (emoji === '👎') return { decision: 'denied', scope: 'once' };
  if (emoji === '⏹️') return { decision: 'cancelled', scope: 'once' };
  return undefined;
}

function isStreamVisibility(value: string): value is StreamVisibility {
  return value === 'normal' || value === 'thinking' || value === 'verbose';
}


export interface DaemonOptions {
  persistencePath?: string;
  imConfigPath?: string;
  enableIM?: boolean;
  imPluginName?: string;
  defaultCLIPluginName?: string;
  imPluginConfig?: Record<string, unknown>;
}

export class Daemon {
  private _server: IPCServer;
  registry: SessionRegistry;
  private _acl: AclManager;
  private _store: PersistenceStore | null;
  private _imPlugin: IMPlugin | null = null;
  private _imPluginName: string | null = null;
  private _imPlugins = new Map<string, IMPlugin>();
  private _imDispatcher: IMMessageDispatcher | null = null;
  private _imWorkerManager: IMWorkerManager | null = null;
  private _approvalManager: ApprovalManager | null = null;
  private _approvalHandler: ApprovalHandler | null = null;
  private _approvalSocketPath: string;
  private _defaultCLIPluginName: string;
  private _imPluginConfig: Record<string, unknown>;

  private _debugLog(payload: Record<string, unknown>): void {
    try {
      console.log(JSON.stringify({ at: new Date().toISOString(), component: 'daemon', ...payload }));
    } catch {
      // ignore logging failure
    }
  }

  constructor(socketPath: string, opts: DaemonOptions = {}) {
    this._server = new IPCServer(socketPath);
    this._store = opts.persistencePath ? new PersistenceStore(opts.persistencePath) : null;
    this.registry = new SessionRegistry(this._store ?? undefined);
    this._acl = new AclManager();
    this._approvalManager = new ApprovalManager({
      autoAllowCapabilities: ['read_only'],
      autoAskCapabilities: ['file_write'],
      autoDenyCapabilities: ['shell_dangerous', 'network_destructive'],
      autoDenyPatterns: [],
      timeoutSeconds: 300,
    });
    this._approvalSocketPath = `${socketPath}.approval.sock`;
    this._defaultCLIPluginName = opts.defaultCLIPluginName ?? getDefaultCLIPluginName();
    this._imPluginConfig = opts.imPluginConfig ?? {};
    this._registerHandlers();

    // Initialize IM if enabled
    if (opts.enableIM) {
      const pluginNames = (opts.imPluginName ?? getDefaultIMPluginName())
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
      void this._initializeIMs(pluginNames, opts.imConfigPath);
    }
  }

  private async _initializeIMs(pluginNames: string[], configPath?: string): Promise<void> {
    const sessions = this.registry.list();
    const activeCount = sessions.filter(s => s.status === 'attached' || s.status === 'im_processing').length;

    for (const pluginName of pluginNames) {
      try {
        const factory = getIMPluginFactory(pluginName);
        const cfgPath = configPath ?? factory.getDefaultConfigPath();
        const plugin = await factory.load(cfgPath, {
          sessionCount: sessions.length,
          activeCount,
        });

        plugin.onMessage((msg) => {
          this._handleIncomingIMMessage(msg, msg.channelId ?? '').catch((err) => {
            console.error(`[IM] Unhandled error in message handler: ${(err as Error).message}`);
          });
        });

        this._imPlugins.set(pluginName, plugin);
        if (!this._imPlugin) {
          this._imPlugin = plugin;
          this._imPluginName = pluginName;
        }

        console.log(`IM plugin '${pluginName}' connected`);
      } catch (err) {
        console.error(`Failed to initialize IM plugin '${pluginName}': ${(err as Error).message}`);
      }
    }

    if (this._imPlugins.size === 0) {
      return;
    }

    this._approvalHandler = new ApprovalHandler({
      socketPath: this._approvalSocketPath,
      approvalManager: this._approvalManager!,
      imPlugin: this._imPlugin!,
      imTarget: {
        plugin: this._imPluginName ?? getDefaultIMPluginName(),
        threadId: '',
      },
      resolveContext: (sessionId: string) => {
        const session = this.registry.list().find((item) => item.sessionId === sessionId);
        if (!session) return undefined;
        const activeMessage = session.messageQueue.find((message) => message.status === 'running' || message.status === 'waiting_approval');
        const operatorId = activeMessage?.userId ?? session.activeOperatorId;
        const binding = session.imBindings[0];
        if (!binding) {
          return {
            target: { plugin: this._imPluginName ?? getDefaultIMPluginName(), threadId: '' },
            sessionName: session.name,
            ...(operatorId ? { operatorId } : {}),
            ...(activeMessage?.approvalState !== undefined || activeMessage?.approvalScope !== undefined
              ? { message: {
                  ...(activeMessage?.approvalState !== undefined ? { approvalState: activeMessage.approvalState } : {}),
                  ...(activeMessage?.approvalScope !== undefined ? { approvalScope: activeMessage.approvalScope } : {}),
                } }
              : {}),
          };
        }
        return {
          target: {
            plugin: binding.plugin,
            ...(binding.channelId ? { channelId: binding.channelId } : {}),
            threadId: binding.bindingKind === 'channel' ? '' : binding.threadId,
          },
          sessionName: session.name,
          ...(operatorId ? { operatorId } : {}),
          ...(activeMessage?.approvalState !== undefined || activeMessage?.approvalScope !== undefined
            ? { message: {
                ...(activeMessage?.approvalState !== undefined ? { approvalState: activeMessage.approvalState } : {}),
                ...(activeMessage?.approvalScope !== undefined ? { approvalScope: activeMessage.approvalScope } : {}),
              } }
            : {}),
        };
      },
    });
    await this._approvalHandler.listen();

    this._startApprovalReactionPollLoop();

    this._imWorkerManager = new IMWorkerManager(
      (session: Session) => getCLIPlugin(session.cliPlugin),
      this.registry,
      this._approvalSocketPath,
    );

      this._imDispatcher = new IMMessageDispatcher({
      registry: this.registry,
      imPlugin: this._imPlugin!,
      imPluginResolver: (message: { plugin?: string }) => this._getIMPluginOrThrow(message.plugin ?? this._imPluginName ?? getDefaultIMPluginName()),
      imTarget: {
        plugin: this._imPluginName ?? getDefaultIMPluginName(),
        threadId: '',
      },
      workerManager: this._imWorkerManager,
      pollIntervalMs: 500,
      onSessionImDone: (sessionName: string) => {
        this._debugLog({ event: 'im_session_done', sessionName, sessionStatus: this.registry.get(sessionName)?.status });
        if (this._store) void this._store.flush();
        this._server.pushEventToAttachWaiter(sessionName, {
          type: 'event',
          event: 'session_resume',
          data: { name: sessionName },
        });
      },
    });

    this._imDispatcher.start();
    console.log(`IM dispatcher started for plugins: ${pluginNames.join(', ')}`);

    // Register existing session channels for listening
    if (this._imPlugin && 'addListenedChannel' in this._imPlugin && typeof (this._imPlugin as any).addListenedChannel === 'function') {
      for (const session of this.registry.list()) {
        for (const binding of session.imBindings) {
          if (binding.bindingKind === 'channel' && binding.channelId) {
            (this._imPlugin as any).addListenedChannel(binding.channelId);
          }
        }
      }
    }
  }

  private _ensureIMActorRoles(session: Session, userId?: string): void {
    if (!userId) return;
    if (!this._acl.hasRole(session.sessionId, userId, 'owner')) {
      this._acl.grantRole(session.sessionId, userId, 'owner');
    }
  }

  private _startApprovalReactionPollLoop(): void {
    const plugin = this._imPlugin;
    const approvalManager = this._approvalManager;
    const listReactions = plugin?.listReactions;
    if (!plugin || !approvalManager || !listReactions) {
      return;
    }

    const tick = async (): Promise<void> => {
      for (const state of approvalManager.getAllApprovalStates()) {
        if (state.decision !== 'pending' || !state.interactionMessageId) {
          continue;
        }
        if (state.lastReactionPollAt && Date.now() - state.lastReactionPollAt < 1500) {
          continue;
        }
        approvalManager.markReactionPoll(state.requestId);
        const reactions = await listReactions.call(plugin, state.interactionMessageId).catch(() => []);
        const reaction = reactions.find((item) => item.emoji === '👍' || item.emoji === '✅' || item.emoji === '👎' || item.emoji === '⏹️');
        if (!reaction) {
          continue;
        }
        const mapped = reactionToApprovalDecision(reaction.emoji);
        if (!mapped) {
          continue;
        }
        const session = this.registry.list().find((item) => item.sessionId === state.sessionId);
        if (!session) {
          continue;
        }
        this._ensureIMActorRoles(session, reaction.userId);
        const binding = session.imBindings[0];
        if (!binding) {
          continue;
        }
        const polledMessage: IncomingMessage = {
          plugin: binding.plugin,
          threadId: binding.bindingKind === 'channel' ? '' : binding.threadId,
          isTopLevel: false,
          userId: reaction.userId,
          text: '',
          messageId: `reaction-poll-${state.requestId}`,
          createdAt: new Date().toISOString(),
          dedupeKey: `reaction-poll-${state.requestId}`,
          reaction: { action: 'added', emoji: reaction.emoji, postId: state.interactionMessageId },
          ...(binding.channelId ? { channelId: binding.channelId } : {}),
        };
        await this._finalizeApprovalDecision(polledMessage, binding.channelId ?? '', state.requestId, mapped.decision, mapped.scope);
      }
    };

    const timer = setInterval(() => {
      void tick();
    }, 2000);
    process.on('exit', () => clearInterval(timer));
  }

  private _getIMPlugin(pluginName: string): IMPlugin | null {
    return this._imPlugins.get(pluginName)
      ?? (pluginName === this._imPluginName ? this._imPlugin : null)
      ?? (this._imPlugins.size === 1 ? [...this._imPlugins.values()][0] : null)
      ?? null;
  }

  private _getIMPluginOrThrow(pluginName: string): IMPlugin {
    const plugin = this._getIMPlugin(pluginName);
    if (!plugin) {
      throw new Error(`IM plugin not initialized: ${pluginName}`);
    }
    return plugin;
  }

  private async _handleIncomingIMMessage(msg: IncomingMessage, channelId: string): Promise<void> {
    const imPlugin = this._getIMPlugin(msg.plugin);
    if (!imPlugin) return;

    const trimmed = msg.text.trim();
    if (msg.reaction?.action === 'added') {
      const handled = await this._handleApprovalReaction(msg, channelId);
      if (handled) {
        return;
      }
    }
    const factory = getIMPluginFactory(msg.plugin);

    if (trimmed.startsWith('//')) {
      const passthrough = trimmed.slice(1);
      if (passthrough.trim() === '/') {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: 'passthrough 命令不能为空。',
        });
        return;
      }

      const conversationKind = this._getMattermostConversationKind();
      let session: Session;
      try {
        session = this._getOrCreateSessionForConversation(
          conversationKind === 'channel' ? (msg.channelId ?? channelId) : msg.threadId,
          msg.plugin,
          conversationKind,
        );
      } catch (err) {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `无法处理消息：${(err as Error).message}`,
        });
        return;
      }
      if ((this._acl.authorize(session.sessionId, msg.userId, 'send_text')) === 'deny') {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: '无权限使用 passthrough。',
        });
        return;
      }
      if (session.status === 'attached' || session.status === 'takeover_pending') {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `当前会话 \`${session.name}\` 正在终端中使用，不接收 IM 消息。可使用 \`/takeover ${session.name}\` 请求接管。`,
        });
        return;
      }
      this._ensureIMActorRoles(session, msg.userId);
      try {
        const effectiveThreadId = conversationKind === 'channel' && msg.isTopLevel ? '' : msg.threadId;
        this.registry.enqueueIMMessage(session.name, {
          text: passthrough,
          dedupeKey: msg.dedupeKey,
          plugin: msg.plugin,
          channelId: msg.channelId ?? channelId,
          threadId: effectiveThreadId,
          messageId: msg.messageId,
          userId: msg.userId,
          receivedAt: msg.createdAt,
          isPassthrough: true as any,
        });
      } catch (err) {
        console.error(`Failed to enqueue IM passthrough message: ${(err as Error).message}`);
      }
      return;
    }

    if (trimmed === '/help') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: factory.getCommandHelpText(),
      });
      return;
    }

    if (trimmed === '/list') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: this._renderIMSessionList(msg.plugin),
      });
      return;
    }

    if (trimmed === '/status') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: this._renderIMStatus(msg),
      });
      return;
    }

    if (trimmed === '/open' || trimmed.startsWith('/open ')) {
      const sessionName = trimmed === '/open' ? '' : trimmed.slice('/open '.length).trim();
      await this._handleOpenCommand(sessionName, channelId, msg);
      return;
    }

    if (trimmed === '/stream' || trimmed.startsWith('/stream ')) {
      await this._handleStreamCommand(trimmed, channelId, msg);
      return;
    }

    if (trimmed === '/takeover' || trimmed.startsWith('/takeover ')) {
      const sessionName = trimmed === '/takeover' ? '' : trimmed.slice('/takeover '.length).trim();
      await this._handleTakeoverCommand(sessionName, channelId, msg, false);
      return;
    }

    if (trimmed === '/takeover-force' || trimmed.startsWith('/takeover-force ')) {
      const sessionName = trimmed === '/takeover-force' ? '' : trimmed.slice('/takeover-force '.length).trim();
      await this._handleTakeoverCommand(sessionName, channelId, msg, true);
      return;
    }

    if (trimmed === '/approve' || trimmed.startsWith('/approve ')) {
      await this._handleApprovalDecision(msg, channelId, 'approved');
      return;
    }

    if (trimmed === '/deny' || trimmed.startsWith('/deny ')) {
      await this._handleApprovalDecision(msg, channelId, 'denied');
      return;
    }

    if (trimmed === '/cancel' || trimmed.startsWith('/cancel ')) {
      await this._handleApprovalDecision(msg, channelId, 'cancelled');
      return;
    }

    // C 类：IM 中不支持的命令（remove/attach/create 等）
    // 在 thread 中（isTopLevel=false）拦截，不落入 CLI
    if (!msg.isTopLevel && trimmed.startsWith('/')) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `命令 \`${trimmed.split(' ')[0]}\` 不支持在 IM 中使用，请使用 mx-coder CLI。`,
      });
      return;
    }

    // D 类：顶层 channel 消息中的未知命令
    if (msg.isTopLevel && trimmed.startsWith('/')) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `未知命令 \`${trimmed.split(' ')[0]}\`。发送 \`/help\` 查看可用命令。`,
      });
      return;
    }

    // E 类：普通文本消息，进入 Claude 处理流程
    const conversationKind = this._getMattermostConversationKind();
    let session: Session;
    try {
      session = this._getOrCreateSessionForConversation(
        conversationKind === 'channel' ? (msg.channelId ?? channelId) : msg.threadId,
        msg.plugin,
        conversationKind,
      );
    } catch (err) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `无法处理消息：${(err as Error).message}`,
      });
      return;
    }
    this._ensureIMActorRoles(session, msg.userId);
    if (session.lifecycleStatus === 'archived') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `当前会话 \`${session.name}\` 已归档，不能接收新的 IM 消息。`,
      });
      return;
    }
    if (session.initState === 'initializing') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `当前会话 \`${session.name}\` 正在初始化，请稍后重试。`,
      });
      return;
    }
    if (session.initState === 'init_failed') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `当前会话 \`${session.name}\` 初始化失败，暂不接收新的 IM 消息。`,
      });
      return;
    }
    if (session.status === 'attached' || session.status === 'takeover_pending') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `当前会话 \`${session.name}\` 正在终端中使用，不接收 IM 消息。可使用 \`/takeover ${session.name}\` 请求接管。`,
      });
      this._debugLog({
        event: 'im_message_rejected_attached',
        sessionName: session.name,
        sessionStatus: session.status,
        threadId: msg.threadId,
        messageId: msg.messageId,
      });
      return;
    }
    try {
      // In channel mode, if message is top-level, clear threadId so reply goes to channel directly
      // If user manually created a thread (isTopLevel=false), keep threadId to reply in that thread
      const effectiveThreadId = conversationKind === 'channel' && msg.isTopLevel ? '' : msg.threadId;

      this.registry.enqueueIMMessage(session.name, {
        text: msg.text,
        dedupeKey: msg.dedupeKey,
        plugin: msg.plugin,
        channelId: msg.channelId ?? channelId,
        threadId: effectiveThreadId,
        messageId: msg.messageId,
        userId: msg.userId,
        receivedAt: msg.createdAt,
      });
      this._debugLog({
        event: 'im_message_enqueued',
        sessionName: session.name,
        sessionStatus: session.status,
        threadId: effectiveThreadId,
        originalThreadId: msg.threadId,
        isTopLevel: msg.isTopLevel,
        conversationKind,
        channelId: msg.channelId ?? channelId,
        messageId: msg.messageId,
      });
    } catch (err) {
      console.error(`Failed to enqueue IM message: ${(err as Error).message}`);
    }
  }

  private async _handleApprovalReaction(msg: IncomingMessage, channelId: string): Promise<boolean> {
    if (!msg.reaction || !this._approvalManager) return false;
    const mapped = reactionToApprovalDecision(msg.reaction.emoji);
    if (!mapped) return false;

    const state = this._approvalManager.getApprovalStateByInteractionMessageId(msg.reaction.postId);
    if (!state) return false;

    await this._finalizeApprovalDecision(msg, channelId, state.requestId, mapped.decision, mapped.scope);
    return true;
  }

  private async _resolveApprovalRequestId(msg: IncomingMessage, rawRequestId: string | undefined): Promise<string | undefined> {
    if (!this._approvalManager) return undefined;
    if (rawRequestId && rawRequestId !== 'last') return rawRequestId;

    const pluginName = msg.plugin;
    const bindingSession = !msg.isTopLevel
      ? this._resolveBoundSession(msg)
      : undefined;

    if (!bindingSession) return undefined;
    return this._approvalManager.getPendingApprovalForSession(bindingSession.sessionId)?.requestId;
  }

  private async _finalizeApprovalDecision(
    msg: IncomingMessage,
    channelId: string,
    requestId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    scope: 'once' | 'session',
  ): Promise<void> {
    const imPlugin = this._getIMPlugin(msg.plugin);
    if (!this._approvalManager) return;

    const state = this._approvalManager.getApprovalState(requestId);
    if (!state) {
      if (imPlugin) {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `未找到待处理审批。${approvalCommandHelp()}`,
        });
      }
      return;
    }

    if (msg.userId && this._acl.authorize(state.sessionId, msg.userId, decision === 'approved' ? 'approve' : decision === 'denied' ? 'deny' : 'cancel') === 'deny') {
      if (imPlugin) {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `无权限处理审批。`,
        });
      }
      return;
    }

    const result = decision === 'cancelled'
      ? await this._approvalManager.cancel(requestId)
      : await this._approvalManager.decideByApprover(requestId, msg.userId, { decision, scope });

    const session = this.registry.list().find((item) => item.sessionId === state.sessionId);
    if (session) {
      const activeMessage = session.messageQueue.find((message) => message.status === 'running' || message.status === 'waiting_approval');
      if (activeMessage) {
        const nextApprovalState = result.status === 'approved'
          ? 'approved'
          : result.status === 'denied'
            ? 'denied'
            : result.status === 'cancelled'
              ? 'cancelled'
              : result.status === 'expired'
                ? 'expired'
                : undefined;
        if (nextApprovalState !== undefined) {
          activeMessage.approvalState = nextApprovalState;
        }
        if (scope === 'session') {
          activeMessage.approvalScope = 'session';
        }
      }
    }

    if (imPlugin) {
      mockApprovalDecision(imPlugin, requestId, decision, scope);
      const stateLabel = decision === 'approved'
        ? (scope === 'session' ? '✅ 已允许本 session' : '✅ 已允许本次操作')
        : decision === 'denied'
          ? '❌ 已拒绝本次操作'
          : '⏹️ 已取消本次审批';
      const replyText = `${stateLabel}（${result.status}）`;
      const alreadySent = msg.reaction?.postId === state.interactionMessageId;
      if (!alreadySent) {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: replyText,
        });
      }
    }
  }


  private async _handleApprovalDecision(
    msg: IncomingMessage,
    channelId: string,
    decision: 'approved' | 'denied' | 'cancelled',
  ): Promise<void> {
    const imPlugin = this._getIMPlugin(msg.plugin);
    if (!this._approvalManager) return;

    const parts = msg.text.trim().split(/\s+/);
    const requestIdToken = parts[1] === 'once' || parts[1] === 'session' ? undefined : parts[1];
    const requestId = await this._resolveApprovalRequestId(msg, requestIdToken);
    const scope = parts[1] === 'session' || parts[2] === 'session' ? 'session' : 'once';
    if (!requestId) {
      if (imPlugin) {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `用法：/${decision === 'approved' ? 'approve [once|session]' : decision === 'denied' ? 'deny' : 'cancel'}`,
        });
      }
      return;
    }

    await this._finalizeApprovalDecision(msg, channelId, requestId, decision, scope);
  }

  private _buildReplyTarget(msg: IncomingMessage, channelId: string): MessageTarget {
    return {
      plugin: msg.plugin,
      channelId: msg.channelId ?? channelId,
      threadId: msg.isTopLevel ? '' : msg.threadId,
      userId: msg.userId,
    };
  }

  private _renderIMStatus(msg: IncomingMessage): string {
    const sessions = this.registry.list();
    // If message is inside a thread, find the bound session
    if (!msg.isTopLevel) {
      const session = this.registry.getByIMThread(msg.plugin, msg.threadId);
      if (session) {
        return this._renderSessionStatus(session, msg.plugin);
      }
    }
    // Global stats (top-level or unbound thread)
    return this._renderGlobalStatus(sessions);
  }

  private _resolveBoundSession(msg: IncomingMessage): Session | undefined {
    return this.registry.list().find((session) => session.imBindings.some((binding) =>
      binding.plugin === msg.plugin
      && (binding.bindingKind === 'channel' ? binding.channelId === (msg.channelId ?? '') : binding.threadId === msg.threadId),
    ));
  }

  private async _handleStreamCommand(trimmed: string, channelId: string, msg: IncomingMessage): Promise<void> {
    const imPlugin = this._getIMPlugin(msg.plugin);
    if (!imPlugin) return;
    const session = this._resolveBoundSession(msg);
    if (!session) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: '请在目标会话的 thread 或 session channel 中执行 `/stream`。',
      });
      return;
    }

    const arg = trimmed === '/stream' ? '' : trimmed.slice('/stream '.length).trim();
    if (!arg) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `当前会话 ${session.name} 的输出模式为 \`${session.streamVisibility}\`。可用值：\`normal\`、\`thinking\`、\`verbose\`。`,
      });
      return;
    }

    if (!isStreamVisibility(arg)) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: '用法：`/stream` 或 `/stream normal|thinking|verbose`。',
      });
      return;
    }

    this.registry.updateStreamVisibility(session.name, arg);
    if (this._store) void this._store.flush();
    await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
      kind: 'text',
      text: `已将会话 ${session.name} 的输出模式切换为 \`${arg}\`。`,
    });
  }

  private _renderSessionStatus(session: Session, pluginName: string): string {
    const binding = session.imBindings.find((item) => item.plugin === pluginName) ?? session.imBindings[0];
    const pending = session.messageQueue.filter(m => m.status === 'pending').length;
    const bindingLabel = !binding
      ? '未绑定'
      : binding.bindingKind === 'channel'
        ? `channel:${binding.channelId ?? 'unknown'}`
        : `thread:${binding.threadId}`;
    const lines = [
      `**会话：** \`${session.name}\``,
      `**状态：** ${session.status}`,
      `**运行态：** ${session.runtimeState ?? 'cold'}`,
      `**输出模式：** ${session.streamVisibility}`,
      `**CLI 插件：** ${session.cliPlugin}`,
      `**工作目录：** ${session.workdir}`,
      `**绑定空间：** ${bindingLabel}`,
      `**待处理消息：** ${pending}`,
      `**创建时间：** ${new Date(session.createdAt).toLocaleString()}`,
    ];
    return lines.join('\n');
  }

  private _renderGlobalStatus(sessions: Session[]): string {
    const total = sessions.length;
    const attached = sessions.filter(s => s.status === 'attached').length;
    const detached = sessions.filter(s => s.status === 'idle').length;
    const imProcessing = sessions.filter(s => s.status === 'im_processing').length;
    const strategy = this._getMattermostConversationKind();
    const openHint = strategy === 'channel'
      ? '\n发送 `/list` 查看详细列表，`/open <name>` 定位到对应 channel。'
      : '\n发送 `/list` 查看详细列表，`/open <name>` 定位到对应 thread。';
    return [
      `**mx-coder 全局状态**`,
      `会话总数：${total}`,
      `默认空间策略：${strategy}`,
      `attached：${attached}　im_processing：${imProcessing}　idle：${detached}`,
      total > 0 ? openHint : '\n直接发送消息即可创建新会话。',
    ].join('\n');
  }

  private _getMattermostConversationKind(): 'thread' | 'channel' {
    const strategy = this._imPluginConfig['spaceStrategy'];
    return strategy === 'channel' ? 'channel' : 'thread';
  }

  private _getOrCreateSessionForConversation(conversationId: string, plugin: string, bindingKind: 'thread' | 'channel') {
    const existing = bindingKind === 'thread'
      ? this.registry.getByIMThread(plugin, conversationId)
      : this.registry.list().find((session) => session.imBindings.some((binding) => binding.plugin === plugin && binding.bindingKind === 'channel' && binding.channelId === conversationId));
    if (existing) return existing;

    // For channel binding, don't auto-create session - user should use /open command
    if (bindingKind === 'channel') {
      throw new Error(`No session bound to channel ${conversationId}. Please use /open <sessionName> to create a session channel.`);
    }

    // Only for thread binding: auto-create session
    const name = this._makeSessionName(conversationId);
    const session = this.registry.create(name, {
      workdir: process.cwd(),
      cliPlugin: this._defaultCLIPluginName,
    });
    this.registry.bindIM(name, {
      plugin,
      bindingKind: 'thread',
      threadId: conversationId,
    });
    return session;
  }

  private _getOrCreateSessionForThread(threadId: string, plugin: string) {
    return this._getOrCreateSessionForConversation(threadId, plugin, 'thread');
  }

  private _makeSessionName(threadId: string): string {
    const base = `im-${threadId.slice(0, 8)}`;
    if (!this.registry.get(base)) return base;

    let i = 2;
    while (this.registry.get(`${base}-${i}`)) {
      i += 1;
    }
    return `${base}-${i}`;
  }

  private _renderIMSessionList(pluginName: string): string {
    const sessions = this.registry.list();
    if (sessions.length === 0) {
      return '当前没有 mx-coder 会话。直接发送一条消息即可创建新会话。';
    }

    const lines = sessions.map((session) => {
      const binding = session.imBindings.find((item) => item.plugin === pluginName);
      const bindingLabel = !binding
        ? '未绑定'
        : binding.bindingKind === 'channel'
          ? `channel=${binding.channelId}`
          : `thread=${binding.threadId}`;
      return `- ${session.name} (${session.status}, cli=${session.cliPlugin}) ${bindingLabel}`;
    });

    return [
      '当前 mx-coder 会话：',
      ...lines,
      '',
      `发送 /open <sessionName> 可在对应${this._getMattermostConversationKind() === 'channel' ? ' channel' : ' thread'}中收到定位消息。`,
    ].join('\n');
  }

  private async _handleTakeoverCommand(sessionName: string, channelId: string, msg: IncomingMessage, force: boolean): Promise<void> {
    const imPlugin = this._getIMPlugin(msg.plugin);
    if (!imPlugin) return;

    if (!sessionName) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: force ? '用法：/takeover-force <sessionName>' : '用法：/takeover <sessionName>',
      });
      return;
    }

    const session = this.registry.get(sessionName);
    if (!session) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `未找到会话 ${sessionName}。`,
      });
      return;
    }

    if (session.status !== 'attached' && session.status !== 'takeover_pending') {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `会话 ${sessionName} 当前不在终端占用状态，无需接管。`,
      });
      return;
    }

    if (!force) {
      if (session.status === 'attached') {
        this.registry.requestTakeover(sessionName, msg.userId);
        if (this._store) void this._store.flush();
      }
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `已请求接管会话 ${sessionName}。请在终端退出 attach，或在终端执行 mx-coder takeover-cancel ${sessionName} 取消。若需立即接管，请使用 /takeover-force ${sessionName}。`,
      });
      this._debugLog({ event: 'takeover_requested', sessionName, requestedBy: msg.userId });
      return;
    }

    await this._approvalManager?.cancelForTakeover(session.sessionId);

    if (session.status === 'attached' && session.attachedPid) {
      try {
        process.kill(session.attachedPid, 'SIGTERM');
      } catch {
        // ignore missing process; we still release session below
      }
    }

    if (session.status === 'attached') {
      this.registry.requestTakeover(sessionName, msg.userId);
    }

    this.registry.completeTakeover(sessionName);
    this._approvalManager?.invalidateSessionCache(session.sessionId);
    if (this._store) void this._store.flush();
    this._server.pushEventToAttachWaiter(sessionName, {
      type: 'event',
      event: 'session_resume',
      data: { name: sessionName },
    });

    await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
      kind: 'text',
      text: `已强制接管会话 ${sessionName}。现在可在当前${msg.threadId ? ' thread' : ' channel'}中继续对话。`,
    });
    this._debugLog({ event: 'takeover_forced', sessionName, requestedBy: msg.userId });
  }

  private async _handleOpenCommand(
    sessionName: string,
    channelId: string,
    msg: IncomingMessage,
    overrideStrategy?: 'thread' | 'channel',
  ): Promise<void> {
    this._debugLog({
      event: 'open_command_received',
      sessionName,
      requestChannelId: channelId,
      msgPlugin: msg.plugin,
      msgThreadId: msg.threadId,
      isTopLevel: msg.isTopLevel,
    });
    const imPlugin = this._getIMPlugin(msg.plugin);
    if (!imPlugin) {
      console.error(`[/open] IM plugin not found for: ${msg.plugin}`);
      return;
    }
    if (!sessionName) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: '用法：/open <sessionName>',
      });
      return;
    }

    const session = this.registry.get(sessionName);

    if (!session) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `未找到会话 ${sessionName}，请先使用 mx-coder create 创建。`,
      });
      return;
    }
    this._ensureIMActorRoles(session, msg.userId);

    const binding = session.imBindings.find((item) => item.plugin === msg.plugin);
    this._debugLog({
      event: 'open_binding_lookup',
      sessionName,
      foundBinding: !!binding,
      bindingThreadId: binding?.threadId,
      bindingChannelId: binding?.channelId,
    });

    if (binding) {
      // 已有绑定：尝试向目标会话空间发锚点
      try {
        await imPlugin.sendMessage({
          plugin: msg.plugin,
          channelId: binding.channelId ?? channelId,
          threadId: binding.bindingKind === 'channel' ? '' : binding.threadId,
        }, {
          kind: 'text',
          text: `已定位到会话 ${sessionName}。请直接在这个${binding.bindingKind === 'channel' ? ' channel' : ' thread'}中继续对话。`,
        });

        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `已在会话 ${sessionName} 的${binding.bindingKind === 'channel' ? ' channel' : ' thread'}中发送定位消息。`,
        });
        return;
      } catch (err) {
        console.error(`[/open] Failed to send to existing ${binding.bindingKind} ${binding.bindingKind === 'channel' ? binding.channelId : binding.threadId}, removing stale binding: ${(err as Error).message}`);
        const idx = session.imBindings.indexOf(binding);
        if (idx >= 0) session.imBindings.splice(idx, 1);
        if (this._store) void this._store.flush();
      }
    }

    const strategy = overrideStrategy ?? this._getMattermostConversationKind();
    if (strategy === 'channel') {
      const pluginWithChannel = imPlugin as IMPlugin & { createChannelConversation?: (input: { channelId: string; teamId: string; isPrivate: boolean; userId?: string; sessionName?: string }) => Promise<string> };
      const teamId = this._imPluginConfig['teamId'];
      if (typeof pluginWithChannel.createChannelConversation !== 'function' || typeof teamId !== 'string') {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `为 ${sessionName} 创建 channel 失败：当前配置或插件能力不完整。`,
        });
        return;
      }

      let newChannelId: string;
      try {
        newChannelId = await pluginWithChannel.createChannelConversation({ channelId, teamId, isPrivate: true, userId: msg.userId, sessionName });
      } catch (err) {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `为 ${sessionName} 创建 channel 失败：${(err as Error).message}`,
        });
        return;
      }

      this.registry.bindIM(sessionName, {
        plugin: msg.plugin,
        bindingKind: 'channel',
        threadId: '',
        channelId: newChannelId,
      });
      if (this._store) void this._store.flush();

      await imPlugin.sendMessage({
        plugin: msg.plugin,
        channelId: newChannelId,
        threadId: '',
      }, {
        kind: 'text',
        text: `已定位到会话 ${sessionName}。请直接在这个 channel 中继续对话。`,
      });

      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `已为会话 ${sessionName} 创建独立 private channel，并在目标 channel 发送定位消息。`,
      });
      return;
    }

    // 无绑定（或旧绑定已失效）：为 session 创建新 thread
    const recheckBinding = session.imBindings.find((item) => item.plugin === msg.plugin);
    if (recheckBinding) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `会话 ${sessionName} 已被绑定到其他 thread。`,
      });
      return;
    }

    let newThreadId: string;
    try {
      newThreadId = await imPlugin.createLiveMessage(
        { plugin: msg.plugin, channelId, threadId: '' },
        { kind: 'text', text: `[${sessionName} thread — 请在此继续对话]` },
      );
      this._debugLog({ event: 'open_thread_created', sessionName, newThreadId, channelId });
    } catch (err) {
      console.error(`[/open] createLiveMessage failed: ${(err as Error).message}`);
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `为 ${sessionName} 创建 thread 失败：${(err as Error).message}`,
      });
      return;
    }

    const finalCheck = session.imBindings.find((item) => item.plugin === msg.plugin);
    if (finalCheck) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `会话 ${sessionName} 已被绑定到其他 thread。`,
      });
      return;
    }

    this.registry.bindIM(sessionName, {
      plugin: msg.plugin,
      bindingKind: 'thread',
      threadId: newThreadId,
      channelId,
    });
    this._debugLog({ event: 'open_binding_created', sessionName, threadId: newThreadId, channelId });
    if (this._store) void this._store.flush();

    await imPlugin.sendMessage({
      plugin: msg.plugin,
      channelId,
      threadId: newThreadId,
    }, {
      kind: 'text',
      text: `已定位到会话 ${sessionName}。请直接在这个 thread 中继续对话。`,
    });

    await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
      kind: 'text',
      text: `已为会话 ${sessionName} 创建独立 thread。已在该 thread 发送定位消息，可直接开始对话。`,
    });
  }

  async start(): Promise<void> {
    if (this._store) {
      await this._store.load(this.registry);
      this.registry.reconcileProcessLiveness();
      await this._store.flush();
    }
    await this._server.listen();
  }

  async stop(): Promise<void> {
    // Stop IM components
    if (this._imDispatcher) {
      this._imDispatcher.stop();
    }
    const plugins = new Set<IMPlugin>([
      ...this._imPlugins.values(),
      ...(this._imPlugin ? [this._imPlugin] : []),
    ]);
    for (const plugin of plugins) {
      await plugin.disconnect?.();
    }
    if (this._approvalHandler) {
      await this._approvalHandler.close();
      this._approvalHandler = null;
    }

    // Stop daemon core
    if (this._store) {
      await this._store.flush();
    }
    await this._server.close();
  }

  /** Write PID file so CLI can detect running daemon */
  writePidFile(pidFile: string): void {
    fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
    process.on('exit', () => {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    });
  }

  private _registerHandlers(): void {
    this._server.handle('create', async (args, actor) => {
      // create is public — no ACL check
      const name = args['name'] as string;
      const workdir = args['workdir'] as string;
      const cli = args['cli'] as string;

      let session;
      try {
        session = this.registry.create(name, { workdir, cliPlugin: cli });
      } catch (err) {
        const code: ErrorCode = 'SESSION_ALREADY_EXISTS';
        const e = new Error((err as Error).message) as Error & { code: ErrorCode };
        e.code = code;
        throw e;
      }

      // Creator becomes owner
      if (actor?.userId) {
        this._acl.grant(session, actor.userId, 'owner');
        this._acl.grantRole(session.sessionId, actor.userId, 'owner');
      }

      return { session: this._serializeSession(session) };
    });

    this._server.handle('list', async () => {
      this.registry.reconcileProcessLiveness();
      if (this._store) void this._store.flush();
      const sessions = this.registry.list().map(s => this._serializeSession(s));
      return { sessions };
    });

    this._server.handle('remove', async (args, actor) => {
      const name = args['name'] as string;
      const session = this.registry.get(name);

      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

      this._checkAcl(actor, 'remove', session);

      if (session.status === 'attached' || session.status === 'attach_pending' || session.status === 'takeover_pending') {
        const e = new Error(`Cannot remove session '${name}' while status is ${session.status}`) as Error & { code: ErrorCode };
        e.code = 'INVALID_STATE_TRANSITION';
        throw e;
      }

      if (session.imWorkerPid != null) {
        await this._imWorkerManager?.terminate(name);
      }

      this.registry.remove(name);
      return {};
    });

    this._server.handle('status', async () => {
      this.registry.reconcileProcessLiveness();
      if (this._store) void this._store.flush();
      const sessions = this.registry.list().map(s => this._serializeSession(s));
      return { pid: process.pid, sessions };
    });

    this._server.handle('markDetached', async (args) => {
      const name = args['name'] as string;
      const exitReason = (args['exitReason'] as 'normal' | 'error' | undefined) ?? 'normal';

      const session = this.registry.get(name);
      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

      // Allow markDetached from 'attached' or 'recovering' (daemon restarted while attached).
      // Also tolerate sessions stuck in 'attach_pending' when the CLI process itself crashed.
      const allowedStates = new Set(['attached', 'attach_pending', 'recovering', 'takeover_pending']);
      if (!allowedStates.has(session.status)) {
        // Already in a stable state (idle/error/im_processing) — this is a stale call; ignore.
        return {};
      }

      if (session.status === 'takeover_pending') {
        this.registry.completeTakeover(name);
      } else if (session.status === 'attach_pending') {
        this._server.pushEventToAttachWaiter(name, {
          type: 'event',
          event: 'session_resume',
          data: { name },
        });
        return {};
      } else {
        this.registry.markDetached(name, exitReason);
      }
      if (this._store) void this._store.flush();

      // Push session_resume for any waiting attach waiter
      this._server.pushEventToAttachWaiter(name, {
        type: 'event',
        event: 'session_resume',
        data: { name },
      });

      return {};
    });

    this._server.handle('attach', async (args, actor, socket) => {
      const name = args['name'] as string;
      const pid = args['pid'] as number;
      const existing = this.registry.get(name);
      if (!existing) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

      this.registry.reconcileProcessLiveness(name);
      const session = this.registry.get(name)!;

      this._checkAcl(actor, 'attach', session);

      // initState guard: concurrent init in progress
      if (session.initState === 'initializing') {
        const e = new Error('SESSION_BUSY') as Error & { code: ErrorCode };
        e.code = 'SESSION_BUSY';
        throw e;
      }

      // lazy init on first attach (first-writer-wins)
      if (session.initState === 'uninitialized') {
        await this.registry.beginInitAndAttach(name, pid);
      } else {
        // markAttached handles im_processing → attach_pending via state machine
        this.registry.markAttached(name, pid);
      }

      if (this._store) void this._store.flush();

      const updated = this.registry.get(name)!;
      if (updated.status === 'attach_pending') {
        // Register socket so markDetached/IM completion can push session_resume event
        if (socket) this._server.registerAttachWaiter(name, socket);
        return { waitRequired: true, session: this._serializeSession(updated) };
      }
      return { session: this._serializeSession(updated) };
    });

    this._server.handle('updateSessionId', async (args) => {
      const name = args['name'] as string;
      const sessionId = args['sessionId'] as string;

      const session = this.registry.get(name);
      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

      this.registry.updateSessionId(name, sessionId);
      if (this._store) void this._store.flush();

      return { session: this._serializeSession(this.registry.get(name)!) };
    });

    this._server.handle('takeoverStatus', async (args, actor) => {
      const name = args['name'] as string;
      const session = this.registry.get(name);
      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      this._checkAcl(actor, 'takeoverStatus', session);
      return {
        session: this._serializeSession(session),
        takeoverRequestedBy: session.takeoverRequestedBy,
        takeoverRequestedAt: session.takeoverRequestedAt,
      };
    });

    this._server.handle('takeoverCancel', async (args, actor) => {
      const name = args['name'] as string;
      const session = this.registry.get(name);
      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      this._checkAcl(actor, 'takeoverCancel', session);
      this.registry.cancelTakeover(name);
      if (this._store) void this._store.flush();
      return { session: this._serializeSession(this.registry.get(name)!) };
    });

    this._server.handle('open', async (args, actor) => {
      const name = args['name'] as string;
      const sessionForAcl = this.registry.get(name);
      if (!sessionForAcl) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      this._checkAcl(actor, 'open', sessionForAcl);
      const plugin = (args['plugin'] as string | undefined) ?? this._imPluginName ?? getDefaultIMPluginName();
      const channelId = (args['channelId'] as string | undefined) ?? '';
      const threadId = (args['threadId'] as string | undefined) ?? '';
      const overrideRaw = args['spaceStrategy'] as string | undefined;
      const overrideStrategy = overrideRaw === 'thread' || overrideRaw === 'channel' ? overrideRaw : undefined;
      const imPlugin = this._getIMPlugin(plugin);
      if (!imPlugin) {
        const e = new Error(`IM plugin not initialized: ${plugin}`) as Error & { code: ErrorCode };
        e.code = 'INTERNAL_ERROR';
        throw e;
      }
      const msg: IncomingMessage = {
        plugin,
        channelId,
        threadId,
        isTopLevel: !threadId,
        userId: '',
        text: `/open ${name}`,
        messageId: randomUUID(),
        createdAt: new Date().toISOString(),
        dedupeKey: randomUUID(),
      };
      await this._handleOpenCommand(name, channelId, msg, overrideStrategy);
      const session = this.registry.get(name);
      return {
        session: session ? this._serializeSession(session) : null,
        spaceStrategy: overrideStrategy ?? this._getMattermostConversationKind(),
      };
    });

    this._server.handle('import', async (args, actor) => {
      const sessionId = args['sessionId'] as string;
      const workdir = args['workdir'] as string;
      const cli = args['cli'] as string;
      const name = (args['name'] as string | undefined) ?? `imported-${randomUUID().slice(0, 8)}`;

      let session;
      try {
        session = this.registry.importSession(sessionId, name, { workdir, cliPlugin: cli });
      } catch (err) {
        const e = new Error((err as Error).message) as Error & { code: ErrorCode };
        e.code = 'SESSION_ALREADY_EXISTS';
        throw e;
      }

      if (actor?.userId) {
        this._acl.grant(session, actor.userId, 'owner');
        this._acl.grantRole(session.sessionId, actor.userId, 'owner');
      }

      return { session: this._serializeSession(session) };
    });
  }

  private _checkAcl(actor: Actor | undefined, action: AclAction, session: import('./types.js').Session): void {
    if (this._acl.authorize(actor, action, session) === 'deny') {
      const e = new Error('ACL_DENIED') as Error & { code: ErrorCode };
      e.code = 'ACL_DENIED';
      throw e;
    }
  }

  private _serializeSession(s: import('./types.js').Session): Record<string, unknown> {
    return {
      name: s.name,
      sessionId: s.sessionId,
      status: s.status,
      runtimeState: s.runtimeState,
      lifecycleStatus: s.lifecycleStatus,
      initState: s.initState,
      workdir: s.workdir,
      cliPlugin: s.cliPlugin,
      imBindings: s.imBindings,
      createdAt: s.createdAt,
    };
  }
}
