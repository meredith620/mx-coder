---
# HARNESS METADATA
# type: specification
# part-of: harness-architecture
# scope: harness-maintenance
# managed-by: harness-system
# version: 1.0
# created: 2026-04-01
# updated: 2026-04-13
---

# Harness 演进规范

> **适用于:** 修改任何 Harness 架构文件
>
> ⚠️ **HARNESS 文件**: 本文

档属于 Harness 架构，修改需谨慎

## 何时需要修改 Harness

Harness 不是一成不变的，以下情况**应该**修改：

| 场景 | 示例 | 操作 |
|------|------|------|
| 技术栈变更 | 从 JavaScript 切换到 TypeScript（已完成） | 更新 `specs/*.md` |
| 架构演进 | 从单文件拆分为多模块 | 更新 `specs/architecture.constraint.md` |
| 新增约束 | 引入新的代码规范 | 在对应 `.constraint.md` 添加 |
| 流程优化 | 改进 CI/CD 流程 | 更新 `specs/release.spec.md` |
| 修复漏洞 | 发现架构验证漏洞 | 更新 `.harness/guards/` |

## 修改 Harness 的流程（原子提交）

```
1. 识别需求
   ↓ 确认这是 Harness 层面的变更，而非业务功能
2. 创建分支
   ↓ git checkout -b harness/update-testing-spec
3. 修改文件
   ↓ 遵循本文档的格式要求
4. 更新版本
   ↓ 修改 harness.yaml 中的 version
5. 更新元数据
   ↓ 修改文件的 HARNESS METADATA 头部
6. 本地验证
   ↓ 运行 ./.harness/scripts/validate-arch.sh
7. 提交（必须原子提交）
   ↓ git add .harness/ AGENTS.md harness.yaml
   ↓ git commit -m "harness: update testing spec for Vitest"
8. Review
   ↓ 建议 PR review，尤其是架构变更
9. 合并
   ↓ 更新 AGENTS.md 中的 Last Updated
```

## 原子提交原则

### 什么是原子提交

一个提交应该：
- **只做一件事** - 所有变更服务于同一个逻辑目的
- **可独立回滚** - 回滚不会意外影响其他功能
- **可独立审查** - 审查者能完整理解变更意图

### 错误示例（非原子提交）

```bash
# ❌ 错误：混合不相关变更
git add .
git commit -m "update"
# 包含了：Harness更新 + 架构修复 + README修改 + 测试文件
```

### 正确示例（原子提交）

```bash
# ✅ 正确：Harness 变更单独提交
git add .harness/ AGENTS.md harness.yaml
git commit -m "harness: adapt to mm-coder TypeScript project

- Rewrite specs/architecture.constraint.md for Node.js/TypeScript
- Replace Rust test patterns with Vitest patterns
- Add IPC/plugin system specification
- Update guards for mm-coder file layout"

# ✅ 正确：源代码变更单独提交
git add src/session-registry.ts tests/unit/session-registry.test.ts
git commit -m "feat(session): add SessionRegistry.create() and state machine"
```

## 文件格式规范

### HARNESS METADATA 头部

每个 Harness 文件必须包含以下 YAML 头部：

```yaml
---
# HARNESS METADATA
# type: [entry-point|specification|constraint|script|manifest|rule]
# part-of: harness-architecture
# scope: [api-development|configuration|architecture|testing|release|...]
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---
```

### 类型说明

| type | 用途 | 示例 |
|------|------|------|
| `entry-point` | Agent 入口文档 | AGENTS.md |
| `specification` | 开发规范 | testing.spec.md |
| `constraint` | 架构约束 | architecture.constraint.md |
| `script` | Harness 脚本 | *.sh |
| `manifest` | 配置文件 | harness.yaml |
| `rule` | 熵防护规则 | *.rule |

## 禁止的操作

⛔ **永远不要：**
- 在没有明确需求的情况下修改 Harness
- 为单个业务功能创建专门的 Harness 文件
- 在 Harness 中硬编码项目特定的实现细节（应保持通用化）
- 删除没有替代方案的旧约束

---
*本文档是 Harness 的元规范 —— 规范如何修改规范本身。*
