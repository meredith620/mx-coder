# mx-coder 支持的原生指令

mx-coder 通过 `//<cmd>` 语法将 IM 消息透传给底层 coder CLI。

## Claude Code 原生指令

在管道模式（`-p`）下，Claude Code 支持以下 slash commands：

### 会话控制

| 指令 | 说明 | 示例输出 |
|------|------|----------|
| `/context` | 显示当前 token 使用统计 | 表格显示各分类 token 占用 |
| `/cost` | 显示会话成本统计 | 总成本、API 时长、代码变更统计 |

### 项目操作

| 指令 | 说明 | 示例输出 |
|------|------|----------|
| `/init` | 在当前目录初始化 CLAUDE.md | 后台任务执行 |
| `/review [path]` | 代码审查（可指定路径） | 交互响应 |

### 调试与分析

| 指令 | 说明 | 示例输出 |
|------|------|----------|
| `/debug` | 启用调试模式，显示会话调试信息 | 后台任务执行 |
| `/insights` | 显示会话洞察 | 后台任务执行 |

### 批量与循环

| 指令 | 说明 | 示例输出 |
|------|------|----------|
| `/batch` | 批量操作 | 交互提示 |
| `/loop [interval] [prompt]` | 循环执行 | 用法说明 |

### 技能（Skills）

| 指令 | 说明 |
|------|------|
| `/simplify` | 简化代码（后台执行） |
| `/claude-api` | Claude API 参考（后台执行） |

## IM 透传语法

在 Mattermost 中发送以 `//` 开头的消息，即可透传到 Claude Code：

```
//context     → 查看 token 使用
//cost        → 查看会话成本
//batch      → 批量操作
```

**注意**：
- 透传命令以双斜杠 `//` 开头，mx-coder 会剥离首个 `/` 后发送给 Claude Code
- 单斜杠命令（如 `/status`、`/help`）由 mx-coder 自己处理，不透传
- `//model` 和 `//effort` 在管道模式下不可用（这些是 TUI 专用命令）

## 不支持的命令

以下命令在管道模式下返回 `Unknown skill` 或无响应：

| 指令 | 说明 |
|------|------|
| `/help` | Unknown skill |
| `/model` | Unknown skill（TUI 专用） |
| `/effort` | Unknown skill（TUI 专用） |
| `/skills` | Unknown skill |
| `/plan` | Unknown skill |
| `/status` | Unknown skill |
| `/diff` | Unknown skill |
| `/memory` | Unknown skill |
| `/doctor` | Unknown skill |
| `/recap` | Unknown skill |
| `/btw` | Unknown skill |
| `/security-review` | 无输出 |

## 相关文档

- [SPEC.md](SPEC.md) — 透传协议的完整规格
- [IMPL-SLICES.v2.1.md](IMPL-SLICES.v2.1.md) — v2.1 透传功能实现切片
- [NATIVE-COMMANDS-SUPPORT.md](NATIVE-COMMANDS-SUPPORT.md) — 真实环境验证结果
