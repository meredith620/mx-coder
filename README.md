# mx-coder (Multi-modal Cross Coder)

AI CLI 会话桥接工具——管理多个 AI CLI 会话，支持终端直接交互与 IM 远程续接。

English README: [README.en.md](README.en.md)

## 解决什么问题

在电脑前使用 Claude Code 等 AI CLI 时，终端体验最好；离开电脑后，同一会话往往无法继续推进。mx-coder 让你通过 Mattermost 等 IM 远程继续使用同一个会话，回到终端后再无缝接续。

## 核心特性

- **终端原生体验**：`attach` 时直接进入 Claude Code，不加中间代理层
- **IM 常驻会话 worker**：每个活跃 session 维护一个常驻 Claude 进程，后续消息连续写入同一 stdin
- **终端优先与接管**：终端占用时，IM 普通消息会被拒绝；可通过 takeover 请求或强制接管
- **多会话并行**：同时管理多个独立 session
- **IM 原生命令穿透**：支持通过 `//<cmd>` 把原生命令透传给底层 coder CLI
- **Mattermost 连接自愈**：WebSocket 具备应用层活性检测与主动重连
- **清晰的运行态语义**：区分 `cold / ready / running / waiting_approval / attached_terminal` 等状态
- **插件化扩展**：支持扩展不同 IM 平台与不同 coder CLI

## 快速开始

```bash
mx-coder start
mx-coder create bug-fix --workdir ~/myapp
mx-coder attach bug-fix
```

### 典型流程

```bash
# 启动后台服务
mx-coder start

# 创建命名会话
mx-coder create bug-fix --workdir ~/myapp

# 终端交互
mx-coder attach bug-fix

# IM 远程交互
# `/open <name>` 会根据 Mattermost `spaceStrategy`：
# - thread：定位或创建 thread
# - channel：通过主 channel 索引入口定位或创建独立 private channel
# attached 时 IM 普通消息会被拒绝，并提示使用 takeover

# 回到终端继续
mx-coder attach bug-fix
```

## Shell Completion

mx-coder 支持：
- `mx-coder completion bash`
- `mx-coder completion zsh`
- `mx-coder completion sessions`

### Bash

将以下内容加入 `~/.bashrc`：

```bash
eval "$(mx-coder completion bash)"
```

然后执行：

```bash
source ~/.bashrc
```

### Zsh

将以下内容加入 `~/.zshrc`：

```bash
eval "$(mx-coder completion zsh)"
```

然后执行：

```bash
source ~/.zshrc
```

## 配置

### Mattermost

创建 `~/.mx-coder/config.json`：

```json
{
  "im": {
    "mattermost": {
      "url": "https://mattermost.example.com",
      "token": "your-bot-token",
      "channelId": "channel-id",
      "spaceStrategy": "thread",
      "reconnectIntervalMs": 5000
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `url` | Mattermost 服务器地址 |
| `token` | Bot 的 Personal Access Token |
| `channelId` | 监听消息的主频道 ID |
| `spaceStrategy` | 新 session 的会话空间策略：`thread`（默认）或 `channel` |
| `teamId` | 当 `spaceStrategy=channel` 时必填，用于创建 private channel |
| `reconnectIntervalMs` | WebSocket 重连间隔，默认 5000ms |

## 系统服务（systemd user service）

当前已具备：
- `mx-coder setup systemd --user --dry-run`：预览将生成的 user service unit
- `mx-coder setup systemd --user`：执行 user service 安装主路径
- `mx-coder setup systemd --user --status`：查看 user service 状态
- `mx-coder setup systemd --user --uninstall`：卸载 user service
- passthrough `//<cmd>`：IM 可将原生命令透传到底层 coder CLI

当前尚未完全闭环：
- repair 仍以状态字段与文档提示为主，尚未扩成独立 CLI 子动作

如需在本机手动接入，可参考 `docs/DEV-OPS.md` 中的 systemd 章节。

## 文档索引

### 使用者文档

- [docs/SPEC.md](docs/SPEC.md) — 当前设计规格与核心行为真值
- [docs/RESEARCH.mattermost-typing-semantics.md](docs/RESEARCH.mattermost-typing-semantics.md) — Mattermost typing 官方语义核对

### 开发者文档

- [docs/DEV-OPS.md](docs/DEV-OPS.md) — 开发、测试、打包与发布
- [docs/CLAUDE-CODE-MCP-PERMISSION.md](docs/CLAUDE-CODE-MCP-PERMISSION.md) — Claude Code MCP permission 协议
- [docs/STATE-INVARIANTS.md](docs/STATE-INVARIANTS.md) — 状态不变量护栏
- [docs/EVENT-SEMANTICS.md](docs/EVENT-SEMANTICS.md) — 事件语义护栏
- [docs/TODO.md](docs/TODO.md) — 当前未完成事项
- [docs/MATTERMOST-GAPS.md](docs/MATTERMOST-GAPS.md) — Mattermost 方向剩余差距
- [docs/IMPL-SLICES.md](docs/IMPL-SLICES.md) — 当前实现切片入口
- [docs/IMPL-SLICES.p1-p3-stabilization.md](docs/IMPL-SLICES.p1-p3-stabilization.md) — 当前未完成主线任务的 TDD 切片
- [docs/IMPL-SLICES.v2.1.md](docs/IMPL-SLICES.v2.1.md) — v2.1 新需求的 TDD 切片

### 历史与归档

- [docs/archive/](docs/archive/) — 历史阶段文档与归档材料

## 项目状态

当前主线已完成 resident IM worker、shell completion、TUI 基础能力，以及 Mattermost thread/channel 空间策略的当前规划范围实现。

当前仍需继续推进的事项见 [docs/TODO.md](docs/TODO.md)。

## 致谢

致谢 [claude-threads](https://github.com/anneschuth/claude-threads)，本项目在产品理念与架构设计上深受其启发。
