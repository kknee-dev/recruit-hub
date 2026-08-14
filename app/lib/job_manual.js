'use strict';
/**
 * 动态「单岗位精准岗位说明书」生成与缓存。
 *
 * 背景：原 career_guides 按「归一化大类」(如 金融与银行) 提供 1 篇通用说明书，
 * 导致「投资开发岗」(能源/城投国企，做项目拓展与工程建设) 被套用金融说明书，过于宽泛。
 * 本模块改为：按 公司|岗位|行业 指纹，调用大模型生成"一岗一书"的精准说明书并缓存，
 * 命中缓存直接返回；大模型不可用或生成失败时，回退到静态大类说明书。
 *
 * 设计要点：
 * - 指纹 = MD5(company|position|industry)，同名同行业的重复招聘共享一份，控制调用成本。
 * - SSR 只用 getCached（纯读取，无 LLM 延迟）；真正的 generate 由客户端 /api/job-manual/:id 懒触发。
 * - 薪资等敏感信息绝不编造具体数字，只给方向性参考（prompt 约束 + 下游展示提示）。
 */
const crypto = require('node:crypto');
const db = require('../db');
const llm = require('./llm');
const tax = require('./position_taxonomy');
const config = require('../config');

/** 计算指纹：公司|岗位|行业 归一化后 MD5 */
function fingerprint(job) {
  const parts = [
    String(job.company || '').trim().toLowerCase(),
    String(job.position || '').trim().toLowerCase(),
    String(job.industry || '').trim().toLowerCase()
  ];
  return crypto.createHash('md5').update(parts.join('|')).digest('hex');
}

/** 静态大类说明书（回退用）：复用 tax + career_guides，单规范类才返回 */
function staticManual(job) {
  let names = [];
  try { names = tax.classify(job.position || ''); } catch { names = []; }
  if (names.length !== 1) return null;
  const row = db.prepare(
    `SELECT position, stage, title, content, source FROM career_guides
     WHERE position = ? AND stage='说明书' AND status='active' ORDER BY created_at DESC LIMIT 1`
  ).get(names[0]);
  if (!row) return null;
  return { position: row.position, title: row.title, content: row.content, source: row.source, tailored: false, fallback: true, cached: false };
}

/** 读取已缓存的精准说明书 */
function getCached(fp) {
  const r = db.prepare("SELECT * FROM job_manuals WHERE fingerprint=? AND status='active'").get(fp);
  if (!r) return null;
  return { id: r.id, fingerprint: r.fingerprint, company: r.company, position: r.position, industry: r.industry,
           title: r.title, content: r.content, model: r.model, tailored: true, fallback: false, cached: true };
}

function buildMessages(job, profile) {
  const sys = `你是校招求职内容编辑，擅长把笼统的岗位名称结合行业与公司背景，写成务实、精准的校招岗位说明书。请严格依据用户提供的岗位名、公司行业、公司类型、工作地、学历、批次，以及（若有）官方公告摘要与公司简介，推断该岗位的真实职责与适配要求，不要泛泛而谈。
输出 Markdown，分四节：### 这个岗位做什么 / ### 适合谁 / ### 薪资与前景 / ### 怎么投。
硬性要求：
1) 紧扣岗位实际，突出行业差异。例如：能源/城投/地产国企里的"投资开发/投资拓展/战略投资"通常是项目挖掘与拓展、工程建设与特许经营开发、投资测算与可研、投后管理，而金融行业的"投资"偏向资产配置/投行/资管——务必按真实行业语境区分，不要套用金融模板。
2) 薪资与前景一节禁止编造具体数字，只给方向性区间参考，并提示"以官方公告与站内薪资爆料为准"。
3) 不要出现除"校招宝"外的其他平台名，不要出现任何 URL 或外链。
4) 全文 380-560 字，语言务实、像前辈给学弟学妹的建议。
只输出 Markdown 正文，不要任何额外说明、前言或代码围栏。`;
  const secs = [
    `公司：${job.company || '未注明'}`,
    `岗位：${job.position || '未注明'}`,
    `行业：${job.industry || '未注明'}`,
    `公司类型：${job.company_type || '未注明'}`,
    `工作地：${job.city || '未注明'}`,
    `学历要求：${job.education || '未注明'}`,
    `招聘批次：${job.batch || '校招'}`
  ];
  if (job.notice_summary) secs.push(`官方公告摘要：${String(job.notice_summary).slice(0, 400)}`);
  const pi = profile && (profile.org_intro || profile.intro);
  if (pi) secs.push(`公司简介：${String(pi).slice(0, 400)}`);
  secs.push('请撰写该岗位的校招说明书。');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: secs.join('\n') }
  ];
}

function cleanContent(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '');
  return s.trim();
}

/**
 * 获取某岗位的精准说明书：优先命中缓存；否则懒生成（大模型）并落库；任何异常回退静态大类。
 * @param {object} job  jobs 行
 * @param {object|null} profile  company_profiles 行（可选）
 * @returns {Promise<object>} {position,title,content,tailored,fallback,cached}
 */
async function generate(job, profile) {
  const fp = fingerprint(job);
  const cached = getCached(fp);
  if (cached) return cached;

  // 大模型不可用：直接回退静态大类说明书
  if (!llm.isConfigured()) {
    return staticManual(job) || {
      position: job.position || '该岗位', title: '岗位说明书',
      content: '该岗位的详细说明书整理中，可先查看下方招聘信息与官方公告。', tailored: false, fallback: true, cached: false
    };
  }

  let text = null;
  try {
    text = await llm.chat(buildMessages(job, profile), { temperature: 0.4, maxTokens: 1200 });
  } catch (e) {
    text = null;
  }
  if (!text || text.trim().length < 60) {
    return staticManual(job) || {
      position: job.position || '该岗位', title: '岗位说明书',
      content: '该岗位的详细说明书整理中，可先查看下方招聘信息与官方公告。', tailored: false, fallback: true, cached: false
    };
  }

  const content = cleanContent(text);
  const title = `${job.position || '岗位'} 岗位：校招精准观察笔记`;
  try {
    db.prepare(
      `INSERT INTO job_manuals (fingerprint, company, position, industry, title, content, model, source)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(fp, job.company || '', job.position || '', job.industry || '', title, content, config.DEEPSEEK_MODEL || 'deepseek-v4-flash', 'ai');
  } catch (e) {
    // 唯一约束冲突：并发首次生成，忽略，下次命中缓存
  }
  return { position: job.position || title, title, content, tailored: true, fallback: false, cached: false };
}

module.exports = { fingerprint, staticManual, getCached, generate, buildMessages };
