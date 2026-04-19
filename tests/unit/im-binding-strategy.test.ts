import { describe, test, expect } from 'vitest';
import { SessionRegistry } from '../../src/session-registry.js';

describe('IM binding strategy', () => {
  test('session binding 可表达 thread 与 channel 两类目标', () => {
    const registry = new SessionRegistry();
    registry.create('thread-session', { workdir: '/tmp', cliPlugin: 'claude-code' });
    registry.create('channel-session', { workdir: '/tmp', cliPlugin: 'claude-code' });

    registry.bindIM('thread-session', {
      plugin: 'mattermost',
      bindingKind: 'thread',
      threadId: 'thread-1',
      channelId: 'root-ch',
    } as any);

    registry.bindIM('channel-session', {
      plugin: 'mattermost',
      bindingKind: 'channel',
      threadId: '',
      channelId: 'channel-1',
    } as any);

    const threadBinding = registry.get('thread-session')!.imBindings[0] as any;
    const channelBinding = registry.get('channel-session')!.imBindings[0] as any;

    expect(threadBinding.bindingKind).toBe('thread');
    expect(threadBinding.threadId).toBe('thread-1');
    expect(channelBinding.bindingKind).toBe('channel');
    expect(channelBinding.channelId).toBe('channel-1');
  });
});
