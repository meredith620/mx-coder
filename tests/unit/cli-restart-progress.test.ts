import { describe, test, expect } from 'vitest';
import { renderTuiOverview } from '../../src/tui.js';

describe('S4.3: stop/restart progress visibility regression', () => {
  test('rendered runtime labels remain stable while stop/restart progress uses distinct phase text', () => {
    const output = renderTuiOverview([
      { name: 'sess-restarting', status: 'idle', runtimeState: 'recovering', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
      { name: 'sess-ready', status: 'idle', runtimeState: 'ready', workdir: '/tmp', lastActivityAt: new Date(), queueLength: 0 },
    ] as any);

    expect(output).toContain('recovering');
    expect(output).toContain('ready');
    expect(output).not.toContain('stopping');
    expect(output).not.toContain('waiting graceful shutdown');
    expect(output).not.toContain('waiting socket release');
    expect(output).not.toContain('Starting daemon');
  });
});
