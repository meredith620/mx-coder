#!/usr/bin/env node
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { IPCClient } from './ipc/client.js';
import { attachSession } from './attach.js';
import { parseCLIArgs } from './cli-parser.js';
import { BUILD_GIT_HASH, BUILD_VERSION } from './generated/build-info.js';
import { getCLIPlugin, getDefaultCLIPluginName } from './plugins/cli/registry.js';
import { getClaudeSessionPath, hasClaudeSession } from './plugins/cli/claude-code.js';
import { getIMPluginFactory, getDefaultIMPluginName } from './plugins/im/registry.js';
import { renderUserServiceUnit, writeUserServiceUnit, installUserService, getUserServiceStatus, uninstallUserService } from './systemd.js';
import { createTuiStateStore, renderTuiOverview } from './tui.js';
import type { Session } from './types.js';

const SOCKET_PATH = process.env.MX_CODER_SOCKET ?? path.join(os.tmpdir(), 'mx-coder-daemon.sock');
const PID_FILE = process.env.MX_CODER_PID_FILE ?? path.join(os.tmpdir(), 'mx-coder-daemon.pid');
const PERSISTENCE_PATH = process.env.MX_CODER_SESSIONS ?? path.join(os.homedir(), '.mx-coder', 'sessions.json');
const LOG_PATH = process.env.MX_CODER_LOG ?? path.join(os.homedir(), '.mx-coder', 'daemon.log');
const VERSION = BUILD_VERSION;
const GIT_HASH = BUILD_GIT_HASH;

function printVersion() {
  console.log(`mx-coder ${VERSION} (${GIT_HASH})`);
}

async function waitForDaemonStop(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function resolveDaemonEntry(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const jsEntry = path.join(currentDir, 'daemon-main.js');
  if (fs.existsSync(jsEntry)) {
    return jsEntry;
  }
  return path.join(currentDir, 'daemon-main.ts');
}

function buildDaemonChildArgs(
  socketPath: string,
  pidFile: string,
  persistencePath: string,
  imConfigPath: string,
  imPluginName: string,
  logPath: string,
): string[] {
  return [
    ...process.execArgv,
    resolveDaemonEntry(),
    socketPath,
    pidFile,
    persistencePath,
    imConfigPath,
    imPluginName,
    logPath,
  ];
}

async function waitForSocketRelease(socketPath: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(socketPath)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !fs.existsSync(socketPath);
}

async function waitForPidFile(pidFile: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for pid file ${pidFile}`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    printVersion();
    process.exit(0);
  }

  try {
    if (argv[0] === 'start-fg') {
      await handleStartForeground(argv.slice(1));
      return;
    }

    const parsed = parseCLIArgs(argv);

    switch (parsed.command) {
      case 'start':
        await handleStart(parsed.args);
        break;
      case 'stop':
        await handleStop();
        break;
      case 'restart':
        await handleRestart(parsed.args);
        break;
      case 'create':
        await handleCreate(parsed.args);
        break;
      case 'attach':
        await handleAttach(parsed.args);
        break;
      case 'open':
        await handleOpen(parsed.args);
        break;
      case 'setup':
        await handleSetup(parsed.args);
        break;
      case 'env':
        await handleEnv(parsed.args);
        break;
      case 'list':
        await handleList();
        break;
      case 'takeover-status':
        await handleTakeoverStatus(parsed.args);
        break;
      case 'takeover-cancel':
        await handleTakeoverCancel(parsed.args);
        break;
      case 'status':
        await handleStatus(parsed.args);
        break;
      case 'remove':
        await handleRemove(parsed.args);
        break;
      case 'diagnose':
        await handleDiagnose(parsed.args);
        break;
      case 'import':
        await handleImport(parsed.args);
        break;
      case 'completion':
        await handleCompletion(parsed.args);
        break;
      case 'im':
        await handleIm(parsed.subcommand!, parsed.args);
        break;
      case 'tui':
        await handleTui();
        break;
      default:
        console.error(`Unknown command: ${parsed.command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
mx-coder - Multi-modal Claude Code session manager

USAGE:
  mx-coder <command> [options]

COMMANDS:
  start                           Start daemon in background
  start-fg                        Start daemon in foreground and print logs
  stop                            Stop the running daemon
  restart                         Restart the daemon
  create <name> [-n|--name <name>] [-w|--workdir <path>] [-C|--cli <name>]
                                  [--space-strategy <thread|channel>]
                                  Create a new session
  attach <name> [-n|--name <name>]  Attach to a session
  open <name> [-n|--name <name>] [--space-strategy <thread|channel>]
                                  Open a session in IM with one-shot space override
  setup systemd [--user] [--dry-run]
                                  Preview systemd user service unit
  env <get|set|unset|clear|import|list> <name> [key] [value]
                                  Manage per-session environment variables
  diagnose <name>                   Print local diagnostic info for a session
  takeover-status <name>            Show takeover request state
  takeover-cancel <name>            Cancel a pending takeover request
  list                            List all sessions
  status [name] [-n|--name <name>]  Show daemon/session status
  remove <name> [-n|--name <name>]  Remove a session
  import <sessionId> [-s|--sessionId <id>] -w <path> [-n|--name <name>] [-C|--cli <name>]
                                  Import external session
  completion <bash|zsh|sessions>   Print shell completion script or session names
  im init [-p|--plugin <name>] [-c|--config <path>]
                                  Create IM config template
  im verify [-p|--plugin <name>] [-c|--config <path>]
                                  Verify IM connectivity
  im run <sessionName>            Run IM worker for a session
  --help, -h                      Show this help
  --version, -v                   Show version info

EXAMPLES:
  mx-coder start
  mx-coder start-fg
  mx-coder create bug-fix -w ~/myapp
  mx-coder attach bug-fix -n my-session
  mx-coder diagnose bug-fix
  mx-coder takeover-status bug-fix
  mx-coder takeover-cancel bug-fix
  mx-coder list
  mx-coder status bug-fix -n my-session
  mx-coder remove bug-fix -n my-session
  mx-coder completion bash
  mx-coder completion zsh
  mx-coder completion sessions
  mx-coder im init -p discord
  mx-coder im verify
  mx-coder im init -c ~/.mx-coder/discord.json
`.trim());
}

function getCompletionCommands(): string[] {
  return [
    'start',
    'stop',
    'restart',
    'create',
    'attach',
    'open',
    'setup',
    'env',
    'diagnose',
    'takeover-status',
    'takeover-cancel',
    'list',
    'status',
    'remove',
    'import',
    'completion',
    'im',
    'tui',
  ];
}

function renderBashCompletion(): string {
  const commands = getCompletionCommands().join(' ');
  return `# bash completion for mx-coder
_mx_coder_collect_sessions() {
  mx-coder completion sessions 2>/dev/null || true
}

_mx_coder_session_completions() {
  local cur sessions session
  cur="\${1}"
  COMPREPLY=()
  sessions="$(_mx_coder_collect_sessions)"
  while IFS= read -r session; do
    [[ -z "\${session}" ]] && continue
    [[ "\${session}" == "\${cur}"* ]] && COMPREPLY+=("\${session}")
  done <<< "\${sessions}"
}

_mx_coder_completions() {
  local cur command needs_session commands_with_sessions
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"
  commands_with_sessions="attach open status remove diagnose takeover-status takeover-cancel"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "\${cur}") )
    return 0
  fi

  if [[ \${command} == "completion" ]]; then
    COMPREPLY=( $(compgen -W "bash zsh sessions" -- "\${cur}") )
    return 0
  fi

  for needs_session in \${commands_with_sessions}; do
    if [[ \${command} == "\${needs_session}" && \${COMP_CWORD} -eq 2 ]]; then
      _mx_coder_session_completions "\${cur}"
      return 0
    fi
  done
}
complete -o bashdefault -o default -F _mx_coder_completions mx-coder
`;
}

function renderZshCompletion(): string {
  const commands = getCompletionCommands().map((command) => `'${command}:${command}'`).join(' ');
  return `#compdef mx-coder

_mxcoder() {
  local -a commands session_commands sessions
  commands=(
    ${commands}
  )
  session_commands=(attach open status remove diagnose takeover-status takeover-cancel)

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  if [[ \${words[2]} == completion ]]; then
    _values 'shell' bash zsh sessions
    return
  fi

  if (( CURRENT == 3 )) && (( \${session_commands[(Ie)\${words[2]}]} <= \${#session_commands} )); then
    sessions=(\${(f)"$(mx-coder completion sessions 2>/dev/null)"})
    _describe 'session' sessions
    return
  fi
}

_mxcoder "$@"
`;
}

async function handleCompletion(args: Record<string, string | undefined>) {
  const shell = args.shell;

  if (shell === 'sessions') {
    const client = new IPCClient(SOCKET_PATH);
    await client.connect();
    const res = await client.send('list', {});
    await client.close();

    if (!res.ok) {
      throw new Error(`Failed to load sessions for completion: ${res.error!.message}`);
    }

    const sessions = res.data.sessions as Array<Record<string, unknown>>;
    const names = sessions
      .map((session) => session.name)
      .filter((name): name is string => typeof name === 'string');
    process.stdout.write(names.join('\n'));
    return;
  }

  if (shell !== 'bash' && shell !== 'zsh') {
    throw new Error('Missing or unsupported shell. Usage: mx-coder completion <bash|zsh|sessions>');
  }

  if (shell === 'bash') {
    process.stdout.write(renderBashCompletion());
    return;
  }

  process.stdout.write(renderZshCompletion());
}

async function handleStart(args: Record<string, string | undefined>) {
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`Daemon already running (PID ${pid})`);
      return;
    } catch {
      fs.unlinkSync(PID_FILE);
    }
  }

  fs.mkdirSync(path.dirname(PERSISTENCE_PATH), { recursive: true });

  const imPluginName = args.plugin ?? getDefaultIMPluginName();
  const imConfigPath = args.config ?? getIMPluginFactory(imPluginName).getDefaultConfigPath();
  const childArgs = buildDaemonChildArgs(
    SOCKET_PATH,
    PID_FILE,
    PERSISTENCE_PATH,
    imConfigPath ?? '',
    imPluginName,
    LOG_PATH,
  );

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  const daemonPid = await waitForPidFile(PID_FILE);
  console.log(`Daemon started (PID ${daemonPid})`);
  console.log(`Log file: ${LOG_PATH}`);
}

async function handleStartForeground(argv: string[]) {
  const parsed = argv.length > 0 ? parseCLIArgs(['start', ...argv]) : { command: 'start', args: {} as Record<string, string | undefined> };
  const args = parsed.args;
  const imPluginName = args.plugin ?? getDefaultIMPluginName();
  const imConfigPath = args.config ?? getIMPluginFactory(imPluginName).getDefaultConfigPath();
  const childArgs = buildDaemonChildArgs(
    SOCKET_PATH,
    '',
    PERSISTENCE_PATH,
    imConfigPath ?? '',
    imPluginName,
    LOG_PATH,
  );

  console.log(`Starting daemon in foreground. Log file: ${LOG_PATH}`);
  const child = spawn(process.execPath, childArgs, {
    stdio: 'inherit',
  });

  await new Promise<number>((resolve, reject) => {
    child.on('close', code => resolve(code ?? 0));
    child.on('error', reject);
  });
}

async function handleStop(): Promise<{ wasRunning: boolean; stoppedPid?: number; alreadyStopped?: boolean }> {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Daemon is not running');
    return { wasRunning: false, alreadyStopped: true };
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  console.log(`Stopping daemon (PID ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    console.log('Waiting for graceful shutdown...');
    const stopped = await waitForDaemonStop(pid);
    if (!stopped) {
      console.log(`Graceful shutdown timed out for PID ${pid}, sending SIGKILL...`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore if already gone
      }
      const killed = await waitForDaemonStop(pid, 2_000);
      if (!killed) {
        throw new Error(`Timed out waiting for daemon ${pid} to stop`);
      }
    }
    console.log('Waiting for socket release...');
    await waitForSocketRelease(SOCKET_PATH);
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log(`Daemon stopped (PID ${pid})`);
    return { wasRunning: true, stoppedPid: pid };
  } catch (err) {
    try {
      process.kill(pid, 0);
      throw err;
    } catch {
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      console.log('Daemon process already exited; waiting for socket release...');
      await waitForSocketRelease(SOCKET_PATH);
      console.log('Daemon was not running (stale PID file removed)');
      return { wasRunning: false, stoppedPid: pid };
    }
  }
}

async function handleRestart(args: Record<string, string | undefined>) {
  console.log('Restarting daemon...');
  const stopResult = await handleStop();
  if (!stopResult.wasRunning) {
    console.log('Starting daemon...');
    await handleStart(args);
    return;
  }
  if (stopResult.stoppedPid !== undefined) {
    console.log(`Verifying daemon ${stopResult.stoppedPid} has exited...`);
    const fullyStopped = await waitForDaemonStop(stopResult.stoppedPid);
    if (!fullyStopped) {
      throw new Error(`Daemon ${stopResult.stoppedPid} failed to stop cleanly`);
    }
  }
  console.log('Verifying socket release...');
  const socketReleased = await waitForSocketRelease(SOCKET_PATH);
  if (!socketReleased) {
    throw new Error(`Socket ${SOCKET_PATH} was not released after stop`);
  }
  console.log('Starting daemon...');
  await handleStart(args);
}

async function handleCreate(args: Record<string, string | undefined>) {
  const name = args.name;
  const workdir = args.workdir ?? process.cwd();
  const cli = args.cli ?? getDefaultCLIPluginName();
  const spaceStrategy = args['space-strategy'];

  if (!name) {
    throw new Error('Missing required argument: name');
  }
  if (spaceStrategy !== undefined && spaceStrategy !== 'thread' && spaceStrategy !== 'channel') {
    throw new Error("space-strategy must be 'thread' or 'channel'");
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('create', {
    name,
    workdir,
    cli,
    ...(spaceStrategy ? { spaceStrategy } : {}),
  });
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.error!.message}`);
  }

  console.log(`Session '${name}' created`);
}

async function handleOpen(args: Record<string, string | undefined>) {
  const name = args.name;
  const spaceStrategy = args['space-strategy'];

  if (!name) {
    throw new Error('Missing required argument: name');
  }
  if (spaceStrategy !== undefined && spaceStrategy !== 'thread' && spaceStrategy !== 'channel') {
    throw new Error("space-strategy must be 'thread' or 'channel'");
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();
  const response = await client.send('open', {
    name,
    ...(spaceStrategy ? { spaceStrategy } : {}),
  });
  await client.close();

  if (!response.ok) {
    throw new Error(`Failed to open session: ${response.error!.message}`);
  }

  console.log(JSON.stringify(response.data, null, 2));
}

async function handleSetup(args: Record<string, string | undefined>) {
  const target = args.target;
  if (target !== 'systemd') {
    throw new Error(`Unsupported setup target: ${target ?? '(none)'}`);
  }

  if (args['dry-run'] === 'true') {
    console.log(renderUserServiceUnit());
    return;
  }

  if (args['status'] === 'true') {
    const status = getUserServiceStatus((cmdArgs) => {
      const child = spawn('systemctl', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: child.exitCode ?? 0, stdout: '', stderr: '' };
    });
    console.log(JSON.stringify(status, null, 2));
    if (status.needsRepair && status.repairHint) {
      console.log(status.repairHint);
    }
    return;
  }

  if (args['uninstall'] === 'true') {
    const result = uninstallUserService((cmdArgs) => {
      const child = spawn('systemctl', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: child.exitCode ?? 0, stdout: '', stderr: '' };
    });
    if (!result.ok) throw new Error(result.error);
    console.log('systemd user service uninstalled');
    return;
  }

  writeUserServiceUnit();
  const result = installUserService((cmdArgs) => {
    const child = spawn('systemctl', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: child.exitCode ?? 0, stdout: '', stderr: '' };
  });
  if (!result.ok) throw new Error(result.error);
  console.log('systemctl --user daemon-reload');
  console.log('systemctl --user enable --now mx-coder.service');
}

async function handleEnv(args: Record<string, string | undefined>) {
  const action = args.action;
  const name = args.name;
  const key = args.key;
  const value = args.value;
  if (!action || !name) {
    throw new Error('Usage: mx-coder env <get|set|unset|clear|import|list> <session> [key] [value]');
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();
  try {
    if (action === 'get') {
      const res = await client.send('sessionEnvGet', { name });
      if (!res.ok) throw new Error(res.error!.message);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    if (action === 'set') {
      if (!key || value === undefined) throw new Error('Usage: mx-coder env set <session> <KEY> <VALUE>');
      const res = await client.send('sessionEnvSet', { name, key, value });
      if (!res.ok) throw new Error(res.error!.message);
      console.log(`Set ${key} for session '${name}'`);
      return;
    }
    if (action === 'unset') {
      if (!key) throw new Error('Usage: mx-coder env unset <session> <KEY>');
      const res = await client.send('sessionEnvUnset', { name, key });
      if (!res.ok) throw new Error(res.error!.message);
      console.log(`Unset ${key} for session '${name}'`);
      return;
    }
    if (action === 'clear') {
      const res = await client.send('sessionEnvClear', { name });
      if (!res.ok) throw new Error(res.error!.message);
      console.log(`Cleared env for session '${name}'`);
      return;
    }
    if (action === 'import') {
      const filePath = args.file;
      if (!filePath) throw new Error('Usage: mx-coder env import <session> <env-file>');
      const { parseEnvFile } = await import('./env-file-parser.js');
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        throw new Error(`Cannot read env file: ${(err as Error).message}`);
      }
      const result = parseEnvFile(content);
      if (result.errors.length > 0) {
        for (const e of result.errors) {
          console.error(`Line ${e.line}: ${e.message}`);
        }
        throw new Error(`Env file has ${result.errors.length} error(s), import aborted`);
      }
      if (result.entries.length === 0) {
        console.log('No entries found in env file, nothing to import.');
        return;
      }
      const res = await client.send('sessionEnvImport', { name, entries: result.entries });
      if (!res.ok) throw new Error(res.error!.message);
      console.log(`Imported ${result.entries.length} env var(s) into session '${name}'`);
      return;
    }
    if (action === 'list') {
      const res = await client.send('sessionEnvList', { name });
      if (!res.ok) throw new Error(res.error!.message);
      const entries = res.data!.entries as Array<{ key: string; maskedValue: string }>;
      if (entries.length === 0) {
        console.log(`Session '${name}' has no env vars.`);
      } else {
        for (const entry of entries) {
          console.log(`${entry.key}=${entry.maskedValue}`);
        }
      }
      return;
    }
    throw new Error(`Unknown env action: ${action}`);
  } finally {
    await client.close();
  }
}

async function handleAttach(args: Record<string, string | undefined>) {
  const name = args.name;

  if (!name) {
    throw new Error('Missing required argument: name');
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();
  const res = await client.send('status', {});
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to get status: ${res.error!.message}`);
  }

  const sessions = res.data!.sessions as Array<Record<string, unknown>>;
  const sessionSummary = sessions.find(s => s.name === name);
  if (!sessionSummary) {
    throw new Error(`Session not found: ${name}`);
  }

  const cliPluginName = typeof sessionSummary.cliPlugin === 'string' ? sessionSummary.cliPlugin : getDefaultCLIPluginName();
  const initState = typeof sessionSummary.initState === 'string' ? sessionSummary.initState as Session['initState'] : 'uninitialized';
  const session: Session = {
    name,
    sessionId: typeof sessionSummary.sessionId === 'string' ? sessionSummary.sessionId : '',
    cliPlugin: cliPluginName,
    workdir: typeof sessionSummary.workdir === 'string' ? sessionSummary.workdir : process.cwd(),
    sessionEnv: (sessionSummary.sessionEnv as Record<string, string> | undefined) ?? {},
    status: (sessionSummary.status as Session['status']) ?? 'idle',
    lifecycleStatus: (sessionSummary.lifecycleStatus as Session['lifecycleStatus']) ?? 'active',
    initState,
    runtimeState: (sessionSummary.runtimeState as Session['runtimeState']) ?? (typeof sessionSummary.status === 'string' && sessionSummary.status === 'attached' ? 'attached_terminal' : 'cold'),
    revision: 0,
    spawnGeneration: 0,
    attachedPid: null,
    imWorkerPid: null,
    imWorkerCrashCount: 0,
    streamVisibility: (sessionSummary.streamVisibility as Session['streamVisibility']) ?? 'normal',
    imBindings: [],
    messageQueue: [],
    createdAt: sessionSummary.createdAt instanceof Date ? sessionSummary.createdAt : new Date(String(sessionSummary.createdAt ?? Date.now())),
    lastActivityAt: new Date(),
  };

  if (initState !== 'uninitialized' && !session.sessionId) {
    throw new Error(`Session ${name} is missing sessionId`);
  }

  const cliPlugin = getCLIPlugin(cliPluginName);
  const cmdSpec = cliPlugin.buildAttachCommand(session);

  await attachSession({
    socketPath: SOCKET_PATH,
    sessionName: name,
    cliCommand: cmdSpec.command,
    cliArgs: cmdSpec.args,
    workdir: session.workdir,
    sessionEnv: session.sessionEnv,
  });
}

async function handleDiagnose(args: Record<string, string | undefined>) {
  const name = args.name;
  if (!name) {
    throw new Error('Missing required argument: name');
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();
  const res = await client.send('status', {});
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to get status: ${res.error!.message}`);
  }

  const sessions = res.data!.sessions as Array<Record<string, unknown>>;
  const session = sessions.find(s => s.name === name);
  if (!session) {
    throw new Error(`Session not found: ${name}`);
  }

  const workdir = typeof session.workdir === 'string' ? session.workdir : process.cwd();
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
  const sessionFile = getClaudeSessionPath(workdir, sessionId);
  const hasLocalSession = hasClaudeSession(workdir, sessionId);
  const commandMode = hasLocalSession ? '--resume' : '--session-id';

  console.log(JSON.stringify({
    name,
    sessionId,
    status: session.status,
    lifecycleStatus: session.lifecycleStatus,
    initState: session.initState,
    workdir,
    cwd: process.cwd(),
    localClaudeSessionPath: sessionFile,
    localClaudeSessionExists: hasLocalSession,
    nextAttachMode: commandMode,
    logPath: LOG_PATH,
    socketPath: SOCKET_PATH,
    persistencePath: PERSISTENCE_PATH,
  }, null, 2));
}

async function handleList() {
  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('list', {});
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to list sessions: ${res.error!.message}`);
  }

  const sessions = res.data!.sessions as Array<Record<string, unknown>>;
  if (sessions.length === 0) {
    console.log('No sessions');
    return;
  }

  console.log('Sessions:');
  for (const s of sessions) {
    console.log(`  ${s.name} (${s.status}) - ${s.workdir}`);
  }
}

async function handleTakeoverStatus(args: Record<string, string | undefined>) {
  const name = args.name;
  if (!name) throw new Error('Missing required argument: name');

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();
  const res = await client.send('takeoverStatus', { name });
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to get takeover status: ${res.error!.message}`);
  }

  console.log(JSON.stringify(res.data, null, 2));
}

async function handleTakeoverCancel(args: Record<string, string | undefined>) {
  const name = args.name;
  if (!name) throw new Error('Missing required argument: name');

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();
  const res = await client.send('takeoverCancel', { name });
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to cancel takeover: ${res.error!.message}`);
  }

  console.log(`Takeover for '${name}' cancelled`);
}

function isBusyRuntimeState(runtimeState: string | undefined): boolean {
  return runtimeState === 'running'
    || runtimeState === 'waiting_approval'
    || runtimeState === 'attached_terminal'
    || runtimeState === 'takeover_pending'
    || runtimeState === 'recovering';
}

async function handleStatus(args: Record<string, string | undefined>) {
  const name = args.name;

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('status', {});
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to get status: ${res.error!.message}`);
  }

  console.log(`Daemon PID: ${res.data!.pid}`);
  const sessions = res.data!.sessions as Array<Record<string, unknown>>;

  if (name) {
    const s = sessions.find(s => s.name === name);
    if (!s) {
      throw new Error(`Session not found: ${name}`);
    }
    const runtimeState = s.runtimeState as string | undefined;
    const busy = isBusyRuntimeState(runtimeState);
    console.log(JSON.stringify({
      ...s,
      busy,
      idle: !busy,
    }, null, 2));
  } else {
    console.log(`Sessions: ${sessions.length}`);
    for (const s of sessions) {
      const runtimeState = (s.runtimeState as string | undefined) ?? (s.status === 'attached' ? 'attached_terminal' : 'cold');
      const busy = isBusyRuntimeState(runtimeState);
      console.log(`  ${s.name} (${s.status}, runtime=${runtimeState}, ${busy ? 'busy' : 'idle'})`);
    }
  }
}

async function handleRemove(args: Record<string, string | undefined>) {
  const name = args.name;

  if (!name) {
    throw new Error('Missing required argument: name');
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('remove', { name });
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to remove session: ${res.error!.message}`);
  }

  console.log(`Session '${name}' removed`);
}

async function handleTui() {
  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('status', {});
  if (!res.ok) {
    await client.close();
    throw new Error(`Failed to get status: ${res.error!.message}`);
  }

  const sessions = (res.data!.sessions as Array<Record<string, unknown>>).map((session) => ({
    name: String(session.name),
    status: session.status as Session['status'],
    runtimeState: session.runtimeState as Session['runtimeState'],
    workdir: String(session.workdir ?? ''),
    queueLength: Array.isArray(session.messageQueue) ? session.messageQueue.length : 0,
    lastActivityAt: new Date(String(session.lastActivityAt ?? Date.now())),
    bindingKind: (session.imBindings as Array<Record<string, unknown>> | undefined)?.[0]?.bindingKind as 'thread' | 'channel' | undefined,
    connectionHealth: session.connectionHealth as { wsHealthy?: boolean; subscriptionHealthy?: boolean } | undefined,
  }));

  const store = createTuiStateStore(sessions as any);

  const clearAndRender = () => {
    const output = renderTuiOverview(store.list());
    process.stdout.write('\x1B[2J\x1B[H');
    process.stdout.write(`mx-coder TUI  (press Ctrl+C to exit)\n\n`);
    process.stdout.write(output);
  };

  clearAndRender();

  await client.subscribe((event) => {
    store.applyEvent(event);
    clearAndRender();
  });

  const cleanup = async () => {
    await client.close();
    process.exit(0);
  };

  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });

  await new Promise(() => {});
}

async function handleImport(args: Record<string, string | undefined>) {
  const sessionId = args.sessionId;
  const workdir = args.workdir ?? process.cwd();
  const name = args.name;
  const cli = args.cli ?? getDefaultCLIPluginName();

  if (!sessionId) {
    throw new Error('Missing required argument: sessionId');
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('import', { sessionId, workdir, name, cli });
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to import session: ${res.error!.message}`);
  }

  const imported = res.data!.session as Record<string, unknown>;
  console.log(`Session imported as '${imported.name}'`);
}

async function handleIm(subcommand: string, args: Record<string, string | undefined>) {
  switch (subcommand) {
    case 'init':
      await handleImInit(args);
      break;
    case 'verify':
      await handleImVerify(args);
      break;
    case 'run':
      console.error('im run: not yet implemented');
      process.exit(1);
      break;
    default:
      console.error(`Unknown im subcommand: ${subcommand}`);
      process.exit(1);
  }
}

async function handleImInit(args: Record<string, string | undefined>) {
  const pluginName = args.plugin ?? getDefaultIMPluginName();
  const factory = getIMPluginFactory(pluginName);
  const configPath = args.config ?? factory.getDefaultConfigPath();

  try {
    factory.writeConfigTemplate(configPath);
    console.log(`Config template written to: ${configPath}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Edit ${configPath}`);
    console.log(`  2. Fill in your ${pluginName} configuration`);
    console.log(`  3. Run: mx-coder im verify -p ${pluginName}`);
  } catch (err) {
    throw new Error((err as Error).message);
  }
}

async function handleImVerify(args: Record<string, string | undefined>) {
  const pluginName = args.plugin ?? getDefaultIMPluginName();
  const factory = getIMPluginFactory(pluginName);
  const configPath = args.config;

  console.log(`Verifying ${pluginName} connection...`);
  const result = await factory.verifyConnection(configPath);

  console.log('Connection OK');
  console.log(`  Plugin: ${pluginName}`);
  console.log(`  Bot user ID: ${result.botUserId}`);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
