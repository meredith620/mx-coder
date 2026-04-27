#!/usr/bin/env node
/**
 * Daemon entry point — invoked by `mx-coder start` as a detached child process.
 * argv[2] = socketPath, argv[3] = pidFile, argv[4] = persistencePath,
 * argv[5] = imConfigPath, argv[6] = imPluginName, argv[7] = logPath
 */
import { Daemon } from './daemon.js';
import { loadMattermostConfig } from './plugins/im/mattermost.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getDefaultIMPluginName } from './plugins/im/registry.js';

const socketPath = process.argv[2];
const pidFile = process.argv[3];
const persistencePath = process.argv[4] ?? path.join(os.homedir(), '.mx-coder', 'sessions.json');
const imConfigPath = process.argv[5];
const imPluginName = process.argv[6] ?? getDefaultIMPluginName();
const logPath = process.argv[7];

if (!socketPath) {
  process.stderr.write('Usage: daemon-main.js <socketPath> [pidFile] [persistencePath] [imConfigPath] [imPluginName] [logPath]\n');
  process.exit(1);
}

if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  const tee = (chunk: any, encoding?: any, cb?: any) => {
    logStream.write(chunk, encoding);
    if (typeof cb === 'function') cb();
    return true;
  };

  process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
    tee(chunk, encoding, cb);
    return origStdoutWrite(chunk, encoding, cb);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
    tee(chunk, encoding, cb);
    return origStderrWrite(chunk, encoding, cb);
  }) as typeof process.stderr.write;

  process.on('exit', () => logStream.end());
}

const disableIM = process.env.MX_CODER_DISABLE_IM === '1';
const resolvedImConfigPath = imConfigPath && imConfigPath.trim() !== ''
  ? imConfigPath.trim()
  : undefined;
const enableIM = !disableIM && !!resolvedImConfigPath;
const resolvedImPluginConfig = enableIM && fs.existsSync(resolvedImConfigPath!)
  ? loadMattermostConfig(resolvedImConfigPath!) as unknown as Record<string, unknown>
  : undefined;

const daemon = new Daemon(socketPath, {
  persistencePath,
  ...(enableIM && resolvedImConfigPath ? { imConfigPath: resolvedImConfigPath } : {}),
  enableIM,
  imPluginName,
  ...(resolvedImPluginConfig ? { imPluginConfig: resolvedImPluginConfig } : {}),
});

if (pidFile) {
  daemon.writePidFile(pidFile);
}

daemon.start().then(() => {
  process.stdout.write(`mx-coder daemon listening on ${socketPath}\n`);
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
