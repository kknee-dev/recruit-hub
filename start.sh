#!/usr/bin/env bash
# 校招宝开源版 · 一键启动（Linux/macOS）
set -e
cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; echo "✓ 已创建 .env（默认配置）"; }
DB="${XZB_DB:-$HOME/.xiaozhaobao/xzb.db}"
if [ ! -f "$DB" ]; then
  mkdir -p "$(dirname "$DB")"
  cp examples/seed.sqlite "$DB"
  echo "✓ 已加载演示数据 → $DB"
fi
echo "🚀 启动：http://localhost:3600"
exec node app/server.js
