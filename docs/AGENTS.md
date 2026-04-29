# Agent 使用指南

## 验证 Claude Code 原生命令支持度

### 快速开始

```bash
# 默认使用远程 (10.10.10.88)
./scripts/verify-native-commands.sh

# 使用本地 Claude Code
./scripts/verify-native-commands.sh --local

# 指定远程主机
./scripts/verify-native-commands.sh --remote 10.10.10.88
```

### 预期输出示例

```
==========================================
Claude Code 原生命令支持度验证
==========================================
执行模式: local

检查 Claude Code 环境...
本地 Claude Code: 2.1.119 (Claude Code)

开始验证...

[1] Testing /cost ... PASS
[2] Testing /context ... PASS
...

==========================================
验证结果汇总
==========================================
总计: 16  通过: 16  失败: 0  跳过: 0

所有验证通过！
```

### 命令分类结果

| 类别 | 命令 | 状态 |
|------|------|------|
| **支持（有直接输出）** | `/cost`, `/context` | ✅ |
| **支持（交互式）** | `/batch`, `/loop`, `/review` | ✅ 有交互响应 |
| **支持（后台执行）** | `/init`, `/debug`, `/insights`, `/simplify`, `/claude-api` | ⚠️ 无 stdout |
| **TUI 专用** | `/model`, `/effort` | ⚠️ 管道模式不可用，TUI 正常 |
| **不支持** | `/help`, `/skills`, `/plan`, `/status`, `/diff`, `/memory`, `/doctor`, `/recap`, `/btw` | ❌ Unknown skill |
| **无输出** | `/security-review` | ⚠️ 管道模式无响应 |

### 命令详细说明

#### ✅ 支持的命令
- `/cost` - 会话成本统计，有表格输出
- `/context` - Token 使用统计，有表格输出
- `/batch` - 批量操作，交互式提示
- `/loop` - 循环执行，交互式提示
- `/review` - 代码审查，交互式响应

#### ⚠️ TUI 专用（管道模式不支持）
- `/model [model]` - 切换模型，管道模式返回 `Unknown skill`
- `/effort [level]` - 设置 effort 级别，管道模式返回 `Unknown skill`

#### ❌ 不支持的命令
以下命令在管道模式下返回 `Unknown skill`：
`/help`, `/skills`, `/plan`, `/status`, `/diff`, `/memory`, `/doctor`, `/recap`, `/btw`

#### ⚠️ 无输出的命令
- `/security-review` - 管道模式下无任何输出

### Agent Task 触发方式

Agent 可以通过以下方式触发验证：

1. **监听用户消息**: "验证 Claude Code 命令"
2. **执行脚本**: `bash scripts/verify-native-commands.sh`
3. **指定模式**: `bash scripts/verify-native-commands.sh --local`
4. **SSH 远程调用**: `ssh 10.10.10.88 "source ~/.nvm/nvm.sh && printf '/cost\n' | claude -p"`

### 注意事项

- **本地模式**: 直接调用本地 `claude -p`
- **远程模式**: 需要 SSH 访问 `10.10.10.88` 并配置 nvm
- 部分命令（如 `/batch`, `/loop`）是交互式的
- 后台执行的命令（如 `/init`, `/simplify`）无 stdout 输出
- `/effort` 和 `/model` 是 TUI 专用，管道模式不可用但 TUI 正常
