#!/bin/bash
# 執行所有 Unit Tests（使用 Node.js 內建 test runner）
echo "🧪 Pinti LINE - Unit Tests"
echo "=========================="
echo ""

cd "$(dirname "$0")/../.."

PASS=0
FAIL=0
ERRORS=""

for test_file in tests/unit/test_*.mjs; do
    echo "📦 Running: $test_file"
    if node --test "$test_file" 2>&1; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        ERRORS="$ERRORS\n  ❌ $test_file"
    fi
    echo ""
done

echo "=========================="
echo "📊 Results: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
    echo -e "❌ Failed tests:$ERRORS"
    exit 1
else
    echo "🎉 All unit test suites passed!"
fi
