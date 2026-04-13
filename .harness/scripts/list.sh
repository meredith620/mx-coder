#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: discovery
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# Harness 发现脚本
# 列出所有可用的 specs 和 scripts

echo "📋 mm-coder Harness 文档清单"
echo "=============================="
echo ""

echo "📖 规范文档 (.harness/specs/):"
if [ -d ".harness/specs" ]; then
    for file in .harness/specs/*.md; do
        [ -f "$file" ] || continue
        name=$(basename "$file" .md)

        # 提取第一行标题
        title=$(head -1 "$file" | sed 's/^# //' 2>/dev/null || echo "$name")

        # 提取适用范围
        scope=$(grep -m1 "适用于:" "$file" 2>/dev/null | sed 's/.*适用于: *//' || echo "通用")

        printf "  • %-30s %s\n" "$name" "[$scope]"
    done
else
    echo "  (specs/ 目录不存在)"
fi

echo ""
echo "🔧 脚本工具 (.harness/scripts/):"
if [ -d ".harness/scripts" ]; then
    for script in .harness/scripts/*.sh; do
        [ -f "$script" ] || continue
        name=$(basename "$script")

        # 提取描述
        desc=$(awk '
            BEGIN { in_meta=0 }
            NR==1 && /^#!/ { next }
            /^# HARNESS METADATA/ { in_meta=1; next }
            in_meta && /^# [a-z-]+:/ { next }
            in_meta && /^#$/ { in_meta=0; next }
            in_meta && /^# --/ { in_meta=0; next }
            in_meta { next }
            /^# [^#]/ { sub(/^# /, ""); print; exit }
            /^#$/ { next }
        ' "$script" 2>/dev/null || echo "$name")

        printf "  • %-30s %s\n" "$name" "$desc"
    done
else
    echo "  (scripts/ 目录不存在)"
fi

echo ""
echo "🛡️ 熵防护规则 (.harness/guards/):"
if [ -d ".harness/guards" ]; then
    for rule in .harness/guards/*.rule; do
        [ -f "$rule" ] || continue
        name=$(basename "$rule")
        printf "  • %s\n" "$name"
    done
else
    echo "  (guards/ 目录不存在)"
fi

echo ""
echo "💡 使用说明:"
echo "  - 根据任务类型选择对应 spec"
echo "  - 运行 .harness/scripts/pre-commit.sh 提交前检查"
echo "  - 运行 .harness/scripts/validate-arch.sh 架构验证"
echo "  - 运行 .harness/scripts/evaluate-guards.sh 熵防护规则检查"
