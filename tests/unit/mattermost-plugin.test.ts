import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MattermostPlugin,
  loadMattermostConfig,
  createConnectedMattermostPlugin,
  getMattermostCommandHelpText,
  getMattermostWelcomeText,
  getDefaultMattermostConfigPath,
} from '../../src/plugins/im/mattermost.js';

type WSStub = {
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  __emit: (event: string, payload?: unknown) => void;
};

const BASE_URL = 'https://mm.example.com';
const TOKEN = 'test-token';
const CHANNEL_ID = 'ch1';

function makeFetchMock(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
}

describe('Mattermost config loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('帮助文案包含所有 IM 命令', () => {
    const text = getMattermostCommandHelpText();
    expect(text).toContain('/help');
    expect(text).toContain('/list');
    expect(text).toContain('/status');
    expect(text).toContain('/open <sessionName>');
    expect(text).toContain('/takeover <sessionName>');
    expect(text).toContain('/takeover-force <sessionName>');
    expect(text).toContain('普通文本消息');
    expect(text).toContain('请在 CLI 中使用');
  });

  test('欢迎文案包含 bot 名称和帮助信息', () => {
    const text = getMattermostWelcomeText('bot-user', 3, 1);
    expect(text).toContain('bot-user');
    expect(text).toContain('/help');
  });

  test('旧版顶层配置结构报错', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
      reconnectIntervalMs: 2000,
    }));

    expect(() => loadMattermostConfig(configPath)).toThrow(/im.*mattermost/i);
  });

  test('旧版 mattermost 分组配置结构报错', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mattermost: {
        url: BASE_URL,
        token: TOKEN,
        channelId: CHANNEL_ID,
      },
    }));

    expect(() => loadMattermostConfig(configPath)).toThrow(/im.*mattermost/i);
  });

  test('支持 im.mattermost 多 IM 配置结构', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      im: {
        mattermost: {
          url: BASE_URL,
          token: TOKEN,
          channelId: CHANNEL_ID,
          reconnectIntervalMs: 3000,
        },
      },
    }));

    const cfg = loadMattermostConfig(configPath);
    expect(cfg.url).toBe(BASE_URL);
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.channelId).toBe(CHANNEL_ID);
    expect(cfg.reconnectIntervalMs).toBe(3000);
  });

  test('缺失必填字段时报错', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      im: {
        mattermost: {
          url: BASE_URL,
          token: TOKEN,
        },
      },
    }));

    expect(() => loadMattermostConfig(configPath)).toThrow(/channelId/);
  });

  test('支持 im.mattermost spaceStrategy=thread 配置', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      im: {
        mattermost: {
          url: BASE_URL,
          token: TOKEN,
          channelId: CHANNEL_ID,
          spaceStrategy: 'thread',
        },
      },
    }));

    const cfg = loadMattermostConfig(configPath) as any;
    expect(cfg.spaceStrategy).toBe('thread');
  });

  test('spaceStrategy=channel 时要求 teamId', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      im: {
        mattermost: {
          url: BASE_URL,
          token: TOKEN,
          channelId: CHANNEL_ID,
          spaceStrategy: 'channel',
        },
      },
    }));

    expect(() => loadMattermostConfig(configPath)).toThrow(/teamId/);
  });

  test('默认配置路径存在时可直接加载', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const configPath = getDefaultMattermostConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        im: {
          mattermost: {
            url: BASE_URL,
            token: TOKEN,
            channelId: CHANNEL_ID,
            spaceStrategy: 'channel',
            teamId: 'team-1',
          },
        },
      }));
      const cfg = loadMattermostConfig();
      expect(cfg.spaceStrategy).toBe('channel');
      expect(cfg.teamId).toBe('team-1');
    } finally {
      process.env.HOME = originalHome;
    }
  });


  test('createConnectedMattermostPlugin 会加载配置并执行 connect', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      im: {
        mattermost: {
          url: BASE_URL,
          token: TOKEN,
          channelId: CHANNEL_ID,
        },
      },
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-user-1', username: 'bot' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'post1' }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock);

    const plugin = await createConnectedMattermostPlugin(configPath);
    expect(plugin).toBeInstanceOf(MattermostPlugin);
    expect(fetchMock).toHaveBeenCalledTimes(2); // GET /users/me + POST welcome message
    const [, welcomeOpts] = fetchMock.mock.calls[1];
    const welcomeBody = JSON.parse(welcomeOpts.body);
    expect(welcomeBody.message).toContain('/help');
  });
});

describe('MattermostPlugin', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let wsInstances: WSStub[];

  beforeEach(() => {
    fetchSpy = makeFetchMock({ id: 'post1' });
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
  });

  test('connect 在 welcome message 失败时不应抛错', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-u1', username: 'bot' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ id: 'api.post.create_post.can_not_post_to_deleted.error' }),
        text: async () => '{"id":"api.post.create_post.can_not_post_to_deleted.error","message":"Can not post to deleted channel."}',
      });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(plugin.connect()).resolves.toBeUndefined();
    expect(wsInstances).toHaveLength(1);
  });

  test('checkChannelStatus 返回 deleted / forbidden / not_found / ok', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: CHANNEL_ID, delete_at: 123 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ id: 'forbidden' }),
        text: async () => '{"id":"forbidden"}',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ id: 'not_found' }),
        text: async () => '{"id":"not_found"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: CHANNEL_ID, delete_at: 0 }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(plugin.checkChannelStatus(CHANNEL_ID)).resolves.toEqual({ kind: 'deleted', error: 'Channel has been deleted' });
    await expect(plugin.checkChannelStatus(CHANNEL_ID)).resolves.toMatchObject({ kind: 'forbidden' });
    await expect(plugin.checkChannelStatus(CHANNEL_ID)).resolves.toMatchObject({ kind: 'not_found' });
    await expect(plugin.checkChannelStatus(CHANNEL_ID)).resolves.toEqual({ kind: 'ok' });
  });
  test('connect 会校验 token 并启动 websocket 认证', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-u1', username: 'bot' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'welcome-1' }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    await plugin.connect();

    expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/api/v4/users/me`, expect.anything());
    expect(wsInstances).toHaveLength(1);
    wsInstances[0].__emit('open');
    expect(wsInstances[0].send).toHaveBeenCalled();
  });

  test('onMessage 能接收 websocket posted 事件', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const received: string[] = [];
    plugin.onMessage((msg) => received.push(msg.text));
    await plugin.connect();

    const post = {
      id: 'post-1',
      user_id: 'user-x',
      channel_id: CHANNEL_ID,
      root_id: '',
      message: 'hello from ws',
      create_at: Date.now(),
    };

    wsInstances[0].__emit('message', {
      data: JSON.stringify({
        event: 'posted',
        data: { post: JSON.stringify(post) },
      }),
    });

    expect(received).toEqual(['hello from ws']);
  });

  test('onMessage 能接收 websocket reaction 事件', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const received: Array<{ emoji?: string; postId?: string }> = [];
    plugin.onMessage((msg) => received.push({ emoji: msg.reaction?.emoji, postId: msg.reaction?.postId }));
    await plugin.connect();

    wsInstances[0].__emit('message', {
      data: JSON.stringify({
        event: 'reaction_added',
        data: {},
        broadcast: {
          channel_id: CHANNEL_ID,
          post_id: 'post-approval-1',
          user_id: 'user-x',
          emoji_name: '+1',
        },
      }),
    });

    expect(received).toEqual([{ emoji: '👍', postId: 'post-approval-1' }]);
  });

  test('sendMessage 使用 target.channelId，且空 threadId 不发送 root_id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.sendMessage({ plugin: 'mattermost', channelId: 'ch-other', threadId: '' }, { kind: 'text', text: 'hello' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    const body = JSON.parse(opts.body);
    expect(body.channel_id).toBe('ch-other');
    expect(body.message).toBe('hello');
    expect(body.root_id).toBeUndefined();
  });

  test('sendMessage 调用正确 API endpoint', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.sendMessage({ plugin: 'mattermost', threadId: 'root-post-id' }, { kind: 'text', text: 'hello' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.message).toBe('hello');
    expect(body.root_id).toBe('root-post-id');
  });

  test('updateMessage 调用 PUT /api/v4/posts/:id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.updateMessage('post-abc', { kind: 'text', text: 'updated' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts/post-abc`);
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body);
    expect(body.message).toBe('updated');
  });

  test('createChannelConversation 创建 private channel 并返回 id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID, teamId: 'team-1' });
    fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-123', username: 'mx-coder-bot' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'welcome-msg-id' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'created-channel-1' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({}),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({}),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    await plugin.connect({ sessionCount: 0, activeCount: 0 });
    const channelId = await plugin.createChannelConversation!({ channelId: 'source-channel', teamId: 'team-1', isPrivate: true, userId: 'user-456', sessionName: 'test-session' });

    expect(channelId).toBe('created-channel-1');
    expect(fetchSpy.mock.calls[2][0]).toBe(`${BASE_URL}/api/v4/channels`);
    const body = JSON.parse(fetchSpy.mock.calls[2][1].body);
    expect(body.team_id).toBe('team-1');
    expect(body.type).toBe('P');
    expect(body.name).toMatch(/^mx-test-session-\d{12}-[a-z0-9]{4}$/);
    expect(body.display_name).toMatch(/^mx-coder: test-session \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/);
  });

  test('createLiveMessage 创建顶层 post 时不发送 root_id 并返回 id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    const msgId = await plugin.createLiveMessage({ plugin: 'mattermost', channelId: 'ch-top', threadId: '' }, { kind: 'text', text: 'live top' });

    expect(msgId).toBe('post1');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.channel_id).toBe('ch-top');
    expect(body.root_id).toBeUndefined();
  });

  test('createLiveMessage 创建 post 并返回 id', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    const msgId = await plugin.createLiveMessage({ plugin: 'mattermost', threadId: 'root1' }, { kind: 'text', text: 'live' });

    expect(msgId).toBe('post1');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test('heartbeat 超时后主动 close 并重连', async () => {
    vi.useFakeTimers();

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

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

    vi.advanceTimersByTime(200);

    expect(wsInstances[0].close).toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(wsInstances.length).toBeGreaterThan(1);

    vi.useRealTimers();
  });

  test('收到 websocket 消息会刷新活性时间戳', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    const before = (plugin as any)._lastWsMessageAt ?? 0;
    wsInstances[0].__emit('message', { data: JSON.stringify({ event: 'hello', data: {} }) });
    const after = (plugin as any)._lastWsMessageAt ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('收到 websocket heartbeat ack 会刷新 ack 时间戳', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    const before = (plugin as any)._lastHeartbeatAckAt ?? 0;
    wsInstances[0].__emit('message', { data: JSON.stringify({ seq_reply: 1, status: 'OK' }) });
    const after = (plugin as any)._lastHeartbeatAckAt ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('只有匹配当前 heartbeat seq 的 ack 才刷新 ack 时间戳', async () => {
    vi.useFakeTimers();

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({
      url: BASE_URL,
      token: TOKEN,
      channelId: CHANNEL_ID,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 500,
    } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    vi.advanceTimersByTime(60);
    const before = (plugin as any)._lastHeartbeatAckAt ?? 0;
    wsInstances[0].__emit('message', { data: JSON.stringify({ seq_reply: 999999, status: 'OK' }) });
    const afterWrongAck = (plugin as any)._lastHeartbeatAckAt ?? 0;
    expect(afterWrongAck).toBe(before);

    const sends = wsInstances[0].send.mock.calls.map(call => JSON.parse(call[0]));
    const heartbeat = sends.find(payload => payload.action === 'ping');
    expect(heartbeat).toBeTruthy();

    wsInstances[0].__emit('message', { data: JSON.stringify({ seq_reply: heartbeat.seq, status: 'OK' }) });
    const afterMatchedAck = (plugin as any)._lastHeartbeatAckAt ?? 0;
    expect(afterMatchedAck).toBeGreaterThanOrEqual(before);

    vi.useRealTimers();
  });

  test('sendTyping 调用官方 Mattermost typing API 路径', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    (plugin as any)._botUserId = 'bot-u1';
    await plugin.sendTyping({ plugin: 'mattermost', channelId: 'ch-typing', threadId: 'root1' } as any);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/users/bot-u1/typing`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.channel_id).toBe('ch-typing');
    expect(body.parent_id).toBe('root1');
  });
  test('requestApproval 发送带 attachments 的消息并预置 reaction', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'approval-post-1' }),
        text: async () => '',
      })
      .mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({}),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);
    (plugin as any)._botUserId = 'bot-u1';

    await plugin.requestApproval({ plugin: 'mattermost', threadId: 'root1' }, {
      requestId: 'req1',
      sessionName: 'sess1',
      messageId: 'msg1',
      toolName: 'bash',
      toolInputSummary: 'ls -la',
      riskLevel: 'low',
      capability: 'bash',
      scopeOptions: ['once', 'session'],
      timeoutSeconds: 60,
    } as any);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v4/posts`);
    const body = JSON.parse(opts.body);
    expect(body.props?.attachments).toBeDefined();
    expect(fetchSpy.mock.calls.slice(1).every(call => call[0] === `${BASE_URL}/api/v4/reactions`)).toBe(true);
  });

  test('listReactions 返回标准化后的 emoji 列表', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([{ user_id: 'user-x', emoji_name: '+1' }]),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const reactions = await plugin.listReactions('approval-post-1');
    expect(reactions).toEqual([{ userId: 'user-x', emoji: '👍' }]);
  });

  test('listReactions 会过滤 bot 自己预置的 reaction', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        { user_id: 'bot-u1', emoji_name: '+1' },
        { user_id: 'user-x', emoji_name: '-1' },
      ]),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);
    (plugin as any)._botUserId = 'bot-u1';

    const reactions = await plugin.listReactions('approval-post-2');
    expect(reactions).toEqual([{ userId: 'user-x', emoji: '👎' }]);
  });

  test('getConnectionHealth 返回 ws/subscription 健康摘要', async () => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID } as any);
    await plugin.connect();
    wsInstances[0].__emit('open');

    const health = plugin.getConnectionHealth();
    expect(typeof health.wsHealthy).toBe('boolean');
    expect(typeof health.subscriptionHealthy).toBe('boolean');
    expect(typeof health.lastWsOpenAt).toBe('number');
  });

  test('disconnect 会关闭 websocket', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });

    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot-u1', username: 'bot' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await plugin.connect();
    expect(wsInstances).toHaveLength(1);

    await plugin.disconnect();
    expect(wsInstances[0].close).toHaveBeenCalled();
  });

  test('Authorization header 包含 token', async () => {
    const plugin = new MattermostPlugin({ url: BASE_URL, token: TOKEN, channelId: CHANNEL_ID });
    await plugin.sendMessage({ plugin: 'mattermost', threadId: 'root1' }, { kind: 'text', text: 'hi' });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});
