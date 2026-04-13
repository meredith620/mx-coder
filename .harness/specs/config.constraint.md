---
# HARNESS METADATA
# type: constraint
# part-of: harness-architecture
# scope: configuration
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---

# 配置变更规范

> **适用于:** 任何修改 OpenClaw 配置的变更
> 
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## 核心原则

**配置变更是高风险操作，必须遵循事务性流程。**

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  验证配置    │ → │  Git 快照   │ → │  尝试应用   │ → │  确认/回滚   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     失败 → 返回错误         失败 → Safe Mode
```

## 配置变更流程

### 1. 配置验证

**必须检查项:**

```rust
// hull/src/validation.rs
pub fn validate_config(config: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    
    // 1. 基本结构
    if !config.is_object() {
        errors.push("配置必须是 JSON 对象".to_string());
        return Err(errors);
    }
    
    // 2. 必填字段
    let required = ["gateway", "models", "channels"];
    for field in &required {
        if config.get(field).is_none() {
            errors.push(format!("缺少必填字段: {}", field));
        }
    }
    
    // 3. 类型检查
    if let Some(port) = config.pointer("/gateway/port") {
        match port.as_u64() {
            Some(n) if n >= 1 && n <= 65535 => {}
            _ => errors.push("gateway.port 必须是 1-65535 的整数".to_string()),
        }
    }
    
    // 4. 交叉引用检查
    // channels 引用的 model 必须存在
    // ...
    
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
```

### 2. Git 快照

**变更前必须保存当前配置到 Git：**

```rust
// 标准流程
let current = config_manager.read_config().await?;
config_manager.save_config(&current).await?;  // git add + commit
```

**Git commit 规范:**
- 作者: `Claw One <dev@claw.one>`
- 消息: `Config update at 2026-03-27T10:30:00+08:00`
- 保留近 100 个提交

### 3. 应用与验证

```rust
// 原子性操作序列
async fn apply_config_transaction(config: Value) -> Result<(), Error> {
    // 1. 停止 OpenClaw
    runtime.stop().await?;
    
    // 2. 写入新配置
    fs::write(config_path, config.to_string()).await?;
    
    // 3. 启动 OpenClaw
    runtime.start().await?;
    
    // 4. 健康检查（30s 超时）
    tokio::time::timeout(Duration::from_secs(30), async {
        while !runtime.health().await {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }).await?;
    
    Ok(())
}
```

### 4. Safe Mode 触发

**以下情况进入 Safe Mode:**
- 配置验证失败
- OpenClaw 启动失败
- 健康检查超时
- 健康检查返回非 200

**Safe Mode 行为:**
- 锁定配置 API（只读）
- 提供三个选项给用户:
  1. 继续编辑配置（修复错误）
  2. 回滚到上一版本
  3. 恢复出厂设置

## 手动修改配置的禁止

⛔ **绝对禁止:**
- 直接编辑 `~/.openclaw/openclaw.json`
- 绕过 claw-one API 修改配置
- 在 Safe Mode 期间强制提交配置

✅ **正确方式:**
- 通过 Web UI 表单修改
- 通过 claw-one REST API 修改
- 开发测试时使用 `hull/config.dev.toml`

## 配置备份

**快照存储位置:**
```
~/.config/claw-one/
├── config.git/              # Git 仓库（自动管理）
├── factory-config.json      # 出厂配置备份
└── openclaw.json -> ~/.openclaw/openclaw.json  # 当前配置链接
```

**回滚命令:**
```bash
# 通过 API
curl -X POST http://localhost:8080/api/rollback \
  -H "Content-Type: application/json" \
  -d '{"version": "abc123"}'

# 或直接 Git 操作（不推荐，仅应急）
cd ~/.config/claw-one/config.git
git checkout abc123 -- openclaw.json
```

## 环境区分

| 环境 | 配置位置 | 操作方式 |
|------|----------|----------|
| 开发 | `hull/config.dev.toml` | 手动编辑 |
| 测试 | 临时目录 | 通过 API |
| 生产 | `~/.openclaw/openclaw.json` | 必须通过 claw-one |
