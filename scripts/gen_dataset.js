#!/usr/bin/env node
/**
 * 生成脱敏数据集（recruit-hub-data 用）
 * 输入：examples/seed.sqlite（完全脱敏）
 * 输出：data/jobs-YYYY-MM-DD.csv + data/jobs.json
 * 用法：node scripts/gen_dataset.js [输出目录]
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'data');
const SEED = path.join(__dirname, '..', 'examples', 'seed.sqlite');
fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new DatabaseSync(SEED, { readOnly: true });
const rows = db.prepare(`SELECT company, company_type, industry, position, batch, city, education,
  grad_year, publish_date, deadline FROM jobs WHERE status='active' ORDER BY publish_date DESC`).all();
db.close();

const date = new Date().toISOString().slice(0, 10);
const csvPath = path.join(OUT_DIR, `jobs-${date}.csv`);
const jsonPath = path.join(OUT_DIR, `jobs-${date}.json`);
const cols = ['company', 'company_type', 'industry', 'position', 'batch', 'city', 'education', 'grad_year', 'publish_date', 'deadline'];
const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
fs.writeFileSync(csvPath, csv, 'utf8');
fs.writeFileSync(jsonPath, JSON.stringify({ generated_at: new Date().toISOString(), source: 'recruit-hub 脱敏演示数据', count: rows.length, jobs: rows }, null, 2), 'utf8');
console.log(`✅ 数据集已生成：${rows.length} 条 → ${csvPath} / ${jsonPath}`);
