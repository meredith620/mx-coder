# mm-coder 实现切片清单（测试先行）

> **面向 AI agent 开发**：每个切片是一个独立的提交单元，包含"先写测试、再写实现"的明确约定。  
> AI agent 执行时应按切片顺序处理，每个切片完成后提交（`git commit`），再开始下一个。  
> 切片依赖关系已标注，有依赖的切片必须等前置完成后才能开始。

---

## 约定说明

### 测试结构
```
tests/
├── unit/          # 纯逻辑单元测试（无 I/O）
├── integration/   # 进程/socket/文件系统集成测试
└── e2e/           # 端到端流程测试（需 claude CLI 或 mock）
```

### 每个切片结构
- **目标**：这个切片完成后系统具备什么能力
- **测试文件**：先写什么测试（测试先行约定）
- **实现文件**：测试通过后写什么实现
- **验收标准**：`npm test -- <pattern>` 全绿即可提交
- **依赖切片**：必须先完成哪些切片

### AI agent 执行规则
1. 每个切片开始前：读取本文件确认依赖已完成
2. 先写测试文件（可以不能运行，但逻辑必须正确）
3. 再写最小实现让测试通过
4. 运行测试，全绿后提交
5. 提交格式：`<type>(<scope>): <description>`

---

## Phase 0：项目初始化

### S0 — 项目脚手架
**目标**：TypeScript 项目可构建、可测试，基础工具链就绪  
**依赖切片**：无

**操作（非 TDD，基础设施）**：
```
package.json         # scripts: build/test/lint
tsconfig.json        # strict, outDir: dist
jest.config.ts       # ts-jest, testMatch
.eslintrc            # @typescript-eslint
src/index.ts         # 空入口（仅 export）
```

**验收**：`npm run build` 成功，`npm test` 输出"No test suites found"（非报错）

**提交**：`chore(scaffold): init TypeScript project with jest and eslint`

---

## Phase 1：核心数据模型

### S1 — 核心类型定义
**目标**：`Session`、`QueuedMessage`、`IMBinding`、`StreamCursor`、`CLIEvent`、`IncomingMessage`、`ApprovalRequest`、`ApprovalResult`、`MessageContent`、`MessageTarget` 等所有核心类型可 import 使用  
**依赖切片**：S0

**测试文件**：`tests/unit/types.test.ts`
```typescript
// 验证类型结构完整性（TypeScript 编译期检查为主）
// 运行期测试：验证状态枚举值穷举、requestId 格式化函数
import { formatRequestId, ALL_SESSION_STATUSES } from '../../src/types';

test('formatRequestId 格式正确', () => {
  const id = formatRequestId('sess1', 'msg1', 'tool1', 'nonce1');
  expect(id).toBe('sess1:msg1:tool1:nonce1');
});

test('ALL_SESSION_STATUSES 包含所有合法状态', () => {
  const expected = ['idle','attach_pending','attached','im_processing',
                    'approval_pending','takeover_pending','recovering','error'];
  expect(ALL_SESSION_STATUSES).toEqual(expect.arrayContaining(expected));
  expect(ALL_SESSION_STATUSES).toHaveLength(expected.length);
});
```

**实现文件**：`src/types.ts`  
- 所有接口/类型定义（从 SPEC §3.2、§3.10、§4.1、§4.2 提取）
- `formatRequestId(sessionId, messageId, toolUseId, nonce): string`
- `ALL_SESSION_STATUSES: readonly SessionStatus[]`

**验收**：`npm test -- types`

**提交**：`feat(types): define core domain types and session status constants`

---

### S2 — Session 状态机
**目标**：状态迁移规则可编程验证，非法迁移抛出标准错误  
**依赖切片**：S1

**测试文件**：`tests/unit/session-state-machine.test.ts`
```typescript
import { SessionStateMachine, INVALID_STATE_TRANSITION } from '../../src/session-state-machine';

test('idle + attach_start → attached', () => {
  const sm = new SessionStateMachine('idle');
  sm.transition('attach_start');
  expect(sm.current).toBe('attached');
});

test('im_processing + attach_start → attach_pending', () => {
  const sm = new SessionStateMachine('im_processing');
  sm.transition('attach_start');
  expect(sm.current).toBe('attach_pending');
});

test('非法迁移抛出 INVALID_STATE_TRANSITION', () => {
  const sm = new SessionStateMachine('idle');
  expect(() => sm.transition('approval_approved'))
    .toThrow(INVALID_STATE_TRANSITION);
});

// 覆盖 SPEC §3.6 中所有合法迁移行
test.each([
  ['idle', 'im_message_received', 'im_processing'],
  ['attached', 'attach_exit_normal', 'idle'],
  ['attached', 'takeover_requested', 'takeover_pending'],
  // ... 完整 13 行
])('%s + %s → %s', (from, event, to) => {
  const sm = new SessionStateMachine(from as SessionStatus);
  sm.transition(event as StateEvent);
  expect(sm.current).toBe(to);
});
```

**实现文件**：`src/session-state-machine.ts`
- `TRANSITION_TABLE: Record<SessionStatus, Partial<Record<StateEvent, SessionStatus>>>`（直接编码 SPEC §3.6 表格）
- `SessionStateMachine` 类：`current`、`transition(event)`、`canTransition(event): boolean`
- `INVALID_STATE_TRANSITION` 错误码常量

**验收**：`npm test -- session-state-machine`（所有合法迁移测试 + 非法迁移测试全绿）

**提交**：`feat(state-machine): implement session state transition table and validator`

---

### S3 — SessionRegistry（无持久化）
**目标**：内存中的 session CRUD 和状态管理，含 PID 校验逻辑、initState 懒初始化、lifecycleStatus/runtimeStatus 解耦、session 锁 + revision CAS、attach 优先于 IM  
**依赖切片**：S2

**测试文件**：`tests/unit/session-registry.test.ts`
```typescript
import { SessionRegistry } from '../../src/session-registry';

let registry: SessionRegistry;
beforeEach(() => { registry = new SessionRegistry(); });

test('create 创建 session，name 唯一', () => {
  registry.create('bug-fix', { workdir: '/tmp', cliPlugin: 'claude-code' });
  expect(() => registry.create('bug-fix', { workdir: '/tmp', cliPlugin: 'claude-code' }))
    .toThrow('SESSION_ALREADY_EXISTS');
});

test('markAttached 更新 pid 和状态', () => {
  registry.create('s1', { workdir: '/tmp', cliPlugin: 'claude-code' });
  registry.markAttached('s1', 1234);
  const s = registry.get('s1')!;
  expect(s.status).toBe('attached');
  expect(s.attachedPid).toBe(1234);
});

test('getByIMThread 按 plugin+threadId 查找', () => {
  registry.create('s2', { workdir: '/tmp', cliPlugin: 'claude-code' });
  registry.bindIM('s2', { plugin: 'mattermost', threadId: 'thread-1' });
  const found = registry.getByIMThread('mattermost', 'thread-1');
  expect(found?.name).toBe('s2');
});

test('非法状态迁移时 markAttached 从 error 状态失败', () => {
  registry.create('s3', { workdir: '/tmp', cliPlugin: 'claude-code' });
  // 手动设置 error 状态
  registry['_sessions'].get('s3')!.status = 'error';
  expect(() => registry.markAttached('s3', 999)).toThrow('INVALID_STATE_TRANSITION');
});

// P1: initState 懒初始化闭环
test('initState=uninitialized 时 attach 触发懒初始化（first-writer-wins）', async () => {
  registry.create('s4', { workdir: '/tmp', cliPlugin: 'claude-code' });
  const s = registry.get('s4')!;
  expect(s.initState).toBe('uninitialized');
  
  // 并发两个 attach 请求
  const p1 = registry.beginInitAndAttach('s4', 1111);
  const p2 = registry.beginInitAndAttach('s4', 2222);
  
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  // 一个成功，一个返回 SESSION_BUSY
  expect([r1.status, r2.status].filter(s => s === 'fulfilled')).toHaveLength(1);
  expect([r1.status, r2.status].filter(s => s === 'rejected')).toHaveLength(1);
  
  const updated = registry.get('s4')!;
  expect(updated.initState).toBe('initialized');
});

test('initState=initializing 时其他操作返回 SESSION_BUSY', () => {
  registry.create('s5', { workdir: '/tmp', cliPlugin: 'claude-code' });
  registry['_sessions'].get('s5')!.initState = 'initializing';
  expect(() => registry.markAttached('s5', 999)).toThrow('SESSION_BUSY');
});

// P1: lifecycleStatus 与 runtimeStatus 解耦
test('lifecycleStatus=archived 时禁止进入运行态', () => {
  registry.create('s6', { workdir: '/tmp', cliPlugin: 'claude-code' });
  registry.archive('s6');
  expect(() => registry.markAttached('s6', 999)).toThrow('SESSION_ARCHIVED');
});

test('lifecycleStatus 与 runtimeStatus 独立迁移', () => {
  registry.create('s7', { workdir: '/tmp', cliPlugin: 'claude-code' });
  registry.markStale('s7'); // lifecycleStatus: active → stale
  const s = registry.get('s7')!;
  expect(s.lifecycleStatus).toBe('stale');
  expect(s.status).toBe('idle'); // runtimeStatus 不受影响
});

// P1: session 锁 + revision CAS
test('并发状态变更时 revision CAS 冲突返回 SESSION_BUSY', async () => {
  registry.create('s8', { workdir: '/tmp', cliPlugin: 'claude-code' });
  const s = registry.get('s8')!;
  const rev = s.revision;
  
  // 模拟并发：第一个操作成功，第二个基于旧 revision 失败
  registry.markAttached('s8', 1111); // revision++
  expect(() => registry.markAttachedWithRevision('s8', 2222, rev)).toThrow('SESSION_BUSY');
});

// P1: attach 优先于 IM
test('idle 态并发时 attach 优先，IM 入队', async () => {
  registry.create('s9', { workdir: '/tmp', cliPlugin: 'claude-code' });
  
  // 并发 attach 和 IM 消息
  const attachPromise = registry.beginAttach('s9', 1111);
  const imPromise = registry.enqueueIMMessage('s9', { text: 'hello', dedupeKey: 'k1' });
  
  await attachPromise;
  const s = registry.get('s9')!;
  expect(s.status).toBe('attached');
  expect(s.messageQueue).toHaveLength(1); // IM 消息已入队
});

test('attach 期间 IM 不入队（直接返回 SESSION_BUSY）', () => {
  registry.create('s10', { workdir: '/tmp', cliPlugin: 'claude-code' });
  registry.markAttached('s10', 1111);
  expect(() => registry.enqueueIMMessage('s10', { text: 'hello', dedupeKey: 'k2' }))
    .toThrow('SESSION_BUSY');
});
```

**实现文件**：`src/session-registry.ts`
- `Map<string, Session>` 内存存储
- `create / get / list / remove`
- `markAttached / markDetached / markImProcessing / markRecovering`
- `bindIM / getByIMThread`
- `validateAttachedPid(name): boolean`（`process.kill(pid, 0)` 存活检测）
- 所有 mark 方法内部调用 `SessionStateMachine.transition`，捕获非法迁移并抛出标准错误
- **P1 新增**：
  - `beginInitAndAttach(name, pid)`: first-writer-wins 懒初始化 + attach
  - `archive(name) / markStale(name)`: lifecycleStatus 独立迁移
  - `markAttachedWithRevision(name, pid, expectedRevision)`: CAS 原子更新
  - `beginAttach(name, pid)`: attach 优先逻辑
  - `enqueueIMMessage(name, msg)`: 检查 attach 状态，attached 时拒绝入队
  - 每个 session 内部维护 `Mutex` 锁，所有状态变更在锁内执行

**验收**：`npm test -- session-registry`

**提交**：`feat(session-registry): in-memory CRUD with initState/lifecycle/CAS/attach-priority (P1)`

---

### S4 — 持久化层（sessions.json）
**目标**：SessionRegistry 可将状态写入/读取 sessions.json，daemon 重启后可恢复元数据  
**依赖切片**：S3

**测试文件**：`tests/integration/persistence.test.ts`
```typescript
import { SessionRegistry } from '../../src/session-registry';
import { PersistenceStore } from '../../src/persistence';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

test('写入后重新加载可恢复 session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
  const store = new PersistenceStore(path.join(dir, 'sessions.json'));
  const r1 = new SessionRegistry(store);
  r1.create('test', { workdir: '/tmp', cliPlugin: 'claude-code' });
  await store.flush();

  const store2 = new PersistenceStore(path.join(dir, 'sessions.json'));
  const r2 = new SessionRegistry(store2);
  await store2.load(r2);
  expect(r2.get('test')?.name).toBe('test');
});

test('重启后 attached/im_processing 状态重置为 recovering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coder-test-'));
  const store = new PersistenceStore(path.join(dir, 'sessions.json'));
  // 手动写入非干净状态
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    version: 1,
    sessions: [{ name: 'broken', status: 'im_processing', cliPlugin: 'claude-code', workdir: '/tmp' }]
  }));
  const store2 = new PersistenceStore(path.join(dir, 'sessions.json'));
  const r2 = new SessionRegistry(store2);
  await store2.load(r2);
  expect(r2.get('broken')?.status).toBe('recovering');
});
```

**实现文件**：`src/persistence.ts`
- `PersistenceStore` 类：`load(registry)`, `flush()`
- 加载时：`attached` / `im_processing` → `recovering`，`approval_pending` / `takeover_pending` → `recovering`
- 写文件用原子写（先写 `.tmp` 再 rename）

**验收**：`npm test -- persistence`

**提交**：`feat(persistence): atomic sessions.json write/load with crash-state recovery`

---

## Phase 2：IPC 通信层

### S5 — IPC 协议编解码
**目标**：请求/响应/ping/pong/event 的序列化与反序列化，含错误码枚举  
**依赖切片**：S1

**测试文件**：`tests/unit/ipc-codec.test.ts`
```typescript
import { encodeRequest, decodeMessage, encodeResponse, encodeError, encodeEvent } from '../../src/ipc/codec';

test('encodeRequest 生成合法 JSON Lines 行', () => {
  const line = encodeRequest('create', { name: 'test' });
  const parsed = JSON.parse(line);
  expect(parsed.type).toBe('request');
  expect(parsed.command).toBe('create');
  expect(parsed.requestId).toMatch(/^[0-9a-f-]{36}$/);
});

test('decodeMessage 识别 response/error', () => {
  const okLine = JSON.stringify({ type: 'response', requestId: 'r1', ok: true, data: {} });
  const msg = decodeMessage(okLine);
  expect(msg.type).toBe('response');
  expect((msg as any).ok).toBe(true);
});

test('encodeError 含标准错误码', () => {
  const line = encodeError('r1', 'SESSION_NOT_FOUND', "Session 'x' not found");
  const parsed = JSON.parse(line);
  expect(parsed.error.code).toBe('SESSION_NOT_FOUND');
});

// P1: server-push event 编码
test('encodeEvent 生成合法 event 消息', () => {
  const line = encodeEvent('session_state_changed', { name: 'bug-fix', status: 'idle', revision: 3 });
  const parsed = JSON.parse(line);
  expect(parsed.type).toBe('event');
  expect(parsed.event).toBe('session_state_changed');
  expect(parsed.data.name).toBe('bug-fix');
});

test('decodeMessage 识别 event 类型', () => {
  const eventLine = JSON.stringify({ type: 'event', event: 'attach_ready', data: { name: 'test' } });
  const msg = decodeMessage(eventLine);
  expect(msg.type).toBe('event');
  expect((msg as any).event).toBe('attach_ready');
});
```

**实现文件**：`src/ipc/codec.ts`
- `ERROR_CODES` 枚举（从 SPEC §3.7 提取全部错误码）
- `encodeRequest / encodeResponse / encodeError / encodePing / encodePong`
- `encodeEvent(event, data)`: 编码 server-push event 行
- `decodeMessage`：解析单行 JSONL，类型 guard（含 `event` 类型）

**验收**：`npm test -- ipc-codec`

**提交**：`feat(ipc): JSONL codec with request/response/error/ping/pong/event`

---

### S6 — Unix Socket 服务端（IPC server）
**目标**：daemon 可监听 Unix socket，接收并响应请求，处理短连接和长连接（keepalive + server-push event），以及 `subscribe` 命令  
**依赖切片**：S5、S3

**测试文件**：`tests/integration/ipc-server.test.ts`
```typescript
import { IPCServer } from '../../src/ipc/socket-server';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';

test('server 响应 create 命令', async () => {
  const socketPath = path.join(os.tmpdir(), `mm-test-${Date.now()}.sock`);
  const server = new IPCServer(socketPath);
  // 注册 create 处理器
  server.handle('create', async (args) => ({ session: { name: args.name, status: 'idle' } }));
  await server.listen();

  const response = await sendRpc(socketPath, 'create', { name: 'test' });
  expect(response.ok).toBe(true);
  expect(response.data.session.name).toBe('test');

  await server.close();
});

test('server 返回 UNKNOWN_COMMAND 错误', async () => {
  // ...
});

test('ping/pong keepalive', async () => {
  // 发送 ping，验证 pong 响应
});

// P1: server-push event 与 subscribe 命令
test('subscribe 命令注册长连接，收到 session_state_changed 事件', async () => {
  const socketPath = path.join(os.tmpdir(), `mm-test-${Date.now()}.sock`);
  const server = new IPCServer(socketPath);
  await server.listen();

  const received: string[] = [];
  const conn = net.createConnection(socketPath);
  const rl = require('readline').createInterface({ input: conn });
  rl.on('line', (line: string) => received.push(line));

  // 发送 subscribe 命令
  conn.write(JSON.stringify({ type: 'request', requestId: 'r1', command: 'subscribe', args: {} }) + '\n');
  await new Promise(r => setTimeout(r, 50)); // 等待 subscribe 响应

  // daemon 推送 session_state_changed 事件
  server.pushEvent({ type: 'event', event: 'session_state_changed', data: { name: 'test', status: 'idle', revision: 1 } });
  await new Promise(r => setTimeout(r, 50));

  expect(received.some(l => JSON.parse(l).event === 'session_state_changed')).toBe(true);
  conn.destroy();
  await server.close();
});

test('attach_ready 事件仅发送给等待中的 attach 连接', async () => {
  // 两个连接：一个 subscribe，一个 attach_pending 等待
  // 触发 attach_ready
  // 验证只有 attach_pending 连接收到 attach_ready 事件
});

test('UID 校验：不同 UID 进程连接时立即拒绝', async () => {
  // mock net.createConnection 模拟不同 UID 场景
  // 验证连接被关闭，审计日志记录
});

// 辅助函数
async function sendRpc(socketPath: string, command: string, args: object) { /* ... */ }
```

**实现文件**：`src/ipc/socket-server.ts`
- `IPCServer` 类：`listen() / close() / handle(command, fn)`
- 每条连接维护独立 `readline.Interface` 解析 JSONL
- 心跳：超过 45s 未收到 ping 主动断开
- socket 文件权限：`chmod(path, 0o600)`
- **P1 新增**：
  - `handle('subscribe', ...)`: 将连接注册为 subscriber，后续 `pushEvent` 广播给所有 subscriber
  - `pushEvent(event)`: 向所有订阅连接广播事件（`session_state_changed`）
  - `pushEventToAttachWaiter(sessionName, event)`: 向等待 `attach_ready` 的特定连接推送
  - UID 校验：连接建立时通过 `socket.remoteAddress` 或 SCM_CREDENTIALS 验证同 UID

**验收**：`npm test -- ipc-server`

**提交**：`feat(ipc): Unix socket server with command routing, keepalive, and server-push events`

---

### S7 — IPC 客户端
**目标**：CLI 命令可通过 IPC 客户端发送请求并等待响应  
**依赖切片**：S6

**测试文件**：`tests/integration/ipc-client.test.ts`
```typescript
import { IPCClient } from '../../src/ipc/client';
// 启动一个 mock server，验证 client 收发
test('client.send 返回 server 响应', async () => {
  // setup mock server
  const response = await client.send('list', {});
  expect(response.ok).toBe(true);
});

test('client 超时时抛出 TIMEOUT 错误', async () => {
  // server 故意不响应
  await expect(client.send('slow', {}, { timeoutMs: 100 })).rejects.toThrow('TIMEOUT');
});
```

**实现文件**：`src/ipc/client.ts`
- `IPCClient` 类：`connect() / send(command, args, opts) / close()`
- 按 `requestId` 匹配响应
- 支持 `timeoutMs` 选项

**验收**：`npm test -- ipc-client`

**提交**：`feat(ipc): IPC client with requestId matching and timeout`

---

## Phase 3：Daemon 命令处理

### S8 — Daemon 命令路由（create/list/remove/status）+ ACL 鉴权
**目标**：daemon 接收 IPC 请求并委托 SessionRegistry 处理基础 CRUD；CLI 命令入口在派发前完成 ACL 鉴权，ACL_DENIED 零副作用  
**依赖切片**：S6、S4

**测试文件**：`tests/integration/daemon-commands.test.ts`
```typescript
// 启动 daemon，通过 IPCClient 发送命令
test('create + list 往返', async () => {
  await client.send('create', { name: 'test', workdir: '/tmp', cli: 'claude-code' });
  const { data } = await client.send('list', {});
  expect(data.sessions.some((s: any) => s.name === 'test')).toBe(true);
});

test('remove 后 list 不再包含该 session', async () => { /* ... */ });

test('status 返回 daemon 运行状态', async () => {
  const { data } = await client.send('status', {});
  expect(data.pid).toBeGreaterThan(0);
  expect(data.sessions).toBeDefined();
});

// P1: ACL 三入口 — CLI 命令入口鉴权
test('attach 命令无 owner 角色时返回 ACL_DENIED', async () => {
  await client.send('create', { name: 'acl-test', workdir: '/tmp', cli: 'claude-code' });
  // 以非 owner actor 发送 attach
  const res = await client.send('attach', { name: 'acl-test', pid: 9999 }, {
    actor: { source: 'cli', userId: 'stranger' }
  });
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe('ACL_DENIED');
  // 验证零副作用：session 状态未变
  const { data } = await client.send('list', {});
  const s = data.sessions.find((s: any) => s.name === 'acl-test');
  expect(s.status).toBe('idle');
});

test('remove 命令无 owner 角色时返回 ACL_DENIED，session 未删除', async () => {
  await client.send('create', { name: 'acl-test2', workdir: '/tmp', cli: 'claude-code' });
  const res = await client.send('remove', { name: 'acl-test2' }, {
    actor: { source: 'cli', userId: 'stranger' }
  });
  expect(res.error.code).toBe('ACL_DENIED');
  const { data } = await client.send('list', {});
  expect(data.sessions.some((s: any) => s.name === 'acl-test2')).toBe(true);
});

// P1: SESSION_BUSY 与 ACL_DENIED 语义隔离
test('SESSION_BUSY 与 ACL_DENIED 返回不同错误码', async () => {
  await client.send('create', { name: 'busy-test', workdir: '/tmp', cli: 'claude-code' });
  // 模拟 session 被锁
  // SESSION_BUSY 表示并发冲突，不是权限问题
  // 验证两者错误码不同
});
```

**实现文件**：`src/daemon.ts`（框架）
- `Daemon` 类：`start() / stop()`
- 注册命令处理器：`create / list / remove / status`
- 委托 `SessionRegistry` 执行并返回结果
- **P1 新增**：
  - `AclManager`（`src/acl-manager.ts`）：`authorize(actor, action, session): 'allow' | 'deny'`
  - 每个命令处理器在执行前调用 `AclManager.authorize`，失败返回 `ACL_DENIED`（无副作用）
  - `actor` 从 IPC request 的 `actor` 字段提取（`{ source: 'cli', userId: string }`）
  - `SESSION_BUSY` 仅在 session 锁冲突时返回，不与 `ACL_DENIED` 混用

**验收**：`npm test -- daemon-commands`

**提交**：`feat(daemon): wire CRUD commands to SessionRegistry with ACL enforcement at CLI entry`

---

### S9 — attach 命令处理
**目标**：`mm-coder attach` 通过 IPC 通知 daemon 标记 session，daemon 验证状态合法性；支持 initState 守卫和 attach 优先测试  
**依赖切片**：S8

**测试文件**：`tests/integration/daemon-attach.test.ts`
```typescript
test('attach idle session 成功', async () => {
  await client.send('create', { name: 'a1', workdir: '/tmp', cli: 'claude-code' });
  const res = await client.send('attach', { name: 'a1', pid: 9999 });
  expect(res.ok).toBe(true);
  // verify status
  const { data } = await client.send('list', {});
  const s = data.sessions.find((s: any) => s.name === 'a1');
  expect(s.status).toBe('attached');
});

test('attach im_processing session 返回 attach_pending + waitRequired', async () => {
  await client.send('create', { name: 'a2', workdir: '/tmp', cli: 'claude-code' });
  // 手动将 session 设为 im_processing
  registry.markImProcessing('a2');
  
  const res = await client.send('attach', { name: 'a2', pid: 9999 });
  expect(res.ok).toBe(true);
  expect(res.data.waitRequired).toBe(true);
  
  // 验证 session 进入 attach_pending
  const { data } = await client.send('list', {});
  const s = data.sessions.find((s: any) => s.name === 'a2');
  expect(s.status).toBe('attach_pending');
});

test('attach nonexistent session 返回 SESSION_NOT_FOUND', async () => { /* ... */ });

// P1: initState 守卫
test('attach uninitialized session 触发懒初始化', async () => {
  await client.send('create', { name: 'a3', workdir: '/tmp', cli: 'claude-code' });
  const s1 = registry.get('a3')!;
  expect(s1.initState).toBe('uninitialized');
  
  await client.send('attach', { name: 'a3', pid: 9999 });
  const s2 = registry.get('a3')!;
  expect(s2.initState).toBe('initialized');
  expect(s2.status).toBe('attached');
});

test('attach initializing session 返回 SESSION_BUSY', async () => {
  await client.send('create', { name: 'a4', workdir: '/tmp', cli: 'claude-code' });
  // 手动设置 initializing
  registry['_sessions'].get('a4')!.initState = 'initializing';
  
  const res = await client.send('attach', { name: 'a4', pid: 9999 });
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe('SESSION_BUSY');
});

// P1: attach 优先于 IM
test('idle 态并发 attach 和 IM 时，attach 优先', async () => {
  await client.send('create', { name: 'a5', workdir: '/tmp', cli: 'claude-code' });
  
  // 并发发送 attach 和 IM 消息
  const attachPromise = client.send('attach', { name: 'a5', pid: 9999 });
  const imPromise = imPlugin.sendMessage({ plugin: 'mock', threadId: 't1' }, { text: 'hello' });
  
  await Promise.all([attachPromise, imPromise]);
  
  const s = registry.get('a5')!;
  expect(s.status).toBe('attached');
  expect(s.messageQueue).toHaveLength(1); // IM 消息已入队
});
```

**实现文件**：`src/daemon.ts`（扩展）
- 注册 `attach` 命令处理器
- 处理 `im_processing` → `attach_pending` 的等待语义（返回 `waitRequired: true`）
- **P1 新增**：
  - attach 前检查 `initState`，`uninitialized` 时调用 `beginInitAndAttach`
  - `initializing` 时返回 `SESSION_BUSY`
  - attach 优先逻辑：调用 `SessionRegistry.beginAttach`，确保 IM 消息入队而非拒绝

**验收**：`npm test -- daemon-attach`

**提交**：`feat(daemon): attach command with attach_pending, initState guard, and attach-priority`

---

### S10 — import 命令处理
**目标**：`mm-coder import <session-id>` 导入外部已启动的 Claude Code session  
**依赖切片**：S8

**测试文件**：`tests/integration/daemon-import.test.ts`
```typescript
test('import 创建 session 并绑定外部 sessionId', async () => {
  const res = await client.send('import', {
    sessionId: 'external-uuid-123',
    name: 'imported',
    workdir: '/tmp',
    cli: 'claude-code'
  });
  expect(res.ok).toBe(true);
  const { data } = await client.send('list', {});
  const s = data.sessions.find((s: any) => s.name === 'imported');
  expect(s.sessionId).toBe('external-uuid-123');
});

test('import 不指定 name 时自动生成名称', async () => { /* ... */ });
```

**实现文件**：`src/daemon.ts`（扩展）

**验收**：`npm test -- daemon-import`

**提交**：`feat(daemon): import command for adopting external CLI sessions`

---

## Phase 4：CLI Plugin

### S11 — CLIPlugin 接口 + ClaudeCodePlugin 命令构建
**目标**：`buildAttachCommand` 和 `buildIMWorkerCommand(session, bridgeScriptPath)` 输出正确命令参数  
**依赖切片**：S1

**测试文件**：`tests/unit/claude-code-plugin.test.ts`
```typescript
import { ClaudeCodePlugin } from '../../src/plugins/cli/claude-code';
import { Session } from '../../src/types';

const plugin = new ClaudeCodePlugin();
const session: Session = { name: 'test', sessionId: 'uuid-123', cliPlugin: 'claude-code', workdir: '/tmp', /* ... */ } as Session;

test('buildAttachCommand 生成 claude --resume', () => {
  const { command, args } = plugin.buildAttachCommand(session);
  expect(command).toBe('claude');
  expect(args).toContain('--resume');
  expect(args).toContain('uuid-123');
});

test('buildIMWorkerCommand 包含所有必要标志和 bridgeScriptPath', () => {
  const bridgePath = '/tmp/mm-coder-mcp-bridge-uuid-123.js';
  const { command, args } = plugin.buildIMWorkerCommand(session, bridgePath);
  expect(args).toContain('-p');
  expect(args).toContain('--input-format');
  expect(args).toContain('stream-json');
  expect(args).toContain('--output-format');
  expect(args).toContain('stream-json');
  expect(args).toContain('--verbose');
  expect(args).toContain('--permission-prompt-tool');
  // 验证 bridge 路径被正确注入
  const ptIdx = args.indexOf('--permission-prompt-tool');
  expect(args[ptIdx + 1]).toContain(bridgePath);
});

test('generateSessionId 生成 UUID 格式', () => {
  const id = plugin.generateSessionId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
```

**实现文件**：`src/plugins/cli/claude-code.ts`  
`src/plugins/types.ts`（CLIPlugin 接口）

**验收**：`npm test -- claude-code-plugin`

**提交**：`feat(plugin/cli): ClaudeCodePlugin with attach/IM worker command builders`

---

### S12 — stream-json 解析器（parseStream）
**目标**：`parseStream` 正确解析 CLIEvent 流，含 StreamCursor 过滤和降级  
**依赖切片**：S11

**测试文件**：`tests/unit/parse-stream.test.ts`
```typescript
import { parseStream } from '../../src/plugins/cli/claude-code';
import { Readable } from 'stream';

function makeStream(lines: string[]): Readable {
  return Readable.from(lines.map(l => l + '\n'));
}

test('基础事件解析：system/assistant/result', async () => {
  const stream = makeStream([
    JSON.stringify({ type: 'system', message: { session_id: 'sess1' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
  ]);
  const events: CLIEvent[] = [];
  for await (const e of parseStream(stream)) {
    events.push(e);
  }
  expect(events.map(e => e.type)).toEqual(['system', 'assistant', 'result']);
});

test('cursor 过滤：跳过已处理的 messageId', async () => {
  // 流中包含 messageId=msg1 和 msg2 的 assistant 事件
  // cursor.lastMessageId = 'msg1'
  // 期望只输出 msg2 的事件
});

test('cursor miss：sessionId 不一致时清空 cursor 全量输出', async () => {
  // system 事件 sessionId 与 cursor.sessionId 不一致
  // 期望所有事件都输出（cursor 重置）
});

test('cursor miss：sessionId 一致但 lastMessageId 不在历史中', async () => {
  // 期望只输出 result 事件之后的增量事件
});

test('未知事件类型不报错（兼容性）', async () => {
  const stream = makeStream([
    JSON.stringify({ type: 'unknown-future-type', data: {} }),
  ]);
  const events: CLIEvent[] = [];
  for await (const e of parseStream(stream)) { events.push(e); }
  expect(events[0].type).toBe('unknown-future-type');
});
```

**实现文件**：`src/plugins/cli/claude-code.ts`（扩展 `parseStream`）

**验收**：`npm test -- parse-stream`

**提交**：`feat(plugin/cli): parseStream with StreamCursor waterline and two-level fallback`

---

## Phase 5：IM Worker 管理

### S13 — IMWorkerManager（生命周期）
**目标**：spawn / terminate / isAlive / 崩溃重启逻辑可单独测试；spawnGeneration 防止 pre-warm 与 lazy spawn 双启动  
**依赖切片**：S3、S11

**测试文件**：`tests/unit/im-worker-manager.test.ts`
```typescript
import { IMWorkerManager } from '../../src/im-worker-manager';

// 使用 mock CLI plugin，spawn 一个实际存活的进程（如 `sleep 60`）
test('spawn 后 isAlive 返回 true', async () => {
  const mgr = new IMWorkerManager(mockCliPlugin, mockRegistry);
  await mgr.spawn(mockSession);
  expect(mgr.isAlive('test')).toBe(true);
  await mgr.terminate('test');
});

test('崩溃后 restartIfCrashed 递增 crashCount', async () => {
  // 模拟进程立即退出（exit code 1）
  // 等待重启完成（最多 3 次）
  // 验证 imWorkerCrashCount
});

test('超过 maxCrashCount 进入 error 状态', async () => {
  // spawn 一个立即崩溃的进程
  // 等待所有重启尝试
  // 验证 session.status === 'error'
});

test('成功处理一条消息后 resetCrashCountOnSuccess 清零', () => {
  // 手动设置 crashCount = 2
  mgr.resetCrashCountOnSuccess('test', 'correlation-1');
  expect(mockRegistry.get('test')?.imWorkerCrashCount).toBe(0);
});

// P1: spawnGeneration 防重（pre-warm vs lazy spawn 竞态）
test('spawnGeneration：并发 spawn 时仅有一个活跃 worker', async () => {
  const mgr = new IMWorkerManager(mockCliPlugin, mockRegistry);
  const session = mockRegistry.create('gen-test', { workdir: '/tmp', cliPlugin: 'claude-code' });
  
  // 模拟 pre-warm 和 lazy spawn 同时触发
  const spawn1 = mgr.spawn(session);
  const spawn2 = mgr.spawn(session);
  
  await Promise.allSettled([spawn1, spawn2]);
  
  // 任一时刻只有一个有效 imWorkerPid
  const s = mockRegistry.get('gen-test')!;
  expect(mgr.isAlive(s.name)).toBe(true);
  // 只有 spawnGeneration 匹配的 worker 被注册，另一个被立即终止
});

test('generation 不匹配时 stale worker 立即被终止', async () => {
  const mgr = new IMWorkerManager(mockCliPlugin, mockRegistry);
  // 手动模拟 spawnGeneration 不一致场景
  // 验证 stale worker 进程被 SIGTERM
});
```

**实现文件**：`src/im-worker-manager.ts`
- `spawn(session)`: `child_process.spawn` + 记录 PID
- `terminate(name, signal)`: SIGTERM/SIGKILL
- `isAlive(name)`: `process.kill(pid, 0)`
- `restartIfCrashed(name)`: 退避重启（1s/3s/10s），超限 → `registry.markError`
- `resetCrashCountOnSuccess(name, correlationId)`: 清零
- **P1 新增**：
  - spawn 前获取当前 `session.spawnGeneration` 并递增（在 session 锁内原子执行）
  - worker 启动成功后，只有 generation 仍匹配时才注册为活跃 worker；否则立即 SIGTERM（stale worker）
  - 保证 `imWorkerPid` 在任意时刻只有一个有效值

**验收**：`npm test -- im-worker-manager`

**提交**：`feat(im-worker): spawn/terminate/restart with spawnGeneration dedup and crash tracking`

---

### S14 — 消息投递（sendMessage + 懒启动/pre-warm + dedupeKey + 恢复矩阵）
**目标**：IM 消息投递到 worker stdin，含懒启动和 attach 退出后 pre-warm；dedupeKey 去重；replay/confirm/discard 恢复决策矩阵  
**依赖切片**：S13、S9

**测试文件**：`tests/integration/message-delivery.test.ts`
```typescript
// 使用 mock IM worker（cat 或 node echo 进程）
test('sendMessage 写入正确 JSONL 格式到 stdin', async () => {
  // spawn 一个将 stdin 写到文件的 mock 进程
  await mgr.sendMessage('test', 'Hello, Claude');
  // 读取文件验证格式
  const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  expect(written.type).toBe('user');
  expect(written.message.content[0].text).toBe('Hello, Claude');
});

test('懒启动：首条消息时 spawn IM worker', async () => {
  // session 初始没有 imWorkerPid
  // 发送消息后 imWorkerPid 非空
});

test('pre-warm：attach 退出后立即 spawn IM worker', async () => {
  // 模拟 markDetached 事件
  // 验证 imWorkerPid 被赋值
});

// P1: dedupeKey 去重约束
test('相同 dedupeKey 的消息不重复入队', async () => {
  const msg = { text: 'hello', dedupeKey: 'mattermost:thread-1:msg-abc' };
  await registry.enqueueIMMessage('test', msg);
  await registry.enqueueIMMessage('test', msg); // 相同 dedupeKey
  
  const s = registry.get('test')!;
  expect(s.messageQueue).toHaveLength(1); // 只有一条
});

test('相同 dedupeKey 的消息在执行中时返回已存在状态引用', async () => {
  const msg = { text: 'hello', dedupeKey: 'mattermost:thread-1:msg-abc', status: 'running' };
  registry['_sessions'].get('test')!.messageQueue.push(msg);
  
  const result = await registry.enqueueIMMessage('test', { text: 'hello', dedupeKey: 'mattermost:thread-1:msg-abc' });
  expect(result.alreadyExists).toBe(true);
  expect(result.existingStatus).toBe('running');
});

// P1: replay/confirm/discard 恢复决策矩阵
test('低风险+无审批+未完成消息 → restoreAction=replay', () => {
  const msg: QueuedMessage = {
    messageId: 'm1', dedupeKey: 'k1', status: 'running',
    enqueuePolicy: 'auto_after_detach',
    // 无 approvalState，低风险
  };
  const action = determineRestoreAction(msg, { hasApprovalContext: false, isHighRisk: false });
  expect(action).toBe('replay');
});

test('带审批上下文的消息 → restoreAction=confirm', () => {
  const msg: QueuedMessage = {
    messageId: 'm2', dedupeKey: 'k2', status: 'waiting_approval',
    approvalState: 'pending',
    enqueuePolicy: 'auto_after_detach',
  };
  const action = determineRestoreAction(msg, { hasApprovalContext: true, isHighRisk: false });
  expect(action).toBe('confirm');
});

test('replay 时写入 replayOf 指针', async () => {
  const original = { messageId: 'm1', dedupeKey: 'k1', status: 'failed' };
  const replayed = await registry.replayMessage('test', 'k1');
  expect(replayed.replayOf).toBe('k1');
  expect(replayed.dedupeKey).not.toBe('k1'); // 新 dedupeKey
});

// P1: 审计最小字段
test('恢复操作写入包含必要字段的审计日志', async () => {
  const auditSpy = jest.spyOn(auditLogger, 'log');
  await registry.replayMessage('test', 'k1');
  
  expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
    dedupeKey: expect.any(String),
    replayOf: expect.any(String),
    action: 'replay',
    result: expect.any(String),
  }));
});
```

**实现文件**：`src/im-worker-manager.ts`（扩展）、`src/daemon.ts`（pre-warm 钩子）
- **P1 新增**：
  - `enqueueIMMessage(name, msg)`: 检查 dedupeKey 去重，重复时返回 `{ alreadyExists: true, existingStatus }`
  - `determineRestoreAction(msg, ctx)`: 实现 replay/confirm/discard 判定矩阵
  - `replayMessage(name, dedupeKey)`: 创建 replay 消息，写入 `replayOf` 指针，写审计日志
  - 审计日志字段：`dedupeKey / replayOf / requestId / operatorId / action / result`（`src/utils/audit-logger.ts`）

**验收**：`npm test -- message-delivery`

**提交**：`feat(im-worker): message delivery with dedupeKey dedup and replay/confirm/discard matrix`

---

## Phase 6：权限审批

### S15 — ApprovalManager（规则匹配 + 状态机 + ApprovalContext + 并发仲裁）
**目标**：autoAllow/autoDeny 规则匹配，审批状态机（pending/approved/denied/expired/cancelled）；ApprovalContext 完整关联链；并发审批 first-write-wins；scope=session 缓存；approval→takeover 优先级  
**依赖切片**：S1

**测试文件**：`tests/unit/approval-manager.test.ts`
```typescript
import { ApprovalManager } from '../../src/approval-manager';

const config = {
  autoAllowCapabilities: ['read_only'],
  autoAskCapabilities: ['file_write'],
  autoDenyCapabilities: ['shell_dangerous'],
  autoDenyPatterns: ['Bash:rm -rf'],
  timeoutSeconds: 300,
};

test('read_only 工具 autoAllow', async () => {
  const mgr = new ApprovalManager(config, mockIMPlugin);
  const result = await mgr.applyRules('Read', { path: '/tmp/a.txt' });
  expect(result).toBe('allow');
});

test('shell_dangerous 工具 autoDeny', async () => {
  const result = await mgr.applyRules('Bash', { command: 'ls' }, 'shell_dangerous');
  expect(result).toBe('deny');
});

test('autoDenyPatterns 兜底匹配', async () => {
  const result = await mgr.applyRules('Bash', { command: 'rm -rf /tmp/test' });
  expect(result).toBe('deny');
});

test('requestId 唯一性：新请求 cancel 同 session 旧 pending', async () => {
  const req1 = await mgr.createPendingApproval('sess1', 'msg1', 'tool1', {} );
  const req2 = await mgr.createPendingApproval('sess1', 'msg2', 'tool2', {});
  expect(mgr.getApprovalState(req1.requestId)?.decision).toBe('cancelled');
});

test('超时后状态变为 expired', async () => {
  jest.useFakeTimers();
  const req = await mgr.createPendingApproval('sess1', 'msg1', 'tool1', {}, { timeoutSeconds: 1 });
  jest.advanceTimersByTime(1001);
  expect(mgr.getApprovalState(req.requestId)?.decision).toBe('expired');
  jest.useRealTimers();
});

// P1: ApprovalContext 关联链
test('createPendingApproval 接受完整 ApprovalContext', async () => {
  const ctx = {
    sessionId: 'sess1',
    messageId: 'msg1',
    toolUseId: 'tool-use-1',
    correlationId: 'corr-1',
    capability: 'file_write',
    operatorId: 'user-123',
  };
  const req = await mgr.createPendingApproval(ctx);
  expect(req.requestId).toContain('sess1:msg1:tool-use-1');
  expect(req.context.correlationId).toBe('corr-1');
});

test('审批结果不匹配 requestId 时标记 stale 并审计', async () => {
  const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });
  const wrongId = 's1:m1:t1:wrong-nonce';
  
  const result = await mgr.decide(wrongId, { decision: 'approved', scope: 'once' });
  expect(result.status).toBe('stale');
  expect(auditLogger.logs.some(l => l.action === 'stale_approval')).toBe(true);
});

// P1: 并发审批 first-write-wins
test('同一 session 并发审批时 first-write-wins', async () => {
  const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });
  
  // 并发两个 decide 调用
  const p1 = mgr.decide(req.requestId, { decision: 'approved', scope: 'once' });
  const p2 = mgr.decide(req.requestId, { decision: 'denied' });
  
  const [r1, r2] = await Promise.all([p1, p2]);
  
  // 一个成功，一个被标记 cancelled
  expect([r1.status, r2.status].filter(s => s === 'approved' || s === 'denied')).toHaveLength(1);
  expect([r1.status, r2.status].filter(s => s === 'cancelled')).toHaveLength(1);
});

test('多 approver 并发时 first-write-wins，其余标记 stale', async () => {
  const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });
  
  // 三个不同 approver 并发响应
  const p1 = mgr.decideByApprover(req.requestId, 'approver-1', { decision: 'approved', scope: 'once' });
  const p2 = mgr.decideByApprover(req.requestId, 'approver-2', { decision: 'approved', scope: 'once' });
  const p3 = mgr.decideByApprover(req.requestId, 'approver-3', { decision: 'denied' });
  
  const results = await Promise.all([p1, p2, p3]);
  const winner = results.filter(r => r.status === 'approved' || r.status === 'denied');
  expect(winner).toHaveLength(1);
});

// P1: scope=session 缓存
test('scope=session 时缓存键 = sessionId + operatorId + capability', async () => {
  const ctx = { sessionId: 's1', messageId: 'm1', toolUseId: 't1', operatorId: 'op1', capability: 'file_write' };
  const req = await mgr.createPendingApproval(ctx);
  await mgr.decide(req.requestId, { decision: 'approved', scope: 'session' });
  
  // 同一 session + operator + capability 的后续请求自动 allow
  const result = await mgr.applyRules('Edit', { path: '/tmp/b.txt' }, 'file_write', { sessionId: 's1', operatorId: 'op1' });
  expect(result).toBe('allow');
});

test('scope=session 缓存在 session 结束时失效', async () => {
  // 设置 scope=session 缓存
  // 调用 mgr.invalidateSessionCache('s1')
  // 验证后续请求不再 autoAllow
});

// P1: approval→takeover 优先级
test('approval_pending 收到 takeover 时先 cancel approval', async () => {
  const req = await mgr.createPendingApproval({ sessionId: 's1', messageId: 'm1', toolUseId: 't1' });
  
  // 触发 takeover
  await mgr.cancelForTakeover('s1');
  
  const state = mgr.getApprovalState(req.requestId);
  expect(state?.decision).toBe('cancelled');
  expect(state?.cancelReason).toBe('takeover');
});
```

**实现文件**：`src/approval-manager.ts`
- `applyRules(toolName, toolInput, capability?)`: `'allow' | 'deny' | 'ask'`
- `createPendingApproval(...)`: 生成 requestId，超时计时器
- `decide(requestId, result: ApprovalResult)`: 解析 pending Promise
- `expirePendingOnRestart()`: 批量 expire
- **P1 新增**：
  - `createPendingApproval(ctx: ApprovalContext)`: 接受完整上下文（messageId/correlationId/capability/operatorId）
  - `decide` 内部验证 requestId 匹配，不匹配 → 标记 stale + 审计
  - 并发 decide 时使用 CAS 或锁保证 first-write-wins
  - `decideByApprover(requestId, approverId, result)`: 多 approver 场景
  - `sessionScopeCache: Map<string, Set<string>>`（键 = `${sessionId}:${operatorId}:${capability}`）
  - `invalidateSessionCache(sessionId)`: session 结束/接管/reset 时清空
  - `cancelForTakeover(sessionId)`: approval→takeover 优先级，cancel 当前 pending

**验收**：`npm test -- approval-manager`

**提交**：`feat(approval): rule-based auto-allow/deny with ApprovalContext, first-write-wins, scope=session cache, and takeover priority`

---

### S15b — AclManager（IM 消息入口鉴权）
**目标**：IM 消息入口在派发前完成 ACL 鉴权；`ACL_DENIED` 零副作用；`SESSION_BUSY` 与 `ACL_DENIED` 语义隔离；IM 消息鉴权矩阵（operator/approver/owner 角色）  
**依赖切片**：S8（AclManager 已在 S8 中引入，本切片扩展 IM 入口鉴权逻辑）

**测试文件**：`tests/unit/acl-manager.test.ts`
```typescript
import { AclManager } from '../../src/acl-manager';

test('owner 创建时自动拥有所有角色', () => {
  const acl = new AclManager();
  acl.grantRole('sess1', 'user-creator', 'owner');
  expect(acl.hasRole('sess1', 'user-creator', 'owner')).toBe(true);
  expect(acl.hasRole('sess1', 'user-creator', 'approver')).toBe(true);
  expect(acl.hasRole('sess1', 'user-creator', 'operator')).toBe(true);
});

test('operator 可发消息，不可审批', () => {
  const acl = new AclManager();
  acl.grantRole('sess1', 'op-user', 'operator');
  expect(acl.authorize('sess1', 'op-user', 'send_message')).toBe('allow');
  expect(acl.authorize('sess1', 'op-user', 'approve')).toBe('deny');
});

test('未授权用户只读，不可发消息或审批', () => {
  const acl = new AclManager();
  expect(acl.authorize('sess1', 'stranger', 'send_message')).toBe('deny');
  expect(acl.authorize('sess1', 'stranger', 'attach')).toBe('deny');
  expect(acl.authorize('sess1', 'stranger', 'list')).toBe('allow'); // 只读允许
});

// P1: IM 消息入口鉴权
test('纯文本消息 operator 角色通过鉴权', () => {
  const acl = new AclManager();
  acl.grantRole('sess1', 'op-user', 'operator');
  const result = acl.authorizeIMAction('sess1', 'op-user', { action: 'send_text', text: 'hello' });
  expect(result).toBe('allow');
});

test('approve 动作需要 approver 角色', () => {
  const acl = new AclManager();
  acl.grantRole('sess1', 'op-user', 'operator');
  const result = acl.authorizeIMAction('sess1', 'op-user', { action: 'approve', requestId: 'r1' });
  expect(result).toBe('deny');
});

test('takeover_hard 动作需要 owner 角色', () => {
  const acl = new AclManager();
  acl.grantRole('sess1', 'approver-user', 'approver');
  const result = acl.authorizeIMAction('sess1', 'approver-user', { action: 'takeover_hard' });
  expect(result).toBe('deny');
});

test('approve 动作 ACL_DENIED 时映射为 deny，写审计日志', async () => {
  // IM 消息入口收到 approve 动作，用户无 approver 角色
  // 验证审批结果为 deny（fail-closed），不改变 session 状态
  const auditSpy = jest.spyOn(auditLogger, 'log');
  await daemon.handleIMAction('sess1', 'stranger', { action: 'approve', requestId: 'r1' });
  expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
    action: 'acl_denied',
    actor: 'stranger',
  }));
  // session 状态未变
});

// P1: SESSION_BUSY 与 ACL_DENIED 语义隔离
test('SESSION_BUSY 和 ACL_DENIED 是不同错误码', () => {
  // 并发写入时返回 SESSION_BUSY（锁冲突）
  // 权限不足时返回 ACL_DENIED（权限问题）
  // 两者独立，不可混用
  expect(ERROR_CODES.SESSION_BUSY).not.toBe(ERROR_CODES.ACL_DENIED);
});

test('ACL_DENIED 零副作用：不入队、不迁移状态', async () => {
  // operator 尝试 takeover（需要 owner 角色）
  await daemon.handleIMAction('sess1', 'op-user', { action: 'takeover_hard' });
  
  const s = registry.get('sess1')!;
  expect(s.status).toBe('idle'); // 状态未变
  expect(s.messageQueue).toHaveLength(0); // 队列未变
});

// P1: autoAllow/autoDeny 入口三约束
test('autoAllow 仅限 read_only capability', () => {
  const mgr = new ApprovalManager(config, mockIMPlugin);
  // 非 read_only 的 autoAllow 配置应被忽略
  const result = mgr.applyRulesFromInternalCall('Bash', { command: 'ls' }, 'shell_dangerous');
  expect(result).not.toBe('allow'); // shell_dangerous 不得 autoAllow
});
```

**实现文件**：`src/acl-manager.ts`
- `AclManager` 类：`grantRole / revokeRole / hasRole / authorize / authorizeIMAction`
- session ACL 存储：`Map<string, Map<string, Set<Role>>>`（`sessionId → userId → roles`）
- 创建 session 时自动为 creator 授予 owner 角色
- `authorizeIMAction(sessionId, userId, action)`: 按 SPEC §6.1 入口二矩阵鉴权
- `ACL_DENIED` 语义：鉴权失败时无副作用（调用方不得入队/迁移状态/更新审批）
- `SESSION_BUSY` 语义：session 锁冲突时返回，与 `ACL_DENIED` 使用不同错误码

**验收**：`npm test -- acl-manager`

**提交**：`feat(acl): AclManager with role-based authorization for CLI and IM entry points (P1)`

---

### S16 — MCP Bridge 脚本生成
**目标**：daemon 可动态生成 `mcp-bridge-<sessionId>.js` 并在 IM worker 中传递  
**依赖切片**：S15

**测试文件**：`tests/integration/mcp-bridge.test.ts`
```typescript
test('生成的 bridge 脚本连接 daemon socket 并转发', async () => {
  // 启动 mock MCP server（Unix socket）
  // 生成 bridge 脚本
  // 启动 bridge 进程
  // 通过 bridge 的 stdin 发 MCP 请求
  // 验证 mock server 收到了相同的请求
});

test('bridge 脚本携带正确 sessionId', async () => {
  const scriptPath = await generateBridgeScript('sess-abc', socketPath);
  const content = fs.readFileSync(scriptPath, 'utf8');
  expect(content).toContain('sess-abc');
});

test('bridge 文件权限为 0600', async () => {
  const scriptPath = await generateBridgeScript('sess-xyz', socketPath);
  const stat = fs.statSync(scriptPath);
  expect(stat.mode & 0o777).toBe(0o600);
});
```

**实现文件**：`src/mcp-bridge.ts`
- `generateBridgeScript(sessionId, socketPath): Promise<string>`（返回脚本路径）
- 脚本模板：连接 Unix socket，stdin→socket，socket→stdout，携带 sessionId 头
- 文件权限 `0600`
- MCP server 监听逻辑（在 daemon 内）

**验收**：`npm test -- mcp-bridge`

**提交**：`feat(mcp-bridge): dynamic bridge script generation for IM worker permission routing`

---

### S17 — 完整审批链路集成
**目标**：IM worker 触发工具审批时，IM 收到审批请求，用户响应后 worker 继续  
**依赖切片**：S15、S16、S14

**测试文件**：`tests/integration/approval-flow.test.ts`
```typescript
// 使用 mock IM worker（能发 MCP permission request 的脚本）
test('approval 链路：mock worker → bridge → daemon → IM → approve → worker 继续', async () => {
  // 启动 mock worker 发送 can_use_tool 请求
  // 验证 mockIMPlugin.requestApproval 被调用
  // 调用 mgr.decide(requestId, { decision: 'approved', scope: 'once' })
  // 验证 worker 收到 allow 响应
});

test('超时后 worker 收到 deny 响应', async () => { /* ... */ });
```

**验收**：`npm test -- approval-flow`

**提交**：`feat(approval): end-to-end approval flow with MCP bridge and IM notification`

---

## Phase 7：IM Plugin

### S18 — IMPlugin 接口 + Mock 实现
**目标**：定义完整 IMPlugin 接口，提供可用于测试的 MockIMPlugin  
**依赖切片**：S1

**测试文件**：`tests/unit/im-plugin-interface.test.ts`
```typescript
import { MockIMPlugin } from '../../tests/helpers/mock-im-plugin';

test('MockIMPlugin 收到 onMessage 事件', async () => {
  const plugin = new MockIMPlugin();
  const received: IncomingMessage[] = [];
  plugin.onMessage(msg => received.push(msg));
  plugin.simulateMessage({ threadId: 'thread-1', userId: 'user1', text: 'hello' });
  expect(received).toHaveLength(1);
  expect(received[0].text).toBe('hello');
});

test('MockIMPlugin.sendMessage 记录发送历史', async () => {
  const plugin = new MockIMPlugin();
  await plugin.sendMessage({ plugin: 'mock', threadId: 't1' }, { kind: 'text', text: 'reply' });
  expect(plugin.sent).toHaveLength(1);
});
```

**实现文件**：  
`src/plugins/types.ts`（IMPlugin 接口，含 `createLiveMessage`）  
`tests/helpers/mock-im-plugin.ts`（测试辅助）

**验收**：`npm test -- im-plugin-interface`

**提交**：`feat(plugin/im): IMPlugin interface with createLiveMessage and MockIMPlugin for tests`

---

### S19 — 流式输出 → IM 更新（createLiveMessage + updateMessage 防抖）
**目标**：IM worker stdout 流式 token 合并后更新同一条 IM 消息（500ms 防抖）  
**依赖切片**：S18、S12

**测试文件**：`tests/unit/stream-to-im.test.ts`
```typescript
import { StreamToIM } from '../../src/stream-to-im';

test('500ms 内多次 token 合并为一次 updateMessage', async () => {
  jest.useFakeTimers();
  const mockIM = new MockIMPlugin();
  const handler = new StreamToIM(mockIM, { plugin: 'mock', threadId: 't1' });

  await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Hello' }] } } });
  await handler.onEvent({ type: 'assistant', payload: { message: { content: [{ type: 'text', text: ' World' }] } } });

  jest.advanceTimersByTime(499);
  expect(mockIM.updated).toHaveLength(0); // 还没触发

  jest.advanceTimersByTime(1);
  expect(mockIM.updated).toHaveLength(1);
  expect(mockIM.updated[0].content).toContain('Hello World');

  jest.useRealTimers();
});

test('result 事件立即 flush（不等防抖）', async () => {
  jest.useFakeTimers();
  await handler.onEvent({ type: 'result', payload: { subtype: 'success', result: 'Done' } });
  // result 应立即 flush，不需要 advanceTimersByTime
  expect(mockIM.updated).toHaveLength(1);
  jest.useRealTimers();
});
```

**实现文件**：`src/stream-to-im.ts`
- `StreamToIM` 类：`onEvent(event)` + 内部防抖 500ms
- `result` / `error` 事件立即 flush
- 首个 `assistant` 事件前调用 `createLiveMessage` 获取 messageId
- 后续统一调用 `updateMessage(target, messageId, content)`

**验收**：`npm test -- stream-to-im`

**提交**：`feat(stream): streaming CLI output to IM with 500ms debounce and createLiveMessage`

---

### S20 — Mattermost Plugin 实现
**目标**：真实 Mattermost Bot 可收发消息，createThread/requestApproval 可用  
**依赖切片**：S18

> 此切片涉及外部 API，使用 `nock` 或 `jest.mock` mock HTTP，不依赖真实服务器

**测试文件**：`tests/unit/mattermost-plugin.test.ts`
```typescript
import { MattermostPlugin } from '../../src/plugins/im/mattermost';

test('sendMessage 调用正确 API endpoint', async () => {
  const scope = nock('https://mm.example.com')
    .post('/api/v4/posts')
    .reply(200, { id: 'post1' });

  const plugin = new MattermostPlugin({ url: 'https://mm.example.com', token: 'tok', channelId: 'ch1' });
  await plugin.sendMessage({ plugin: 'mattermost', threadId: 'root-post-id' }, { kind: 'text', text: 'hello' });
  expect(scope.isDone()).toBe(true);
});

test('requestApproval 发送带按钮的 interactive message', async () => { /* ... */ });

test('updateMessage 调用 PUT /api/v4/posts/:id', async () => { /* ... */ });
```

**实现文件**：`src/plugins/im/mattermost.ts`

**验收**：`npm test -- mattermost-plugin`

**提交**：`feat(plugin/im): Mattermost plugin with send/update/createThread/requestApproval`

---

## Phase 8：CLI 入口

### S21 — CLI 命令解析（index.ts）
**目标**：`mm-coder` 命令解析正确，通过 IPC client 调用 daemon  
**依赖切片**：S7

**测试文件**：`tests/unit/cli-parser.test.ts`
```typescript
// 测试参数解析逻辑（不依赖真实 daemon）
test('parse "create bug-fix --workdir /tmp"', () => {
  const parsed = parseCLIArgs(['create', 'bug-fix', '--workdir', '/tmp']);
  expect(parsed.command).toBe('create');
  expect(parsed.args.name).toBe('bug-fix');
  expect(parsed.args.workdir).toBe('/tmp');
});

test('parse "attach test"', () => {
  const parsed = parseCLIArgs(['attach', 'test']);
  expect(parsed.command).toBe('attach');
  expect(parsed.args.name).toBe('test');
});

test('parse "import uuid-123 --name imported --workdir /tmp"', () => {
  const parsed = parseCLIArgs(['import', 'uuid-123', '--name', 'imported', '--workdir', '/tmp']);
  expect(parsed.command).toBe('import');
  expect(parsed.args.sessionId).toBe('uuid-123');
});
```

**实现文件**：`src/index.ts`（CLI 入口）
- 使用 `commander` 或手写参数解析
- `parseCLIArgs` 可独立导出（便于测试）
- `mm-coder start`：以 daemon 模式启动并 daemonize（fork + detach）
- 其余命令：创建 IPCClient → 发送请求 → 输出结果

**验收**：`npm test -- cli-parser`

**提交**：`feat(cli): command parser for all mm-coder subcommands`

---

### S22 — attach 流程（attach 命令完整实现）
**目标**：`mm-coder attach` 通知 daemon → 等待 IM 完成 → spawn 原生 AI CLI → 退出后通知 daemon  
**依赖切片**：S21、S9

**测试文件**：`tests/integration/attach-flow.test.ts`
```typescript
// 使用 mock daemon（IPC server），mock claude 命令（立即退出的 shell 脚本）
test('attach 完整流程：通知 daemon → spawn → 退出 → 通知 detach', async () => {
  // 1. mock daemon 记录收到的命令
  // 2. 运行 mm-coder attach test
  // 3. mock claude 退出（exit 0）
  // 4. 验证 daemon 收到 markDetached + exitReason=normal
});

test('attach 期间 IM 正在处理：界面显示等待提示', async () => {
  // mock daemon 响应 attach → waitRequired: true
  // 等待 daemon 发送 resume 信号
  // 验证 stdout 输出等待提示
});
```

**实现文件**：`src/index.ts`（attach 命令实现）

**验收**：`npm test -- attach-flow`

**提交**：`feat(cli): attach command with im_processing wait and detach notification`

---

## Phase 9：端到端验证

### S23 — 完整 IM 消息处理 E2E
**目标**：从 IM 消息到 AI CLI 处理再到 IM 回复的完整链路可测试  
**依赖切片**：S14、S17、S19、S20（或 mock）

**测试文件**：`tests/e2e/im-message-flow.test.ts`
```typescript
// 使用 mock IM plugin + mock claude CLI（输出固定 stream-json 的脚本）
test('IM 消息 → mock claude → IM 回复', async () => {
  // 1. 启动完整 daemon（含 mock plugins）
  // 2. mock IM plugin 模拟收到消息
  // 3. mock claude 进程输出固定 stream-json 事件
  // 4. 验证 mock IM plugin.sendMessage/updateMessage 被调用
  // 5. 验证 session 状态回到 idle
});

test('消息处理中崩溃 → 重启 → 状态恢复', async () => {
  // mock claude 进程第一次立即崩溃，第二次正常
  // 验证 crashCount 增减和最终 IM 回复
});
```

**验收**：`npm test -- im-message-flow`

**提交**：`test(e2e): full IM message processing flow with mock plugins`

---

### S24 — TUI 模式（实时面板）
**目标**：`mm-coder tui` 连接 daemon IPC，通过 `subscribe` 命令订阅 server-push 事件，实时更新 session 状态面板  
**依赖切片**：S7、S6（subscribe 命令）

**测试文件**：`tests/unit/tui-renderer.test.ts`
```typescript
test('renderSessionList 正确格式化 session 信息', () => {
  const output = renderSessionList([
    { name: 'bug-fix', status: 'idle', workdir: '/tmp', lastActivityAt: new Date() },
    { name: 'review', status: 'im_processing', workdir: '/tmp', lastActivityAt: new Date() },
  ]);
  expect(output).toContain('bug-fix');
  expect(output).toContain('idle');
  expect(output).toContain('im_processing');
});

// P1: 实时面板 — subscribe 命令
test('TUI 发送 subscribe 命令后收到 session_state_changed 事件并更新渲染', async () => {
  const mockServer = new MockIPCServer();
  const tui = new TUIClient(mockServer.socketPath);
  
  await tui.connect();
  // 验证 TUI 发送了 subscribe 命令
  expect(mockServer.receivedCommands).toContain('subscribe');
  
  // 服务端推送 session_state_changed 事件
  mockServer.pushEvent({ type: 'event', event: 'session_state_changed', data: { name: 'bug-fix', status: 'attached', revision: 2 } });
  await new Promise(r => setTimeout(r, 50));
  
  // 验证 TUI 内部状态已更新
  expect(tui.getSessionStatus('bug-fix')).toBe('attached');
});

test('TUI 收到 approval_pending 状态时高亮显示', async () => {
  // 推送 approval_pending 状态
  // 验证渲染输出包含高亮标记
});
```

**实现文件**：`src/tui.ts`
- 使用 `blessed` 或纯 ANSI escape code 渲染
- 启动时发送 `subscribe` 命令，保持长连接
- 监听 `session_state_changed` 事件，实时更新 session 列表
- `renderSessionList(sessions)` 可独立测试
- 面板显示：session 名称、状态（含颜色区分）、队列长度、最近活动时间
- `approval_pending` 状态高亮提示（需要用户审批）

**验收**：`npm test -- tui-renderer`

**提交**：`feat(tui): real-time session panel with IPC subscribe and server-push event handling`

---

## 附录：切片依赖图

```
S0
├── S1
│   ├── S2 → S3 → S4
│   ├── S5 → S6 → S7 → S21 → S22
│   │         └── S8 → S9 → S22
│   │               └── S10
│   ├── S11 → S12
│   │     └── S19 (+ S18)
│   ├── S15 → S15b (+ S8)
│   │     └── S16 → S17 (+ S14)
│   └── S18
│
├── S13 (S3 + S11) → S14 → S17
└── S6 + S4 → S8 → S9

完整链路 E2E：
S23 = S14 + S17 + S19 + (S20 or mock)
S24 = S7 + S6（subscribe）
```

P1 覆盖切片对照：

| P1 项 | 覆盖切片 |
|---|---|
| initState 懒初始化闭环 | S3、S9 |
| lifecycleStatus 与 runtimeStatus 解耦 | S3 |
| 会话级锁 + revision CAS | S3 |
| attach 优先于 IM | S3、S9 |
| spawnGeneration 防重 | S13 |
| approval → takeover 优先级 | S15 |
| ApprovalContext 关联链 | S15 |
| 并发审批 first-write-wins | S15 |
| scope=session 粒度落地 | S15 |
| CLI 命令入口鉴权 | S8 |
| IM 消息入口鉴权 | S15b |
| 审批动作入口约束 | S15、S15b |
| SESSION_BUSY 与 ACL_DENIED 语义隔离 | S8、S15b |
| dedupeKey 去重约束 | S14 |
| replay/confirm/discard 判定矩阵 | S14 |
| replayOf 指针约束 | S14 |
| 审计最小字段 | S14 |
| server-push event（subscribe/attach_ready） | S5、S6 |
| TUI 实时面板 | S24 |

---

## AI Agent 执行检查清单

每个切片开始前，agent 应确认：
- [ ] 前置依赖切片已提交（`git log --oneline | grep <切片关键词>`）
- [ ] 测试文件先于实现文件创建（`git show --stat HEAD` 验证顺序）
- [ ] `npm test -- <pattern>` 在写实现前应失败（红灯阶段确认）
- [ ] 实现完成后 `npm test -- <pattern>` 全绿
- [ ] 提交前运行 `.harness/scripts/evaluate-guards.sh`
- [ ] 提交信息遵循 `<type>(<scope>): <description>` 格式
