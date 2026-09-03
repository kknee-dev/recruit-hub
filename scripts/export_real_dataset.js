#!/usr/bin/env node
/**
 * 导出真实校招数据脱敏数据集（recruit-hub 用）
 * ---------------------------------------------------------------
 * 数据来源：校招宝真实聚合库（XZB_DB_PATH 或默认本机路径）。
 * 合规三原则（与线上运营站独立，仅作公开样本数据集）：
 *   1) 来源标注：每条含 source + source_url（公开公告/招聘页链接），并附 disclaimer；
 *   2) 不含个人信息：仅导出公开聚合字段，正则扫描 email/手机号并脱敏；
 *   3) 非运营平台：本数据集是“公开样本”，不承接投递、不存简历。
 *
 * 用法：node scripts/export_real_dataset.js [--db <path>] [--limit <n>] [--out <dir>]
 * 输出：<out>/jobs-YYYY-MM-DD.csv  +  jobs-YYYY-MM-DD.json  +  digest/校招情报周报-YYYY-MM-DD.md
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// ---- 参数 ----
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const DB = arg('--db', process.env.XZB_DB_PATH || 'C:/Users/28473/.xiaozhaobao/xzb.db');
const LIMIT = parseInt(arg('--limit', '8000'), 10);
const OUT = arg('--out', path.join(__dirname, '..'));

// ---- 脱敏工具 ----
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:(?:\+?86)?[-\s]?)?(?:1[3-9]\d{9})(?!\d)/g;
function redact(s) {
  if (!s) return s;
  return String(s).replace(EMAIL_RE, '[邮箱已脱敏]').replace(PHONE_RE, '[电话已脱敏]');
}
function domainOf(u) {
  try { return new URL(u).host; } catch { return ''; }
}
// 仅白名单公开字段参与导出
const COLS = ['company','company_type','batch','industry','position','education','grad_year','city','publish_date','deadline','source','salary'];

// ---- 读取 ----
let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (e) {
  console.error('❌ 无法打开数据库:', DB, '\n', e.message);
  process.exit(1);
}
const totalActive = db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='active'").get().c;
const rows = db.prepare(`
  SELECT ${COLS.join(',')}, apply_url
  FROM jobs WHERE status='active'
  ORDER BY publish_date DESC
  LIMIT ?
`).all(LIMIT);
db.close();

// ---- 脱敏转换 ----
const jobs = rows.map(r => {
  const o = {};
  for (const c of COLS) o[c] = redact(r[c]);
  o.source_domain = domainOf(r.apply_url || '');
  o.source_url = r.apply_url || '';        // 公开公告/招聘页链接（非个人信息）
  return o;
});

// ---- 写 CSV ----
const date = new Date().toISOString().slice(0, 10);
const dataDir = path.join(OUT, 'data');
const digDir = path.join(OUT, 'digest');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(digDir, { recursive: true });

const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvCols = [...COLS, 'source_domain', 'source_url'];
const csv = [csvCols.join(','), ...jobs.map(r => csvCols.map(c => esc(r[c])).join(','))].join('\n');
const csvPath = path.join(dataDir, `jobs-${date}.csv`);
fs.writeFileSync(csvPath, '﻿' + csv, 'utf8'); // BOM 便于 Excel 打开

const jsonPath = path.join(dataDir, `jobs-${date}.json`);
fs.writeFileSync(jsonPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  disclaimer: '本数据集为校招宝真实聚合数据的公开脱敏样本，仅含公开招聘信息（公司/岗位/城市/批次/学历/截止日/来源），不含任何个人信息。数据聚合自各企业公开校招公告与招聘平台，版权归原发布方所有，本仓库仅作技术演示与检索研究用途，非官方、不构成招聘服务。',
  source: '校招宝真实聚合库（脱敏导出）',
  total_active_in_source: totalActive,
  exported_count: jobs.length,
  fields: csvCols,
  note: 'source_url 为原公开公告/招聘页链接；如需下线某条，联系仓库维护者。',
  jobs,
}, null, 2), 'utf8');

// ---- 生成周报（digest）----
function topN(map, n) {
  return Object.entries(map).filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, n);
}
const acc = { company: {}, city: {}, batch: {}, education: {}, industry: {}, source: {}, salary: {} };
for (const j of jobs) {
  for (const k of ['company','city','batch','education','industry','source']) acc[k][j[k]] = (acc[k][j[k]] || 0) + 1;
  if (j.salary) acc.salary[j.salary] = (acc.salary[j.salary] || 0) + 1;
}
const md = [
  `# 校招情报周报 · ${date}`,
  '',
  '> 数据来源：校招宝真实聚合库脱敏样本（公开招聘信息，不含个人信息）。本仓库仅作技术演示与检索研究，非官方招聘服务。',
  '',
  `**样本量**：${jobs.length} 条在招岗位（源库在招合计 ${totalActive} 条）`,
  '',
  '## 🏢 在招 Top 公司（前 15）',
  ...topN(acc.company, 15).map(([k, v]) => `- ${k}：${v}`),
  '',
  '## 🌆 热门城市（前 15）',
  ...topN(acc.city, 15).map(([k, v]) => `- ${k}：${v}`),
  '',
  '## 📅 招聘批次分布',
  ...topN(acc.batch, 10).map(([k, v]) => `- ${k || '未标注'}：${v}`),
  '',
  '## 🎓 学历要求分布（前 10）',
  ...topN(acc.education, 10).map(([k, v]) => `- ${k || '未标注'}：${v}`),
  '',
  '## 🏭 行业分布（前 10）',
  ...topN(acc.industry, 10).map(([k, v]) => `- ${k || '未标注'}：${v}`),
  '',
  '## 🔌 数据源分布',
  ...topN(acc.source, 10).map(([k, v]) => `- ${k || '未标注'}：${v}`),
  '',
  '## 💰 薪资区间样本（前 10，如有）',
  ...topN(acc.salary, 10).map(([k, v]) => `- ${k}：${v}`),
  '',
  '---',
  `生成时间：${new Date().toISOString()} · 完整数据见 \`data/jobs-${date}.json\``,
].join('\n');
const mdPath = path.join(digDir, `校招情报周报-${date}.md`);
fs.writeFileSync(mdPath, md, 'utf8');

console.log(`✅ 真实脱敏数据集已生成：`);
console.log(`   源库在招合计：${totalActive}`);
console.log(`   本次导出：${jobs.length} 条`);
console.log(`   CSV ：${csvPath}`);
console.log(`   JSON：${jsonPath}`);
console.log(`   周报：${mdPath}`);
