import { describe, test, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';

describe('session env registry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.create('env-demo', { workdir: '/tmp', cliPlugin: 'claude-code' });
  });

  test('setSessionEnv / unsetSessionEnv / clearSessionEnv', () => {
    registry.setSessionEnv('env-demo', 'API_KEY', 'secret123');
    expect(registry.get('env-demo')!.sessionEnv.API_KEY).toBe('secret123');

    registry.unsetSessionEnv('env-demo', 'API_KEY');
    expect(registry.get('env-demo')!.sessionEnv.API_KEY).toBeUndefined();

    registry.setSessionEnv('env-demo', 'FOO', 'bar');
    registry.setSessionEnv('env-demo', 'BAZ', 'qux');
    registry.clearSessionEnv('env-demo');
    expect(registry.get('env-demo')!.sessionEnv).toEqual({});
  });
});
