#!/usr/bin/env node
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { IPCClient } from './ipc/client.js';
import { attachSession } from './attach.js';
import { parseCLIArgs } from './cli-parser.js';
import { writeMattermostConfigTemplate, verifyMattermostConnection, getDefaultMattermostConfigPath } from './plugins/im/mattermost.js';

const SOCKET_PATH = process.env.MM_CODER_SOCKET ?? path.join(os.tmpdir(), 'mm-coder-daemon.sock');
const PID_FILE = process.env.MM_CODER_PID_FILE ?? path.join(os.tmpdir(), 'mm-coder-daemon.pid');
const PERSISTENCE_PATH = process.env.MM_CODER_SESSIONS ?? path.join(os.homedir(), '.mm-coder', 'sessions.json');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
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
      case 'im-init':
        await handleImInit(parsed.args);
        break;
      case 'im-verify':
        await handleImVerify(parsed.args);
        break;
      case 'im-run':
        console.error('im-run: not yet implemented');
        process.exit(1);
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
  create <name> [-w|--workdir <path>]  Create a new session
  attach <name>                   Attach to a session
  list                            List all sessions
  status [name]                   Show daemon/session status
  remove <name>                   Remove a session
  import <sessionId> --workdir <path> [--name <name>]
                                  Import external session
  im-init [--config <path>]       Create IM config template
  im-verify [--config <path>]     Verify IM connectivity
  --help, -h                      Show this help

EXAMPLES:
  mm-coder start
  mm-coder create bug-fix -w ~/myapp
  mm-coder attach bug-fix
  mm-coder list
  mm-coder status bug-fix
  mm-coder remove bug-fix
  mm-coder im-init
  mm-coder im-verify
`.trim());
}

async function handleStart() {
  // Check if daemon already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      console.log(`Daemon already running (PID ${pid})`);
      return;
    } catch {
      // PID file stale, remove it
      fs.unlinkSync(PID_FILE);
    }
  }

  // Ensure persistence directory exists
  fs.mkdirSync(path.dirname(PERSISTENCE_PATH), { recursive: true });

  // Fork daemon to background
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
  } catch (err) {
    // Process not found — clean up stale PID file
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log('Daemon was not running (stale PID file removed)');
  }
}

async function handleRestart() {
  await handleStop();
  // Brief wait to allow daemon to flush and exit
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

  await attachSession({
    socketPath: SOCKET_PATH,
    sessionName: name,
    cliCommand: 'claude',
    cliArgs: [],
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

async function handleImInit(args: Record<string, string | undefined>) {
  const configPath = args.config ?? getDefaultMattermostConfigPath();

  try {
    writeMattermostConfigTemplate(configPath);
    console.log(`Config template written to: ${configPath}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Edit ${configPath}`);
    console.log('  2. Fill in your Mattermost URL, bot token, and channel ID');
    console.log('  3. Run: mm-coder im-verify');
  } catch (err) {
    throw new Error((err as Error).message);
  }
}

async function handleImVerify(args: Record<string, string | undefined>) {
  const configPath = args.config;

  console.log('Verifying Mattermost connection...');
  const result = await verifyMattermostConnection(configPath);

  console.log('Connection OK');
  console.log(`  URL: ${result.config.url}`);
  console.log(`  Bot user ID: ${result.botUserId}`);
  console.log(`  Channel ID: ${result.config.channelId}`);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

