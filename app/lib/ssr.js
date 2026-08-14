/* SEO 静态化：为爬虫/AI 引擎生成语义化 HTML + JSON-LD 结构化数据
 * - 人类访问：返回 SPA（/index.html），由前端交互渲染
 * - 机器人访问：返回本模块生成的完整静态 HTML（含 JSON-LD），利于收录与 GEO
 */
const fs = require('node:fs');
const path = require('node:path');

// 从 public/index.html 抽取资源版本号与 SW 注册脚本，保证 SSR 外壳与 SPA 入口完全一致。
// 这样以后只维护 index.html 一处（bump ?v=、改 SW 逻辑），SSR 页面自动同步，不再漏改。
const ASSET = { css: '50', js: '70', sw: "if ('serviceWorker' in navigator) {\n    navigator.serviceWorker.register('/sw.js').catch(function () {});\n  }" };
try {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const cssM = html.match(/app\.css\?v=(\d+)/);
  const jsM = html.match(/app\.js\?v=(\d+)/);
  if (cssM) ASSET.css = cssM[1];
  if (jsM) ASSET.js = jsM[1];
  const swM = html.match(/<script>\s*if \('serviceWorker'[\s\S]*?<\/script>/);
  if (swM) ASSET.sw = swM[0].replace(/^<script>/, '').replace(/<\/script>\s*$/, '');
} catch (e) {}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 截断职位名：在逗号边界截断，避免词语中间被切断（如"电子/半"）
const posShort = (s, max = 40) => { s = String(s || ''); if (s.length <= max) return s; const cut = Math.max(s.lastIndexOf('，', max), s.lastIndexOf(',', max)); return (cut > max * 0.5 ? s.slice(0, cut) : s.slice(0, max)) + '…'; };

// 品牌图形 Logo（靶心+雷达扫描线），全站 hero / 登录页复用
const LOGO_IC = `<span class="logo-ic"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="10"/><circle cx="24" cy="24" r="2.5"/><line x1="24" y1="24" x2="38" y2="10"/><line x1="42" y1="24" x2="38" y2="24"/><line x1="24" y1="42" x2="24" y2="38"/></svg></span>`;

// 拼接型岗位名（如"战略岗、财务岗、审计岗…"）拆成 chip 展示；短岗位名原样
function posChips(pos) {
  const s = String(pos ?? '');
  if (s.length <= 30) return esc(s);
  const parts = s.split(/[、，,/\n;；]+/).map(x => x.trim()).filter(Boolean);
  if (parts.length <= 1) return esc(s);
  return parts.map(p => `<span class="pos-chip">${esc(p)}</span>`).join('');
}

// 企业简介：剥离「校招情报」标记块（已由「校招画像」区块承载），仅展示基础简介文本（与前端 renderIntel 一致）
function ssrIntel(intro) {
  if (!intro) return '';
  const base = intro.replace(/<!--XZB_INTEL-->[\s\S]*?<!--\/XZB_INTEL-->/, '').trim();
  if (!base) return '';
  return `<p style="line-height:1.7;color:var(--text);font-size:14px;margin:0">${esc(base)}</p>`;
}

// 岗位名 → 英文 slug（避免中文出现在 URL 中）
const { slugOf } = require('./position_slugs');
const tax = require('./position_taxonomy');
const jobManual = require('./job_manual');

// GEO 规范域名：llms.txt / sitemap / canonical / JSON-LD 统一指向正式域名（已注册，备案中）。
// 备案完成后 xiaozhaobao.com.cn 即可解析；AI 收录用域名而非服务器 IP 才有价值。
// 开源版通过环境变量 XZB_SITE_BASE 覆盖（默认保持线上域名，不破坏现有部署）。
const SITE_BASE = process.env.XZB_SITE_BASE || 'https://xiaozhaobao.com.cn';

const IS_EXPIRED_SQL = "(date(deadline) IS NOT NULL AND date(deadline) < date('now','localtime'))";
const NOT_EXPIRED_SQL = "(date(deadline) IS NULL OR date(deadline) >= date('now','localtime'))";
// 纯校招站防线（2026-08-12）：与 server.js NOT_SOCIAL 保持一致，仅排除不含校招成分的社招批次
const NOT_SOCIAL_SQL = "(batch NOT LIKE '%社招%' OR batch LIKE '%春招%' OR batch LIKE '%实习%' OR batch LIKE '%秋招%' OR batch LIKE '%提前批%' OR batch LIKE '%校招%')";

function ddlHtml(d) {
  if (!d) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return `<span class="ddl ok">${esc(d)}</span>`;
  const days = Math.ceil((new Date(d + 'T23:59:59') - Date.now()) / 86400000);
  if (days < 0) return `<span class="ddl ddl-end">已截止</span>`;
  if (days <= 3) return `<span class="ddl ddl-urgent">剩 ${days} 天</span>`;
  if (days <= 7) return `<span class="ddl ddl-soon">剩 ${days} 天</span>`;
  return `<span class="ddl">截止 ${esc(d)}</span>`;
}

// 机器人 UA 识别（覆盖搜索引擎 + AI 抓取器）
const BOT_RE = /(googlebot|bingbot|bingpreview|slurp|duckduckbot|baiduspider|yandex|sogou|360spider|teoma|applebot|gptbot|chatgpt-user|oai-search|perplexity|anthropic|claude|meta-external|facebookexternalhit|twitterbot|linkedinbot|pinterest|rogerbot|dotbot|seekport|semrush|ahrefs|mj12bot|blexbot|feedfetcher|ia_archiver|ccbot)/i;
function isBot(ua) { return !!ua && BOT_RE.test(ua); }

const TOPBAR = '';

function doc({ title, description, canonical, jsonLd, body }) {
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '';
  const can = canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="ssr" content="1">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical || '')}">
<meta property="og:image" content="${esc(SITE_BASE)}/og-cover.png">
<meta name="twitter:card" content="summary_large_image">
${can}
${ld}
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/png" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="stylesheet" href="/css/app.css?v=${ASSET.css}">
</head>
<body>
<div id="app">
${TOPBAR}
<div id="view">${body}</div>
<nav class="tabbar" id="tabbar">
  <a href="/" data-tab="home"><span class="ico tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><line x1="14.5" y1="14.5" x2="20" y2="20"/><line x1="4" y1="20" x2="16" y2="20"/></svg></span>情报</a>
  <a href="/companies" data-tab="companies"><span class="ico tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="12"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="9" y1="4" x2="15" y2="4"/></svg></span>企业</a>
  <a href="/materials" data-tab="materials"><span class="ico tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19L16 8"/><polyline points="13 5 17 5 17 9"/><polyline points="7 15 11 19 17 13"/></svg></span>练习</a>
  <a href="/guides" data-tab="guides"><span class="ico tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="16"/><line x1="12" y1="4" x2="12" y2="20"/></svg></span>攻略</a>
  <a href="/subs" data-tab="subs"><span class="ico tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12"/><polyline points="3 7 12 13 21 7"/></svg></span>订阅</a>
  <a href="/me" data-tab="me"><span class="ico tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg></span>我的</a>
</nav>
</div>
<div id="toast"></div>
<div id="modal-root"></div>
<script src="/js/app.js?v=${ASSET.js}"></script>
<script>
${ASSET.sw}
</script>
</body>
</html>`;
}

function jobBody(db, j, profile) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const city = (j.city || '').split(',').join('、');
  const manualsHtml = (() => {
    const names = tax.classify(j.position || '');
    if (!names.length) return '';
    const multi = names.length > 1;

    // 单岗位：优先展示已缓存的「一岗一书」精准说明书（纯读取，无 LLM 延迟）；否则回退静态大类
    if (!multi) {
      const cached = jobManual.getCached(jobManual.fingerprint(j));
      if (cached) {
        return `<div class="section"><h2>📋 岗位说明书 <span style="font-size:11px;background:#EAF3DE;color:#3B6D11;padding:2px 7px;border-radius:10px;font-weight:500;vertical-align:middle">AI 精准匹配</span></h2>`
          + `<div class="manual-card"><div class="manual-pos">${esc(cached.position || j.position)}</div><div class="manual-box">${mdToHtml(cached.content)}</div></div>`
          + `<a class="morelink" href="/guides">查看全部岗位的求职攻略 ›</a></div>`;
      }
    }

    const cards = [];
    for (const name of names) {
      const m = db.prepare(`SELECT position, title, content FROM career_guides WHERE position = ? AND stage='说明书' AND status='active' ORDER BY created_at DESC LIMIT 1`).get(name);
      if (m) cards.push(m);
    }
    if (!cards.length) return '';
    let h = `<div class="section"><h2>📋 岗位说明书${multi ? '（多岗位）' : ''}</h2>`;
    if (multi) h += `<div class="manual-note">本招聘含多个岗位，以下分别介绍；薪资数据来自站内真实爆料，仅供参考。</div>`;
    for (const m of cards) h += `<div class="manual-card"><div class="manual-pos">${esc(m.position)}</div><div class="manual-box">${mdToHtml(m.content)}</div></div>`;
    if (multi) h += `<a class="morelink" href="/guides">查看全部岗位的求职攻略 ›</a>`;
    else h += `<a class="morelink" href="/guide/${esc(encodeURIComponent(cards[0].position))}">查看 ${esc(cards[0].position)} 完整求职攻略 ›</a>`;
    h += `</div>`;
    return h;
  })();
  const rows = [
    ['招聘岗位', j.positions
      ? `<div class="pos-chips">${j.positions.split(/[、,，]/).map(p => `<span class="chip">${esc(p.trim())}</span>`).join('')}</div>`
      : posChips(j.position)],
    ['工作城市', city],
    ['毕业届别', j.grad_year],
    ['学历要求', j.education],
    ['是否笔试', j.exam || '未明确'],
    ['招聘批次', j.batch],
    ['截止日期', j.deadline],
    ['发布日期', j.publish_date]
  ].filter(r => r[1]).map(([k, v]) => {
    const html = k === '招聘岗位' ? v : esc(v); // 岗位字段已是 posChips 生成的 HTML，其余转义
    return `<div class="kv"><div class="k">${k}</div><div class="v">${html}</div></div>`;
  }).join('');
  const expired = j.deadline && /^\d{4}-\d{2}-\d{2}$/.test(j.deadline) && new Date(j.deadline + 'T23:59:59') < new Date();
  const applyHtml = expired
    ? `<a class="btn btn-primary" href="${esc(j.notice_url || '#')}" target="_blank" rel="noopener" style="display:block;text-align:center">📋 查看详情</a>`
    : `<span class="muted">投递入口为会员专属，<a href="/login">登录 / 注册</a> 后查看（注册送 15 天免费试用）</span>`;
  return `
  <article class="page">
    <div class="detail-top"><div class="co">${esc(j.company)}</div>
      <div class="tags"><span class="tag">${esc(j.batch || '校招')}</span>${j.company_type ? `<span class="tag">${esc(j.company_type)}</span>` : ''}${j.industry ? `<span class="tag">${esc(j.industry)}</span>` : ''}</div>
    </div>
    <div class="section"><h2>岗位信息</h2>${rows}</div>
    ${profile && profile.intro ? `<div class="section"><h2>🏢 企业简介</h2>${ssrIntel(profile.intro)}</div>` : ''}
    ${profile && profile.locations && profile.locations.length ? `<div class="section" style="padding-top:0"><div style="font-size:13px;color:var(--text2);margin-bottom:8px">📍 主要办公地点</div><div class="loc-tags">${profile.locations.slice(0, 10).map(l => `<span class="loc-tag">${esc(l)}</span>`).join('')}</div></div>` : ''}
    <div class="section"><h2>官方公告</h2>${j.notice_summary ? `<p class="nsum">${esc(j.notice_summary)}</p>` : ''}${j.notice_url ? `<a class="notice-link" href="${esc(j.notice_url)}" target="_blank" rel="noopener">查看官方公告原文 ›</a>` : '<span class="muted">暂无官方公告</span>'}</div>
    <div class="section"><h2>投递方式</h2>${applyHtml}</div>
    <div class="section"><h2>企业档案</h2><a class="morelink" href="/company/${esc(encodeURIComponent(j.parent_company || j.company))}">查看 ${esc(j.parent_company || j.company)} 全部在招岗位与笔面经 ›</a></div>
    ${j.position_list ? `<div class="section"><h2>📋 招聘岗位</h2><div class="pos-table-wrap">${j.position_list}</div></div>` : ''}
    ${manualsHtml}
  </article>`;
}

// 岗位页 FAQ：全部来自站内真实数据，AI 可直接引用（无数据的问题不生成）
function jobFaq(db, job) {
  const faq = [];
  const co = job.parent_company || job.company;
  // 1) 笔试考什么：题库真实题型分布
  const qtypes = db.prepare(`SELECT q_type, COUNT(*) c FROM practice_questions WHERE position=? AND exam_stage='笔试' GROUP BY q_type ORDER BY c DESC`).all(job.position);
  if (qtypes.length) {
    const parts = qtypes.map(t => `${t.q_type} ${t.c} 道`).join('、');
    faq.push({
      q: `${job.company} 的 ${job.position} 岗位笔试一般考什么？`,
      a: `根据校招宝题库，${job.position} 岗位笔试主要题型为${parts}，侧重专业知识、业务常识与基本技能。数据来源：校招宝岗位题库。`
    });
  }
  // 2) 薪资：offer_reference 真实聚合（月薪千元）
  const sal = db.prepare(`SELECT MIN(salary_min) lo, MAX(salary_max) hi, COUNT(*) c FROM offer_reference WHERE (company LIKE ? OR company LIKE ?) AND position=? AND salary_min IS NOT NULL`)
    .get('%' + co + '%', '%' + (job.company || '') + '%', job.position);
  if (sal && sal.c > 0) {
    faq.push({
      q: `${job.company} 的 ${job.position} 岗位校招薪资大概多少？`,
      a: `校招宝薪资参考显示，${job.position} 岗位参考月薪区间约 ${sal.lo}-${sal.hi} 千元（共 ${sal.c} 条数据，供参考）。数据来源：校招宝薪资参考库。`
    });
  }
  // 3) 截止时间
  if (job.deadline) {
    faq.push({
      q: `${job.company} ${job.position} 岗位的投递截止时间？`,
      a: `该岗位投递截止日期为 ${job.deadline}，请尽快投递。数据来源：校招宝招聘库。`
    });
  }
  // 4) 工作地点
  if (job.city) {
    faq.push({
      q: `${job.company} ${job.position} 岗位工作地点在哪？`,
      a: `该岗位工作地点：${job.city}。数据来源：校招宝招聘库。`
    });
  }
  // 5) 是否笔试
  if (job.exam && !qtypes.length) {
    faq.push({
      q: `${job.company} ${job.position} 需要笔试吗？`,
      a: `该岗位笔试要求：${job.exam}。数据来源：校招宝招聘库。`
    });
  }
  return faq;
}

function jobJsonLd(db, j, url) {
  const faq = jobFaq(db, j);
  const co = j.parent_company || j.company;
  const sal = db.prepare(`SELECT MIN(salary_min) lo, MAX(salary_max) hi FROM offer_reference WHERE (company LIKE ? OR company LIKE ?) AND position=? AND salary_min IS NOT NULL`)
    .get('%' + co + '%', '%' + (j.company || '') + '%', j.position);
  const graph = [{
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title: `${posShort(j.position)} - ${j.company}`,
    datePosted: j.publish_date || undefined,
    dateModified: j.publish_date || undefined,
    validThrough: j.deadline && /^\d{4}-\d{2}-\d{2}/.test(j.deadline) ? j.deadline : undefined,
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: co },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: (j.city || '').split(',')[0] } },
    description: `${j.company} 招聘 ${posShort(j.position)}（${j.batch || '校招'}），工作地：${j.city || '未注明'}，截止：${j.deadline || '未注明'}。来源：校招宝。`
  }];
  if (sal && sal.lo != null && sal.hi != null) {
    graph[0].baseSalary = {
      '@type': 'MonetaryAmount', currency: 'CNY',
      value: { '@type': 'QuantitativeValue', minValue: sal.lo * 1000, maxValue: sal.hi * 1000, unitText: 'CNY per month' }
    };
  }
  if (faq.length) {
    graph.push({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
    });
  }
  graph.push({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: SITE_BASE + '/' },
      { '@type': 'ListItem', position: 2, name: co, item: `${SITE_BASE}/company/${encodeURIComponent(co)}` },
      { '@type': 'ListItem', position: 3, name: posShort(j.position), item: url }
    ]
  });
  return graph.length === 1 ? graph[0] : { '@context': 'https://schema.org', '@graph': graph };
}

function renderJob(db, job, host, profile) {
  const url = `${SITE_BASE}/job/${job.id}`;
  const desc = `${job.company} ${posShort(job.position)} 2026届校招｜${job.batch || '校招'}｜工作地：${job.city || '未注明'}｜学历：${job.education || '未注明'}｜截止：${job.deadline || '未注明'}。数据来源：校招宝。`;
  return doc({
    title: `${job.company} ${posShort(job.position)} 招聘（${job.batch || '校招'}）- 校招宝`,
    description: desc,
    canonical: url,
    jsonLd: jobJsonLd(db, job, url),
    body: jobBody(db, job, profile)
  });
}

function companyBody(d) {
  const jobs = d.jobs.slice(0, 30).map(j => `<div class="titem">
    <div style="font-size:12px;color:var(--text2)">${esc(j.publish_date)} · ${esc(j.batch)}</div>
    <a href="/job/${j.id}"><b>${esc(j.position.slice(0, 60))}</b></a>
    <div style="font-size:12px;color:var(--text2)">${esc((j.city || '').split(',').slice(0, 3).join('/'))}</div></div>`).join('');
  const expired = (d.expired_jobs || []).slice(0, 30).map(j => `<div class="titem expired">
    <div style="font-size:12px;color:var(--text2)">${esc(j.publish_date)} · ${esc(j.batch)}</div>
    <a href="/job/${j.id}"><b>${esc(j.position.slice(0, 60))}</b></a>
    <div style="font-size:12px;color:var(--text2)">${esc((j.city || '').split(',').slice(0, 3).join('/'))} <span style="color:#999">已截止</span></div></div>`).join('');
  const posts = renderExperienceSummary(d.experience_summary);
  return `
  <article class="page">
    <div class="detail-top"><div class="co">${esc(d.name)}</div>
      <div class="tags">${d.stats.company_type ? `<span class="tag">${esc(d.stats.company_type)}</span>` : ''}${d.stats.industry ? `<span class="tag">${esc(d.stats.industry)}</span>` : ''}<span class="tag">${d.stats.job_count} 条招聘记录</span></div>
    </div>
    ${renderCampusRecruit(d.profile)}
    <div class="section"><h2>📝 笔面经精华（${d.experience_summary ? d.experience_summary.total : 0} 篇）</h2>${posts}</div>
    <div class="section"><h2>📋 招聘信息（${d.stats.job_count} 条）</h2><div class="timeline">${jobs}</div></div>
    ${expired ? `<div class="section expired-section"><div class="expired-toggle" style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px 0;cursor:pointer"><span style="font-size:15px;font-weight:700">🗓️ 已截止校招信息（${d.expired_jobs.length} 条 · 仅供参考）</span><span style="font-size:12.5px;color:var(--brand);font-weight:600">▸ 点击展开</span></div><div class="timeline expired-body" style="display:none">${expired}</div></div>` : ''}
  </article>`;
}

function companyJsonLd(d, url) {
  const p = d.profile || {};
  const intro = p.intro ? p.intro.replace(/<!--XZB_INTEL-->[\s\S]*?<!--\/XZB_INTEL-->/, '').trim() : '';
  const ld = {
    '@context': 'https://schema.org', '@type': 'Organization',
    name: d.name, url,
    description: intro || `${d.name} 校招档案：共 ${d.stats.job_count} 条招聘记录，涵盖${d.stats.industry || '多行业'}。来源：校招宝。`
  };
  if (p.website) ld.sameAs = [p.website];
  return ld;
}

function renderExperienceSummary(sum) {
  if (!sum || !sum.total) return '<div class="empty">暂无笔面经</div>';
  const block = (t, c) => {
    if (!c || !c.count) return '';
    const tags = (c.tags || []).map(x => `<span class="es-tag">${esc(x)}</span>`).join('');
    const li = arr => (arr || []).map(x => `<li>${esc(x)}</li>`).join('');
    let h = `<div class="exp-role"><div class="exp-role-h">${t} <span class="exp-n">${c.count} 篇</span></div>`;
    if (tags) h += `<div class="exp-tags">${tags}</div>`;
    if (c.keypoints && c.keypoints.length) h += `<div class="exp-sec"><b>🔑 核心要点</b><ul>${li(c.keypoints)}</ul></div>`;
    if (c.tips && c.tips.length) h += `<div class="exp-sec"><b>⚠️ 注意事项</b><ul>${li(c.tips)}</ul></div>`;
    if (c.advice && c.advice.length) h += `<div class="exp-sec"><b>💡 实用建议</b><ul>${li(c.advice)}</ul></div>`;
    h += `</div>`;
    return h;
  };
  const ex = block('✍️ 笔面试经验', sum.exam);
  const rev = block('🏢 公司口碑', sum.review);
  return ex + rev + `<div class="exp-src">数据来源：牛客网用户匿名分享，经校招宝提炼聚合展示，原始内容不提供。</div>`;
}

// 公司校招画像（公众号官方公告自动提炼，campus_recruit JSON）
function renderCampusRecruit(profile) {
  if (!profile || !profile.campus_recruit) return '';
  let o; try { o = JSON.parse(profile.campus_recruit); } catch { return ''; }
  if (!o || !o.summary) return '';
  const row = (k, v) => v ? `<div class="cr-row"><span class="cr-k">${k}</span><span class="cr-v">${esc(v)}</span></div>` : '';
  const bits = [
    row('🎓 校招对象', (o.grad_classes || []).join('、')),
    row('🗓️ 毕业窗口', o.grad_time || ''),
    row('🎯 面向对象', (o.targets || []).join('，')),
    row('💰 薪资参考', o.salary || ''),
  ].join('');
  const desc = (label, v) => v ? `<div class="cr-desc"><div class="cr-dt">${label}</div><div class="cr-dv">${esc(v)}</div></div>` : '';
  const descs = [
    desc('📋 招聘情况', o.situation || ''),
    desc('💡 价值亮点', o.value || ''),
    desc('🧭 岗位方向', o.positions || ''),
    desc('🚀 投递要点', o.apply_tips || ''),
  ].join('');
  return `<div class="section cp-campus"><h2>📢 校招画像 · 来自官方公告</h2>
    <div class="cr-summary">${esc(o.summary)}</div>
    ${bits ? `<div class="cr-box">${bits}</div>` : ''}
    ${descs ? `<div class="cr-descs">${descs}</div>` : ''}
    <div class="cr-note">由公众号官方招聘公告自动提炼，仅供参考</div></div>`;
}

function renderCompany(d, host) {
  const url = `${SITE_BASE}/company/${d.slug || encodeURIComponent(d.name)}`;
  const desc = `${d.name} 校招档案｜${d.stats.job_count} 条在招岗位、${(d.experience_summary ? d.experience_summary.total : 0)} 篇笔面经精华。校招宝企业档案库。`;
  return doc({
    title: `${d.name} 校招档案 - 校招宝`,
    description: desc,
    canonical: url,
    jsonLd: companyJsonLd(d, url),
    body: companyBody(d)
  });
}

// ---------- sitemap.xml（内存缓存，导入时失效） ----------
let _sitemap = null;
function invalidateSeoCache() { _sitemap = null; }

function buildSitemap(db, host) {
  if (_sitemap) return _sitemap;
  const base = SITE_BASE;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${base}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${base}/companies</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    `  <url><loc>${base}/guides</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
    `  <url><loc>${base}/offers</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    `  <url><loc>${base}/materials</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`];
  const jobs = db.prepare(`SELECT id, update_date, added_date FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL}`).all();
  for (const j of jobs) out.push(`  <url><loc>${base}/job/${j.id}</loc><lastmod>${j.update_date || j.added_date || today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  const comps = db.prepare(`SELECT COALESCE(ci.slug, j.parent_company) AS k, MAX(COALESCE(j.update_date, j.added_date)) lm FROM jobs j LEFT JOIN company_index ci ON ci.name=j.parent_company WHERE j.status='active' AND ${NOT_SOCIAL_SQL} GROUP BY j.parent_company`).all();
  for (const c of comps) out.push(`  <url><loc>${base}/company/${encodeURIComponent(c.k)}</loc><lastmod>${c.lm || today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  const gpos = db.prepare("SELECT DISTINCT position FROM career_guides WHERE status='active' AND position IS NOT NULL AND position<>''").all();
  for (const g of gpos) out.push(`  <url><loc>${base}/guide/${slugOf(g.position)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  out.push('</urlset>');
  _sitemap = out.join('\n');
  return _sitemap;
}

function buildRobots(host) {
  // AI 爬虫单独放行（确保拿到完整 SSR 页面），普通爬虫照旧
  const aiUa = ['GPTBot', 'PerplexityBot', 'ClaudeBot', 'anthropic-ai', 'Applebot-Extended', 'CCBot', 'OAI-SearchBot', 'ChatGPT-User'];
  const lines = aiUa.map(ua => `User-agent: ${ua}\nAllow: /\n`).join('\n');
  // 管理后台不收录（2026-08-09：/admin 虽有密钥保护，不应暴露入口）
  return `${lines}User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${SITE_BASE}/sitemap.xml\n`;
}

function buildLlms(db) {
  const top = db.prepare(`SELECT j.parent_company AS company, COUNT(*) c, COALESCE(ci.slug, j.parent_company) AS k FROM jobs j LEFT JOIN company_index ci ON ci.name=j.parent_company WHERE j.status='active' AND ${NOT_SOCIAL_SQL} GROUP BY j.parent_company ORDER BY c DESC LIMIT 25`).all();
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL}`).get().c;
  const pos = db.prepare("SELECT name, job_count FROM practice_positions WHERE status='active' ORDER BY job_count DESC LIMIT 12").all();
  const practice = db.prepare("SELECT COUNT(*) c FROM practice_questions").get().c;
  const salaryRef = db.prepare("SELECT COUNT(*) c FROM offer_reference").get().c;
  const salaryRep = db.prepare("SELECT COUNT(*) c FROM offer_salaries WHERE status='active'").get().c;
  // 示例链接：动态取真实在库记录，避免数据清洗后出现死链（历史教训：/job/45、/company/tencent 曾 404）
  const jobSample = db.prepare(`SELECT id FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND (parent_company LIKE '%腾讯%' OR company LIKE '%腾讯%') ORDER BY id LIMIT 1`).get()
    || db.prepare(`SELECT id FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} ORDER BY id LIMIT 1`).get();
  const coSample = db.prepare(`SELECT COALESCE(ci.slug, j.parent_company) AS k FROM jobs j LEFT JOIN company_index ci ON ci.name=j.parent_company WHERE j.status='active' AND ${NOT_SOCIAL_SQL} AND ci.slug IS NOT NULL AND (j.parent_company LIKE '%腾讯%' OR j.company LIKE '%腾讯%') ORDER BY j.id LIMIT 1`).get()
    || db.prepare(`SELECT COALESCE(ci.slug, j.parent_company) AS k FROM jobs j LEFT JOIN company_index ci ON ci.name=j.parent_company WHERE j.status='active' AND ${NOT_SOCIAL_SQL} AND ci.slug IS NOT NULL ORDER BY j.id LIMIT 1`).get();
  const lines = [
    '# 校招宝 (Xiaozhaobao)',
    '',
    '> 校招宝是一个面向应届生的校园招聘情报站，聚合秋招、春招、实习、提前批等招聘信息，',
    '> 提供精准筛选、企业档案、求职攻略、岗位练习与薪资参考。所有数据均来自公开渠道并标注来源。',
    '',
    '## 核心内容',
    `- 招聘信息列表（当前收录 ${total} 条真实校招岗位，可按城市、届别、行业、企业类型、笔试情况筛选）：${SITE_BASE}/`,
    `- 求职攻略（按岗位整理的笔试/面试/薪资备考指南，共 ${pos.length} 个热门岗位）：${SITE_BASE}/guides`,
    `- 企业档案库（按母公司聚合子公司招聘与笔面经）：${SITE_BASE}/companies`,
    `- 校招薪资参考（${salaryRef} 条参考区间 + ${salaryRep} 条真实爆料）：${SITE_BASE}/offers`,
    `- 校招练习（${practice} 道岗位练习题，在线作答自动判分）：${SITE_BASE}/materials`,
    `- 单条招聘详情示例：${SITE_BASE}/job/${jobSample ? jobSample.id : ''}`,
    `- 单企业档案示例：${SITE_BASE}/company/${coSample ? encodeURIComponent(coSample.k) : ''}`,
    `- 单岗位攻略示例：${SITE_BASE}/guide/algorithm-engineer`,
    '',
    '## 数据说明',
    '- 信息来源于公开渠道（企业官方公告、招聘平台等），投递前请以官方公告为准。',
    '- 投递链接与内推码为注册会员权益（注册送 15 天免费试用，年费 99 元）。',
    '- 薪资数据来自公开薪资汇总与匿名爆料，仅供参考。',
    '',
    '## 热门岗位',
    ...pos.map(p => `- ${p.name}（在招 ${p.job_count} 条）：${SITE_BASE}/guide/${slugOf(p.name)}`),
    '',
    '## 招聘企业（按在招数量 Top 25）',
    ...top.map(t => `- ${t.company}（${t.c} 条在招）：${SITE_BASE}/company/${encodeURIComponent(t.k)}`),
    '',
    '## 常见问题',
    '- Q：校招信息多久更新一次？A：数据每日更新，覆盖秋招/春招/实习/提前批。',
    '- Q：如何快速找到适合自己的岗位？A：在首页按公司/岗位/城市/学历/届别筛选，或查看「求职攻略」了解每个岗位的笔试面试重点。',
    '- Q：岗位投递需要付费吗？A：浏览岗位与筛选免费；投递链接、内推码与每日情报邮件为会员权益（注册送 15 天免费试用）。',
    '- Q：薪资数据可靠吗？A：薪资参考来自公开汇总与用户匿名爆料，均标注来源，仅供求职参考。',
    `- Q：笔试面试怎么准备？A：每个热门岗位都有求职攻略（${SITE_BASE}/guides），并有配套练习题库可在线作答。`
  ];
  return lines.join('\n');
}

function buildLlmsFull(db) {
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL}`).get().c;
  const pos = db.prepare("SELECT name, job_count FROM practice_positions WHERE status='active' ORDER BY job_count DESC LIMIT 30").all();
  const salaryRep = db.prepare("SELECT COUNT(*) c FROM offer_salaries WHERE status='active'").get().c;
  const qcount = db.prepare("SELECT COUNT(*) c FROM practice_questions").get().c;
  const lines = [
    '# 校招宝全量数据（llms-full.txt）',
    '',
    '本文件为校招宝的结构化数据摘要，供 AI 深度引用。详细数据见各页面。',
    '',
    `## 总体统计`,
    `- 在招岗位总数：${total}`,
    `- 薪资爆料：${salaryRep} 条`,
    `- 岗位练习题：${qcount} 道`,
    '',
    '## 热门岗位及在招数',
    ...pos.map(p => `- ${p.name}: ${p.job_count}`),
    '',
    '## 完整数据入口',
    `- 全部岗位：${SITE_BASE}/`,
    `- 全部企业：${SITE_BASE}/companies`,
    `- 求职攻略：${SITE_BASE}/guides`,
    `- 薪资参考：${SITE_BASE}/offers`,
    `- 岗位练习：${SITE_BASE}/materials`
  ];
  return lines.join('\n');
}

const NOT_EXPIRED = NOT_EXPIRED_SQL;

// ---------- 全页面 SSR ----------
function renderHome(db, host) {
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL}`).get().c;
  const imported = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND (source IS NULL OR source='')`).get().c;
  const scraped = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND source IS NOT NULL AND source<>''`).get().c;
  const todayAdded = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND added_date = date('now','localtime')`).get().c;
  const todayImported = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND added_date = date('now','localtime') AND (source IS NULL OR source='')`).get().c;
  const todayScraped = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND added_date = date('now','localtime') AND source IS NOT NULL AND source<>''`).get().c;
  const soonExpiring = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL_SQL} AND date(deadline) IS NOT NULL AND date(deadline) <= date('now','localtime','+7 days')`).get().c;
  // 首页聚合：同母公司(无则公司名)+同职位+同批次 → 合并为一条（保留各分行入口，SSR 默认展开供 SEO）
  const GRP_KEY = `CASE WHEN parent_company IS NOT NULL AND parent_company<>'' THEN parent_company ELSE company END`;
  const groups = db.prepare(`
    SELECT ${GRP_KEY} AS gk, COUNT(*) cnt, MIN(id) rep_id,
           GROUP_CONCAT(city, '|') g_cities,
           GROUP_CONCAT(id, '|') g_ids,
           GROUP_CONCAT(company, '|') g_companies
    FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL_SQL}
    GROUP BY gk, position, batch HAVING cnt > 1
  `).all();
  const aggMap = new Map(), aggName = new Map();
  const excluded = [];
  for (const g of groups) {
    const members = String(g.g_ids).split('|').map(Number);
    aggMap.set(g.rep_id, { count: g.cnt, cities: String(g.g_cities).split('|'), member_ids: members, member_companies: String(g.g_companies).split('|') });
    aggName.set(g.rep_id, g.gk);
    excluded.push(...members.filter(id => id !== g.rep_id));
  }
  let listWhere = `status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL_SQL}`;
  if (excluded.length) listWhere += ` AND id NOT IN (${excluded.join(',')})`;
  const list = db.prepare(`SELECT id, company, batch, company_type, industry, position, city, grad_year, publish_date, deadline FROM jobs WHERE ${listWhere} ORDER BY publish_date DESC, id DESC LIMIT 50`).all();
  const batchOpts = db.prepare(`SELECT batch, COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL_SQL} AND batch IS NOT NULL AND batch!='' GROUP BY batch ORDER BY c DESC LIMIT 12`).all();
  const aggCities = (g) => {
    const all = [];
    for (const c of g.cities) for (const cc of String(c || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)) if (!all.includes(cc)) all.push(cc);
    return all.length > 4 ? `${all.slice(0, 4).join('/')} 等 ${all.length} 城` : all.join('/');
  };
  const cards = list.map(j => {
    const isNew = j.publish_date && /^\d{4}-\d{2}-\d{2}$/.test(j.publish_date) && (Date.now() - new Date(j.publish_date+'T00:00:00').getTime())/86400000 < 10;
    if (aggMap.has(j.id)) {
      const g = aggMap.get(j.id);
      const members = g.member_ids.map((id, i) => {
        const c = g.member_companies[i] || '';
        const cs = String(g.cities[i] || '').split(/[,，]/).filter(Boolean).slice(0, 2).join('/');
        return `<a class="grp-member" href="/job/${id}"><span class="gm-co">${esc(c)}</span><span class="gm-city">${esc(cs)}</span><span class="gm-go">投递 ›</span></a>`;
      }).join('');
      return `<div class="jcard group-card">
      <div class="row1"><span class="co">${esc(aggName.get(j.id))}</span><span class="tag grp">${g.count} 个分行</span><span class="tag batch">${esc(j.batch||'校招')}</span>${j.company_type?`<span class="tag ct">${esc(j.company_type)}</span>`:''}</div>
      <div class="pos">${esc(j.position)}</div>
      <div class="meta"><span>📍 <b>${esc(aggCities(g))}</b></span>${j.publish_date?`<span>📅 ${esc(j.publish_date)}</span>`:''}${ddlHtml(j.deadline)}</div>
      <div class="grp-body">${members}</div>
      </div>`;
    }
    return `<a class="jcard" href="/job/${j.id}">
      <div class="row1">${isNew?'<span class="tag new">NEW</span>':''}<span class="co">${esc(j.company)}</span><span class="tag batch">${esc(j.batch||'校招')}</span>${j.company_type?`<span class="tag ct">${esc(j.company_type)}</span>`:''}</div>
      <div class="pos">${esc(j.position)}</div>
      <div class="meta">${j.city?`<span>📍 <b>${esc(j.city.split(',').slice(0,3).join('/'))}</b></span>`:''}${j.publish_date?`<span>📅 ${esc(j.publish_date)}</span>`:''}${ddlHtml(j.deadline)}</div>
    </a>`;
  }).join('');
  const pageSize = 50;
  const pages = Math.ceil(total / pageSize);
  const pager = pages > 1 ? `<div class="pager">
    <span class="pg on">1</span>
    <a class="pg" href="/?page=2">2</a>
    ${pages > 3 ? '<span class="pg-ell">…</span>' : ''}
    ${pages > 2 ? `<a class="pg" href="/?page=${pages}">${pages}</a>` : ''}
    <a class="pg" href="/?page=2">下一页 ›</a>
    <span class="pg-info">第 1/${pages} 页</span>
  </div>` : '';
  const body = `
    <div class="hero">
      <div class="brand"><div><h1 class="logo"><span class="logo-ic"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="10"/><circle cx="24" cy="24" r="2.5"/><line x1="24" y1="24" x2="38" y2="10"/><line x1="42" y1="24" x2="38" y2="24"/><line x1="24" y1="42" x2="24" y2="38"/></svg></span>校招宝</h1><div class="slogan">应届生校招情报站 · 不错过任何一个机会</div></div><div class="stat">已收录 <b>${total}</b> 条<div class="stat-sub">今日新增 <b>${todayAdded || 0}</b> 条</div></div></div>
      <div class="searchbar"><span>🔍</span><input id="q" placeholder="搜公司 / 岗位 / 行业" value=""><button class="go">搜索</button></div>
    </div>
    <div class="filterrow">
      <button class="fbtn on">全部</button><button class="fbtn">⚙️ 筛选</button><button class="fbtn on">最新发布</button><button class="fbtn">即将截止</button>
    </div>
    <h2 class="vh">最新校招信息</h2>
    <div class="list">${cards||'<div class="empty">暂无招聘信息</div>'}</div>
    ${pager}
    <div class="notice">数据每日更新 · 信息来源于公开渠道，投递前请核实</div>`;
  const today = new Date().toISOString();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite', name: '校招宝 · 应届生校招情报站',
        alternateName: '校招宝', url: SITE_BASE + '/',
        description: '聚合秋招、春招、实习、提前批等校园招聘信息，支持精准筛选、企业档案、求职攻略、校招练习与薪资参考。',
        inLanguage: 'zh-CN',
        publisher: { '@type': 'Organization', name: '校招宝', url: SITE_BASE + '/', logo: { '@type': 'ImageObject', url: SITE_BASE + '/icon-192.png' } },
        potentialAction: { '@type': 'SearchAction', target: SITE_BASE + '/?q={search_term_string}', 'query-input': 'required name=search_term_string' }
      },
      {
        '@type': 'Organization', name: '校招宝 · 应届生校招情报站',
        alternateName: '校招宝', url: SITE_BASE + '/',
        logo: { '@type': 'ImageObject', url: SITE_BASE + '/icon-192.png' },
        description: '面向应届生的校园招聘情报站：聚合秋招、春招、实习、提前批招聘信息，提供企业档案、求职攻略、岗位练习与薪资参考。',
        foundingDate: '2025'
      },
      {
        '@type': 'WebPage', name: '校招宝 · 应届生校招情报站', url: SITE_BASE + '/',
        dateModified: today, inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', url: SITE_BASE + '/' }
      },
      {
        '@type': 'ItemList', name: '最新校招信息',
        itemListElement: list.slice(0, 20).map((j, i) => ({
          '@type': 'ListItem', position: i + 1,
          name: `${j.company} ${j.position}（${j.batch || '校招'}）`,
          url: `${SITE_BASE}/job/${j.id}`
        }))
      },
      {
        '@type': 'FAQPage', mainEntity: [
          { '@type': 'Question', name: '校招宝是什么？', acceptedAnswer: { '@type': 'Answer', text: '校招宝是一个面向应届生的校园招聘情报站，聚合秋招、春招、实习、提前批等招聘信息，提供精准筛选、企业档案、求职攻略、岗位练习与薪资参考。' } },
          { '@type': 'Question', name: '校招宝的招聘信息来自哪里？', acceptedAnswer: { '@type': 'Answer', text: '所有招聘信息均来自企业官方公告与公开渠道并标注来源，投递前请以企业官方公告为准。' } },
          { '@type': 'Question', name: '校招宝收费吗？', acceptedAnswer: { '@type': 'Answer', text: '注册赠送 15 天免费试用，可查看投递链接与内推码；会员年费 99 元。' } },
          { '@type': 'Question', name: '校招宝数据多久更新？', acceptedAnswer: { '@type': 'Answer', text: '招聘数据每日更新，覆盖秋招、春招、实习、提前批等校招全周期。' } }
        ]
      }
    ]
  };
  return doc({
    title: '校招宝 · 应届生校招情报站',
    description: `校招宝已收录 ${total} 条真实校招信息：秋招/春招/实习/提前批，支持按公司、岗位、城市、学历精准筛选；附企业档案、求职攻略、岗位练习与薪资参考，解决校招信息不对称。数据每日更新。`,
    jsonLd, body
  });
}

function renderCompanies(db, host) {
  const list = db.prepare(`SELECT parent_company AS company, COALESCE(ci.slug, parent_company) AS slug, COUNT(*) job_count, MAX(company_type) company_type, MAX(industry) industry, GROUP_CONCAT(DISTINCT batch) batches FROM jobs j LEFT JOIN company_index ci ON ci.name=j.parent_company WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL_SQL} GROUP BY parent_company ORDER BY job_count DESC, MAX(publish_date) DESC LIMIT 50`).all();
  const cards = list.map(c => `<a class="ccard" href="/company/${encodeURIComponent(c.slug)}">
    <div class="avatar">${esc(c.company[0])}</div>
    <div class="cinfo"><div class="cn">${esc(c.company)}</div><div class="cm">${esc(c.company_type||'')} ${c.industry?'· '+esc(c.industry):''} · ${esc((c.batches||'').split(',').slice(0,3).join('/'))}</div></div>
    <div class="cnum">${c.job_count}<small>条在招</small></div>
  </a>`).join('');
  const body = `
    <div class="hero"><div class="brand"><div><div class="logo">${LOGO_IC}企业档案库</div><div class="slogan">每家校招企业的完整档案</div></div></div></div>
    <div class="list">${cards||'<div class="empty">暂无企业</div>'}</div>`;
  return doc({ title:'企业档案库 - 校招宝', description:'按母公司聚合的校招企业档案库，查看每家企业的全部在招岗位、笔面经与招聘动态。', body });
}

function renderMaterials(db, host) {
  // SSR 真实数据：练习岗位入口 + 题库统计（2026-08-09 内容化，爬虫可见）
  const qcount = db.prepare("SELECT COUNT(*) c FROM practice_questions").get().c || 0;
  const positions = db.prepare("SELECT name, intro, job_count FROM practice_positions WHERE status='active' ORDER BY sort_no, job_count DESC LIMIT 24").all();
  const posCards = positions.map(p => `<a class="mcard" href="/materials#paper/${encodeURIComponent(p.name)}">
    <div class="m-top"><span class="tag batch">岗位练习</span><span class="m-src">${p.job_count || 0} 条在招</span></div>
    <div class="m-title">${esc(p.name)}</div>
    ${p.intro ? `<div class="m-sum">${esc(p.intro.slice(0, 60))}</div>` : ''}
  </a>`).join('');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: '校招练习岗位题库',
    itemListElement: positions.slice(0, 12).map((p, i) => ({
      '@type': 'ListItem', position: i + 1, name: `${p.name} 校招练习`,
      url: `${SITE_BASE}/materials#paper/${encodeURIComponent(p.name)}`
    }))
  };
  const body = `
    <div class="hero practice-hero"><div class="brand"><div><div class="logo">${LOGO_IC}校招练习</div><div class="slogan">按岗位练 · 每卷10题 · 笔试面试混编</div></div></div></div>
    <div class="stat-row" style="display:flex;gap:12px;margin:12px 16px">
      <div class="stat-box" style="flex:1;background:#f8faff;border-radius:8px;padding:10px 14px"><div style="font-size:12px;color:#666">岗位练习题总数</div><div style="font-size:20px;font-weight:500;color:#3b5bfd">${qcount} 道</div></div>
      <div class="stat-box" style="flex:1;background:#f8faff;border-radius:8px;padding:10px 14px"><div style="font-size:12px;color:#666">练习岗位数</div><div style="font-size:20px;font-weight:500;color:#3b5bfd">${positions.length} 个</div></div>
    </div>
    <div class="list">${posCards || '<div class="empty">正在加载岗位题库…</div>'}</div>
    <div class="notice">每份练习卷 10 题（80% 笔试 + 20% 面试），整卷交卷自动判分</div>`;
  return doc({ title:'校招练习 - 校招宝', description:`校招练习：${positions.length} 个热门岗位、${qcount} 道练习题，按岗位在线作答自动判分，每卷 10 题（笔试+面试混编），错题可反复练习。`, jsonLd, body });
}

function renderOffers(db, host) {
  // SSR 真实数据：薪资爆料 Top 榜单（2026-08-09 内容化，爬虫可见）
  const stats = db.prepare("SELECT COUNT(*) c FROM offer_salaries WHERE status='active'").get().c || 0;
  const companies = db.prepare("SELECT COUNT(DISTINCT parent_company) c FROM offer_salaries WHERE status='active' AND parent_company IS NOT NULL").get().c || 0;
  const top = db.prepare(`SELECT company, parent_company, position, education, city, salary_text, month_min, month_max, months, total_min, total_max, grad_year
    FROM offer_salaries WHERE status='active' AND total_max IS NOT NULL ORDER BY total_max DESC LIMIT 20`).all();
  const rows = top.map(o => `<div class="ocard">
    <div class="o-top"><b>${esc(o.company || o.parent_company)}</b><span class="tag ct">${esc(o.position || '')}</span><span class="tag batch">${esc(o.grad_year || '')}</span></div>
    <div class="o-mid">${o.city ? `📍 ${esc(o.city)}` : ''} ${o.education ? `· ${esc(o.education)}` : ''}</div>
    <div class="o-salary">${o.total_min || o.total_max ? `💰 ${o.total_min ? (o.total_min / 10).toFixed(1) : '?'} - ${o.total_max ? (o.total_max / 10).toFixed(1) : '?'} 万` : esc(o.salary_text || '')}</div>
  </div>`).join('');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: '校招薪资参考 Top 榜单',
    itemListElement: top.slice(0, 10).map((o, i) => ({
      '@type': 'ListItem', position: i + 1,
      name: `${o.company || o.parent_company} ${o.position || ''} 校招薪资`,
      description: o.salary_text || (o.total_min && o.total_max ? `${o.total_min / 10}-${o.total_max / 10} 万` : '')
    }))
  };
  const body = `
    <div class="hero practice-hero"><div class="brand"><div><div class="logo">${LOGO_IC}校招薪资参考</div><div class="slogan">大厂校招薪资数据 · 公开汇总+匿名爆料</div></div></div></div>
    <div class="stat-row" style="display:flex;gap:12px;margin:12px 16px">
      <div class="stat-box" style="flex:1;background:#f8faff;border-radius:8px;padding:10px 14px"><div style="font-size:12px;color:#666">薪资爆料总数</div><div style="font-size:20px;font-weight:500;color:#3b5bfd">${stats} 条</div></div>
      <div class="stat-box" style="flex:1;background:#f8faff;border-radius:8px;padding:10px 14px"><div style="font-size:12px;color:#666">覆盖企业数</div><div style="font-size:20px;font-weight:500;color:#3b5bfd">${companies} 家</div></div>
    </div>
    <div class="list">${rows || '<div class="empty">暂无薪资数据</div>'}</div>
    <div class="notice">数据来自公开薪资汇总与用户匿名爆料，仅供参考</div>`;
  return doc({ title:'校招薪资参考 - 校招宝', description:`校招Offer薪资参考数据库：${stats} 条薪资爆料、覆盖 ${companies} 家企业，支持按公司/岗位/学历/城市/届别筛选对比。数据来源：公开薪资汇总+用户匿名爆料。`, jsonLd, body });
}

function renderExpired(db, host) {
  const list = db.prepare(`SELECT id, company, batch, company_type, position, city, publish_date, deadline FROM jobs WHERE status='active' AND ${IS_EXPIRED_SQL} AND ${NOT_SOCIAL_SQL} ORDER BY deadline DESC LIMIT 50`).all();
  const cards = list.map(j => `<a class="jcard expired-card" href="/job/${j.id}">
    <div class="row1"><span class="co">${esc(j.company)}</span><span class="tag batch">${esc(j.batch||'校招')}</span></div>
    <div class="pos">${esc(j.position)}</div>
    <div class="meta">${j.city?`<span>📍 <b>${esc(j.city.split(',').slice(0,3).join('/'))}</b></span>`:''}${j.publish_date?`<span>📅 ${esc(j.publish_date)}</span>`:''}${j.deadline?`<span class="ddl">截止 ${esc(j.deadline)}</span>`:''}<span class="expired-badge">已截止</span></div>
  </a>`).join('');
  const body = `<div class="list">${cards||'<div class="empty">暂无已截止信息</div>'}</div>
    <div class="notice">以下为已截止的校招信息，仅供参考</div>`;
  return doc({ title:'已截止校招信息 - 校招宝', description:'已截止的校招信息汇总，仅供参考。', body });
}

function renderStatic({ title, description, body }) {
  return doc({ title, description, body });
}

// ---------- 求职攻略 ----------
// 极简 Markdown → HTML（仅覆盖攻略文用到的语法：标题/加粗/列表/引用/分隔线/换行）
function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inUl = false, inOl = false;
  const flush = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const e = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); out.push(`<h${h[1].length} class="gm-h">${e(h[2])}</h${h[1].length}>`); continue; }
    const li = line.match(/^[-*]\s+(.*)/);
    if (li) { if (!inUl) { out.push('<ul class="gm-ul">'); inUl = true; } out.push(`<li>${e(li[1])}</li>`); continue; }
    const oi = line.match(/^\d+[.、]\s+(.*)/);
    if (oi) { if (!inOl) { out.push('<ol class="gm-ol">'); inOl = true; } out.push(`<li>${e(oi[1])}</li>`); continue; }
    if (/^>\s?/.test(line)) { flush(); out.push(`<blockquote class="gm-q">${e(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^---+\s*$/.test(line)) { flush(); out.push('<hr class="gm-hr">'); continue; }
    flush();
    out.push(`<p class="gm-p">${e(line)}</p>`);
  }
  flush();
  return out.join('\n');
}

const GUIDE_STAGES = [
  { key: 'overview', icon: '🔭', name: '岗位全景', desc: '这个岗位做什么、谁在招、去哪投' },
  { key: 'written', icon: '✍️', name: '笔试怎么准备', desc: '常考题型、高频知识点、真题示例' },
  { key: 'interview', icon: '🎤', name: '面试怎么准备', desc: '面试流程、高频问题、STAR 框架' },
  { key: 'salary', icon: '💰', name: '薪资参考', desc: '按公司/学历的薪资分布与谈薪建议' },
  { key: 'faq', icon: '❓', name: '常见问答', desc: '你最关心的几个问题，直接给答案' }
];

function renderGuides(db, host) {
  // 各规范岗位在招数（按归一化聚合）
  const counts = new Map();
  const rows = db.prepare(`SELECT position FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND position IS NOT NULL AND position<>''`).all();
  for (const r of rows) for (const c of tax.classify(r.position)) counts.set(c, (counts.get(c) || 0) + 1);
  const list = db.prepare(`
    SELECT g.position AS name, COUNT(*) gcount,
      (SELECT COUNT(*) FROM practice_questions pq WHERE pq.position=g.position) practiceN
    FROM career_guides g WHERE g.status='active' GROUP BY g.position
    ORDER BY COALESCE((SELECT p.job_count FROM practice_positions p WHERE p.name=g.position), 0) DESC, gcount DESC`).all();
  const cards = list.map(p => {
    const hasP = p.practiceN > 0;
    return `<a class="gcard${hasP ? '' : ' gcard-plain'}" href="/guide/${slugOf(p.name)}">
    <div class="g-card-top"><span class="g-emoji">📖</span><span class="g-name">${esc(p.name)}</span>${hasP ? '<span class="gtag">练习</span>' : '<span class="gtag gtag-plain">攻略</span>'}<span class="g-count">${counts.get(p.name) || 0}<small> 在招</small></span></div>
    <div class="g-meta">${p.gcount} 篇攻略${hasP ? ' · 含在线练习' : ' · 看在招岗位'} ›</div>
  </a>`;
  }).join('');
  const body = `
    <div class="hero practice-hero"><div class="brand"><div><div class="logo">${LOGO_IC}求职攻略</div><div class="slogan">热门岗位怎么准备，一篇讲透</div></div></div></div>
    <div class="guide-notice">按岗位整理的校招备考指南：岗位全景 · 笔试真题 · 面试技巧 · 薪资参考 · 常见问答，全部基于站内真实数据 + AI 方法论整理。</div>
    <div class="list glist">${cards || '<div class="empty">攻略整理中，稍后再来…</div>'}</div>
    <div class="notice">攻略中数据均来自校招宝真实招聘/薪资/题库聚合，方法论部分由 AI 生成，仅供参考。</div>`;
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: '校招求职攻略',
    itemListElement: list.slice(0, 20).map((p, i) => ({
      '@type': 'ListItem', position: i + 1, name: `${p.name} 校招求职攻略`,
      url: `${SITE_BASE}/guide/${slugOf(p.name)}`
    }))
  };
  return doc({
    title: '校招求职攻略大全（按岗位） - 校招宝',
    description: `按热门岗位整理的校招求职攻略：${list.slice(0, 8).map(p => p.name).join('、')}等岗位的笔试备考、面试技巧、薪资参考与常见问答，数据来自校招宝真实招聘与题库聚合。`,
    jsonLd, body
  });
}

function renderGuide(db, host, position) {
  const guides = db.prepare("SELECT * FROM career_guides WHERE position=? AND status='active' ORDER BY CASE stage WHEN 'overview' THEN 0 WHEN 'written' THEN 1 WHEN 'interview' THEN 2 WHEN 'salary' THEN 3 WHEN 'faq' THEN 4 ELSE 5 END").all(position);
  if (!guides.length) return null;
  const p = db.prepare("SELECT * FROM practice_positions WHERE name=? AND status='active'").get(position);
  // 在招数（按归一化聚合，非 TOP30 岗位也能正确计数）
  let jobCount = 0;
  const jr = db.prepare(`SELECT position FROM jobs WHERE status='active' AND ${NOT_SOCIAL_SQL} AND position IS NOT NULL AND position<>''`).all();
  for (const r of jr) if (tax.classify(r.position).includes(position)) jobCount++;
  const byStage = {};
  for (const g of guides) byStage[g.stage] = g;

  // 数据徽标
  const practiceN = db.prepare("SELECT COUNT(*) c FROM practice_questions WHERE position=?").get(position).c;
  const salaryN = db.prepare("SELECT COUNT(*) c FROM offer_reference WHERE position=?").get(position).c;
  const badges = [
    `📋 ${jobCount} 条在招`,
    practiceN ? `✍️ ${practiceN} 道练习` : null,
    salaryN ? `💰 ${salaryN} 条薪资参考` : null
  ].filter(Boolean);

  const sections = GUIDE_STAGES.map(st => {
    const g = byStage[st.key];
    const content = g ? (st.key === 'faq' ? renderFaqContent(g.content) : mdToHtml(g.content)) : '';
    return `<section class="gsec" id="${st.key}">
      <div class="gsec-head"><span class="gsec-ic">${st.icon}</span><div><div class="gsec-title">${st.name}</div><div class="gsec-desc">${st.desc}</div></div></div>
      <div class="gsec-body">${content || '<div class="empty">整理中…</div>'}</div>
      <div class="gsec-actions">
        ${practiceN ? `<a class="btn btn-primary" href="/materials#paper/${encodeURIComponent(position)}">✍️ 去练习 ${esc(position)}</a>` : ''}
        <a class="btn btn-ghost" href="/?q=${encodeURIComponent(position)}">📋 看在招岗位</a>
      </div>
    </section>`;
  }).join('');

  // FAQ JSON-LD（faq 板块为可解析 JSON 时输出）
  let faqLd = null;
  const fg = byStage.faq;
  if (fg) {
    try {
      const arr = JSON.parse(fg.content);
      if (Array.isArray(arr) && arr.length) {
        faqLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: arr.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
      }
    } catch { /* 非 JSON 则跳过 FAQ schema */ }
  }
  const jsonLd = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Article', headline: `${position} 校招求职攻略`, description: `${position} 岗位的笔试备考、面试技巧与薪资参考。`, author: { '@type': 'Organization', name: '校招宝' }, publisher: { '@type': 'Organization', name: '校招宝' }, inLanguage: 'zh-CN', mainEntityOfPage: `${SITE_BASE}/guide/${slugOf(position)}` }
  ]};
  if (faqLd) jsonLd['@graph'].push(faqLd);

  const body = `
    <div class="guide-detail">
      <div class="g-hero">
        <div class="g-hero-emoji">📖</div>
        <div class="g-hero-info">
          <div class="g-hero-name">${esc(position)} 校招攻略</div>
          <div class="g-hero-intro">${esc((p && p.intro) || '')}</div>
          <div class="g-badges">${badges.map(b => `<span class="g-badge">${b}</span>`).join('')}</div>
        </div>
      </div>
      <nav class="g-nav">${GUIDE_STAGES.map(st => `<a href="#${st.key}" class="g-nav-item">${st.icon}${st.name}</a>`).join('')}</nav>
      ${sections}
      <div class="g-disclaimer">⚠️ 攻略中岗位数据/薪资/题型统计均来自校招宝真实数据聚合；备考方法论由 AI 生成，仅供参考，请结合自身情况制定计划。</div>
    </div>`;
  return doc({
    title: `${position} 校招求职攻略：笔试/面试/薪资 - 校招宝`,
    description: `${position} 校招求职攻略：${jobCount} 条在招岗位、岗位全景、笔试真题题型、面试技巧、薪资参考（${salaryN} 条数据）与常见问答。数据来源：校招宝。`,
    canonical: `${SITE_BASE}/guide/${slugOf(position)}`,
    jsonLd, body
  });
}

function renderFaqContent(content) {
  try {
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) throw new Error('not array');
    return `<div class="gfaq">${arr.map(f => `<details class="gfaq-item"><summary>${esc(f.q)}</summary><div class="gfaq-a">${mdToHtml(f.a)}</div></details>`).join('')}</div>`;
  } catch {
    return mdToHtml(content);
  }
}

module.exports = { isBot, renderJob, renderCompany, renderHome, renderCompanies, renderMaterials, renderOffers, renderExpired, renderStatic, renderGuides, renderGuide, buildSitemap, buildRobots, buildLlms, buildLlmsFull, invalidateSeoCache };
