import { IPCServer } from './ipc/socket-server.js';
import { SessionRegistry } from './session-registry.js';
import { AclManager } from './acl-manager.js';
import { PersistenceStore } from './persistence.js';
import { IMMessageDispatcher } from './im-message-dispatcher.js';
import { IMWorkerManager } from './im-worker-manager.js';
import { ApprovalManager } from './approval-manager.js';
import { getIMPluginFactory, getDefaultIMPluginName } from './plugins/im/registry.js';
import { getCLIPlugin, getDefaultCLIPluginName } from './plugins/cli/registry.js';
import type { IMPlugin } from './plugins/types.js';
import type { IncomingMessage, MessageTarget, Session } from './types.js';
import type { AclAction, Actor } from './acl-manager.js';
import type { ErrorCode } from './ipc/codec.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';


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

    this._imWorkerManager = new IMWorkerManager((session: Session) => getCLIPlugin(session.cliPlugin), this.registry);

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
    const factory = getIMPluginFactory(msg.plugin);

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

    // C 类：IM 中不支持的命令（remove/attach/create 等）
    // 在 thread 中（isTopLevel=false）拦截，不落入 CLI
    if (!msg.isTopLevel && trimmed.startsWith('/')) {
      await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `命令 \`${trimmed.split(' ')[0]}\` 不支持在 IM 中使用，请使用 mm-coder CLI。`,
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
    const session = this._getOrCreateSessionForConversation(
      conversationKind === 'channel' ? (msg.channelId ?? channelId) : msg.threadId,
      msg.plugin,
      conversationKind,
    );
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
      this.registry.enqueueIMMessage(session.name, {
        text: msg.text,
        dedupeKey: msg.dedupeKey,
        plugin: msg.plugin,
        channelId: msg.channelId ?? channelId,
        threadId: msg.threadId,
        messageId: msg.messageId,
        userId: msg.userId,
        receivedAt: msg.createdAt,
      });
      this._debugLog({
        event: 'im_message_enqueued',
        sessionName: session.name,
        sessionStatus: session.status,
        threadId: msg.threadId,
        channelId: msg.channelId ?? channelId,
        messageId: msg.messageId,
      });
    } catch (err) {
      console.error(`Failed to enqueue IM message: ${(err as Error).message}`);
    }
  }

  private _buildReplyTarget(msg: IncomingMessage, channelId: string): MessageTarget {
    return {
      plugin: msg.plugin,
      channelId: msg.channelId ?? channelId,
      // For top-level messages (channel root posts), reply to the channel itself (empty threadId).
      // For thread replies, reply into that thread.
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
    return [
      `**mm-coder 全局状态**`,
      `会话总数：${total}`,
      `attached：${attached}　im_processing：${imProcessing}　idle：${detached}`,
      total > 0 ? '\n发送 `/list` 查看详细列表，`/open <name>` 定位到对应 thread。' : '\n直接发送消息即可创建新会话。',
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

    const name = this._makeSessionName(conversationId);
    const session = this.registry.create(name, {
      workdir: process.cwd(),
      cliPlugin: this._defaultCLIPluginName,
    });
    this.registry.bindIM(name, {
      plugin,
      bindingKind,
      threadId: bindingKind === 'thread' ? conversationId : '',
      ...(bindingKind === 'channel' ? { channelId: conversationId } : {}),
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
      return '当前没有 mm-coder 会话。直接发送一条消息即可创建新会话。';
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
      '当前 mm-coder 会话：',
      ...lines,
      '',
      '发送 /open <sessionName> 可在对应 thread 中收到定位消息。',
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
        text: `已请求接管会话 ${sessionName}。请在终端退出 attach，或在终端执行 mm-coder takeover-cancel ${sessionName} 取消。若需立即接管，请使用 /takeover-force ${sessionName}。`,
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
      text: `已强制接管会话 ${sessionName}。现在可在当前 thread 中继续对话。`,
    });
    this._debugLog({ event: 'takeover_forced', sessionName, requestedBy: msg.userId });
  }

  private async _handleOpenCommand(sessionName: string, channelId: string, msg: IncomingMessage): Promise<void> {
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
        text: `未找到会话 ${sessionName}，请先使用 mm-coder create 创建。`,
      });
      return;
    }

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

    const strategy = this._getMattermostConversationKind();
    if (strategy === 'channel') {
      const createChannelConversation = (imPlugin as IMPlugin & { createChannelConversation?: (input: { channelId: string; teamId: string; isPrivate: boolean }) => Promise<string> }).createChannelConversation;
      const teamId = this._imPluginConfig['teamId'];
      if (typeof createChannelConversation !== 'function' || typeof teamId !== 'string') {
        await imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
          kind: 'text',
          text: `为 ${sessionName} 创建 channel 失败：当前配置或插件能力不完整。`,
        });
        return;
      }

      let newChannelId: string;
      try {
        newChannelId = await createChannelConversation({ channelId, teamId, isPrivate: true });
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
      }

      return { session: this._serializeSession(session) };
    });

    this._server.handle('list', async () => {
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
      const session = this.registry.get(name);

      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

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

    this._server.handle('takeoverStatus', async (args) => {
      const name = args['name'] as string;
      const session = this.registry.get(name);
      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      return {
        session: this._serializeSession(session),
        takeoverRequestedBy: session.takeoverRequestedBy,
        takeoverRequestedAt: session.takeoverRequestedAt,
      };
    });

    this._server.handle('takeoverCancel', async (args) => {
      const name = args['name'] as string;
      const session = this.registry.get(name);
      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      this.registry.cancelTakeover(name);
      if (this._store) void this._store.flush();
      return { session: this._serializeSession(this.registry.get(name)!) };
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
