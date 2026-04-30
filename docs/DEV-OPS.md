# mx-coder 开发运维手册

## 环境要求

- Node.js >= 20
- npm >= 10
- TypeScript 5.5+（已包含在 devDependencies）

---

## 打包编译

```bash
# 安装依赖
npm install

# 编译 TypeScript → dist/
npm run build

# 仅做类型检查（不输出文件）
npm run check
```

编译结果输出到 `dist/`，入口为 `dist/index.js`。

---

## 本地安装与调试

### 全局安装（推荐用于验证 CLI 命令）

```bash
# 编译后全局安装
npm run build
npm install -g .

# 验证
mx-coder --help
```

### 使用 npm link（开发迭代时更方便）

```bash
npm link
```

修改源码后重新 `npm run build`，`mx-coder` 命令即反映最新构建结果。

### Shell completion 安装

#### Bash

```bash
# 生成并加载 mx-coder bash completion
eval "$(mx-coder completion bash)"

# 若希望每次打开 shell 自动生效，可写入 ~/.bashrc
echo 'eval "$(mx-coder completion bash)"' >> ~/.bashrc
source ~/.bashrc
```

#### Zsh

```bash
# 生成并加载 mx-coder zsh completion
eval "$(mx-coder completion zsh)"

# 若希望每次打开 shell 自动生效，可写入 ~/.zshrc
echo 'eval "$(mx-coder completion zsh)"' >> ~/.zshrc
source ~/.zshrc
```

#### 动态 session 名补全说明

```bash
mx-coder completion sessions
```

该命令用于输出当前 daemon 中可补全的 session 名，供 shell completion 内部调用；无 session 时输出为空且不报错。

## 3. Systemd 集成

为了确保 `mx-coder daemon` 在后台稳定运行并随系统自启，建议使用 systemd user 模式。

### 3.1 当前状态

当前已实现：
- `mx-coder setup systemd --user --dry-run`：输出 systemd user service unit 预览
- `mx-coder setup systemd --user`：执行 user service 写入、`daemon-reload` 与 `enable --now`
- `mx-coder setup systemd --user --status`：输出 user service 当前状态
- `mx-coder setup systemd --user --uninstall`：卸载 user service 并 reload
- user service 文件落盘规则与幂等更新逻辑已具备底层实现
- passthrough `//<cmd>` 已可在 IM 路由到底层 coder CLI

当前尚未完全闭环：
- repair 建议仍主要以底层 status 字段与文档说明形式存在，尚未扩成更完整的 CLI repair 子命令

### 3.2 手动服务模板 (mx-coder.service)

```ini
[Unit]
Description=mx-coder Daemon
After=network.target

[Service]
Type=simple
ExecStart=%h/.nvm/versions/node/v20.x.x/bin/mx-coder start-fg
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

### 3.3 手动安装步骤

1. 将 service 文件写入 `~/.config/systemd/user/mx-coder.service`
2. 根据本机实际安装位置，把 `ExecStart` 调整为可用的 `mx-coder` 启动命令
3. 执行 `systemctl --user daemon-reload`
4. 执行 `systemctl --user enable --now mx-coder`

### 3.4 常用操作

- **查看日志**：`journalctl --user -u mx-coder -f`
- **重启服务**：`systemctl --user restart mx-coder`
- **查看状态**：`systemctl --user status mx-coder`

当 `mx-coder setup systemd` 的完整 CLI 控制面（install/status/uninstall）收口后，这一节应改回自动配置优先、手动步骤作为 fallback。

### 卸载本地安装

```bash
npm uninstall -g mx-coder
# 或
npm unlink
```

---

## 插件开发

### CLI 插件

1. 实现 `src/plugins/types.ts` 中的 `CLIPlugin`
2. 必须提供以下 3 个能力：
   - `buildAttachCommand(session)`
   - `buildIMWorkerCommand(session, bridgeScriptPath)`
   - `generateSessionId()`
3. 如需兼容旧的单条消息路径，可额外实现 `LegacyIMMessageCLIPlugin.buildIMMessageCommand(session, prompt)`，但当前主链不应依赖它
4. 在 `src/plugins/cli/registry.ts` 注册插件工厂
5. 如需作为默认插件，修改 registry 中的默认插件常量

当前默认 CLI 插件名：`claude-code`

### IM 插件

1. 实现 `src/plugins/types.ts` 中的 `IMPlugin`
2. 在 `src/plugins/im/registry.ts` 注册工厂
3. 工厂需提供：
   - `load(configPath, opts)`
   - `getDefaultConfigPath()`
   - `writeConfigTemplate(configPath)`
   - `verifyConnection(configPath)`
   - `getCommandHelpText()`
4. `IncomingMessage.plugin` 必须稳定标识该 IM 插件名，供 daemon 做动态路由

当前默认 IM 插件名：`mattermost`

### 当前插件接口约束

- `buildAttachCommand()` 必须返回可直接进入交互式会话的命令
- `buildIMWorkerCommand()` 用于常驻 IM worker，不是单次 prompt 命令
- `sendMessage()` / `createLiveMessage()` / `updateMessage()` 必须尊重 `MessageTarget.threadId/channelId`
- 若平台支持独立 channel 型会话空间，可实现可选能力 `createChannelConversation()`
- 若平台支持交互式审批，可实现可选能力 `addReactions()` / `listReactions()`
- 若平台支持 typing，可实现可选能力 `sendTyping()`
- `disconnect()` 必须幂等，daemon 停止时会统一调用

### 动态路由约束

- daemon 创建 IM session 时，`session.cliPlugin` 使用默认 CLI 插件名
- dispatcher 发送 IM 消息时，应按 `session.cliPlugin` 动态解析 CLI 插件
- `/help`、`/list`、`/status`、`/open` 处理时，应使用 `IncomingMessage.plugin` 做 IM 路由，不得写死 `mattermost`
- `/open` 已绑定场景下，锚点消息应发送到该 binding 自身的 `channelId/threadId`

---

## 开发模式运行 Daemon

```bash
# 直接用 tsx（无需编译）
npm run daemon
# 等价于：tsx src/daemon.ts
```

### 开发包本地安装

```
npm run build
npm pack
npm install -g mx-coder-x.y.z.tgz
```
---

## 测试

```bash
# 全量运行
npm test

# 仅单元测试
npm run test:unit

# 仅集成测试
npm run test:integration

# 监视模式（TDD 开发时使用）
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

建议在改动插件架构后至少补跑：

```bash
npx vitest run tests/unit/cli-plugin-registry.test.ts tests/unit/im-plugin-registry.test.ts tests/integration/im-routing.test.ts tests/e2e/cli-e2e.test.ts
```

---

## 发布到 npm

1. **确认版本号**

   ```bash
   # 修改 package.json 中的 version 字段，遵循 SemVer
   # 或使用 npm version 命令
   npm version patch   # 0.1.0 → 0.1.1
   npm version minor   # 0.1.0 → 0.2.0
   npm version major   # 0.1.0 → 1.0.0
   ```

2. **构建并验证**

   ```bash
   npm run build
   npm run check
   npm test
   ```

3. **预检发布内容**

   ```bash
   npm pack --dry-run
   ```

   确认只包含 `dist/`、`package.json`、`README.md`、`LICENSE` 等必要文件（`src/`、`tests/`、`node_modules/` 不应包含在内）。如需排除，在 `package.json` 中添加 `"files"` 字段：

   ```json
   "files": ["dist", "README.md"]
   ```

4. **登录 npm 并发布**

   ```bash
   npm login
   npm publish
   ```

   若发布 scoped 包（如 `@org/mx-coder`），需加 `--access public`：

   ```bash
   npm publish --access public
   ```

5. **打 Git tag**

   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push --tags
   ```

---

## 终端用户安装

```bash
npm install -g mx-coder
```

验证：

```bash
mx-coder --help
```

---

## 常见问题

**Q: 编译后执行 `mx-coder` 报 `ERR_UNKNOWN_FILE_EXTENSION`**

`package.json` 中 `"type": "module"` 要求所有导入使用 `.js` 扩展名。检查 `dist/index.js` 的 shebang：

```
#!/usr/bin/env node
```

如果缺失，在 `src/index.ts` 顶部添加该行。

**Q: `npm link` 后找不到命令**

确认 npm 全局 bin 目录在 `PATH` 中：

```bash
npm bin -g
```

**Q: 测试中 Unix socket 残留导致 `EADDRINUSE`**

`afterEach` 里需要调用 `handler.close()` 并删除 socket 文件。测试已通过临时目录（`fs.mkdtempSync`）隔离，不应出现此问题；若本地环境异常，手动清理 `/tmp/mm-*` 目录。
