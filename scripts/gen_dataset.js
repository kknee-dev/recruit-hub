#!/usr/bin/env node
/**
 * 生成数据集（recruit-hub 用）
 * ---------------------------------------------------------------
 * 输入：
 *   - 若设置了 XZB_DB_PATH 且文件存在 → 读取【真实聚合库】导出脱敏公开字段；
 *   - 否则回退读取 examples/seed.sqlite（完全脱敏演示数据）。
 * 输出：data/demo/jobs-YYYY-MM-DD.csv + data/demo/jobs-YYYY-MM-DD.json
 * 用法：node scripts/gen_dataset.js [输出目录]
 *
 * 注：CI（content-engine）默认无真实库，自动回退演示数据，且默认输出到 data/demo 子目录，
 *     避免覆盖维护者提交的根目录真实脱敏数据集快照（data/jobs-*.csv）。
 *     真实脱敏数据集由维护者本地用 scripts/export_real_dataset.js 导出后提交到根目录。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// 默认输出到 data/demo 子目录，保护根目录真实数据集快照不被 CI 虚构数据覆盖
const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'data', 'demo');
const SEED = path.join(__dirname, '..', 'examples', 'seed.sqlite');
const REAL = process.env.XZB_DB_PATH && fs.existsSync(process.env.XZB_DB_PATH)
  ? process.env.XZB_DB_PATH : null;

fs.mkdirSync(OUT_DIR, { recursive: true });

const DB = REAL || SEED;
const isReal = !!REAL;
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`SELECT company, company_type, industry, position, batch, city, education,
  grad_year, publish_date, deadline FROM jobs WHERE status='active' ORDER BY publish_date DESC`).all();
db.close();

const date = new Date().toISOString().slice(0, 10);
const csvPath = path.join(OUT_DIR, `jobs-${date}.csv`);
const jsonPath = path.join(OUT_DIR, `jobs-${date}.json`);
const cols = ['company', 'company_type', 'industry', 'position', 'batch', 'city', 'education', 'grad_year', 'publish_date', 'deadline'];
const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
fs.writeFileSync(csvPath, '﻿' + csv, 'utf8');
fs.writeFileSync(jsonPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  source: isReal ? '校招宝真实聚合库（脱敏导出）' : 'recruit-hub 脱敏演示数据',
  count: rows.length,
  jobs: rows,
}, null, 2), 'utf8');
console.log(`✅ 数据集已生成（${isReal ? '真实库' : '演示数据'}）：${rows.length} 条 → ${csvPath} / ${jsonPath}`);
