# Claude Code 原生命令支持度分析（真实环境验证）

## 验证环境

- **主机**: 10.10.10.88
- **Claude Code 版本**: 2.1.100
- **验证方法**: `ssh 10.10.10.88 "source ~/.nvm/nvm.sh && printf '/<command>\n' | claude -p"`

## Passthrough 机制

mx-coder 通过 `//<cmd>` 语法透传命令给 Claude Code：

```
IM 消息: //compact
   ↓ daemon.ts:317-373
剥离一个 / → /compact
   ↓ 发送到 Claude Code 管道模式
Claude Code 处理并返回结果
```

**关键限制**：mx-coder 无法控制 Claude Code 是否支持某个命令，只负责透传。

---

## 命令验证结果

### ✅ 已确认支持（管道模式下可用）

| 命令 | 验证结果 | 输出示例 |
|------|---------|---------|
| `/cost` | ✅ 正常工作 | `Total cost: $0.0000` |
| `/context` | ✅ 正常工作 | 显示 token 使用统计表格 |
| `/batch` | ✅ 正常工作 | `What batch change would you like to make?` |
| `/loop` | ✅ 正常工作 | 显示用法说明 |
| `/review` | ✅ 正常工作 | `I don't have permission to run gh pr list...` |
| `/init` | ✅ 正常工作 | 后台任务执行 |
| `/debug` | ✅ 正常工作 | 后台任务执行 |
| `/insights` | ✅ 正常工作 | 后台任务执行 |
| `/simplify` | ✅ 正常工作 | 后台任务执行 |
| `/claude-api` | ✅ 正常工作 | 后台任务执行 |

### ❌ 已确认不支持（管道模式下不可用）

| 命令 | 验证结果 | 错误信息 |
|------|---------|---------|
| `/help` | ❌ 不支持 | `Unknown skill: help` |
| `/model` | ❌ 不支持 | `Unknown skill: model` |
| `/effort [level]` | ⚠️ TUI 专用 | 管道模式 `Unknown skill`，TUI 正常 |
| `/skills` | ❌ 不支持 | `Unknown skill: skills` |
| `/plan` | ❌ 不支持 | `Unknown skill: plan` |
| `/status` | ❌ 不支持 | `Unknown skill: status` |
| `/diff` | ❌ 不支持 | `Unknown skill: diff` |
| `/memory` | ❌ 不支持 | `Unknown skill: memory` |
| `/doctor` | ❌ 不支持 | `Unknown skill: doctor` |
| `/recap` | ❌ 不支持 | `Unknown skill: recap` |
| `/btw` | ❌ 不支持 | `Unknown skill: btw` |
| `/model sonnet` | ❌ 不支持 | `Unknown skill: model` |
| `/effort high` | ❌ 不支持 | `Unknown skill: effort` |
| `/security-review` | ❌ 不支持 | (无输出/无响应) |

---

## 验证命令汇总表

| 命令 | 支持状态 | 备注 |
|------|---------|------|
| `/compact` | ⚠️ 无输出 | 可能有响应但无文本输出 |
| `/context` | ✅ 支持 | 有完整表格输出 |
| `/cost` | ✅ 支持 | 有完整统计输出 |
| `/recap` | ❌ 不支持 | Unknown skill |
| `/init` | ✅ 支持 | 后台执行 |
| `/review` | ✅ 支持 | 有交互响应 |
| `/debug` | ✅ 支持 | 后台执行 |
| `/insights` | ✅ 支持 | 后台执行 |
| `/security-review` | ❌ 无响应 | 后台执行但无输出 |
| `/simplify` | ✅ 支持 | 后台执行 |
| `/batch` | ✅ 支持 | 有交互提示 |
| `/loop` | ✅ 支持 | 有用法说明 |
| `/claude-api` | ✅ 支持 | 后台执行 |
| `/help` | ❌ 不支持 | Unknown skill |
| `/model` | ❌ 不支持 | Unknown skill |
| `/effort` | ❌ 不支持 | Unknown skill |
| `/skills` | ❌ 不支持 | Unknown skill |
| `/plan` | ❌ 不支持 | Unknown skill |
| `/status` | ❌ 不支持 | Unknown skill |
| `/diff` | ❌ 不支持 | Unknown skill |
| `/memory` | ❌ 不支持 | Unknown skill |
| `/doctor` | ❌ 不支持 | Unknown skill |
| `/btw` | ❌ 不支持 | Unknown skill |

---

## 需要进一步验证的命令

以下命令在管道模式下可能支持，但需要更深入的测试：

| 命令 | 说明 | 需要验证 |
|------|------|---------|
| `/attach` | 附加终端 | TUI 专用 |
| `/terminal-setup` | 终端配置 | TUI 专用 |
| `/tui` | TUI 渲染器 | TUI 专用 |
| `/focus` | 焦点视图 | TUI 专用 |
| `/fast` | 快速模式 | 需测试 |
| `/remote-control` | 远程控制 | 需测试 |
| `/teleport` | 拉入终端 | 需测试 |
| `/export` | 导出会话 | 需测试 |
| `/rename` | 重命名会话 | 需测试 |
| `/branch` | 创建分支 | 需测试 |
| `/resume` | 恢复会话 | 需测试 |
| `/rewind` | 回退对话 | 需测试 |
| `/tasks` | 后台任务 | 需测试 |
| `/config` | 配置界面 | 需测试 |
| `/theme` | 更改主题 | 需测试 |
| `/keybindings` | 按键绑定 | 需测试 |
| `/hooks` | Hook 配置 | 需测试 |
| `/mcp` | MCP 服务器 | 需测试 |
| `/permissions` | 工具权限 | 需测试 |
| `/plugin` | 插件管理 | 需测试 |
| `/reload-plugins` | 重载插件 | 需测试 |
| `/color` | 提示栏颜色 | 需测试 |
| `/release-notes` | 更新日志 | 需测试 |
| `/copy` | 复制响应 | 需测试 |
| `/feedback` | 提交反馈 | 需测试 |
| `/voice` | 语音听写 | 需测试 |
| `/schedule` | 创建例程 | 需测试 |
| `/mobile` | 移动应用 | 需测试 |
| `/upgrade` | 升级计划 | 需测试 |
| `/exit` | 退出 CLI | 需测试 |

---

## 关键发现

1. **很多 "原生命令" 在管道模式下实际是 `Unknown skill`**
   - `/help`, `/model`, `/effort`, `/skills`, `/plan`, `/status`, `/diff`, `/memory`, `/doctor`, `/recap`, `/btw` 等都不支持

2. **真正支持的命令**（有实际输出）：
   - `/cost` - 会话成本统计
   - `/context` - Token 使用统计
   - `/batch` - 批量操作
   - `/loop` - 循环执行
   - `/review` - 代码审查
   - `/init` - 初始化
   - `/simplify` - 简化代码

3. **部分命令后台执行**，不在 stdout 输出：
   - `/debug`, `/insights`, `/simplify`, `/claude-api`, `/init` 等

4. **TUI 专用命令**（永远不能在管道模式工作）：
   - `/model`, `/effort`, `/fast`, `/attach`, `/terminal-setup`, `/tui`, `/focus`

---

## 建议

mx-coder 文档中列出的 `/recap`, `/security-review` 等命令实际上在管道模式下不支持或无响应。建议更新文档以反映真实情况。