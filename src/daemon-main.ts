#!/usr/bin/env node
/**
 * Daemon entry point — invoked by `mm-coder start` as a detached child process.
 * argv[2] = socketPath, argv[3] = pidFile, argv[4] = persistencePath, argv[5] = imConfigPath
 */
import { Daemon } from './daemon.js';
import * as path from 'path';
import * as os from 'os';

const socketPath = process.argv[2];
const pidFile = process.argv[3];
const persistencePath = process.argv[4] ?? path.join(os.homedir(), '.mm-coder', 'sessions.json');
const imConfigPath = process.argv[5];

if (!socketPath) {
  process.stderr.write('Usage: daemon-main.js <socketPath> [pidFile] [persistencePath] [imConfigPath]\n');
  process.exit(1);
}

const daemon = new Daemon(socketPath, {
  persistencePath,
  ...(imConfigPath ? { imConfigPath } : {}),
  enableIM: true,
});

if (pidFile) {
  daemon.writePidFile(pidFile);
}

daemon.start().then(() => {
  process.stdout.write(`mm-coder daemon listening on ${socketPath}\n`);
}).catch(err => {
  process.stderr.write(`Daemon failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  daemon.stop().then(() => process.exit(0)).catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  daemon.stop().then(() => process.exit(0)).catch(() => process.exit(1));
});
