#!/usr/bin/env node
/**
 * 生成「本周校招情报」周报（recruit-hub 传播内容引擎，Phase 2）
 * 从脱敏演示数据统计生成，无 LLM 依赖（任何环境可跑）。
 * 输出：digest/demo/YYYY-W##.md
 * 用法：node scripts/gen_digest.js [输出目录]
 *
 * 注：默认输出到 digest/demo 子目录，保护根目录真实周报快照（digest/校招情报周报-*.md）不被覆盖。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// 默认输出到 digest/demo 子目录，保护根目录真实周报快照
const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'digest', 'demo');
const SEED = path.join(__dirname, '..', 'examples', 'seed.sqlite');
fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new DatabaseSync(SEED, { readOnly: true });
const total = db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='active'").get().c;
const companies = db.prepare('SELECT COUNT(DISTINCT company) c FROM jobs WHERE status=\'active\'').get().c;
const batchTop = db.prepare("SELECT batch, COUNT(*) c FROM jobs WHERE status='active' GROUP BY batch ORDER BY c DESC LIMIT 5").all();
const cityTop = db.prepare("SELECT city, COUNT(*) c FROM jobs WHERE status='active' GROUP BY city ORDER BY c DESC LIMIT 5").all();
const recent = db.prepare(`SELECT company, position, city, deadline FROM jobs
  WHERE status='active' AND publish_date >= date('now','-7 day') ORDER BY publish_date DESC LIMIT 8`).all();
db.close();

// ISO 周号
const now = new Date();
const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
const dayNum = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - dayNum);
const isoWeek = Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7);
const weekStr = `${now.getFullYear()}-W${String(isoWeek).padStart(2, '0')}`;

const bar = (n) => '█'.repeat(Math.max(1, Math.round(n))) + '░'.repeat(Math.max(0, 5 - Math.round(n)));
const rowsMd = recent.length
  ? recent.map(j => `- **${j.company}** ${j.position}（${j.city || '多地'}）${j.deadline ? `截止 ${j.deadline}` : ''}`).join('\n')
  : '- 本周暂无新增演示岗位（数据为脱敏示例，接入真实数据后此栏目即生效）';

const md = `# 校招情报周报 ${weekStr}

> 数据来源：recruit-hub 脱敏演示数据集（接入真实数据源后自动反映真实校招动态）。

## 📊 本周概览
- 在招岗位 **${total}** 条 ｜ 覆盖企业 **${companies}** 家
- 热门批次：${batchTop.map(b => `${b.batch}(${b.c})`).join(' / ')}
- 热门城市：${cityTop.map(c => `${c.city}(${c.c})`).join(' / ')}

## 🆕 本周新增（演示）
${rowsMd}

## 🏢 热门企业
${recent.slice(0, 5).map((j, i) => `${bar(5 - i)} **${j.company}**`).join('\n')}

---
*本仓库的演示数据完全脱敏（虚构公司名）；接入真实数据源后，本周报自动变为真实校招情报。*
`;

const out = path.join(OUT_DIR, `${weekStr}.md`);
fs.writeFileSync(out, md, 'utf8');
console.log(`✅ 周报已生成：${out}（${md.length} 字符）`);
