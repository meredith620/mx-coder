# mx-coder (Multi-modal Coder)

AI CLI 会话桥接工具 — 管理多个 AI CLI 会话，支持终端直接交互和 IM 远程交互。

## 解决什么问题

在电脑前用终端操作 Claude Code 等 AI CLI 工具时体验很好，但离开电脑后就无法继续推进任务。mx-coder 让你通过 IM（Mattermost 等）远程继续与同一会话交互，回来后在终端无缝衔接。

## 核心特性

- **终端零中间层** — attach 时直接运行 AI CLI，体验与原生完全一致
- **IM 常驻会话 worker** — 每个活跃 IM session 维护一个常驻 Claude 进程，后续消息通过 stdin 连续投递
- **终端优先 + 接管** — 终端 attach 时 IM 普通消息会被拒绝，可用 takeover 请求或强制接管
- **多会话并行** — 同时管理多个独立会话，终端和 IM 各自操作
- **Mattermost 连接自愈** — WebSocket 需做应用层活性检测与主动重连，避免“TCP 恢复但订阅逻辑已断”的假活状态
- **状态与 typing 语义清晰** — 区分 `cold / ready / running / waiting_approval / attached_terminal` 等运行态，并仅在真正 `running` 时发送 typing 提示
- **插件化扩展** — IM 端（Mattermost / Slack / Discord）和 CLI 端（Claude Code / Codex / Gemini）均可通过插件扩展

## 使用流程

```bash
mx-coder start                              # 启动后台服务（一次性）
mx-coder create bug-fix --workdir ~/myapp   # 创建命名会话

# 终端交互（原生体验）
mx-coder attach bug-fix                     # 直接进入 Claude Code
# ... 正常工作 ...
# 退出 Claude Code = 释放会话

# IM 远程交互
# `/open <name>` 会根据当前配置的 Mattermost `spaceStrategy`：
# - `thread`：定位或创建 thread
# - `channel`：通过主 channel 索引入口定位或创建独立 **private channel**
# `channel` 是 Mattermost 的可选模式，不替代默认 `thread`
# session 首次被 IM 使用时，daemon 懒启动一个常驻 Claude worker
# 后续消息都会写入同一个 worker 的 stdin
# attached 时 IM 普通消息会被拒绝，并提示使用 `/takeover <name>`
# `/takeover <name>` 请求终端释放；`/takeover-force <name>` 立即接管

# 回到终端
mx-coder attach bug-fix                     # 再次进入，自动 resume
```

## Shell Completion

mx-coder 已支持：
- `mx-coder completion bash`：输出 bash 补全脚本
- `mx-coder completion zsh`：输出 zsh 补全脚本
- `mx-coder completion sessions`：输出当前可补全的 session 名（供 shell completion 内部调用）

### Bash

将以下内容加入 `~/.bashrc`：

```bash
eval "$(mx-coder completion bash)"
```

保存后执行：

```bash
source ~/.bashrc
```

### Zsh

将以下内容加入 `~/.zshrc`：

```bash
eval "$(mx-coder completion zsh)"
```

保存后执行：

```bash
source ~/.zshrc
```

说明：
- 当前 T1/T2 已支持静态子命令补全，以及通过 `completion sessions` 获取动态 session 名
- `eval "$(mx-coder completion bash)"` / `eval "$(mx-coder completion zsh)"` 用于安装补全脚本
- 安装后 `attach/open/status/remove/diagnose/takeover-status/takeover-cancel` 会动态补全 session 名
- `completion sessions` 输出的是 session 名列表，供补全脚本内部调用，不应直接用于 `eval`

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
| `channelId` | 监听消息的频道 ID |
| `spaceStrategy` | 新 session 的 Mattermost 会话空间策略：`thread`（默认）或 `channel`；`channel` 通过主 channel 作为统一索引入口并默认创建 private channel；仅影响未来新建的 session |
| `teamId` | 当 `spaceStrategy=channel` 时必填，用于创建 private channel |
| `reconnectIntervalMs` | WebSocket 重连间隔（可选，默认 5000ms） |

## 插件开发

当前默认插件：
- 默认 CLI 插件：`claude-code`
- 默认 IM 插件：`mattermost`

扩展方式：
- 新增 CLI 插件：实现 `src/plugins/types.ts` 中的 `CLIPlugin`，并注册到 `src/plugins/cli/registry.ts`
- 新增 IM 插件：实现 `src/plugins/types.ts` 中的 `IMPlugin`，并注册到 `src/plugins/im/registry.ts`

更完整的开发与发布说明见 [docs/DEV-OPS.md](docs/DEV-OPS.md)。

## 架构

Session-based 混合方案：

- **终端**：CLI 插件负责构造 attach 命令，默认实现为 `claude --resume <id>` / `claude --session-id <id>`
- **IM**：daemon 为每个活跃 session 维护一个常驻 `claude -p --input-format stream-json --output-format stream-json` worker，消息经队列串行后写入同一个 worker 的 stdin
- **流式输出**：daemon 持续消费 worker stdout 事件流，并把增量内容回传到 IM thread
- **运行态**：设计上区分 `cold / ready / running / waiting_approval / attached_terminal / takeover_pending / recovering / error`，不再简单等同于 session status
- **typing 提示**：作为 `runtimeState=running` 的派生行为，仅在真正执行中按节流发送
- **连接健壮性**：Mattermost WebSocket 通过应用层活性检测与主动重连维持长期稳定

详见 [docs/SPEC.md](docs/SPEC.md)。

## 致谢

致谢 [claude-threads](https://github.com/anneschuth/claude-threads) -- 本项目在产品理念与架构设计上都深受其启发。

## 技术栈

- TypeScript / Node.js
- 插件系统：IM Plugin + CLI Plugin 接口

## 项目状态

设计收敛中：文档已切换到“常驻 IM worker”方案，代码实现将在下一阶段推进。详见：

- [docs/IMPL-SLICES.md](docs/IMPL-SLICES.md) — 当前实现切片入口
- [docs/STATE-INVARIANTS.md](docs/STATE-INVARIANTS.md) — 状态不变量护栏
- [docs/EVENT-SEMANTICS.md](docs/EVENT-SEMANTICS.md) — 事件语义护栏
- [docs/MATTERMOST-GAPS.md](docs/MATTERMOST-GAPS.md) — Mattermost 当前实现与目标设计的差距清单
- [docs/TODO.md](docs/TODO.md) — 待解决问题清单
