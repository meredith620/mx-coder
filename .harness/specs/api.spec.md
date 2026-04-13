---
# HARNESS METADATA
# type: specification
# part-of: harness-architecture
# scope: api-development
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
---

# API 开发规范

> **适用于:** API 端点新增/修改/删除
> 
> ⚠️ **HARNESS 文件**: 本文档属于 Harness 架构，修改需谨慎

## API 设计原则

### 1. RESTful 风格

```rust
// ✅ 正确: 资源路径 + HTTP 方法
GET    /api/config          // 读取配置
POST   /api/config          // 应用配置
GET    /api/snapshots       // 列出快照
POST   /api/rollback        // 回滚到版本

// ❌ 错误: 动作在路径中
POST   /api/config/get
POST   /api/config/update
```

### 2. 统一响应格式

```rust
// 成功响应
#[derive(Serialize)]
struct ApiResponse<T> {
    success: bool,      // true
    data: T,
}

// 错误响应  
#[derive(Serialize)]
struct ApiError {
    success: bool,      // false
    error: String,      // 用户友好的错误信息
    code: Option<String>, // 错误码（可选）
}
```

### 3. 状态码使用

| 状态码 | 使用场景 |
|--------|----------|
| 200 OK | GET/POST 成功 |
| 201 Created | 资源创建成功 |
| 400 Bad Request | 参数验证失败 |
| 404 Not Found | 资源不存在 |
| 409 Conflict | 资源冲突（如重复ID）|
| 500 Internal Server Error | 服务器内部错误 |

### 4. Axum 路由模式

```rust
// hull/src/api/mod.rs
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health_check))
        .route("/config", get(get_config).post(apply_config))
        .route("/snapshots", get(list_snapshots))
        .route("/rollback", post(rollback))
}

// handler 签名
async fn handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RequestType>,  // 对于 POST
) -> Result<Json<ResponseType>, ApiError>
```

## 新增 API 端点的步骤

1. **在 `hull/src/api/` 添加 handler**
   ```rust
   // hull/src/api/config.rs
   pub async fn new_endpoint(
       State(state): State<Arc<AppState>>,
   ) -> Result<Json<Value>, ApiError> {
       // 实现逻辑
   }
   ```

2. **注册路由**
   ```rust
   // hull/src/api/mod.rs
   .route("/new-endpoint", get(new_endpoint))
   ```

3. **添加集成测试**
   ```rust
   // hull/tests/api_new_feature.rs
   #[tokio::test]
   async fn test_new_endpoint() {
       let server = TestServer::new().await;
       let response = server.get("/api/new-endpoint").await;
       assert_eq!(response.status(), 200);
   }
   ```

4. **更新 API 文档**（如有）

## 配置相关 API 特殊要求

任何修改配置的 API 必须：

1. **先验证配置** - 调用 `validation::validate_config()`
2. **写 Git 快照** - 调用 `config_manager.save_config()`
3. **尝试应用** - 重启 OpenClaw 服务
4. **健康检查** - 等待确认服务正常
5. **失败回滚** - 如失败进入 Safe Mode

```rust
pub async fn apply_config(
    State(state): State<Arc<AppState>>,
    Json(config): Json<Value>,
) -> Result<Json<ConfigResponse>, ApiError> {
    // 1. 验证
    validation::validate_config(&config)?;
    
    // 2. 写 Git 快照（保存当前配置）
    state.config_manager.save_config(&current_config).await?;
    
    // 3. 写入新配置
    state.config_manager.write_config(&config).await?;
    
    // 4. 尝试应用
    match state.runtime.restart().await {
        Ok(_) => {
            // 5a. 成功：commit 快照
            state.config_manager.commit_snapshot("Config update").await?;
            Ok(Json(ConfigResponse { success: true }))
        }
        Err(e) => {
            // 5b. 失败：进入 Safe Mode
            state.state_manager.enter_safe_mode(e).await?;
            Err(ApiError::safe_mode(e))
        }
    }
}
```

## 错误处理规范

```rust
// ✅ 正确: 使用 thiserror 定义具体错误
#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("配置验证失败: {0}")]
    ValidationError(String),
    #[error("Git 操作失败: {0}")]
    GitError(#[from] git2::Error),
    #[error("IO 错误: {0}")]
    IoError(#[from] std::io::Error),
}

impl IntoResponse for ConfigError {
    fn into_response(self) -> Response {
        let status = match &self {
            ConfigError::ValidationError(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}
```

## 测试要求

新增 API 必须包含：
- [ ] 正常路径测试（happy path）
- [ ] 参数验证测试（无效输入）
- [ ] 错误场景测试（资源不存在等）
- [ ] 如需认证，包含未认证访问测试
