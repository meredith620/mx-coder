import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';

describe('session env worker injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-session-env-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('worker spawn 时注入 sessionEnv', async () => {
    const captureFile = path.join(tmpDir, 'env.json');
    const mockCli = path.join(tmpDir, 'mock-env.sh');
    fs.writeFileSync(mockCli, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ TEST_ENV: process.env.TEST_ENV }));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'), { mode: 0o755 });

    const registry = new SessionRegistry();
    registry.create('env-spawn', { workdir: tmpDir, cliPlugin: 'mock' });
    registry.setSessionEnv('env-spawn', 'TEST_ENV', 'hello-session-env');

    const mgr = new IMWorkerManager(new MockCLIPlugin(mockCli), registry);
    await mgr.ensureRunning('env-spawn');
    await new Promise(resolve => setTimeout(resolve, 150));

    const data = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(data.TEST_ENV).toBe('hello-session-env');
    await mgr.terminate('env-spawn');
  });
});
