#!/usr/bin/env node
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { IPCClient } from './ipc/client.js';
import { attachSession } from './attach.js';
import { parseCLIArgs } from './cli-parser.js';
import { getCLIPlugin } from './plugins/cli/registry.js';
import { getIMPluginFactory } from './plugins/im/registry.js';

const SOCKET_PATH = process.env.MM_CODER_SOCKET ?? path.join(os.tmpdir(), 'mm-coder-daemon.sock');
const PID_FILE = process.env.MM_CODER_PID_FILE ?? path.join(os.tmpdir(), 'mm-coder-daemon.pid');
const PERSISTENCE_PATH = process.env.MM_CODER_SESSIONS ?? path.join(os.homedir(), '.mm-coder', 'sessions.json');
const VERSION = '0.1.0';
const GIT_HASH = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();

function printVersion() {
  console.log(`mm-coder ${VERSION} (${GIT_HASH})`);
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
    const parsed = parseCLIArgs(argv);

    switch (parsed.command) {
      case 'start':
        await handleStart();
        break;
      case 'stop':
        await handleStop();
        break;
      case 'restart':
        await handleRestart();
        break;
      case 'create':
        await handleCreate(parsed.args);
        break;
      case 'attach':
        await handleAttach(parsed.args);
        break;
      case 'list':
        await handleList();
        break;
      case 'status':
        await handleStatus(parsed.args);
        break;
      case 'remove':
        await handleRemove(parsed.args);
        break;
      case 'import':
        await handleImport(parsed.args);
        break;
      case 'im':
        await handleIm(parsed.subcommand!, parsed.args);
        break;
      case 'tui':
        console.error('tui: not yet implemented');
        process.exit(1);
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
mm-coder - Multi-modal Claude Code session manager

USAGE:
  mm-coder <command> [options]

COMMANDS:
  start                           Start daemon in background
  stop                            Stop the running daemon
  restart                         Restart the daemon
  create <name> [-n|--name <name>] [-w|--workdir <path>] [-C|--cli <name>]
                                  Create a new session
  attach <name> [-n|--name <name>]  Attach to a session
  list                            List all sessions
  status [name] [-n|--name <name>]  Show daemon/session status
  remove <name> [-n|--name <name>]  Remove a session
  import <sessionId> [-s|--sessionId <id>] -w <path> [-n|--name <name>] [-C|--cli <name>]
                                  Import external session
  im init [-p|--plugin <name>] [-c|--config <path>]
                                  Create IM config template
  im verify [-p|--plugin <name>] [-c|--config <path>]
                                  Verify IM connectivity
  im run <sessionName>            Run IM worker for a session
  --help, -h                      Show this help
  --version, -v                   Show version info

EXAMPLES:
  mm-coder start
  mm-coder create bug-fix -w ~/myapp
  mm-coder attach bug-fix -n my-session
  mm-coder list
  mm-coder status bug-fix -n my-session
  mm-coder remove bug-fix -n my-session
  mm-coder im init -p discord
  mm-coder im verify
  mm-coder im init -c ~/.mm-coder/discord.json
`.trim());
}

async function handleStart() {
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

  const child = spawn(process.execPath, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon-main.js'),
    SOCKET_PATH,
    PID_FILE,
    PERSISTENCE_PATH,
  ], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  console.log(`Daemon started (PID ${child.pid})`);
}

async function handleStop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Daemon is not running');
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Daemon stopped (PID ${pid})`);
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log('Daemon was not running (stale PID file removed)');
  }
}

async function handleRestart() {
  await handleStop();
  await new Promise(resolve => setTimeout(resolve, 500));
  await handleStart();
}

async function handleCreate(args: Record<string, string | undefined>) {
  const name = args.name;
  const workdir = args.workdir ?? process.cwd();
  const cli = args.cli ?? 'claude-code';

  if (!name) {
    throw new Error('Missing required argument: name');
  }

  const client = new IPCClient(SOCKET_PATH);
  await client.connect();

  const res = await client.send('create', { name, workdir, cli });
  await client.close();

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.error!.message}`);
  }

  console.log(`Session '${name}' created`);
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

  let cliPluginName = 'claude-code';
  if (res.ok) {
    const sessions = res.data!.sessions as Array<Record<string, unknown>>;
    const session = sessions.find(s => s.name === name);
    if (session?.cliPlugin && typeof session.cliPlugin === 'string') {
      cliPluginName = session.cliPlugin;
    }
  }

  const cliPlugin = getCLIPlugin(cliPluginName);
  const cmdSpec = cliPlugin.buildAttachCommand({ sessionId: '', name, workdir: '', cliPlugin: cliPluginName } as any);

  await attachSession({
    socketPath: SOCKET_PATH,
    sessionName: name,
    cliCommand: cmdSpec.command,
    cliArgs: cmdSpec.args.filter(a => a !== '--resume' && a !== ''),
  });
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
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`Sessions: ${sessions.length}`);
    for (const s of sessions) {
      console.log(`  ${s.name} (${s.status})`);
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

async function handleImport(args: Record<string, string | undefined>) {
  const sessionId = args.sessionId;
  const workdir = args.workdir ?? process.cwd();
  const name = args.name;
  const cli = args.cli ?? 'claude-code';

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
  const pluginName = args.plugin ?? 'mattermost';
  const factory = getIMPluginFactory(pluginName);
  const configPath = args.config ?? factory.getDefaultConfigPath();

  try {
    factory.writeConfigTemplate(configPath);
    console.log(`Config template written to: ${configPath}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Edit ${configPath}`);
    console.log(`  2. Fill in your ${pluginName} configuration`);
    console.log(`  3. Run: mm-coder im verify -p ${pluginName}`);
  } catch (err) {
    throw new Error((err as Error).message);
  }
}

async function handleImVerify(args: Record<string, string | undefined>) {
  const pluginName = args.plugin ?? 'mattermost';
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
