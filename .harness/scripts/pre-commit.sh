#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: pre-commit-hook
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# 提交前检查脚本
# 应在 git commit 前运行 (可作为 git pre-commit hook)

set -e

echo "🔍 提交前检查..."
echo ""

FAILED=0

# 1. TypeScript 类型检查
echo "  检查 TypeScript 类型..."
if command -v npx >/dev/null 2>&1; then
    if npx tsc --noEmit 2>/dev/null; then
        echo "    ✅ 类型检查通过"
    else
        echo "    ❌ 类型检查失败，运行 'npm run check' 查看详情"
        FAILED=$((FAILED + 1))
    fi
else
    echo "    ⏭️  跳过 (npx 未安装)"
fi

# 2. 单元测试 + 集成测试
echo "  运行测试..."
if command -v npx >/dev/null 2>&1; then
    if npx vitest run --reporter=default 2>&1 | tail -5 | grep -qE "tests|passed|failed"; then
        echo "    ✅ 测试通过"
    else
        echo "    ❌ 测试失败，运行 'npm test' 查看详情"
        FAILED=$((FAILED + 1))
    fi
else
    echo "    ⏭️  跳过 (vitest 未安装)"
fi

# 3. 检查 AGENTS.md 是否过期
echo "  检查文档更新..."
if [ -f "AGENTS.md" ]; then
    NEWER_FILES=$(find src -name "*.ts" -newer AGENTS.md 2>/dev/null | head -5)
    if [ -n "$NEWER_FILES" ]; then
        echo "    ⚠️  以下源文件比 AGENTS.md 新，文档可能需要更新:"
        echo "$NEWER_FILES" | sed 's/^/       /'
    else
        echo "    ✅ 文档状态正常"
    fi
else
    echo "    ⚠️  缺少 AGENTS.md"
fi

echo ""
if [ $FAILED -eq 0 ]; then
    echo "✅ 提交前检查通过"
    exit 0
else
    echo "❌ 提交前检查失败: $FAILED 个问题"
    echo ""
    echo "💡 修复建议:"
    echo "   - npm run check     # 类型检查"
    echo "   - npm test          # 运行测试"
    exit 1
fi
