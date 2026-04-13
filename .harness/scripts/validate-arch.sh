#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: validation
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# Harness 架构验证脚本
# 检查代码是否符合架构约束

set -e

echo "🔍 运行 Harness 架构验证..."
echo ""

ERRORS=0
WARNINGS=0

# 1. 检查表示层是否直接 spawn Claude Code 进程
echo "  检查表示层业务逻辑隔离..."
if grep -rn "spawn.*claude" src/index.ts src/ipc/ 2>/dev/null; then
    echo "    ❌ 错误: CLI/IPC 层直接 spawn Claude Code 进程，应通过 CLIPlugin"
    ERRORS=$((ERRORS + 1))
else
    echo "    ✅ 通过"
fi

# 2. 检查插件层是否直接访问 SessionRegistry
echo "  检查插件层架构约束..."
if grep -rn "SessionRegistry" src/plugins/im/ 2>/dev/null; then
    echo "    ❌ 错误: IM Plugin 直接访问 SessionRegistry，应通过 daemon 间接"
    ERRORS=$((ERRORS + 1))
else
    echo "    ✅ 通过"
fi

# 3. 检查 package.json 存在
echo "  检查 package.json..."
if [ -f "package.json" ]; then
    echo "    ✅ package.json 存在"
else
    echo "    ❌ 错误: 缺少 package.json"
    ERRORS=$((ERRORS + 1))
fi

# 4. 检查测试文件组织
echo "  检查测试文件组织..."
UNIT_TESTS=$(find tests/unit -name "*.test.ts" 2>/dev/null | wc -l)
INTEG_TESTS=$(find tests/integration -name "*.test.ts" 2>/dev/null | wc -l)
echo "    单元测试文件: $UNIT_TESTS"
echo "    集成测试文件: $INTEG_TESTS"

if [ "$UNIT_TESTS" -eq 0 ] && [ "$INTEG_TESTS" -eq 0 ]; then
    echo "    ⚠️  警告: 未发现测试文件（Phase 1 开发初期可接受）"
    WARNINGS=$((WARNINGS + 1))
fi

# 5. 检查模块组织
echo "  检查模块组织..."
for module in session-registry im-worker-manager approval-manager daemon; do
    if [ -f "src/${module}.ts" ] || [ -f "src/${module}.js" ]; then
        echo "    ✅ src/${module} 存在"
    fi
done

# 6. 检查 AGENTS.md 和 harness.yaml 存在
echo "  检查 Harness 入口文件..."
if [ -f "AGENTS.md" ] && [ -f "harness.yaml" ]; then
    echo "    ✅ AGENTS.md 和 harness.yaml 存在"
else
    echo "    ❌ 错误: 缺少 Harness 入口文件"
    ERRORS=$((ERRORS + 1))
fi

# 7. 检查插件接口定义
echo "  检查插件系统..."
if [ -f "src/plugins/types.ts" ]; then
    echo "    ✅ src/plugins/types.ts 存在"
else
    echo "    ⚠️  警告: 未发现 src/plugins/types.ts"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo "✅ 架构验证通过"
    exit 0
elseelse
    echo "❌ 架构验证失败: 发现 $ERRORS 个问题"
    if [ $WARNINGS -gt 0 ]; then
        echo "⚠️  另有 $WARNINGS 个警告"
    fi
    exit 1
fi
