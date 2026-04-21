# 使用中遇到的问题 2026-04-15
* 修复 .gitignore
* 当前 mm-coder 无法与 mattermost 通信
* mm-coder 与 IM 连接后要发送欢迎消息
* mm-coder 对已配置的 IM 信息连通性和 token verify 功能
* mm-coder start 后，遇到 mm-coder 升级如何更新 daemon 程序，希望提供命令 restrat 或 stop
* mm-coder stop/restart 或被 kill 后，其下的 claude session 会不会失去管理, 重启 mm-coder 后是否会失去之前的session (持久化问题)
* mm-coder 对 IM 的 config 缺乏引导配置过程
* claude code 从 terminal 退出后，mm-coder 对其状态跟踪错误，并且无法再次 attach
```
[lvliang@m1267 claude-workspace]$ mm-coder list
Sessions:
  demo (attached) - /home/lvliang/claude-workspace/himalchuli/
[lvliang@m1267 claude-workspace]$ mm-coder attach demo
Error: {"code":"INTERNAL_ERROR","message":"INVALID_STATE_TRANSITION"}
```
* tui 模式需求讨论与补齐
* e2e 测试是否覆盖了 stdio + mm-coder + claude-code 都覆盖了哪些场景，是否覆盖了日常使用场景：
  + 与 claude code 通话
  + detach / attach 后上下文未丢失
  + IM / terminal 互相切换

# 问题 
* 设计如何支持 IM 中给当前 coder cli 发送对应其原生command能力，比如如果当前绑定为 claude code ，则可以用这个设计发送对应的命令，如 /effort <xxx> 等; 如果是 gemini-cli 则可以给其发送 /model 等；对于 codex 等也是如此，但要与 mm-coder 命令区分开,要能明确表达命令是发给 mm-coder 的还是发给当前 session banding 的 coder cli。
* 将is typing 的实现方式改为官方文档 https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/introduction.yaml 的 ws 方式 
```
{
  "action": "user_typing",
  "data": {
    "channel_id": "你的频道ID",
    "parent_id": "" 
  }
}
```

* 请同样在网上搜索和从 https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/introduction.yaml 确认，mattermost的 channel 的功能和限制(包括channel是否可以被删除等)，跟我讨论claude code session 是否适合绑定 mattermost 的 channel,由此跟我讨论其合理性.并且在 channel 中绑定 claude session 的话，是不是每次对话都要 at claude bot?
* 去掉对旧版配置格式以及最早平铺格式配置的支持
* mm-coder create demo1 -w /tmp; 然后 mm 中 /open demo1； 然后 mm-coder remove demo1; 接着 mm-coder create demo1 -w /tmp/workspace; 接着 mm 中 /open demo1 报错 : "An error occurred while listing channels."
* mm-coder 连接 claude code session 后，会自动设置为 accept edit 模式么？我如何在 mm 中验证 权限审批
* mm-coder tui 提示未实现
* 确保 mm-coder 没有污染传给 coder cli 的 prompt 和 message (遇到同样一句话，在claude tui 中反复问与 mm中反复问问差别非常大，但是各自都很稳定)

* 在 mm 中 mm-coder 能否用创建新 channel 的方式代替现在新建 thread的方式？
* 增加 mm-coder setup systemd 添加 mm-coder.service 开机启动的功能
* 添加 mm-coder 类似 readline 按 tab 键补全后面参数的功能

-------------------
  1. 先执行
    - docs/AGENT-INSTRUCTIONS.phase1-typing-recheck.md
    - 先把 typing 官方语义再确认一轮
  2. xdocs/REVIEW.phase2-and-current-state.md
    - 对当前修复后的代码状态做新的 review 总结
    - 明确指出：
        - 当前实现哪些修复已经成立
      - 哪些 review 文档已过时
      - MATTERMOST-GAPS.md 目前结构不干净，需要清理
  2. 再执行
    - docs/AGENT-INSTRUCTIONS.phase3-docs-and-channel-strategy.md
    - 把文档双真值、过期表述、channel 设计彻底收口
  3. 最后再执行
    - docs/AGENT-INSTRUCTIONS.phase2-phase3-features.md
    - 进入真正 phase3 功能实现
