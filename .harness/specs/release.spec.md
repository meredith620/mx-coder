---
# HARNESS METADATA
# type: specification
# part-of: harness-architecture
# scope: release
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---

# 发布构建规范

> **适用于:** 版本发布、分发包构建、安装脚本修改
>
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## 构建命令

### 开发构建

```bash
# 类型检查 + 编译
npm run build        # tsc --noEmit && tsc

# 仅类型检查
npm run check        # tsc --noEmit

# 本地开发（监听变化）
npm run dev          # ts-node src/index.ts

# 单元测试 + 集成测试
npm test             # vitest run
```

### 分发构建

```bash
# 完整分发包
npm run dist
# 输出: dist/mm-coder-{VERSION}-{OS}-{ARCH}.tar.gz

# 包含安装脚本
npm run dist:install
# 输出: dist/mm-coder-{VERSION}-{ARCH}-install.sh
```

## 版本管理

### 版本号规则

使用语义化版本：`MAJOR.MINOR.PATCH`

| 版本变化 | 说明 |
|----------|------|
| MAJOR | 不兼容的 API 变更 |
| MINOR | 向后兼容的功能添加 |
| PATCH | 向后兼容的问题修复 |

### 版本标记

```bash
# 1. 更新版本号（package.json）
# 编辑 package.json: version = "0.2.0"

# 2. 提交
git add -A
git commit -m "bump version to 0.2.0"

# 3. 打标签
git tag -a v0.2.0 -m "Release version 0.2.0"
git push origin v0.2.0
```

### 版本获取

```makefile
VERSION := $(shell node -p "require('./package.json').version")
# 0.2.0
```

## 分发包内容

```
mm-coder-{VERSION}-{OS}-{ARCH}.tar.gz
├── bin/
│   └── mm-coder            # CLI 可执行文件
├── share/
│   └── config/
│       └── config.yaml.template  # 配置模板
├── scripts/
│   ├── install.sh          # 安装脚本
│   └── uninstall.sh        # 卸载脚本
└── README.md               # 说明文档
```

## 安装脚本规范

### 安装流程

```bash
# install.sh
1. 检测环境依赖 (check-env.sh)
   - Node.js >= 20 是否可用
   - 端口是否被占用
   - 磁盘空间

2. 创建目录结构
   ~/.config/mm-coder/
   ├── bin/mm-coder
   └── sessions.json

3. 复制文件

4. 创建 systemd 用户服务（可选）
   ~/.config/systemd/user/mm-coder.service

5. 提示用户编辑配置
```

### 安装路径

| 路径 | 用途 | 说明 |
|------|------|------|
| `~/.config/mm-coder/` | 配置目录 | 用户级，无需 root |
| `~/.config/mm-coder/sessions.json` | Session 元数据 | daemon 管理 |
| `~/.config/systemd/user/` | 服务配置 | systemd 用户服务（可选）|

### 检查脚本

```bash
# scripts/check-env.sh 必须检查:
- [ ] Node.js >= 20 可用
- [ ] npm 可用
- [ ] 磁盘空间 > 50MB
```

## 发布检查清单

发布新版本前必须确认：

- [ ] 版本号已更新（`package.json`）
- [ ] `npm run check` 无错误
- [ ] `npm test` 全部通过
- [ ] `npm run dist` 成功
- [ ] 安装脚本在新环境测试通过
- [ ] Git tag 已打并推送

## 升级兼容性

### 配置迁移

```typescript
// src/config/index.ts
export async function migrateConfig(config: Config): Promise<Config> {
  const version = config.version ?? '0.1.0';

  if (compareVersions(version, '0.2.0') < 0) {
    // 从 0.1.x 迁移到 0.2.x
    config = migrateV01ToV02(config);
  }

  config.version = packageJson.version;
  return config;
}
```
