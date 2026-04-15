#!/usr/bin/env node
/**
 * Daemon entry point — invoked by `mm-coder start` as a detached child process.
 * argv[2] = socketPath, argv[3] = pidFile
 */
import { Daemon } from './daemon.js';

const socketPath = process.argv[2];
const pidFile = process.argv[3];

if (!socketPath) {
  process.stderr.write('Usage: daemon-main.js <socketPath> [pidFile]\n');
  process.exit(1);
}

const daemon = new Daemon(socketPath);

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
