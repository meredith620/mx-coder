# mm-coder 开发运维手册

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
mm-coder --help
```

### 使用 npm link（开发迭代时更方便）

```bash
npm link
```

修改源码后重新 `npm run build`，`mm-coder` 命令即反映最新构建结果。

### 卸载本地安装

```bash
npm uninstall -g mm-coder
# 或
npm unlink
```

---

## 开发模式运行 Daemon

```bash
# 直接用 tsx（无需编译）
npm run daemon
# 等价于：tsx src/daemon.ts
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

   若发布 scoped 包（如 `@org/mm-coder`），需加 `--access public`：

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
npm install -g mm-coder
```

验证：

```bash
mm-coder --help
```

---

## 常见问题

**Q: 编译后执行 `mm-coder` 报 `ERR_UNKNOWN_FILE_EXTENSION`**

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
