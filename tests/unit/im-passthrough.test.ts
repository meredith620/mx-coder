import { describe, test, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';
import { IMWorkerManager } from '../../src/im-worker-manager.js';
import { MockCLIPlugin } from '../helpers/mock-cli-plugin.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeRegistryWithSession(tmpDir: string) {
  const registry = new SessionRegistry();
  registry.create('pass-worker', { workdir: tmpDir, cliPlugin: 'mock' });
  return registry;
}

describe('IM passthrough worker payload', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pass-worker-'));
  });

  test('passthrough 命令写入 worker stdin 时保持单斜杠原生命令', async () => {
    const captureFile = path.join(tmpDir, 'stdin.jsonl');
    const mockCli = path.join(tmpDir, 'mock-pass.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf "%s\\n" "$line" >> "${captureFile}"`,
      'done',
    ].join('\n'), { mode: 0o755 });

    const registry = makeRegistryWithSession(tmpDir);
    const mgr = new IMWorkerManager(new MockCLIPlugin(mockCli), registry);

    await mgr.sendMessage('pass-worker', '/model sonnet');
    await new Promise(resolve => setTimeout(resolve, 100));
    await mgr.terminate('pass-worker');

    const lines = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.message.content[0].text).toBe('/model sonnet');
  });

  test('普通文本与 passthrough 混排时顺序保持不变', async () => {
    const captureFile = path.join(tmpDir, 'stdin-order.jsonl');
    const mockCli = path.join(tmpDir, 'mock-pass-order.sh');
    fs.writeFileSync(mockCli, [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf "%s\\n" "$line" >> "${captureFile}"`,
      'done',
    ].join('\n'), { mode: 0o755 });

    const registry = makeRegistryWithSession(tmpDir);
    const mgr = new IMWorkerManager(new MockCLIPlugin(mockCli), registry);

    await mgr.sendMessage('pass-worker', 'hello');
    await mgr.sendMessage('pass-worker', '/compact');
    await mgr.sendMessage('pass-worker', 'world');
    await new Promise(resolve => setTimeout(resolve, 100));
    await mgr.terminate('pass-worker');

    const lines = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
    const texts = lines.map(line => JSON.parse(line).message.content[0].text);
    expect(texts).toEqual(['hello', '/compact', 'world']);
  });
});
