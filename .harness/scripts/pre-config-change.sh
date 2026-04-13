#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: pre-config-check
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# Harness 配置变更前检查
# 应在任何配置修改前运行

set -e

echo "🔒 配置变更前检查..."
echo ""

# 1. 检查当前配置备份
echo "  检查配置备份状态..."
if [ -d "~/.config/claw-one/config.git" ]; then
    cd ~/.config/claw-one/config.git
    COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo "0")
    echo "    已有 $COMMIT_COUNT 个配置快照"
else
    echo "    ⚠️  警告: 未发现 Git 备份目录"
fi

# 2. 检查 OpenClaw 状态
echo "  检查 OpenClaw 状态..."
if systemctl --user is-active openclaw >/dev/null 2>&1; then
    echo "    OpenClaw 运行中"
    
    # 健康检查
    if curl -s http://localhost:18790/health | grep -q "ok"; then
        echo "    健康检查通过"
    else
        echo "    ⚠️  警告: 健康检查未通过"
    fi
else
    echo "    OpenClaw 未运行"
fi

# 3. 检查磁盘空间
echo "  检查磁盘空间..."
AVAILABLE=$(df -h ~/.config/claw-one 2>/dev/null | tail -1 | awk '{print $4}' || echo "unknown")
echo "    可用空间: $AVAILABLE"

# 4. 检查配置文件语法
echo "  检查配置文件语法..."
if [ -f "~/.openclaw/openclaw.json" ]; then
    if jq empty ~/.openclaw/openclaw.json 2>/dev/null; then
        echo "    ✅ 配置 JSON 语法有效"
    else
        echo "    ❌ 错误: 配置 JSON 语法无效"
        exit 1
    fi
fi

# 5. 检查端口占用
echo "  检查端口占用..."
for PORT in 8080 18790; do
    if netstat -tuln 2>/dev/null | grep -q ":$PORT " || \
       ss -tuln 2>/dev/null | grep -q ":$PORT "; then
        echo "    端口 $PORT 已占用"
    else
        echo "    端口 $PORT 可用"
    fi
done

echo ""
echo "✅ 配置变更前检查完成"
echo ""
echo "💡 提示: 如果继续修改配置，建议："
echo "   1. 先导出当前配置备份"
echo "   2. 小步修改，每次验证"
echo "   3. 保持 claw-one 日志窗口打开"
