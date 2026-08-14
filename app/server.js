const path = require('path');
const fs = require('node:fs');
const db = require('./db');
const config = require('./config');
const { importCSV } = require('./lib/importer');
const { createApp } = require('./lib/web');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./lib/auth');
const mailer = require('./lib/mailer');
const ssr = require('./lib/ssr');
const practice = require('./lib/practice');
const offer = require('./lib/offer');
const llm = require('./lib/llm');
const monitor = require('./lib/monitor');
const { slugOf: posSlugOf, nameOfSlug: posNameOfSlug } = require('./lib/position_slugs');
const tax = require('./lib/position_taxonomy');
const jobManual = require('./lib/job_manual');
const { isBot, renderJob, renderCompany, renderHome, renderCompanies, renderMaterials, renderOffers, renderExpired, renderStatic, renderGuides, renderGuide, buildSitemap, buildRobots, buildLlms, buildLlmsFull, invalidateSeoCache } = ssr;
const { buildExperienceSummary } = require('./lib/exp');

const app = createApp();
app.static(path.join(__dirname, 'public'));

// ---------- 工具 ----------
const now = () => new Date();
const fmtDT = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function userTier(u) {
  if (!u) return 'guest';
  // 付费会员功能已暂停（2026-08-11）：注册用户无限制使用全部功能
  return 'paid';
}
// 会员功能暂停：登录用户即视为会员，解锁投递入口/内推码/笔面经发布等全部权益
const isMember = () => true;

// 企业解析：key 可以是 slug 或原始公司名（URL 解码后），返回规范的 parent_company
function resolveCompany(key) {
  if (!key) return null;
  const raw = decodeURIComponent(key);
  let name = null;
  const bySlug = db.prepare('SELECT name FROM company_index WHERE slug=?').get(key);
  if (bySlug) name = bySlug.name;
  else {
    const byParent = db.prepare("SELECT DISTINCT parent_company c FROM jobs WHERE parent_company=? AND status='active'").get(raw);
    if (byParent) name = byParent.c;
    else {
      // 子品牌 company -> 父公司：让任何子公司链接 301 归并到父 slug（根治中文链接）
      const byCompany = db.prepare("SELECT parent_company c FROM jobs WHERE company=? AND status='active' LIMIT 1").get(raw);
      name = byCompany ? byCompany.c : null;
    }
  }
  if (!name) return null;
  // 子公司归并：若 name 自身是某集团的子公司（parent_company 指向另一有效公司），统一跳到集团页
  const parentOf = db.prepare("SELECT parent_company c FROM jobs WHERE company=? AND status='active' LIMIT 1").get(name);
  if (parentOf && parentOf.c && parentOf.c !== name) {
    const pc = db.prepare('SELECT name FROM company_index WHERE name=?').get(parentOf.c);
    // 仅当 name 自己不再是某集团的父（避免误并把集团页并掉）；如此 广州新东方/西安新东方等 → 新东方
    const isOwnParent = db.prepare("SELECT 1 FROM jobs WHERE parent_company=? AND status='active' LIMIT 1").get(name);
    if (pc && !isOwnParent) name = parentOf.c;
  }
  return name;
}
function slugOf(name) {
  const r = db.prepare('SELECT slug FROM company_index WHERE name=?').get(name);
  return r ? r.slug : name;
}

// 已截止判定：deadline 为合法日期且早于今天视为过期（空值/非日期文本如"滚动""长期"经 date() 解析为 NULL，视为未过期）
const NOT_EXPIRED = "(date(deadline) IS NULL OR date(deadline) >= date('now','localtime'))";
const IS_EXPIRED = "(date(deadline) IS NOT NULL AND date(deadline) < date('now','localtime'))";
// 纯校招站防线（2026-08-12）：仅排除「不含任何校招成分的社招批次」。
// 春招/实习/秋招/提前批/校招字样均视为校招（含其的混合批次如「春招专场, 社招」保留），纯「社招」及「其他, 社招」类排除
const NOT_SOCIAL = "(batch NOT LIKE '%社招%' OR batch LIKE '%春招%' OR batch LIKE '%实习%' OR batch LIKE '%秋招%' OR batch LIKE '%提前批%' OR batch LIKE '%校招%')";

function optionalAuth(req, _res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const payload = verifyToken(h.slice(7));
    if (payload && payload.uid != null) {
      try { req.user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid) || null; }
      catch { req.user = null; }
    }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== config.ADMIN_KEY) return res.status(403).json({ error: '管理密钥错误' });
  next();
}
app.use(optionalAuth);

// ---------- 元数据（筛选项） ----------
let metaCache = null;
let metaCacheAt = 0;
const META_TTL = 5 * 60 * 1000; // 5 分钟 TTL：同步后最多 5 分钟自动刷新「已收录/今日新增」
function buildMeta() {
  const rows = db.prepare(`SELECT batch, company_type, industry, city, grad_year, education, exam FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL}`).all();
  const count = {};
  const add = (key, val) => {
    if (!val) return;
    count[key] = count[key] || {};
    count[key][val] = (count[key][val] || 0) + 1;
  };
  for (const r of rows) {
    add('batch', r.batch); add('company_type', r.company_type); add('industry', r.industry); add('exam', r.exam);
    (r.city || '').split(/[,，/]/).forEach(c => { c = c.trim(); if (c) add('city', c); });
    (r.grad_year || '').split(/[,，]/).forEach(y => { y = y.trim(); if (y) add('grad_year', y); });
    (r.education || '').split(/[,，]/).forEach(e => { e = e.trim(); if (e) add('education', e); });
  }
  const top = (key, n) => Object.entries(count[key] || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  // 统计口径：导入（source 空，来自 CSV 等整理数据）+ 抓取（source 非空，如飞书表格）两种情况都计
  const imported = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL} AND (source IS NULL OR source='')`).get().c;
  const scraped = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL} AND source IS NOT NULL AND source<>''`).get().c;
  const todayAdded = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL} AND added_date = date('now','localtime')`).get().c;
  const todayImported = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL} AND added_date = date('now','localtime') AND (source IS NULL OR source='')`).get().c;
  const todayScraped = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_SOCIAL} AND added_date = date('now','localtime') AND source IS NOT NULL AND source<>''`).get().c;
  const soonExpiring = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL} AND date(deadline) IS NOT NULL AND date(deadline) <= date('now','localtime','+7 days')`).get().c;
  metaCache = {
    total: imported + scraped,
    imported,
    scraped,
    today_added: todayAdded,
    today_imported: todayImported,
    today_scraped: todayScraped,
    soon_expiring: soonExpiring,
    batch: top('batch', 12),
    company_type: top('company_type', 12),
    industry: top('industry', 40),
    city: top('city', 40),
    grad_year: top('grad_year', 10).sort(),
    education: top('education', 6),
    exam: top('exam', 8)
  };
  return metaCache;
}
app.get('/api/meta', (_req, res) => {
  if (!metaCache || Date.now() - metaCacheAt > META_TTL) { metaCache = buildMeta(); metaCacheAt = Date.now(); }
  res.json(metaCache);
});
// 同步完成后由脚本调用：强制失效 meta 缓存，下次请求立即重建「已收录/今日新增」
app.post('/api/admin/refresh-meta', requireAdmin, (_req, res) => {
  metaCache = null; metaCacheAt = 0;
  res.json({ ok: true });
});

// ---------- 招聘信息 ----------
function buildJobQuery(q) {
  const conds = ["status='active'", NOT_SOCIAL], params = [];
  if (q.q) {
    for (const kw of String(q.q).trim().split(/\s+/).slice(0, 5)) {
      conds.push('(company LIKE ? OR position LIKE ? OR industry LIKE ?)');
      const like = `%${kw}%`;
      params.push(like, like, like);
    }
  }
  const eq = (field, val) => { if (val) { conds.push(`${field} = ?`); params.push(val); } };
  const like = (field, val) => { if (val) { conds.push(`${field} LIKE ?`); params.push(`%${val}%`); } };
  eq('batch', q.batch);
  eq('company_type', q.company_type);
  like('industry', q.industry);
  // 城市：支持多选（逗号分隔或数组），任一命中即匹配
  if (q.city) {
    const cities = (Array.isArray(q.city) ? q.city : String(q.city).split(/[,，]/).map(s => s.trim())).filter(Boolean);
    if (cities.length) {
      conds.push('(' + cities.map(() => 'city LIKE ?').join(' OR ') + ')');
      cities.forEach(c => params.push(`%${c}%`));
    }
  }
  like('grad_year', q.grad_year);
  like('education', q.education);
  like('exam', q.exam);
  eq('company', q.company);
  if (q.added_after) { conds.push('added_date >= ?'); params.push(q.added_after); }
  // 仅返回已截止岗位
  if (q.expired === '1') {
    conds.push(IS_EXPIRED);
  } else if (!q.include_expired || (q.include_expired !== '1' && q.include_expired !== 'true')) {
    // 默认不返回已截止信息（仅当显式 include_expired=1/true 时返回）
    conds.push(NOT_EXPIRED);
  }
  return { where: conds.join(' AND '), params };
}

const PUBLIC_COLS = `id, company, company_type, batch, industry, position, education, grad_year,
  city, publish_date, deadline, exam, notice_url, notice_summary, added_date, source, source_url, first_seen, positions, position_list,
  salary, org_intro, quality_score`;

app.get('/api/jobs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(50, parseInt(req.query.size) || 20);
  const { where, params } = buildJobQuery(req.query);
  let order = 'publish_date DESC, id DESC';
  if (req.query.sort === 'deadline') {
    order = 'CASE WHEN date(deadline) IS NOT NULL THEN 0 ELSE 1 END, deadline ASC, id DESC';
  } else if (req.query.sort === 'fresh' || req.query.order === 'fresh') {
    order = 'first_seen DESC, added_date DESC, id DESC';
  } else if (req.query.sort === 'quality') {
    order = 'quality_score DESC, publish_date DESC, id DESC';
  }
  // ---- 分行/同职位聚合（仅 active 列表；expired 历史列表不聚合）----
  // 同母公司(无则公司名) + 同职位 + 同批次 → 合并为一条，保留各分行投递入口
  let aggMap = new Map(), aggName = new Map(), excluded = [];
  if (!req.query.expired) {
    const GRP_KEY = `CASE WHEN parent_company IS NOT NULL AND parent_company<>'' THEN parent_company ELSE company END`;
    const groups = db.prepare(`
      SELECT ${GRP_KEY} AS gk, COUNT(*) cnt, MIN(id) rep_id,
             GROUP_CONCAT(city, '|') g_cities,
             GROUP_CONCAT(id, '|') g_ids,
             GROUP_CONCAT(company, '|') g_companies
      FROM jobs WHERE ${where}
      GROUP BY gk, position, batch HAVING cnt > 1
    `).all(...params);
    for (const g of groups) {
      const members = String(g.g_ids).split('|').map(Number);
      const cities = String(g.g_cities).split('|');
      const companies = String(g.g_companies).split('|');
      aggMap.set(g.rep_id, { count: g.cnt, cities, member_ids: members, member_companies: companies });
      aggName.set(g.rep_id, g.gk);
      excluded.push(...members.filter(id => id !== g.rep_id));
    }
  }
  let where2 = where;
  if (excluded.length) where2 += ` AND id NOT IN (${excluded.join(',')})`;
  const rawTotal = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE ${where}`).get(...params).c;
  const total = rawTotal - excluded.length;
  const list = db.prepare(`SELECT ${PUBLIC_COLS} FROM jobs WHERE ${where2} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  for (const j of list) {
    if (aggMap.has(j.id)) { j.group = aggMap.get(j.id); j.company = aggName.get(j.id); }
  }
  res.json({ total, page, size, list });
});

// 若该 id 是重复记录（已合并），返回其保留记录 id
function dupTarget(id) {
  const r = db.prepare("SELECT dup_of FROM jobs WHERE id=? AND status='dup'").get(id);
  return r && r.dup_of ? r.dup_of : null;
}

app.get('/api/jobs/:id', (req, res) => {
  let job = db.prepare(`SELECT * FROM jobs WHERE id=? AND status='active' AND ${NOT_SOCIAL}`).get(req.params.id);
  if (!job) {
    const t = dupTarget(req.params.id);
    if (t) job = db.prepare(`SELECT * FROM jobs WHERE id=? AND status='active' AND ${NOT_SOCIAL}`).get(t);
    if (!job) return res.status(404).json({ error: '信息不存在或已下架' });
  }
  const tier = userTier(req.user);
  const member = isMember(tier);
  if (!member) { job.apply_url = null; job.referral_code = null; }
  let fav = false, track = null;
  if (req.user) {
    fav = !!db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND job_id=?').get(req.user.id, job.id);
    const tr = db.prepare('SELECT * FROM job_tracks WHERE user_id=? AND job_id=?').get(req.user.id, job.id);
    if (tr) track = { id: tr.id, current: tr.current, stages: JSON.parse(tr.stages_json || '[]') };
  }
  const manual = offer.getManual(job.position);
  const manuals = offer.getManuals(job.position);
  // 两档分离：附上该岗位自身公告的「本次招聘画像」（notice_recruit），前端与 company_profiles.campus_recruit 企业级概览分开渲染
  if (job.notice_url) {
    const nr = db.prepare('SELECT data FROM notice_recruit WHERE notice_url=?').get(job.notice_url);
    if (nr) job.notice_recruit = nr.data;
  }
  res.json({ job, tier, locked: !member, fav, track, manual, manuals });
});

// 单岗位精准说明书（懒生成 + 缓存，失败回退静态大类说明书）
app.get('/api/job-manual/:id', (req, res) => {
  let job = db.prepare(`SELECT * FROM jobs WHERE id=? AND status='active' AND ${NOT_SOCIAL}`).get(req.params.id);
  if (!job) {
    const t = dupTarget(req.params.id);
    if (t) job = db.prepare(`SELECT * FROM jobs WHERE id=? AND status='active' AND ${NOT_SOCIAL}`).get(t);
    if (!job) return res.status(404).json({ error: '信息不存在或已下架' });
  }
  const profile = db.prepare('SELECT * FROM company_profiles WHERE name=?').get(job.parent_company || job.company) || null;
  if (profile && typeof profile.locations === 'string') {
    try { profile.locations = JSON.parse(profile.locations); } catch { profile.locations = []; }
  }
  jobManual.generate(job, profile)
    .then(m => res.json(m))
    .catch(e => res.status(500).json({ error: e.message || '生成失败' }));
});

// ---------- 企业档案（按母公司 parent_company 聚合） ----------
app.get('/api/companies', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = 50;
  let where = `status='active' AND ${NOT_SOCIAL}`, params = [];
  if (req.query.q) {
    const q = `%${req.query.q.trim()}%`;
    where += ' AND (parent_company LIKE ? OR company LIKE ?)';
    params.push(q, q);
  }
  if (req.query.company_type) {
    where += ' AND company_type = ?';
    params.push(req.query.company_type);
  }
  where += ` AND ${NOT_EXPIRED}`;
  const total = db.prepare(`SELECT COUNT(DISTINCT parent_company) c FROM jobs WHERE ${where}`).get(...params).c;
  const list = db.prepare(`
    SELECT parent_company AS company, MAX(company_index.slug) AS slug, COUNT(*) job_count, MAX(publish_date) latest,
           MAX(company_type) company_type, MAX(industry) industry,
           GROUP_CONCAT(DISTINCT batch) batches
    FROM jobs LEFT JOIN company_index ON company_index.name = parent_company
    WHERE ${where}
    GROUP BY parent_company ORDER BY job_count DESC, latest DESC LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  res.json({ total, page, size, list });
});

app.get('/api/companies/:name', (req, res) => {
  const name = resolveCompany(req.params.name);
  if (!name) return res.status(404).json({ error: '未找到该企业' });
  const members = db.prepare(`SELECT DISTINCT company FROM jobs WHERE parent_company=? AND status='active' AND ${NOT_SOCIAL}`).all(name).map(r => r.company);
  if (!members.length) return res.status(404).json({ error: '未找到该企业' });
  const jobs = db.prepare(`SELECT ${PUBLIC_COLS} FROM jobs WHERE parent_company=? AND status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL} ORDER BY publish_date DESC, id DESC`).all(name);
  const expiredJobs = db.prepare(`SELECT ${PUBLIC_COLS} FROM jobs WHERE parent_company=? AND status='active' AND ${IS_EXPIRED} AND ${NOT_SOCIAL} ORDER BY publish_date DESC, id DESC`).all(name);
  const rawPosts = db.prepare(`
    SELECT p.id, p.type, p.title, p.created_at, u.email, p.essence
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE (p.company IN (${members.map(() => '?').join(',')}) OR p.company=?) AND p.status='approved' ORDER BY p.id DESC LIMIT 60`).all(...members, name)
    .map(p => ({ ...p, email: p.email.replace(/^(.{2}).*@/, '$1***@') }));
  // 仅保留已提炼精华（牛客来源）的帖子用于聚合展示；用户原创暂不展示；不返回原始 content（避免侵权）
  const posts = rawPosts.filter(p => p.essence && String(p.essence).trim());
  const experience_summary = buildExperienceSummary(posts);
  const profile = db.prepare('SELECT * FROM company_profiles WHERE name=?').get(name) || null;
  if (profile && typeof profile.locations === 'string') {
    try { profile.locations = JSON.parse(profile.locations); } catch { profile.locations = []; }
  }
  // 官方投递入口（Campus2026 公司级入口，2026-08-10 导入）
  const entry = db.prepare('SELECT apply_url FROM company_index WHERE name=?').get(name);
  res.json({
    name, slug: slugOf(name), members, jobs, posts, expired_jobs: expiredJobs,
    profile, apply_url: entry && entry.apply_url || null, experience_summary,
    stats: { job_count: jobs.length, company_type: jobs[0] && jobs[0].company_type, industry: jobs[0] && jobs[0].industry }
  });
});

// ---------- 账号 ----------
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

// ---- 防爆破（2026-08-09）：内存态计数，重启清零可接受 ----
// 登录/验证码失败：email 维度 5 次失败锁 15 分钟；发验证码：IP 每日 20 次上限
const FAIL_LIMIT = 5, FAIL_WINDOW_MS = 15 * 60 * 1000;
const IP_SEND_DAILY = 20;
const loginFails = new Map();   // email -> { n, lockedUntil }
const ipSendCount = new Map();  // ip:YYYY-MM-DD -> count
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

function checkLoginLocked(email) {
  const rec = loginFails.get(String(email || '').toLowerCase());
  if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  return false;
}
function recordLoginFail(email) {
  const key = String(email || '').toLowerCase();
  const rec = loginFails.get(key) || { n: 0, lockedUntil: 0 };
  rec.n++;
  if (rec.n >= FAIL_LIMIT) { rec.lockedUntil = Date.now() + FAIL_WINDOW_MS; rec.n = 0; }
  loginFails.set(key, rec);
}
function recordLoginOk(email) { loginFails.delete(String(email || '').toLowerCase()); }

// 发送注册验证码（未配置 SMTP 时为演示模式：验证码直接随响应返回）
app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body || {};
  if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: '邮箱格式不正确' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(400).json({ error: '该邮箱已注册，请直接登录' });
  if (checkLoginLocked(email)) return res.status(429).json({ error: '操作过于频繁，请 15 分钟后再试' });
  // IP 每日发码上限（防批量抢注）
  const ip = clientIp(req);
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const ipKey = `${ip}:${day}`;
  const sent = ipSendCount.get(ipKey) || 0;
  if (sent >= IP_SEND_DAILY) return res.status(429).json({ error: '今日发送次数过多，请明日再试' });
  const recent = db.prepare(`SELECT created_at FROM email_codes WHERE email=? AND created_at > datetime('now','localtime','-${config.CODE_RESEND_SEC} seconds') ORDER BY id DESC LIMIT 1`).get(email);
  if (recent) return res.status(429).json({ error: `发送过于频繁，请 ${config.CODE_RESEND_SEC} 秒后再试` });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = fmtDT(new Date(Date.now() + config.CODE_TTL_MIN * 60000));
  db.prepare('INSERT INTO email_codes (email, code, expires_at) VALUES (?,?,?)').run(email, code, expires);
  db.prepare("DELETE FROM email_codes WHERE created_at < datetime('now','localtime','-1 day')").run(); // 清理过期
  ipSendCount.set(ipKey, sent + 1);
  if (ipSendCount.size > 2000) { const keep = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); for (const k of ipSendCount.keys()) if (!k.endsWith(':' + day) && !k.endsWith(':' + keep)) ipSendCount.delete(k); }
  if (mailer.isConfigured()) {
    try {
      await mailer.sendMail({ to: email, code, expireMin: config.CODE_TTL_MIN });
      return res.json({ message: '验证码已发送至邮箱，请查收（注意垃圾箱）' });
    } catch (e) {
      console.error('[mail] 发送失败:', e.message);
      return res.status(500).json({ error: '邮件发送失败，请稍后再试' });
    }
  }
  // 演示模式：SMTP 未配置，验证码直接返回给前端展示
  res.json({ message: '验证码已生成（演示模式：正式环境将发送至邮箱）', dev_code: code });
});

function consumeCode(email, code) {
  const row = db.prepare(`SELECT id FROM email_codes WHERE email=? AND code=? AND used=0 AND expires_at > datetime('now','localtime') ORDER BY id DESC LIMIT 1`).get(email, String(code || ''));
  if (!row) { recordLoginFail(email); return false; }
  db.prepare('UPDATE email_codes SET used=1 WHERE id=?').run(row.id);
  recordLoginOk(email);
  return true;
}

app.post('/api/auth/register', (req, res) => {
  const { email, password, code } = req.body || {};
  if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (checkLoginLocked(email)) return res.status(429).json({ error: '操作过于频繁，请 15 分钟后再试' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(400).json({ error: '该邮箱已注册，请直接登录' });
  if (!code) return res.status(400).json({ error: '请填写邮箱验证码' });
  if (!consumeCode(email, code)) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
  const trialEnd = fmtDT(addDays(now(), config.TRIAL_DAYS));
  const info = db.prepare('INSERT INTO users (email, pass_hash, trial_end) VALUES (?,?,?)')
    .run(email, hashPassword(password), trialEnd);
  recordLoginOk(email);
  const token = signToken({ uid: Number(info.lastInsertRowid) });
  res.json({ token, message: '注册成功，已免费开放全部功能' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (checkLoginLocked(email)) return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email || '');
  if (!u || !verifyPassword(password || '', u.pass_hash)) { recordLoginFail(email); return res.status(400).json({ error: '邮箱或密码错误' }); }
  recordLoginOk(email);
  const token = signToken({ uid: Number(u.id) });
  res.json({ token });
});

// 兼容旧端点：仅登录，不再自动注册（注册须经邮箱验证码流程）
app.post('/api/auth/upsert', (req, res) => {
  const { email, password } = req.body || {};
  if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (checkLoginLocked(email)) return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u) return res.status(400).json({ error: '该邮箱尚未注册，请切换到「注册」完成邮箱验证', code: 'NEED_REGISTER' });
  if (!verifyPassword(password, u.pass_hash)) { recordLoginFail(email); return res.status(400).json({ error: '邮箱或密码错误' }); }
  recordLoginOk(email);
  res.json({ token: signToken({ uid: Number(u.id) }), message: '登录成功' });
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  const tier = userTier(u);
  res.json({
    id: u.id, email: u.email, tier,
    trial_end: u.trial_end, paid_end: u.paid_end, created_at: u.created_at,
    fav_count: db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id=?').get(u.id).c,
    sub_count: db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE user_id=? AND enabled=1').get(u.id).c,
    track_count: db.prepare('SELECT COUNT(*) c FROM job_tracks WHERE user_id=?').get(u.id).c,
    vip_price: config.VIP_PRICE
  });
});

// ---------- 收藏 ----------
app.post('/api/favorites/:jobId', requireAuth, (req, res) => {
  const jid = req.params.jobId;
  const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND job_id=?').get(req.user.id, jid);
  if (exists) { db.prepare('DELETE FROM favorites WHERE user_id=? AND job_id=?').run(req.user.id, jid); return res.json({ fav: false }); }
  db.prepare('INSERT INTO favorites (user_id, job_id) VALUES (?,?)').run(req.user.id, jid);
  res.json({ fav: true });
});
app.get('/api/favorites', requireAuth, (req, res) => {
  const list = db.prepare(`SELECT j.id, j.company, j.batch, j.position, j.city, j.deadline, j.publish_date, j.grad_year, j.company_type, j.industry, j.education, j.exam
    FROM favorites f JOIN jobs j ON j.id=f.job_id WHERE f.user_id=? ORDER BY f.created_at DESC`).all(req.user.id);
  res.json({ list });
});

// ---------- 求职跟踪 ----------
// 阶段：投递 / 测评 / 笔试 / 面试(带轮次n) / offer / 被拒，每项含 date、可选 note
const STAGE_TYPES = ['投递', '测评', '笔试', '面试', 'offer', '被拒'];
function sanitizeStages(stages) {
  if (!Array.isArray(stages)) return null;
  const out = [];
  for (const s of stages.slice(0, 50)) {
    if (!s || !STAGE_TYPES.includes(s.type)) return null;
    const item = { type: s.type, date: String(s.date || '').slice(0, 10) };
    if (s.type === '面试') item.n = Math.min(20, Math.max(1, parseInt(s.n) || 1));
    if (s.note) item.note = String(s.note).slice(0, 200);
    out.push(item);
  }
  return out;
}
const stageLabel = s => s.type === '面试' ? `第${s.n}面` : s.type;

app.get('/api/tracks', requireAuth, (req, res) => {
  const list = db.prepare(`
    SELECT t.id track_id, t.job_id, t.stages_json, t.current, t.updated_at,
           j.company, j.position, j.batch, j.city, j.deadline, j.company_type
    FROM job_tracks t JOIN jobs j ON j.id = t.job_id
    WHERE t.user_id=? ORDER BY t.updated_at DESC`).all(req.user.id)
    .map(r => ({ ...r, stages: JSON.parse(r.stages_json || '[]'), stages_json: undefined }));
  res.json({ list });
});
app.post('/api/tracks/:jobId', requireAuth, (req, res) => {
  const job = db.prepare(`SELECT id FROM jobs WHERE id=? AND status='active' AND ${NOT_SOCIAL}`).get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '信息不存在或已下架' });
  const exists = db.prepare('SELECT id FROM job_tracks WHERE user_id=? AND job_id=?').get(req.user.id, job.id);
  if (exists) return res.json({ tracked: true, message: '已在跟踪列表中' });
  db.prepare('INSERT INTO job_tracks (user_id, job_id) VALUES (?,?)').run(req.user.id, job.id);
  res.json({ tracked: true, message: '已纳入跟踪，可在「我的-求职跟踪」中记录进展' });
});
app.put('/api/tracks/:jobId', requireAuth, (req, res) => {
  const tr = db.prepare('SELECT id FROM job_tracks WHERE user_id=? AND job_id=?').get(req.user.id, req.params.jobId);
  if (!tr) return res.status(404).json({ error: '尚未跟踪该信息' });
  const stages = sanitizeStages((req.body || {}).stages);
  if (!stages) return res.status(400).json({ error: '进展数据格式不正确' });
  stages.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const current = stages.length ? stageLabel(stages[stages.length - 1]) : '已跟踪';
  db.prepare(`UPDATE job_tracks SET stages_json=?, current=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(JSON.stringify(stages), current, tr.id);
  res.json({ ok: true, current, stages });
});
app.delete('/api/tracks/:jobId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM job_tracks WHERE user_id=? AND job_id=?').run(req.user.id, req.params.jobId);
  res.json({ ok: true, tracked: false });
});

// ---------- 订阅（会员功能已暂停，登录即用） ----------
function requirePaid(req, _res, next) {
  // 付费会员已暂停：登录用户即可使用每日情报邮件订阅
  next();
}
app.get('/api/subscriptions', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM subscriptions WHERE user_id=? ORDER BY id DESC').all(req.user.id)
    .map(s => ({ ...s, filters: JSON.parse(s.filters_json) }));
  const logs = db.prepare(`SELECT id, log_date, hits_count, jobs_json, sent, created_at
    FROM subscription_logs WHERE user_id=? ORDER BY log_date DESC, id DESC LIMIT 10`).all(req.user.id)
    .map(l => { let jobs = []; try { jobs = JSON.parse(l.jobs_json || '[]'); } catch {} return { ...l, jobs }; });
  res.json({ list, tier: userTier(req.user), logs });
});
app.post('/api/subscriptions', requireAuth, (req, res) => {
  const { name, filters } = req.body || {};
  if (!filters || typeof filters !== 'object') return res.status(400).json({ error: '缺少筛选条件' });
  // 付费会员已暂停：登录用户即可创建订阅
  // 每用户仅一条订阅：已存在则修改为新条件（可改设置）
  const json = JSON.stringify(filters);
  const existing = db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(req.user.id);
  if (existing) {
    db.prepare('UPDATE subscriptions SET name=?, filters_json=? WHERE id=?')
      .run(name || existing.name || '我的订阅', json, existing.id);
  } else {
    db.prepare('INSERT INTO subscriptions (user_id, name, filters_json) VALUES (?,?,?)')
      .run(req.user.id, name || '我的订阅', json);
  }
  res.json({ ok: true, modified: !!existing });
});
app.delete('/api/subscriptions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});
// 订阅预览：命中最近新增
app.get('/api/subscriptions/:id/preview', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: '订阅不存在' });
  const f = JSON.parse(s.filters_json);
  const { where, params } = buildJobQuery(f);
  const list = db.prepare(`SELECT ${PUBLIC_COLS} FROM jobs WHERE ${where} ORDER BY added_date DESC, id DESC LIMIT 20`).all(...params);
  res.json({ list });
});

// ---------- 订单（模拟支付） ----------
app.post('/api/orders', requireAuth, (req, res) => {
  const info = db.prepare('INSERT INTO orders (user_id, amount) VALUES (?,?)').run(req.user.id, config.VIP_PRICE);
  res.json({ order_id: Number(info.lastInsertRowid), amount: config.VIP_PRICE });
});
app.post('/api/orders/:id/mockpay', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status === 'paid') return res.json({ ok: true, message: '订单已支付' });
  const base = req.user.paid_end && new Date(req.user.paid_end) > now() ? new Date(req.user.paid_end) : now();
  const paidEnd = fmtDT(addDays(base, config.VIP_DAYS));
  const tx = db.transaction(() => {
    db.prepare("UPDATE orders SET status='paid', paid_at=datetime('now','localtime') WHERE id=?").run(o.id);
    db.prepare('UPDATE users SET paid_end=? WHERE id=?').run(paidEnd, req.user.id);
  });
  tx();
  res.json({ ok: true, paid_end: paidEnd, message: '（模拟）支付成功，会员已开通' });
});

// ---------- 简历优化（AI · 混元） ----------
const RESUME_QUOTA = 10; // 每账号上限：防恶意使用
const resumeRate = new Map(); // ip -> {t, n}
app.post('/api/resume/optimize', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const used = (db.prepare('SELECT n FROM resume_usage WHERE user_id=?').get(uid) || {}).n || 0;
  if (used >= RESUME_QUOTA) return res.status(403).json({ error: `简历优化次数已用完（每个账号上限 ${RESUME_QUOTA} 次）`, code: 'QUOTA_EXCEEDED', remain: 0 });
  let { resume, positions } = req.body || {};
  positions = Array.isArray(positions) ? positions.map(p => String(p).slice(0, 50)).filter(Boolean).slice(0, 5) : [];
  if (!resume || String(resume).trim().length < 50) return res.status(400).json({ error: '请完整粘贴简历内容（至少 50 字）' });
  if (!positions.length) return res.status(400).json({ error: '请先点「智能推荐岗位」并至少勾选一个目标岗位' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const t0 = Date.now();
  const r = resumeRate.get(ip) || { t: t0, n: 0 };
  if (t0 - r.t > 60000) { r.t = t0; r.n = 0; }
  if (++r.n > 5) return res.status(429).json({ error: '操作太频繁，请 1 分钟后再试' });
  resumeRate.set(ip, r);
  const sys = `你是一名有10年经验的校招简历顾问，曾帮助数千名应届生拿到大厂、国企、外企 offer。你精通 STAR 法则、用数据量化成果、简历关键词与 JD 匹配、一页纸信息密度、应届生常见雷区（流水账、无重点、空话套话、经历堆砌）。

输出规则：
- 只输出建议正文，不要客套话与开场白。
- 必须基于用户提供的简历原文给出具体、可执行的修改，禁止泛泛而谈。
- 对关键经历必须给出「改前 → 改后」对照示例，改后须体现动作、量化结果、能力关键词。
- 按优先级排序，先改影响最大的问题。
- 用中文、分点、清晰排版。`;
  try {
    const results = [];
    for (const position of positions) {
      const user = `目标岗位：${position}

我的简历原文：
${String(resume).slice(0, 8000)}

请严格按以下结构输出优化建议：
一、整体诊断：用1-2句话点出这份简历最致命的1-2个问题。
二、结构与表达问题：列出具体毛病，每条配「改前 → 改后」对照改写。
三、与目标岗位的匹配度：指出缺失的能力/经历，并给出补充方向。
四、立即可做的行动项：按优先级列出前3-5条。

要求：建议必须针对我的真实经历，给出能直接照抄的改写；不要给放之四海皆准的套话。`;
      const text = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.4, maxTokens: 2000 });
      if (!text) throw new Error('AI 服务暂不可用，请稍后再试');
      results.push({ position, advice: text });
    }
    db.prepare("INSERT INTO resume_usage(user_id,n,updated_at) VALUES(?,1,datetime('now','localtime')) ON CONFLICT(user_id) DO UPDATE SET n=n+1, updated_at=datetime('now','localtime')").run(uid);
    res.json({ results, remain: RESUME_QUOTA - (used + 1), total: RESUME_QUOTA });
  } catch (e) {
    res.status(502).json({ error: 'AI 生成失败：' + e.message });
  }
});

// ---------- 简历岗位推荐（AI · 混元） ----------
app.post('/api/resume/recommend-positions', requireAuth, async (req, res) => {
  const { resume } = req.body || {};
  if (!resume || String(resume).trim().length < 50) return res.status(400).json({ error: '请先上传或粘贴简历（至少 50 字）' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const t0 = Date.now(); const r = resumeRate.get(ip) || { t: t0, n: 0 };
  if (t0 - r.t > 60000) { r.t = t0; r.n = 0; }
  if (++r.n > 5) return res.status(429).json({ error: '操作太频繁，请 1 分钟后再试' });
  resumeRate.set(ip, r);
  const sys = `你是一名校招职业规划顾问，擅长根据学生简历匹配最合适的校招目标岗位。
只输出 JSON 数组，元素格式：{"title":"岗位全称","reason":"一句话匹配理由，不超过20字"}，不要任何多余文字、不要代码块标记。`;
  const user = `简历原文：\n${String(resume).slice(0, 8000)}\n\n请基于这份简历推荐 3-5 个最匹配的校招岗位（尽量覆盖不同方向），只返回严格 JSON 数组。`;
  try {
    const text = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.6, maxTokens: 700 });
    let positions = [];
    try { positions = JSON.parse(text); } catch (e) { const m = text.match(/\[[\s\S]*\]/); if (m) positions = JSON.parse(m[0]); }
    if (!Array.isArray(positions) || !positions.length) return res.status(502).json({ error: '岗位推荐失败，请重试' });
    positions = positions.filter(p => p && p.title).slice(0, 5).map(p => ({ title: String(p.title).slice(0, 40), reason: String(p.reason || '').slice(0, 40) }));
    res.json({ positions });
  } catch (e) { res.status(502).json({ error: 'AI 生成失败：' + e.message }); }
});

// ---------- 简历优化剩余次数 ----------
app.get('/api/resume/quota', requireAuth, (req, res) => {
  const used = (db.prepare('SELECT n FROM resume_usage WHERE user_id=?').get(req.user.id) || {}).n || 0;
  res.json({ used, remain: Math.max(0, RESUME_QUOTA - used), total: RESUME_QUOTA });
});

// ---------- 笔面经 ----------
app.post('/api/posts', requireAuth, (req, res) => {
  if (!isMember(userTier(req.user))) return res.status(403).json({ error: '试用已到期，开通会员后可发布笔面经', code: 'NEED_VIP' });
  const { company, type, title, content } = req.body || {};
  if (!company || !title || !content) return res.status(400).json({ error: '请填写完整内容' });
  db.prepare('INSERT INTO posts (company, user_id, type, title, content) VALUES (?,?,?,?,?)')
    .run(company, req.user.id, type || '面经', String(title).slice(0, 100), String(content).slice(0, 5000));
  res.json({ ok: true, message: '已提交，审核通过后展示' });
});

// ---------- 备考资料库（眼哥职说等外部资料，标注来源） ----------
app.get('/api/materials', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = 20;
  const conds = ['1=1'], params = [];
  if (req.query.q) { const q = '%' + req.query.q.trim() + '%'; conds.push('(title LIKE ? OR summary LIKE ?)'); params.push(q, q); }
  if (req.query.category) { conds.push('category=?'); params.push(req.query.category); }
  if (req.query.company) { conds.push('(company=? OR title LIKE ? OR summary LIKE ?)'); params.push(req.query.company, '%' + req.query.company + '%', '%' + req.query.company + '%'); }
  const where = conds.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM materials WHERE ${where}`).get(...params).c;
  const list = db.prepare(`SELECT id, title, category, company, source, summary, file_type, file_name, created_at FROM materials WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  res.json({ total, page, size, list });
});
app.get('/api/materials/cats', (_req, res) => {
  const list = db.prepare('SELECT DISTINCT category FROM materials ORDER BY category').all().map(r => r.category);
  res.json({ list });
});
app.get('/api/materials/:id', (req, res) => {
  const m = db.prepare('SELECT id, title, category, company, source, summary, file_type, file_name, created_at FROM materials WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '资料不存在' });
  res.json(m);
});
// 资料已改版为「校招练习」知识库，不再向用户直接提供下载/预览（原始文件仅作后台抽取语料）
app.get('/m/:id', (_req, res) => {
  res.status(403).json({ error: '资料已升级为校招练习知识库，不再提供文件下载。请前往「校招练习」在线学习。' });
});
app.get('/p/:id', (_req, res) => {
  res.status(403).json({ error: '资料已升级为校招练习知识库，不再提供文件预览。请前往「校招练习」在线学习。' });
});

// ===================== 校招练习（岗位维度改版） =====================
// 练习入口：Top20 岗位（来源=招聘库 position 归一化统计）
app.get('/api/practice/positions', (req, res) => {
  const assessment = db.prepare("SELECT COUNT(*) c FROM practice_questions WHERE position='综合测评'").get().c;
  res.json({ list: practice.listPositions(), assessment });
});

// 随机组卷：某岗位题库中抽 10 题（80% 笔试 + 20% 面试）
app.get('/api/practice/paper', (req, res) => {
  try {
    const name = req.query.position;
    if (!name) return res.status(400).json({ error: '缺少 position' });
    const size = req.query.size ? Math.max(1, Math.min(30, parseInt(req.query.size, 10))) : undefined;
    res.json(practice.buildPaper(name, size ? { size } : {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 整卷统一交卷判分（必须登录）
app.post('/api/practice/paper/submit', requireAuth, async (req, res) => {
  try {
    const { position, answers } = req.body || {};
    const r = await practice.submitPaper({ userId: req.user.id, position, answers });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 岗位维度进度（必须登录）
app.get('/api/practice/position-progress', requireAuth, (req, res) => {
  try {
    const name = req.query.position;
    if (!name) return res.status(400).json({ error: '缺少 position' });
    res.json(practice.getPositionProgress(req.user.id, name));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- 以下为题库维度旧接口（保留兼容） ----
app.get('/api/practice/banks', (req, res) => {
  const list = practice.listBanks({
    kind: req.query.kind, company_type: req.query.company_type, position: req.query.position
  });
  res.json({ list });
});

app.get('/api/practice/bank/:id', (req, res) => {
  const bank = practice.getBankMeta(req.params.id);
  if (!bank) return res.status(404).json({ error: '题库不存在' });
  const questions = practice.getBankQuestions(req.params.id);
  res.json({ bank, questions });
});

// 提交作答并判分（必须登录）
app.post('/api/practice/attempt', requireAuth, async (req, res) => {
  try {
    const { question_id, bank_id, answer } = req.body || {};
    if (!question_id || !bank_id) return res.status(400).json({ error: '缺少参数' });
    const r = await practice.submitAttempt({ userId: req.user.id, questionId: question_id, bankId: bank_id, answer });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 整卷统一提交并判分（必须登录）
app.post('/api/practice/attempt-batch', requireAuth, async (req, res) => {
  try {
    const { bank_id, answers } = req.body || {};
    if (!bank_id) return res.status(400).json({ error: '缺少 bank_id' });
    const r = await practice.submitAttemptBatch({ userId: req.user.id, bankId: bank_id, answers });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 错题集（必须登录）
app.get('/api/practice/wrong-set', requireAuth, (req, res) => {
  const list = practice.getWrongSet(req.user.id, req.query.bank_id, req.query.position);
  res.json({ list });
});

// 标记掌握（移出错题集）
app.post('/api/practice/wrong-set/resolve', requireAuth, (req, res) => {
  const { attempt_id } = req.body || {};
  if (!attempt_id) return res.status(400).json({ error: '缺少参数' });
  practice.resolveWrong(attempt_id, req.user.id);
  res.json({ ok: true });
});

// 进度（必须登录）
app.get('/api/practice/progress', requireAuth, (req, res) => {
  try {
    const p = practice.getProgress(req.user.id, req.query.bank_id);
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ================= 薪资/Offer 数据库 =================
// 筛选搜索（公开浏览）
app.get('/api/offer/search', (req, res) => {
  try {
    const { company, position, education, city, grad_year, sort } = req.query;
    const r = offer.searchOffers({ company, position, education, city, grad_year, sort, limit: 100 });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 全局限概览（公开）
app.get('/api/offer/stats', (_req, res) => {
  res.json(offer.getOfferStats());
});

// 爆料（需登录）
app.post('/api/offer/report', requireAuth, (req, res) => {
  try {
    const id = offer.reportOffer({ ...(req.body || {}), user_id: req.user.id });
    res.json(id);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 薪资参考区间（公开）
app.get('/api/offer/reference', (req, res) => {
  try {
    const r = offer.getReference(req.query);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 岗位上下文（job详情页配套）
app.get('/api/jobs/:id/context', (req, res) => {
  try {
    const ctx = offer.getJobContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: '岗位不存在或已下架' });
    res.json(ctx);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- 后台：薪资审核 / 求职攻略管理 ----
app.post('/api/admin/offer/review', requireAdmin, (req, res) => {
  try {
    const { id, action } = req.body || {};
    const r = offer.reviewOffer(Number(id), action);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/guides', requireAdmin, (req, res) => {
  res.json({ list: offer.listGuides() });
});

app.post('/api/admin/guides', requireAdmin, (req, res) => {
  try {
    const { position, stage, title, content, source } = req.body || {};
    if (!position || !title) return res.status(400).json({ error: '缺少 position/title' });
    const r = offer.upsertGuide({ position, stage, title, content, source });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 批量同步求职攻略（本地 → 线上，幂等：同 position+stage 自动替换，每个板块只留一条）
app.post('/api/admin/import-guides', requireAdmin, (req, res) => {
  const { guides } = req.body || {};
  if (!Array.isArray(guides)) return res.status(400).json({ error: 'guides 必须为数组' });
  let inserted = 0, updated = 0, skipped = 0;
  const check = db.prepare("SELECT id FROM career_guides WHERE position=? AND stage=?");
  const ins = db.prepare("INSERT INTO career_guides (position, stage, title, content, source) VALUES (?,?,?,?,?)");
  const upd = db.prepare("UPDATE career_guides SET title=?, content=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const g of guides) {
      if (!g || !g.position || !g.stage) continue;
      const exist = check.get(g.position, g.stage || null);
      if (exist) { upd.run(g.title || '', g.content || '', exist.id); updated++; }
      else { ins.run(g.position, g.stage || null, g.title || '', g.content || '', g.source || 'ai'); inserted++; }
    }
  });
  tx();
  invalidateSeoCache();  // 攻略有变动 → sitemap 需重新生成
  guidesCache = null; guidesCacheAt = 0;  // 攻略列表缓存同步失效
  res.json({ ok: true, inserted, updated, skipped });
});

// 批量导入薪资参考区间 + 爆料（幂等）
app.post('/api/admin/import-offers', requireAdmin, (req, res) => {
  try {
    const { references, salaries, clearSource } = req.body || {};
    // 按 source 清空（re-sync 场景）
    if (clearSource) {
      db.prepare('DELETE FROM offer_salaries WHERE source=?').run(clearSource);
      db.prepare('DELETE FROM offer_reference WHERE source LIKE ?').run('%' + clearSource + '%');
    }
    let refInserted = 0, salInserted = 0;
    if (Array.isArray(references)) {
      const ins = db.prepare(`INSERT OR IGNORE INTO offer_reference
        (company,position,education,tier,salary_min,salary_max,grad_year,source)
        VALUES (?,?,?,?,?,?,?,?)`);
      db.transaction(() => { for (const r of references) refInserted += ins.run(r.company,r.position||'',r.education||'',r.tier||'',r.salary_min,r.salary_max,r.grad_year,r.source||'').changes; })();
    }
    if (Array.isArray(salaries)) {
      const ins = db.prepare(`INSERT OR IGNORE INTO offer_salaries
        (company,parent_company,position,education,city,salary_text,month_min,month_max,months,total_min,total_max,grad_year,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => { for (const s of salaries) salInserted += ins.run(s.company||'',s.parent_company||'',s.position||'',s.education||'',s.city||'',s.salary_text||'',s.month_min||null,s.month_max||null,s.months||null,s.total_min||null,s.total_max||null,s.grad_year||'',s.source||'').changes; })();
    }
    res.json({ ok: true, refInserted, salInserted });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- 后台：题库/题目管理 ----
app.post('/api/admin/practice/bank', requireAdmin, (req, res) => {
  try {
    const id = practice.createBank(req.body || {});
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/practice/question', requireAdmin, (req, res) => {
  try {
    const id = practice.addQuestion(req.body || {});
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 批量同步岗位练习数据（本地 → 线上，幂等：同名岗位/同题干题目自动跳过）
app.post('/api/admin/import-practice', requireAdmin, (req, res) => {
  try {
    const { positions, questions } = req.body || {};
    if (!Array.isArray(positions) || !Array.isArray(questions))
      return res.status(400).json({ error: 'positions/questions 必须为数组' });
    const r = practice.importPractice({ positions, questions });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 管理后台 ----------
app.post('/api/admin/import', requireAdmin, (req, res) => {
  // 前端以 text/csv 直接上传文件内容
  const text = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body && req.body.csv));
  if (!text || text.length < 10) return res.status(400).json({ error: '请上传 CSV 内容' });
  try {
    const result = importCSV(text);
    metaCache = null;
    guidesCache = null; guidesCacheAt = 0;
    invalidateSeoCache();
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const one = sql => db.prepare(sql).get();
  res.json({
    jobs: one("SELECT COUNT(*) c FROM jobs WHERE status='active'").c,
    companies: one('SELECT COUNT(DISTINCT parent_company) c FROM jobs').c,
    users: one('SELECT COUNT(*) c FROM users').c,
    paid_users: one("SELECT COUNT(*) c FROM users WHERE paid_end > datetime('now','localtime')").c,
    subs: one('SELECT COUNT(*) c FROM subscriptions WHERE enabled=1').c,
    pending_posts: one("SELECT COUNT(*) c FROM posts WHERE status='pending'").c,
    orders_paid: one("SELECT COUNT(*) c FROM orders WHERE status='paid'").c,
    today_added: one(`SELECT COUNT(*) c FROM jobs WHERE added_date = date('now','localtime')`).c,
    pending_suggestions: one("SELECT COUNT(*) c FROM work_suggestions WHERE status='pending'").c,
    open_errors: one("SELECT COUNT(*) c FROM site_errors WHERE status IN ('open','flagged')").c,
    new_feedback: one("SELECT COUNT(*) c FROM feedback WHERE status='new'").c
  });
});

// ---------- 匿名意见反馈 ----------
// 简单内存限流：同一 IP 10 分钟内最多 5 条，防刷
const fbRate = new Map();
function fbRateOk(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 5;
  const arr = (fbRate.get(ip) || []).filter(t => now - t < win);
  if (arr.length >= max) { fbRate.set(ip, arr); return false; }
  arr.push(now); fbRate.set(ip, arr); return true;
}
const FB_CATS = ['功能建议', '内容纠错', '体验问题', '其他'];
app.post('/api/feedback', (req, res) => {
  const ip = monitor.clientIp(req);
  if (!fbRateOk(ip)) return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
  const body = req.body || {};
  let text = String(body.text || '').trim();
  let category = String(body.category || '其他');
  if (!FB_CATS.includes(category)) category = '其他';
  if (text.length < 2) return res.status(400).json({ error: '反馈内容太短' });
  if (text.length > 1000) text = text.slice(0, 1000);
  const page = String(body.page || (req.headers.referer || '')).slice(0, 200);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  try {
    db.prepare('INSERT INTO feedback (category, text, page, ua, ip) VALUES (?,?,?,?,?)')
      .run(category, text, page, ua, ip);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '反馈提交失败' });
  }
});

// ---------- 管理端：待办建议 / 错误日志 / 反馈 ----------
app.get('/api/admin/suggestions', requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const list = db.prepare('SELECT * FROM work_suggestions WHERE status=? ORDER BY ts DESC LIMIT 200').all(status);
  res.json({ list, total: list.length });
});
app.post('/api/admin/suggestions/:id/resolve', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body && req.body.action || '');
  const map = { accept: 'accepted', reject: 'rejected', done: 'done' };
  const status = map[action];
  if (!status) return res.status(400).json({ error: '无效操作' });
  const note = String((req.body && req.body.note) || '').slice(0, 500);
  db.prepare("UPDATE work_suggestions SET status=?, note=?, resolved_at=datetime('now','localtime') WHERE id=?")
    .run(status, note, id);
  // 关联错误一并标记 resolved
  if (status !== 'pending') db.prepare("UPDATE site_errors SET status='resolved' WHERE suggestion_id=?").run(id);
  res.json({ ok: true });
});
app.get('/api/admin/errors', requireAdmin, (req, res) => {
  const status = req.query.status || '';
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const list = status
    ? db.prepare('SELECT * FROM site_errors WHERE status=? ORDER BY ts DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM site_errors ORDER BY ts DESC LIMIT ?').all(limit);
  res.json({ list, total: list.length });
});
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const status = req.query.status || 'new';
  const list = db.prepare('SELECT * FROM feedback WHERE status=? ORDER BY ts DESC LIMIT 200').all(status);
  res.json({ list, total: list.length });
});
app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const list = db.prepare(`SELECT p.*, u.email FROM posts p JOIN users u ON u.id=p.user_id WHERE p.status=? ORDER BY p.id DESC LIMIT 100`).all(status);
  res.json({ list });
});
app.post('/api/admin/posts/:id/review', requireAdmin, (req, res) => {
  const st = req.body.approve ? 'approved' : 'rejected';
  db.prepare('UPDATE posts SET status=? WHERE id=?').run(st, req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = req.query.q ? '%' + req.query.q.trim() + '%' : null;
  const sql = q
    ? 'SELECT id, email, created_at, trial_end, paid_end FROM users WHERE email LIKE ? ORDER BY id DESC LIMIT 200'
    : 'SELECT id, email, created_at, trial_end, paid_end FROM users ORDER BY id DESC LIMIT 200';
  const list = q ? db.prepare(sql).all(q) : db.prepare(sql).all();
  res.json({ list });
});
app.post('/api/admin/users/:id/grant', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const days = parseInt(req.body.days) || 365;
  const base = u.paid_end && new Date(u.paid_end) > now() ? new Date(u.paid_end) : now();
  const paidEnd = fmtDT(addDays(base, days));
  db.prepare('UPDATE users SET paid_end=? WHERE id=?').run(paidEnd, u.id);
  res.json({ ok: true, paid_end: paidEnd });
});

// ---------- 管理后台：在库信息（jobs）列表/详情/状态管理（2026-08-09） ----------
app.get('/api/admin/jobs', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, parseInt(req.query.size) || 20);
  const conds = ["1=1"], params = [];
  if (req.query.q) {
    const q = '%' + req.query.q.trim() + '%';
    conds.push('(company LIKE ? OR position LIKE ? OR industry LIKE ? OR parent_company LIKE ?)');
    params.push(q, q, q, q);
  }
  if (req.query.company) { conds.push('company LIKE ?'); params.push('%' + req.query.company + '%'); }
  if (req.query.batch) { conds.push('batch LIKE ?'); params.push('%' + req.query.batch + '%'); }
  if (req.query.city) { conds.push('city LIKE ?'); params.push('%' + req.query.city + '%'); }
  const status = req.query.status || 'active';
  if (status === 'active') conds.push("status='active'");
  else if (status === 'dup') conds.push("status='dup'");
  else if (status === 'expired') conds.push("status='active' AND " + IS_EXPIRED);
  const where = conds.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE ${where}`).get(...params).c;
  const list = db.prepare(`SELECT id, company, parent_company, position, batch, city, grad_year, education, exam, deadline, publish_date, added_date, source, status, dup_of, notice_url, apply_url, referral_code, remark
    FROM jobs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  res.json({ total, page, size, list });
});

app.get('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '信息不存在' });
  res.json({ job });
});

// 状态管理：active/dup（dup 需传 dup_of 指向保留记录，仅信息性标记，不物理删除）
app.post('/api/admin/jobs/:id/status', requireAdmin, (req, res) => {
  const { status, dup_of } = req.body || {};
  if (!['active', 'dup', 'deleted'].includes(status)) return res.status(400).json({ error: 'status 不合法' });
  const job = db.prepare('SELECT id FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '信息不存在' });
  if (status === 'dup') {
    const target = db.prepare("SELECT id FROM jobs WHERE id=? AND status='active'").get(dup_of || 0);
    if (!target) return res.status(400).json({ error: 'dup_of 必须指向一条有效记录' });
    db.prepare("UPDATE jobs SET status='dup', dup_of=? WHERE id=?").run(target.id, req.params.id);
  } else if (status === 'deleted') {
    db.prepare("UPDATE jobs SET status='deleted' WHERE id=?").run(req.params.id);
  } else {
    db.prepare("UPDATE jobs SET status='active', dup_of=NULL WHERE id=?").run(req.params.id);
  }
  metaCache = null; guidesCache = null; guidesCacheAt = 0; invalidateSeoCache();
  res.json({ ok: true });
});

// ---------- 管理后台：企业列表/详情（2026-08-09） ----------
app.get('/api/admin/companies', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, parseInt(req.query.size) || 20);
  const conds = ["1=1"], params = [];
  if (req.query.q) { const q = '%' + req.query.q.trim() + '%'; conds.push('(parent_company LIKE ? OR company LIKE ?)'); params.push(q, q); }
  const where = conds.join(' AND ');
  const total = db.prepare(`SELECT COUNT(DISTINCT parent_company) c FROM jobs WHERE ${where}`).get(...params).c;
  const list = db.prepare(`
    SELECT parent_company AS name, COALESCE(ci.slug, parent_company) AS slug,
      COUNT(*) job_count, MAX(company_type) company_type, MAX(industry) industry,
      MAX(publish_date) latest, GROUP_CONCAT(DISTINCT batch) batches
    FROM jobs j LEFT JOIN company_index ci ON ci.name=j.parent_company
    WHERE ${where} GROUP BY parent_company
    ORDER BY job_count DESC, latest DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  res.json({ total, page, size, list });
});

app.get('/api/admin/companies/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const jobs = db.prepare(`SELECT id, company, position, batch, city, deadline, publish_date, status, added_date FROM jobs WHERE parent_company=? ORDER BY id DESC LIMIT 200`).all(name);
  if (!jobs.length) return res.status(404).json({ error: '未找到该企业' });
  const members = db.prepare('SELECT DISTINCT company FROM jobs WHERE parent_company=?').all(name).map(r => r.company);
  const posts = db.prepare(`SELECT p.id, p.type, p.title, p.status, p.created_at, u.email FROM posts p JOIN users u ON u.id=p.user_id WHERE p.company IN (${members.map(() => '?').join(',')}) ORDER BY p.id DESC LIMIT 50`).all(...members);
  const profile = db.prepare('SELECT * FROM company_profiles WHERE name=?').get(name) || null;
  res.json({ name, slug: slugOf(name), members, jobs, posts, profile });
});

// ---------- 管理后台：订阅列表/启停/删除（2026-08-09） ----------
app.get('/api/admin/subscriptions', requireAdmin, (req, res) => {
  const list = db.prepare(`SELECT s.id, s.user_id, s.name, s.filters_json, s.enabled, s.created_at, u.email
    FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 200`).all()
    .map(s => ({ ...s, filters: (() => { try { return JSON.parse(s.filters_json); } catch { return null; } })() }));
  res.json({ list });
});

app.post('/api/admin/subscriptions/:id/toggle', requireAdmin, (req, res) => {
  const s = db.prepare('SELECT id FROM subscriptions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '订阅不存在' });
  db.prepare('UPDATE subscriptions SET enabled = 1 - enabled WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/subscriptions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 管理后台：订单列表（2026-08-09） ----------
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const list = db.prepare(`SELECT o.id, o.user_id, o.amount, o.status, o.created_at, o.paid_at, u.email
    FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 200`).all();
  res.json({ list });
});

// 每日邮件数据接口（供定时任务调用）：返回每个订阅用户（试用期/付费）的匹配命中
// 注意：窗口用「最近 2 天」（added_date >= 昨天），避免当天 09:00 数据尚未入库时漏发、次日不补
app.get('/api/admin/daily-digest', requireAdmin, (_req, res) => {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const since = new Date(Date.now() + 8 * 3600 * 1000 - 2 * 86400000).toISOString().slice(0, 10);
  const subs = db.prepare(`
    SELECT s.*, u.email, u.paid_end, u.trial_end FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.enabled=1 AND (u.paid_end > datetime('now','localtime') OR u.trial_end > datetime('now','localtime'))`).all();
  const out = [];
  for (const s of subs) {
    const f = JSON.parse(s.filters_json);
    f.added_after = since;
    const { where, params } = buildJobQuery(f);
    const hits = db.prepare(`SELECT ${PUBLIC_COLS}, apply_url FROM jobs WHERE ${where} ORDER BY id DESC LIMIT 50`).all(...params);
    if (hits.length) out.push({
      user_id: s.user_id, subscription_id: s.id, email: s.email, sub_name: s.name,
      hits_count: hits.length,
      hits: hits.map(h => ({ id: h.id, company: h.company, position: h.position, city: h.city, batch: h.batch, deadline: h.deadline, added_date: h.added_date, apply_url: h.apply_url }))
    });
  }
  res.json({ date: today, since, digests: out });
});

// 企业档案编辑（管理后台）
app.put('/api/admin/company-profile', requireAdmin, (req, res) => {
  const { name, intro, locations, website, logo, campus_recruit } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少企业名称' });
  const locStr = Array.isArray(locations) ? JSON.stringify(locations) : (locations || '[]');
  db.prepare(`INSERT INTO company_profiles (name, intro, locations, website, logo, campus_recruit) VALUES (?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET intro=excluded.intro, locations=excluded.locations, website=excluded.website, logo=excluded.logo, campus_recruit=excluded.campus_recruit`)
    .run(name, intro || '', locStr, website || '', logo || '', campus_recruit || '');
  res.json({ message: '企业档案已更新' });
});

// 批量回填 jobs.salary / org_intro（校招画像抽取后的第二步；仅填空白行，不覆盖既有值）
// 支持两种载体：
//   - rows: [{company, salary, org_intro}]  公司级代表值（旧）
//   - jobs: [{id, salary, org_intro}]        岗位级精确值（新，优先）
app.put('/api/admin/jobs-recruit-fields', requireAdmin, (req, res) => {
  const body = req.body || {};
  const rows = body.rows, jobs = body.jobs;
  if (!Array.isArray(rows) && !Array.isArray(jobs)) return res.status(400).json({ error: 'rows 或 jobs 必为数组' });
  const uSalaryCo = db.prepare(`UPDATE jobs SET salary=? WHERE (company=? OR parent_company=?) AND (salary IS NULL OR salary='')`);
  const uOrgCo = db.prepare(`UPDATE jobs SET org_intro=? WHERE (company=? OR parent_company=?) AND (org_intro IS NULL OR org_intro='')`);
  const uSalary = db.prepare(`UPDATE jobs SET salary=? WHERE id=? AND (salary IS NULL OR salary='')`);
  const uOrg = db.prepare(`UPDATE jobs SET org_intro=? WHERE id=? AND (org_intro IS NULL OR org_intro='')`);
  let ns = 0, no = 0;
  db.transaction(() => {
    if (Array.isArray(jobs)) {
      for (const r of jobs) {
        if (r.id == null) continue;
        if (r.salary) ns += uSalary.run(r.salary, r.id).changes;
        if (r.org_intro) no += uOrg.run(r.org_intro, r.id).changes;
      }
    }
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (!r.company) continue;
        if (r.salary) ns += uSalaryCo.run(r.salary, r.company, r.company).changes;
        if (r.org_intro) no += uOrgCo.run(r.org_intro, r.company, r.company).changes;
      }
    }
  })();
  res.json({ updated_salary: ns, updated_org: no });
});

// ===================== 求职攻略（公开） =====================
// 攻略列表缓存：/api/guides 每次全表扫描 9641 行 + JS 聚合（实测 0.29-0.45s），
// 加 TTL 缓存（与 metaCache 同策略；导入/攻略变更时失效）
let guidesCache = null;
let guidesCacheAt = 0;
const GUIDES_TTL = 5 * 60 * 1000;

function buildGuidesList() {
  const counts = new Map();
  const rows = db.prepare("SELECT position FROM jobs WHERE status='active' AND position IS NOT NULL AND position<>''").all();
  for (const r of rows) for (const c of tax.classify(r.position)) counts.set(c, (counts.get(c) || 0) + 1);
  const list = db.prepare(`
    SELECT g.position AS name, COUNT(*) gcount,
      (SELECT COUNT(*) FROM practice_questions pq WHERE pq.position=g.position) practiceN
    FROM career_guides g WHERE g.status='active'
    GROUP BY g.position
    ORDER BY COALESCE((SELECT p.job_count FROM practice_positions p WHERE p.name=g.position), 0) DESC, gcount DESC`).all();
  return list.map(p => ({
    name: p.name, job_count: counts.get(p.name) || 0, gcount: p.gcount,
    practiceN: p.practiceN, hasPractice: p.practiceN > 0, slug: posSlugOf(p.name)
  }));
}

app.get('/api/guides', (_req, res) => {
  if (!guidesCache || Date.now() - guidesCacheAt > GUIDES_TTL) { guidesCache = buildGuidesList(); guidesCacheAt = Date.now(); }
  res.json({ list: guidesCache });
});

app.get('/api/guides/:position', (req, res) => {
  const position = posNameOfSlug(req.params.position);
  if (!position) return res.status(404).json({ error: '未找到该岗位攻略' });
  const guides = db.prepare("SELECT * FROM career_guides WHERE position=? AND status='active' ORDER BY created_at DESC").all(position);
  if (!guides.length) return res.status(404).json({ error: '该岗位攻略整理中' });
  const practiceN = db.prepare("SELECT COUNT(*) c FROM practice_questions WHERE position=?").get(position).c;
  const salaryN = db.prepare("SELECT COUNT(*) c FROM offer_reference WHERE position=?").get(position).c;
  // 在招数：从 guidesCache 命中（避免重复全表扫描；缓存过期时兜底重建）
  if (!guidesCache || Date.now() - guidesCacheAt > GUIDES_TTL) { guidesCache = buildGuidesList(); guidesCacheAt = Date.now(); }
  const cached = guidesCache.find(g => g.name === position);
  const jobCount = cached ? cached.job_count : 0;
  res.json({ position, slug: posSlugOf(position), job_count: jobCount, practiceN, salaryN, hasPractice: practiceN > 0, guides });
});

// ---------- SEO：静态化快照（机器人返回完整 HTML，人类返回 SPA） ----------
app.get('/job/:id', (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE id=? AND status='active'").get(req.params.id);
  if (!job) {
    const t = dupTarget(req.params.id);
    if (t) return res.redirect(301, '/job/' + t);   // 重复记录统一 301 到保留记录
    return res.status(404).json({ error: '信息不存在或已下架' });
  }
  const ua = req.headers['user-agent'] || '';
  if (isBot(ua)) {
    // 搜索引擎/AI 抓取：返回完整静态 SSR（含 JSON-LD 结构化数据）
    const host = req.headers.host || `localhost:${config.PORT}`;
    let profile = db.prepare('SELECT * FROM company_profiles WHERE name=?').get(job.parent_company || job.company) || null;
    if (profile && typeof profile.locations === 'string') {
      try { profile.locations = JSON.parse(profile.locations); } catch { profile.locations = []; }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(renderJob(db, job, host, profile));
  }
  // 人类浏览器访问：返回 SPA，由前端渲染完整交互（收藏、跟踪、企业简介、办公地点等）
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(require('fs').readFileSync(indexPath, 'utf8'));
});

app.get('/company/:name', (req, res) => {
  const raw = req.params.name;
  const name = resolveCompany(raw);
  if (!name) return res.status(404).json({ error: '未找到该企业' });
  // SEO：中文/原始名 URL 统一 301 重定向到 slug，避免重复收录
  const slug = slugOf(name);
  if (slug && slug !== raw) return res.redirect(301, '/company/' + slug);
  const ua = req.headers['user-agent'] || '';
  if (!isBot(ua)) {
    // 人类浏览器访问：返回 SPA，由前端渲染完整交互（企业简介、办公地点、资料、笔面经等）
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(require('fs').readFileSync(indexPath, 'utf8'));
  }
  const members = db.prepare(`SELECT DISTINCT company FROM jobs WHERE parent_company=? AND status='active' AND ${NOT_SOCIAL}`).all(name).map(r => r.company);
  if (!members.length) return res.status(404).json({ error: '未找到该企业' });
  const jobs = db.prepare(`SELECT ${PUBLIC_COLS} FROM jobs WHERE parent_company=? AND status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL} ORDER BY publish_date DESC, id DESC`).all(name);
  const expiredJobs = db.prepare(`SELECT ${PUBLIC_COLS} FROM jobs WHERE parent_company=? AND status='active' AND ${IS_EXPIRED} AND ${NOT_SOCIAL} ORDER BY publish_date DESC, id DESC`).all(name);
  const rawPosts = db.prepare(`
    SELECT p.id, p.type, p.title, p.created_at, u.email, p.essence
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE (p.company IN (${members.map(() => '?').join(',')}) OR p.company=?) AND p.status='approved' ORDER BY p.id DESC LIMIT 60`).all(...members, name)
    .map(p => ({ ...p, email: p.email.replace(/^(.{2}).*@/, '$1***@') }));
  const posts = rawPosts.filter(p => p.essence && String(p.essence).trim());
  const experience_summary = buildExperienceSummary(posts);
  const profile = db.prepare('SELECT * FROM company_profiles WHERE name=?').get(name) || null;
  if (profile && typeof profile.locations === 'string') {
    try { profile.locations = JSON.parse(profile.locations); } catch { profile.locations = []; }
  }
  const d = {
    name, slug, members, jobs, posts, expired_jobs: expiredJobs, profile, experience_summary,
    stats: { job_count: jobs.length, company_type: jobs[0] && jobs[0].company_type, industry: jobs[0] && jobs[0].industry }
  };
  const host = req.headers.host || `localhost:${config.PORT}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(renderCompany(d, host));
});

app.get('/sitemap.xml', (req, res) => {
  const host = req.headers.host || `localhost:${config.PORT}`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.end(buildSitemap(db, host));
});

app.get('/robots.txt', (req, res) => {
  const host = req.headers.host || `localhost:${config.PORT}`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(buildRobots(host));
});

app.get('/llms.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(buildLlms(db));
});

app.get('/llms-full.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(buildLlmsFull(db));
});

// ---------- AI 发现端点（GEO P0，2026-08-12） ----------
app.get('/ai/summary.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  try {
    const total = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL}`).get().c;
    const companies = db.prepare(`SELECT COUNT(DISTINCT parent_company) c FROM jobs WHERE status='active' AND ${NOT_EXPIRED} AND ${NOT_SOCIAL} AND parent_company IS NOT NULL AND parent_company<>''`).get().c;
    const qcount = db.prepare('SELECT COUNT(*) c FROM practice_questions').get().c;
    const guideCount = db.prepare('SELECT COUNT(DISTINCT position) c FROM career_guides WHERE status=\'active\'').get().c || 0;
    res.json({
      name: '校招宝 · 应届生校招情报站',
      alternateName: '校招宝',
      url: 'https://xiaozhaobao.com.cn/',
      inLanguage: 'zh-CN',
      description: '面向应届生的校园招聘情报站：聚合秋招、春招、实习、提前批等招聘信息，提供企业档案、求职攻略、岗位练习与薪资参考。',
      stats: { total_jobs: total, companies, practice_questions: qcount, guides: guideCount },
      update_frequency: '每日更新，覆盖校招全周期',
      data_sources: '企业官方公告与公开渠道，均标注来源',
      key_pages: [
        { title: '校招信息列表', url: 'https://xiaozhaobao.com.cn/' },
        { title: '企业档案库', url: 'https://xiaozhaobao.com.cn/companies' },
        { title: '求职攻略', url: 'https://xiaozhaobao.com.cn/guides' },
        { title: '校招薪资参考', url: 'https://xiaozhaobao.com.cn/offers' },
        { title: '校招练习', url: 'https://xiaozhaobao.com.cn/materials' }
      ],
      generated_at: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/ai/faq.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    name: '校招宝 · 常见问题',
    faqs: [
      { question: '校招宝是什么？', answer: '校招宝是一个面向应届生的校园招聘情报站，聚合秋招、春招、实习、提前批等招聘信息，提供精准筛选、企业档案、求职攻略、岗位练习与薪资参考。' },
      { question: '校招宝的招聘信息来自哪里？', answer: '所有招聘信息均来自企业官方公告与公开渠道并标注来源，投递前请以企业官方公告为准。' },
      { question: '校招宝收费吗？', answer: '注册赠送 15 天免费试用，可查看投递链接与内推码；会员年费 99 元。' },
      { question: '校招宝数据多久更新？', answer: '招聘数据每日更新，覆盖秋招、春招、实习、提前批等校招全周期。' },
      { question: '如何查看企业的全部在招岗位？', answer: '在企业档案库搜索企业名称，即可查看该企业全部在招岗位、笔面经与招聘动态。' },
      { question: '在哪里做岗位练习？', answer: '校招练习板块按岗位提供在线练习题，每卷 10 题、自动判分，覆盖笔试面试高频考点。' }
    ]
  });
});

app.get('/ai/service.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    name: '校招宝 · 应届生校招情报站',
    url: 'https://xiaozhaobao.com.cn/',
    description: '面向应届生的校园招聘情报站，提供校招信息聚合、企业档案、求职攻略、岗位练习与薪资参考服务。',
    capabilities: [
      { name: '校招信息检索', description: '按公司、岗位、城市、学历、届别筛选秋招/春招/实习/提前批招聘信息。' },
      { name: '企业档案查询', description: '按母公司聚合全部在招岗位、笔面经与招聘动态。' },
      { name: '求职攻略', description: '按岗位提供笔试备考、面试技巧与薪资参考。' },
      { name: '岗位练习', description: '在线作答、自动判分，覆盖笔试面试高频考点。' },
      { name: '薪资参考', description: '校招薪资区间参考与真实匿名爆料。' }
    ]
  });
});

// ---------- 全页面 SSR（搜索引擎可见） ----------
const ssrSend = (fn, ...args) => (req, res) => {
  const host = req.headers.host || `localhost:${config.PORT}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache'); // HTML 不缓存，保证版本更新后立即生效
  res.end(fn(...args, host));
};

// 开源版：根路径 = 校招首页（主项目线上为公安备案博客，开源版直接展示产品）
app.get('/', ssrSend(renderHome, db));

app.get('/companies', ssrSend(renderCompanies, db));
app.get('/expired', ssrSend(renderExpired, db));
app.get('/materials', ssrSend(renderMaterials, db));
app.get('/offers', ssrSend(renderOffers, db));
app.get('/guides', ssrSend(renderGuides, db));
app.get('/guide/:position', (req, res) => {
  let position = posNameOfSlug(req.params.position);
  if (!position) {
    // 兜底：参数本身就是中文岗位名（来自 /guides 列表的 encodeURIComponent(name) 链接，或 TOP30 外未登记 slug 的岗位）。
    // 注意：req.params.position 已被路由解码，此处勿再 decodeURIComponent（否则原始中文 URL 会抛 URIError）。
    const raw = req.params.position;
    if (db.prepare("SELECT 1 FROM career_guides WHERE position=? AND status='active' LIMIT 1").get(raw)) position = raw;
  }
  if (!position) return res.status(404).json({ error: '未找到该岗位攻略' });
  const ua = req.headers['user-agent'] || '';
  const host = req.headers.host || `localhost:${config.PORT}`;
  if (!isBot(ua)) {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(require('fs').readFileSync(indexPath, 'utf8'));
  }
  const html = renderGuide(db, host, position);
  if (!html) return res.status(404).json({ error: '未找到该岗位攻略' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
});
app.get('/login', ssrSend(renderStatic, { title:'登录 / 注册 - 校招宝', description:'登录或注册校招宝账号，注册送15天免费试用。', body:
  `<div style="padding:40px 20px;text-align:center"><div style="font-size:40px">🎯</div><h2>校招宝</h2><p style="color:var(--text2)">登录 / 注册</p>
   <p style="color:#999;font-size:12px;margin-top:16px"><a href="/privacy" style="color:#3b5bfd">隐私政策</a> · <a href="/terms" style="color:#3b5bfd">用户协议</a></p>
  </div>` }));
app.get('/register', (req, res) => { res.statusCode = 301; res.setHeader('Location', '/login'); res.end(); });
// 付费会员已暂停（2026-08-11）：/vip 一律 301 到个人中心
app.get('/vip', (req, res) => { res.statusCode = 301; res.setHeader('Location', '/me'); res.end(); });
app.get('/resume', ssrSend(renderStatic, { title:'简历优化 - 校招宝', description:'AI 简历优化：粘贴简历与目标岗位，AI 帮你找出问题、提升匹配度、给出改写建议，助力校招上岸。', body:
  `<div style="padding:20px 12px"><div class="empty">加载中…</div></div>` }));
app.get('/fav', ssrSend(renderStatic, { title:'我的收藏 - 校招宝', description:'我的收藏校招信息。', body:
  `<div style="padding:20px 12px"><div class="empty">加载中…</div></div>` }));
app.get('/tracks', ssrSend(renderStatic, { title:'求职跟踪 - 校招宝', description:'求职跟踪记录。', body:
  `<div style="padding:20px 12px"><div class="empty">加载中…</div></div>` }));
app.get('/subs', ssrSend(renderStatic, { title:'每日情报邮件订阅 - 校招宝', description:'订阅校招情报邮件。', body:
  `<div style="padding:20px 12px"><div class="empty">加载中…</div></div>` }));
app.get('/me', ssrSend(renderStatic, { title:'个人中心 - 校招宝', description:'校招宝个人中心。', body:
  `<div style="padding:20px 12px"><div class="empty">加载中…</div></div>` }));
// ---------- 合规页（2026-08-09：隐私政策 / 用户协议） ----------
app.get('/privacy', ssrSend(renderStatic, { title:'隐私政策 - 校招宝', description:'校招宝隐私政策：我们如何收集、使用与保护你的个人信息。', body:
  `<article class="page" style="padding:20px 16px;max-width:720px;margin:0 auto;line-height:1.8">
    <h1 style="font-size:20px;margin:0 0 8px">校招宝隐私政策</h1>
    <p style="color:#666;font-size:12px">更新日期：2026-08-09</p>
    <h2 style="font-size:15px;margin:18px 0 6px">1. 我们收集的信息</h2>
    <p>注册登录：邮箱地址与密码（密码加密存储）；求职跟踪：你主动记录的投递/测评/笔试/面试/Offer 进展；收藏与订阅：你收藏的岗位与订阅筛选条件；练习记录：答题记录与错题集（用于学习进度）。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">2. 信息的使用</h2>
    <p>用于提供岗位检索、求职跟踪、订阅提醒、练习判分等服务；仅在获得你授权或法律要求时向第三方提供。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">3. 信息的存储与保护</h2>
    <p>数据存储于中国境内服务器，采取加密与访问控制措施；密码使用安全哈希存储，不存储明文。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">4. 你的权利</h2>
    <p>你可随时在「个人中心」查看、修改或删除你的账号信息与求职数据；注销账号可联系我们处理。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">5. Cookie 与本地存储</h2>
    <p>本站使用浏览器本地存储（localStorage）保存登录态与搜索历史，不使用第三方跟踪 Cookie。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">6. 联系我们</h2>
    <p>如有隐私相关疑问，请通过邮件联系：28473@qq.com。</p>
  </article>` }));
app.get('/terms', ssrSend(renderStatic, { title:'用户协议 - 校招宝', description:'校招宝用户协议：使用本站服务前请阅读并同意本协议。', body:
  `<article class="page" style="padding:20px 16px;max-width:720px;margin:0 auto;line-height:1.8">
    <h1 style="font-size:20px;margin:0 0 8px">校招宝用户协议</h1>
    <p style="color:#666;font-size:12px">更新日期：2026-08-09</p>
    <h2 style="font-size:15px;margin:18px 0 6px">1. 服务说明</h2>
    <p>校招宝为应届生提供校招信息聚合、求职攻略、岗位练习与薪资参考服务。招聘信息来源于公开渠道，投递前请以企业官方公告为准。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">2. 账号与会员</h2>
    <p>注册即可免费使用全部功能（含投递入口、每日情报邮件、企业档案、笔面经等）。请勿恶意注册、批量注册或利用系统漏洞获取权益。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">3. 用户行为规范</h2>
    <p>请勿发布违法、侵权、骚扰或垃圾信息；请勿利用本站数据从事商业爬取、转售等行为；请勿攻击、干扰本站正常服务。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">4. 内容与免责声明</h2>
    <p>薪资数据与攻略内容来自公开汇总、用户爆料与 AI 生成，仅供参考，不构成任何承诺；信息准确性与时效性以官方发布为准。</p>
    <h2 style="font-size:15px;margin:18px 0 6px">5. 协议变更</h2>
    <p>我们可能适时更新本协议，更新后将在本站公示。继续使用即视为接受更新后的协议。</p>
  </article>` }));

// ---------- 运维监控：错误捕获 / 安全自恢复 / 自动上报 ----------
// 复位热点缓存（DB 锁等瞬态错误重试前调用），涵盖 meta 与攻略缓存
monitor.setCacheReset(() => { metaCache = null; metaCacheAt = 0; try { guidesCache = null; guidesCacheAt = 0; } catch {} invalidateSeoCache(); });
app.onError(monitor.handleWebError);
monitor.initProcessHandlers();

app.listen(config.PORT, () => {
  console.log(`校招宝已启动: http://localhost:${config.PORT}`);
  buildMeta();
});
