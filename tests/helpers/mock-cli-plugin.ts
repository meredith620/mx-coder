import { randomUUID } from 'crypto';
import type { CLIPlugin, CommandSpec, LegacyIMMessageCLIPlugin } from '../../src/plugins/types.js';
import type { Session } from '../../src/types.js';

export class MockCLIPlugin implements LegacyIMMessageCLIPlugin {
  private _command: string;
  private _args: string[];
  private _buildIMWorkerArgs?: (session: Session, bridgeScriptPath: string) => string[];

  constructor(command: string, args: string[] = [], opts?: { buildIMWorkerArgs?: (session: Session, bridgeScriptPath: string) => string[] }) {
    this._command = command;
    this._args = args;
    this._buildIMWorkerArgs = opts?.buildIMWorkerArgs;
  }

  buildAttachCommand(session: Session): CommandSpec {
    return {
      command: this._command,
      args: [...this._args, '--resume', session.sessionId],
    };
  }

  buildIMWorkerCommand(session: Session, bridgeScriptPath: string): CommandSpec {
    return {
      command: this._command,
      args: this._buildIMWorkerArgs ? this._buildIMWorkerArgs(session, bridgeScriptPath) : [...this._args],
    };
  }

  buildIMMessageCommand(session: Session, prompt: string): CommandSpec {
    return {
      command: this._command,
      args: [...this._args, '-p', prompt, '--resume', session.sessionId],
    };
  }

  generateSessionId(): string {
    return randomUUID();
  }
}
