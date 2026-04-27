#!/bin/bash
set -euo pipefail

echo "Fuyao Executor Starting..."
echo "Task ID: ${TASK_ID:-unknown}"
echo "Timeout: ${TIMEOUT:-none}"

# 1. 检查任务配置
if [ ! -f "/workspace/task.json" ]; then
    echo "Error: task.json not found in /workspace"
    exit 1
fi

echo ""
echo "Executing run.sh..."
echo ""

# 2. 执行 run.sh
exec /opt/run.sh "$@"
