import { IPCServer } from './ipc/socket-server.js';
import { SessionRegistry } from './session-registry.js';
import { AclManager } from './acl-manager.js';
import type { AclAction, Actor } from './acl-manager.js';
import type { ErrorCode } from './ipc/codec.js';

export class Daemon {
  private _server: IPCServer;
  private _registry: SessionRegistry;
  private _acl: AclManager;

  constructor(socketPath: string) {
    this._server = new IPCServer(socketPath);
    this._registry = new SessionRegistry();
    this._acl = new AclManager();
    this._registerHandlers();
  }

  async start(): Promise<void> {
    await this._server.listen();
  }

  async stop(): Promise<void> {
    await this._server.close();
  }

  private _registerHandlers(): void {
    this._server.handle('create', async (args, actor) => {
      // create is public — no ACL check
      const name = args['name'] as string;
      const workdir = args['workdir'] as string;
      const cli = args['cli'] as string;

      let session;
      try {
        session = this._registry.create(name, { workdir, cliPlugin: cli });
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
      const sessions = this._registry.list().map(s => this._serializeSession(s));
      return { sessions };
    });

    this._server.handle('remove', async (args, actor) => {
      const name = args['name'] as string;
      const session = this._registry.get(name);

      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

      this._checkAcl(actor, 'remove', session);

      this._registry.remove(name);
      return {};
    });

    this._server.handle('status', async () => {
      const sessions = this._registry.list().map(s => this._serializeSession(s));
      return { pid: process.pid, sessions };
    });

    this._server.handle('attach', async (args, actor) => {
      const name = args['name'] as string;
      const pid = args['pid'] as number;
      const session = this._registry.get(name);

      if (!session) {
        const e = new Error(`Session not found: ${name}`) as Error & { code: ErrorCode };
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }

      this._checkAcl(actor, 'attach', session);

      this._registry.markAttached(name, pid);
      return { session: this._serializeSession(this._registry.get(name)!) };
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
