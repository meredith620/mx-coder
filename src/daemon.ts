import { IPCServer } from './ipc/socket-server.js';
import { SessionRegistry } from './session-registry.js';
import { AclManager } from './acl-manager.js';
import { PersistenceStore } from './persistence.js';
import { IMMessageDispatcher } from './im-message-dispatcher.js';
import { IMWorkerManager } from './im-worker-manager.js';
import { getMattermostCommandHelpText } from './plugins/im/mattermost.js';
import { getIMPluginFactory } from './plugins/im/registry.js';
import { getCLIPlugin } from './plugins/cli/registry.js';
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
}

export class Daemon {
  private _server: IPCServer;
  registry: SessionRegistry;
  private _acl: AclManager;
  private _store: PersistenceStore | null;
  private _imPlugin: IMPlugin | null = null;
  private _imDispatcher: IMMessageDispatcher | null = null;
  private _imWorkerManager: IMWorkerManager | null = null;

  constructor(socketPath: string, opts: DaemonOptions = {}) {
    this._server = new IPCServer(socketPath);
    this._store = opts.persistencePath ? new PersistenceStore(opts.persistencePath) : null;
    this.registry = new SessionRegistry(this._store ?? undefined);
    this._acl = new AclManager();
    this._registerHandlers();

    // Initialize IM if enabled
    if (opts.enableIM) {
      void this._initializeIM(opts.imPluginName ?? 'mattermost', opts.imConfigPath);
    }
  }

  private async _initializeIM(pluginName: string, configPath?: string): Promise<void> {
    try {
      const factory = getIMPluginFactory(pluginName);
      const cfgPath = configPath ?? factory.getDefaultConfigPath();

      this._imPlugin = await factory.load(cfgPath);

      // Register message handler
      this._imPlugin.onMessage((msg) => {
        // Use channelId from message, or empty string as fallback
        void this._handleIncomingIMMessage(msg, msg.channelId ?? '');
      });

      // Initialize CLI plugin via registry
      const cliPlugin = getCLIPlugin('claude-code');

      // Initialize worker manager
      this._imWorkerManager = new IMWorkerManager(cliPlugin, this.registry);

      // Initialize message dispatcher
      this._imDispatcher = new IMMessageDispatcher({
        registry: this.registry,
        imPlugin: this._imPlugin,
        imTarget: {
          plugin: pluginName,
          threadId: '',
        },
        cliPlugin,
        pollIntervalMs: 500,
      });

      // Start dispatcher
      this._imDispatcher.start();

      console.log(`IM plugin '${pluginName}' connected and dispatcher started`);
    } catch (err) {
      console.error(`Failed to initialize IM: ${(err as Error).message}`);
    }
  }

  private async _handleIncomingIMMessage(msg: IncomingMessage, channelId: string): Promise<void> {
    if (!this._imPlugin) return;

    const trimmed = msg.text.trim();

    if (trimmed === '/help') {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: getMattermostCommandHelpText(),
      });
      return;
    }

    if (trimmed === '/list') {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: this._renderIMSessionList(),
      });
      return;
    }

    if (trimmed === '/status') {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
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

    // C 类：IM 中不支持的命令（remove/attach/create 等）
    // 在 thread 中（isTopLevel=false）拦截，不落入 CLI
    if (!msg.isTopLevel && trimmed.startsWith('/')) {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `命令 \`${trimmed.split(' ')[0]}\` 不支持在 IM 中使用，请使用 mm-coder CLI。`,
      });
      return;
    }

    // D 类：顶层 channel 消息中的未知命令
    if (msg.isTopLevel && trimmed.startsWith('/')) {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `未知命令 \`${trimmed.split(' ')[0]}\`。发送 \`/help\` 查看可用命令。`,
      });
      return;
    }

    // E 类：普通文本消息，进入 Claude 处理流程
    const session = this._getOrCreateSessionForThread(msg.threadId, msg.plugin);
    try {
      this.registry.enqueueIMMessage(session.name, {
        text: msg.text,
        dedupeKey: msg.dedupeKey,
        plugin: msg.plugin,
        threadId: msg.threadId,
        messageId: msg.messageId,
        userId: msg.userId,
        receivedAt: msg.createdAt,
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
        return this._renderSessionStatus(session);
      }
    }
    // Global stats (top-level or unbound thread)
    return this._renderGlobalStatus(sessions);
  }

  private _renderSessionStatus(session: Session): string {
    const binding = session.imBindings[0];
    const pending = session.messageQueue.filter(m => m.status === 'pending').length;
    const lines = [
      `**会话：** \`${session.name}\``,
      `**状态：** ${session.status}`,
      `**工作目录：** ${session.workdir}`,
      `**绑定 thread：** ${binding?.threadId ?? '未绑定'}`,
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

  private _getOrCreateSessionForThread(threadId: string, plugin: string) {
    const existing = this.registry.getByIMThread(plugin, threadId);
    if (existing) return existing;

    const name = this._makeSessionName(threadId);
    const session = this.registry.create(name, {
      workdir: process.cwd(),
      cliPlugin: 'claude-code',
    });
    this.registry.bindIM(name, { plugin, threadId });
    return session;
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

  private _renderIMSessionList(): string {
    const sessions = this.registry.list();
    if (sessions.length === 0) {
      return '当前没有 mm-coder 会话。直接发送一条消息即可创建新会话。';
    }

    const lines = sessions.map((session) => {
      const binding = session.imBindings.find((item) => item.plugin === 'mattermost');
      const thread = binding ? binding.threadId : '未绑定';
      return `- ${session.name} (${session.status}) thread=${thread}`;
    });

    return [
      '当前 mm-coder 会话：',
      ...lines,
      '',
      '发送 /open <sessionName> 可在对应 thread 中收到定位消息。',
    ].join('\n');
  }

  private async _handleOpenCommand(sessionName: string, channelId: string, msg: IncomingMessage): Promise<void> {
    if (!this._imPlugin) return;
    if (!sessionName) {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: '用法：/open <sessionName>',
      });
      return;
    }

    const session = this.registry.get(sessionName);

    if (!session) {
      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `未找到会话 ${sessionName}，请先使用 mm-coder create 创建。`,
      });
      return;
    }

    const binding = session.imBindings.find((item) => item.plugin === 'mattermost');

    if (binding) {
      // 已有绑定：向目标 session 绑定 thread 发锚点 + 当前 thread 发确认
      await this._imPlugin.sendMessage({
        plugin: 'mattermost',
        channelId,
        threadId: binding.threadId,
      }, {
        kind: 'text',
        text: `已定位到会话 ${sessionName}。请直接在这个 thread 中继续对话。`,
      });

      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `已在会话 ${sessionName} 的 thread 中发送定位消息。`,
      });
    } else {
      // 无绑定：为 session 创建新 thread（发 root post），绑定后回复
      const newThreadId = await this._imPlugin.createLiveMessage(
        { plugin: 'mattermost', channelId, threadId: '' },
        { kind: 'text', text: `[${sessionName} thread — 请在此继续对话]` },
      );

      this.registry.bindIM(sessionName, {
        plugin: 'mattermost',
        threadId: newThreadId,
        channelId,
      });

      await this._imPlugin.sendMessage(this._buildReplyTarget(msg, channelId), {
        kind: 'text',
        text: `已为会话 ${sessionName} 创建独立 thread。已在该 thread 发送定位消息，可直接开始对话。`,
      });
    }
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
    if (this._imPlugin) {
      await this._imPlugin.disconnect?.();
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
      const allowedStates = new Set(['attached', 'attach_pending', 'recovering']);
      if (!allowedStates.has(session.status)) {
        // Already in a stable state (idle/error/im_processing) — this is a stale call; ignore.
        return {};
      }

      this.registry.markDetached(name, exitReason);
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
        // Register socket so markDetached can push session_resume event
        if (socket) this._server.registerAttachWaiter(name, socket);
        return { waitRequired: true, session: this._serializeSession(updated) };
      }
      return { session: this._serializeSession(updated) };
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
      lifecycleStatus: s.lifecycleStatus,
      workdir: s.workdir,
      cliPlugin: s.cliPlugin,
      createdAt: s.createdAt,
    };
  }
}
