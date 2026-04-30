import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../../src/daemon.js';
import { IPCClient } from '../../src/ipc/client.js';
import { createTuiActions } from '../../src/tui.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('TUI session env actions', () => {
  let tmpDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let client: IPCClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tui-env-'));
    socketPath = path.join(tmpDir, 'daemon.sock');
    daemon = new Daemon(socketPath);
    await daemon.start();
    client = new IPCClient(socketPath);
    await client.connect();
    await client.send('create', { name: 'env-demo', workdir: '/tmp', cli: 'claude-code' });
  });

  afterEach(async () => {
    await client.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('get/set/unset/clear session env via TUI actions', async () => {
    const actions = createTuiActions(client);

    await actions.setSessionEnv({ name: 'env-demo', key: 'API_KEY', value: 'secret123' });
    let envState = await actions.getSessionEnv('env-demo');
    expect((envState.env as Record<string, string>).API_KEY).toContain('***');

    await actions.unsetSessionEnv({ name: 'env-demo', key: 'API_KEY' });
    await actions.setSessionEnv({ name: 'env-demo', key: 'FOO', value: 'bar' });
    await actions.clearSessionEnv('env-demo');
    expect(daemon.registry.get('env-demo')!.sessionEnv).toEqual({});
  });
});
