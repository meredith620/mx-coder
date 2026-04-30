import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { MattermostPlugin } from '../../src/plugins/im/mattermost.js';

const BASE_URL = 'https://mm.example.com';
const TOKEN = 'test-token';
const CHANNEL_ID = 'ch1';

type WSStub = {
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  __emit: (event: string, payload?: unknown) => void;
};

describe('Mattermost WS resilience', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let wsInstances: WSStub[];

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    wsInstances = [];
    const WS = vi.fn().mockImplementation(() => {
      const listeners = new Map<string, Array<(arg?: unknown) => void>>();
      const ws: WSStub = {
        addEventListener: vi.fn((event: string, handler: (arg?: unknown) => void) => {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event)!.push(handler);
        }),
        close: vi.fn(() => {
          for (const h of listeners.get('close') ?? []) h();
        }),
        send: vi.fn(),
        __emit: (event: string, payload?: unknown) => {
          for (const h of listeners.get(event) ?? []) h(payload);
        },
      };
      wsInstances.push(ws);
      return ws;
    });
    vi.stubGlobal('WebSocket', WS as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('heartbeat 超时后主动 close + reconnect，且连接健康字段更新', async () => {
    vi.useFakeTimers();

    const plugin = new MattermostPlugin({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
      reconnectIntervalMs: 10,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 120,
    } as any);

    await plugin.connect();
    wsInstances[0].__emit('open');

    expect(plugin.getConnectionHealth().wsHealthy).toBe(true);
    vi.advanceTimersByTime(200);

    expect(wsInstances[0].close).toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(wsInstances.length).toBeGreaterThan(1);
    expect(plugin.getConnectionHealth().wsHealthy).toBe(false);
  });

  test('close 后旧连接健康状态被清理，新连接可重新建立健康状态', async () => {
    vi.useFakeTimers();

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID, reconnectIntervalMs: 10 } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');
    expect(plugin.getConnectionHealth().wsHealthy).toBe(true);

    wsInstances[0].__emit('close');
    expect(plugin.getConnectionHealth().wsHealthy).toBe(false);
    expect(plugin.getConnectionHealth().subscriptionHealthy).toBe(false);

    vi.advanceTimersByTime(20);
    expect(wsInstances.length).toBeGreaterThan(1);
    wsInstances[1].__emit('open');
    expect(plugin.getConnectionHealth().wsHealthy).toBe(true);
  });

  test('收到业务事件后 subscriptionHealthy 变为 true', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    plugin.onMessage(() => {});
    await plugin.connect();
    wsInstances[0].__emit('open');

    expect(plugin.getConnectionHealth().subscriptionHealthy).toBe(false);
    wsInstances[0].__emit('message', {
      data: JSON.stringify({
        event: 'posted',
        data: { post: JSON.stringify({ id: 'p1', user_id: 'user-x', channel_id: CHANNEL_ID, root_id: '', message: 'hello', create_at: Date.now() }) },
      }),
    });

    expect(plugin.getConnectionHealth().subscriptionHealthy).toBe(true);
  });
});
