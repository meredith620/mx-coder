---
# HARNESS METADATA
# type: specification
# part-of: harness-architecture
# scope: testing
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---

# 测试开发规范

> **适用于:** 新增或修改测试代码
>
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## 测试分层架构

```
Layer 1: 单元测试 ─────────────────────────
  范围: 单个模块内部逻辑
  文件: tests/unit/**/*.test.ts
  耗时: <5 秒
  命令: npm run test:unit

Layer 2: 集成测试 ─────────────────────────
  范围: 模块交互 / IPC / 进程生命周期
  文件: tests/integration/**/*.test.ts
  耗时: <30 秒
  命令: npm run test:integration

Layer 3: E2E 测试 ─────────────────────────
  范围: 完整用户流程
  文件: e2e/tests/*.sh
  耗时: <5 分钟
  命令: npm run test:e2e
```

## 单元测试规范（Layer 1）

### 测试组织

```typescript
// tests/unit/session-registry.test.ts

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry(tmpDir);
  });

  // 每个测试独立，描述行为而非实现
  it('create should return a session with status idle', () => {
    const session = registry.create('bug-fix', { workdir: '/tmp' });
    expect(session.status).toBe('idle');
    expect(session.name).toBe('bug-fix');
  });

  it('create should throw if name already exists', () => {
    registry.create('bug-fix', { workdir: '/tmp' });
    expect(() => registry.create('bug-fix', { workdir: '/tmp' }))
      .toThrow('Session already exists');
  });

  // 状态迁移
  it('markAttached should transition idle → attached', () => {
    const s = registry.create('bug-fix', { workdir: '/tmp' });
    registry.markAttached('bug-fix', 12345);
    expect(s.status).toBe('attached');
    expect(s.attachedPid).toBe(12345);
  });
});
```

### Mock 使用

```typescript
import { vi } from 'vitest';
import { spawn } from 'child_process';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 12345,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') cb(0, null);
      return { on: vi.fn() };
    }),
    stdout: { on: vi.fn(), destroy: vi.fn() },
    stderr: { on: vi.fn(), destroy: vi.fn() },
  }),
}));

it('IMWorkerManager should track spawned process PID', async () => {
  const manager = new IMWorkerManager(registry);
  const session = registry.create('bug-fix', {});
  const pid = await manager.spawn(session);
  expect(spawn).toHaveBeenCalledOnce();
  expect(pid).toBe(12345);
});
```

### 常用 mock 场景

| 外部依赖 | Mock 方式 |
|---------|-----------|
| `child_process.spawn` | `vi.mock('child_process')` |
| `fs/promises` | `vi.mock('fs/promises')` 或 `memfs` |
| `net.Socket` | `vi.mock('net')` |
| `process.kill` | `vi.spyOn(process, 'kill')` |
| IM Plugin（Mattermost HTTP） | MSW（Mock Service Worker） |

## 集成测试规范（Layer 2）

### 测试辅助

```typescript
// tests/integration/helpers/test-daemon.ts
import { fork } from 'child_process';
import { Socket } from 'net';
import { unlinkSync, existsSync } from 'fs';

export class TestDaemon {
  private proc: ReturnType<typeof fork> | null = null;
  public socketPath: string;

  static async start(): Promise<TestDaemon> {
    const daemon = new TestDaemon();
    const socketPath = `/tmp/mm-coder-test-${Date.now()}.sock`;
    if (existsSync(socketPath)) unlinkSync(socketPath);
    daemon.socketPath = socketPath;
    daemon.proc = fork('./dist/daemon.js', {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { MM_SOCKET_PATH: socketPath, MM_CONFIG_DIR: daemon.configDir },
    });
    await daemon.waitForSocket();
    return daemon;
  }

  private async waitForSocket(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (existsSync(this.socketPath)) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('Socket did not appear');
  }

  async sendCommand(cmd: object): Promise<object> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      sock.connect(this.socketPath);
      sock.on('data', (data) => {
        sock.destroy();
        resolve(JSON.parse(data.toString()));
      });
      sock.on('error', reject);
      sock.write(JSON.stringify(cmd) + '\n');
    });
  }

  async stop(): Promise<void> {
    this.proc?.kill('SIGTERM');
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }
}
```

### 测试文件命名

```
tests/
├── unit/
│   ├── session-registry.test.ts
│   ├── im-worker-manager.test.ts
│   └── approval-manager.test.ts
├── integration/
│   ├── helpers/
│   │   └── test-daemon.ts
│   ├── session-lifecycle.test.ts
│   ├── ipc-commands.test.ts
│   └── worker-restart.test.ts
└── fixtures/
    ├── sessions-empty.json
    └── sessions-with-one.json
```

## E2E 测试规范（Layer 3）

### 测试环境管理

```bash
# e2e/scripts/test-env-up.sh
#!/usr/bin/env bash
set -e

echo "启动 E2E 测试环境..."
npm run build

# 启动 daemon
npm run daemon -- start &
DAEMON_PID=$!
sleep 2

if ! nc -z /tmp/mm-coder-daemon.sock 2>/dev/null; then
  echo "✗ Daemon socket 未就绪"
  kill $DAEMON_PID 2>/dev/null || true
  exit 1
fi

echo "✓ E2E 环境就绪 (daemon PID: $DAEMON_PID)"
```

### E2E 测试脚本

```bash
# e2e/tests/test_session_lifecycle.sh
#!/usr/bin/env bash
set -e

source "$(dirname "$0")/assert.sh"

echo "测试: Session 完整生命周期"

OUTPUT=$(mm-coder create test-session --workdir /tmp)
assert_contains "$OUTPUT" "created" "创建应成功"

OUTPUT=$(mm-coder list)
assert_contains "$OUTPUT" "test-session" "列表应包含 test-session"

OUTPUT=$(mm-coder remove test-session)
assert_contains "$OUTPUT" "removed" "删除应成功"

OUTPUT=$(mm-coder list)
assert_not_contains "$OUTPUT" "test-session" "列表不应包含 test-session"

echo "✓ Session 生命周期测试通过"
```

## 测试质量要求

### 覆盖率目标

| 模块 | 目标覆盖率 | 关键路径 |
|------|----------|---------|
| session-registry.ts | 85%+ | create/list/remove, 所有状态迁移 |
| im-worker-manager.ts | 80%+ | spawn/terminate/restart |
| approval-manager.ts | 90%+ | 所有审批状态迁移 |
| daemon.ts | 70%+ | 所有 IPC 命令处理 |
| plugins/cli/claude-code.ts | 80%+ | buildAttachCommand / buildIMWorkerCommand |

### 测试数据

```json
// tests/fixtures/sessions-empty.json
{ "sessions": [], "version": 1 }
```

### 测试命名

```typescript
// ✅ 描述行为
create_should_return_session_with_idle_status
create_should_throw_if_name_already_exists

// ❌ 避免
test1
create_session
```

## 测试开发流程

> **每个功能模块：先写测试验证，再进入人工验证**

1. 分析功能模块的公共 API 表面
2. 编写 Layer 1 单元测试，mock 所有外部依赖
3. 实现功能模块
4. Layer 1 通过 → 功能开发完成
5. 功能稳定后，编写 Layer 2 集成测试
6. Layer 2 通过 → 提交流程

## 测试检查清单

新增功能时必须：

- [ ] 单元测试覆盖核心逻辑（`npm run test:unit`）
- [ ] 集成测试覆盖 IPC 命令（`npm run test:integration`）
- [ ] 状态迁移场景单独测试
- [ ] 错误场景单独测试
- [ ] `npm run check` 无类型错误
- [ ] `npm test` 全部通过
