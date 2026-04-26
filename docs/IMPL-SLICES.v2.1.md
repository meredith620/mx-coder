# mx-coder v2.1 TDD 切片

> 本文件覆盖 **v2.1 新增需求**，仅供这一轮开发使用。  
> 当前范围严格限定为两项：
> 1. IM 原生命令穿透（`//<cmd>`）
> 2. `mx-coder setup systemd` 命令

---

## 1. 目标与边界

### V2.1-A 原生命令穿透
让 IM 用户可以通过 `//<cmd>` 将原生命令透传给底层 coder CLI，例如：
- `//effort`
- `//model sonnet`
- `//compact`

但必须满足：
- `//` 只是 **穿透到底层 coder CLI**，不是 mx-coder 控制命令
- `/open`、`/status`、`/takeover` 等 **单斜杠命令** 仍优先解析为 mx-coder 命令
- 权限、审计、恢复语义必须明确

### V2.1-B systemd user service 自动配置
实现 `mx-coder setup systemd`，自动生成并配置 systemd user service，支持开机自启。  
但必须满足：
- 不修改系统级服务，只操作 **user service**
- 明确 install / enable / start / status / uninstall 的边界
- 失败时给出可操作的本地诊断信息

---

## 2. 当前现状复核

### 已有设计真值
- 原生命令穿透需求已在 `docs/SPEC.md` §2.5 定义
- `mx-coder setup systemd` 已在 `docs/TODO.md` 列为未完成项

### 当前代码现状
- 尚未发现 `//<cmd>` 路由实现：需要新增主链
- 尚未发现 `setup systemd` CLI 子命令与实现
- `docs/DEV-OPS.md` 已将 `mx-coder setup systemd --user` 正确标注为“尚未实现”；V5 只需在功能完成后收口运维指引与最终真值

---

## 3. 切片总顺序

本文件包含两条相对独立的子链：

- passthrough 子链：V1 → V2
- systemd 子链：V3 → V4 → V5

`不得跳序` 的含义是：**同一子链内部必须按顺序推进**。两条子链之间没有强制跨链依赖；若当前执行环境允许，可并行安排，但单个 agent 在一个回合内仍应只专注一条子链。

1. **V1 原生命令穿透协议与路由基线**
2. **V2 原生命令穿透权限/审计/恢复闭环**
3. **V3 systemd service 文件生成与 dry-run 基线**
4. **V4 systemd install / status / uninstall 命令闭环**
5. **V5 文档与运维指引收口**

---

## 4. 详细 TDD slices

## V1 — 原生命令穿透协议与路由基线

### V1.1 `//<cmd>` 语法识别与路由
**目标**：让 IM 文本消息中的 `//<cmd>` 正确透传给底层 coder CLI。  
**前置依赖**：无。

**先写测试**
- 新增 `tests/unit/im-passthrough.test.ts`
- `tests/integration/im-routing.test.ts`
- 如需要可补 `tests/e2e/im-message-flow.test.ts`

**测试关注点**
- `//compact` 会被转换为发送给底层 CLI 的 `/compact`
- `//model sonnet` 会被转换为 `/model sonnet`
- `/status` 仍按 mx-coder 控制命令解析，不进入 passthrough
- `//` 必须在 C/D 类单斜杠拦截之前检测，否则会被误拦截为“不支持的命令”
- `///foo`、空命令 `//`、仅空白参数等边界行为清晰可测

**后写实现**
- `src/daemon.ts`（语法识别与命令分支裁决主入口）
- `src/im-message-dispatcher.ts`
- `src/im-worker-manager.ts`
- 必要时新增轻量 helper

**完成判定**
- passthrough 是显式语法分支，不与普通文本/控制命令混淆

---

### V1.2 IM worker 输入真值支持 passthrough
**目标**：确认透传不会被误包装成普通文本任务语义。  
**前置依赖**：V1.1。

**先写测试**
- `tests/unit/im-worker-manager.test.ts`
- `tests/e2e/stdio-im-e2e.test.ts`

**测试关注点**
- 透传命令写入 worker stdin 时，内容是单斜杠原生命令
- 不额外包裹解释性前缀，不污染底层 CLI 语义
- 多条普通文本与 passthrough 混排时，顺序不乱

**后写实现**
- `src/im-worker-manager.ts`
- `src/im-message-dispatcher.ts`
- 必要时扩展消息模型

**完成判定**
- 底层 CLI 接收内容与用户意图一一对应

---

## V2 — 原生命令穿透权限 / 审计 / 恢复闭环

### V2.1 passthrough ACL 与 capability 收口
**目标**：把 `//<cmd>` 纳入 ACL、审批、风险模型。  
**前置依赖**：V1.2，以及主线稳定化文档中与 IM/ACL 相关的 P1 修复（尤其 ACL 三入口真值收口）。

**先写测试**
- 新增 `tests/integration/im-passthrough-acl.test.ts`
- `tests/unit/approval-handler.test.ts`
- `tests/integration/daemon-commands.test.ts`

**测试关注点**
- 仅 `operator` 可发起 passthrough
- passthrough 统一视作至少 `shell_dangerous` 风险，不走 read_only autoAllow
- attached/takeover_pending 状态下 passthrough 与普通 IM 文本一样遵循控制权规则
- 必须覆盖当前 IM 入口 ACL 仍可能不稳的路径，避免 happy-path 掩盖真实权限缺口
- 无权限时零副作用

**后写实现**
- `src/daemon.ts`
- `src/approval-handler.ts`
- `src/acl-manager.ts`
- `src/types.ts`

**完成判定**
- passthrough 不是绕过审批/ACL 的后门

---

### V2.2 passthrough 审计与恢复语义
**目标**：明确 passthrough 在中断、恢复、重放时的行为。  
**前置依赖**：V2.1。

**先写测试**
- 新增 `tests/integration/im-passthrough-recovery.test.ts`
- `tests/integration/persistence.test.ts`

**测试关注点**
- passthrough 消息拥有 dedupeKey，可被去重
- dedupeKey 格式仍遵循主线真值 `<plugin>:<threadId>:<messageId>`，但消息元数据必须额外可识别为 passthrough（例如 `isPassthrough: boolean`）
- daemon 重启后 passthrough 默认不自动 replay，至少需 confirm 或 discard
- 审计能区分 passthrough 与普通文本消息
- replay/confirm/discard 矩阵对 passthrough 有明确保守策略

**后写实现**
- `src/restore-action.ts`
- `src/session-registry.ts`
- `src/persistence.ts`
- `src/daemon.ts`

**完成判定**
- 透传命令不会在恢复时被静默重放

---

## V3 — systemd service 文件生成与 dry-run 基线

### V3.1 CLI 解析与 service spec 生成
**目标**：先生成可验证的 service 文件内容，不急于直接安装。  
**前置依赖**：无。

> 注意：当前 `docs/DEV-OPS.md` 中的手动 systemd 模板只用于说明结构，不应被实现直接照抄为最终 `ExecStart` 真值；最终 service 启动命令应由本切片中的实现与测试收口。

**先写测试**
- 新增 `tests/unit/systemd-setup.test.ts`
- `tests/unit/cli-parser.test.ts`
- `tests/e2e/cli-e2e.test.ts`

**测试关注点**
- 新命令：`mx-coder setup systemd`
- 支持 `--user`（但实现始终只落到 user service，不提供 system-level 变体）
- 支持 `--dry-run`
- 生成的 unit 文件包含稳定 service 名、ExecStart、Restart、WantedBy
- 不写系统级路径，不要求 root

**后写实现**
- `src/cli-parser.ts`
- `src/index.ts`
- 新增 `src/systemd.ts`

**完成判定**
- 用户可先 dry-run 查看将写入的 unit 文件

---

### V3.2 用户目录与文件落盘规则
**目标**：定义 unit 文件写入位置与幂等更新规则。  
**前置依赖**：V3.1。

**先写测试**
- `tests/unit/systemd-setup.test.ts`
- 如需要新增 `tests/integration/systemd-files.test.ts`

**测试关注点**
- unit 文件写入 `~/.config/systemd/user/`
- 重复执行 update 而不是产生多个副本
- 已存在不同内容时可覆盖并提示 reload
- 非 Linux / 无 systemd 场景给出明确错误

**后写实现**
- `src/systemd.ts`
- `src/index.ts`

**完成判定**
- service 文件生成与落盘幂等可测

---

## V4 — systemd install / status / uninstall 闭环

### V4.1 install / enable / start 主路径
**目标**：完成最常用的一键安装路径。  
**前置依赖**：V3.2。

**先写测试**
- 新增 `tests/integration/systemd-install.test.ts`
- `tests/e2e/cli-e2e.test.ts`

**测试关注点**
- 调用顺序：`daemon-reload` → `enable --now`
- 输出清晰的阶段进度与结果
- 失败时暴露具体 systemctl 错误

**后写实现**
- `src/systemd.ts`
- `src/index.ts`

**完成判定**
- `mx-coder setup systemd --user` 主路径闭环完成

---

### V4.2 status / uninstall / repair 语义
**目标**：避免只做 install，后续无法诊断或卸载。  
**前置依赖**：V4.1。

**先写测试**
- `tests/integration/systemd-install.test.ts`
- 新增 `tests/unit/systemd-status.test.ts`

**测试关注点**
- 可查询 unit 是否存在、是否 enabled、是否 active
- uninstall 仅移除 user service，不动业务数据
- service 文件存在但失配时，给出 repair 建议

**后写实现**
- `src/systemd.ts`
- `src/index.ts`

**完成判定**
- systemd 命令面不是一次性脚本，而是可维护控制面

---

## V5 — 文档与运维指引收口

### V5.1 修正文档真值并补运行手册
**目标**：收口当前文档与最终实现之间的运维真值，并补全运行手册。  
**前置依赖**：V4.2。

**先写/先改文档核对清单**
- `docs/DEV-OPS.md`
- `README.md`
- `docs/TODO.md`
- 如需要补充 `docs/SPEC.md`

**文档关注点**
- 在功能未完成前，不得再写成“当前已经可用”
- 功能完成后，再把手动 systemd 安装降为 fallback 路径
- 说明日志查看、重启、停用、卸载方式
- 说明 passthrough 的边界：它不是 mx-coder 控制命令

**后写实现**
- 仅文档收口，无新增产品逻辑

**完成判定**
- README / DEV-OPS / TODO / SPEC 不再相互冲突

---

## 5. 关键约束（必须遵守）

### passthrough 约束
1. `//` 语法只对 IM 文本入口生效。
2. 单斜杠 `/` 命令永远优先视为 mx-coder 控制命令。
3. passthrough 不得绕过 ACL / approval / audit。
4. passthrough 的恢复策略必须保守，默认不得静默自动 replay。

### systemd 约束
1. 仅支持 **systemd user service**。
2. 不写 system-level unit，不要求 root。
3. service 文件路径、服务名、ExecStart 必须稳定可预测。
4. 失败输出必须给用户可操作的下一步，而不是抽象报错。

---

## 6. 执行规则（给下游 agent）

1. 必须严格按切片顺序推进。
2. 先测试、后实现，不能只写设计不落测试。
3. 若实现中发现 v2.1 需求与 P1–P3 稳定化主链冲突，应先停下并回报冲突，不要私自扩展范围。
4. systemd 相关命令优先做 dry-run 与 mockable shell 封装，避免测试依赖真实宿主环境。

---

## 7. 建议测试命令

阶段性建议：

```bash
npm test
npm run build
```

对 v2.1 开发，建议至少补跑：

```bash
npx vitest run tests/unit/cli-parser.test.ts tests/unit/im-worker-manager.test.ts tests/integration/im-routing.test.ts tests/integration/persistence.test.ts tests/e2e/cli-e2e.test.ts
```