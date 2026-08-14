const crypto = require('crypto');
const db = require('../db');
const { normCity, normGradYear, normIndustry, normCompanyType, normExam, normReferral, cleanCompany, fpNorm } = require('./normalize');
const { canonicalCompany } = require('./brands');

// ---- CSV 解析（支持引号内逗号与换行）----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// 北京时间日期（YYYY-MM-DD）：added_date/first_seen 统一按中国时区，避免 UTC 日期错位（本地 0-8 点入库记成前一天）
function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cleanUrl(raw) {
  if (!raw) return { url: '', type: 'link' };
  raw = raw.trim();
  const emailMatch = raw.match(/邮箱[:：]?\s*([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/) ||
    (!/^https?:\/\//.test(raw) && raw.match(/([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/));
  if (emailMatch) return { url: emailMatch[1], type: 'email' };
  if (/^https?:\/\//.test(raw)) return { url: raw, type: 'link' };
  return { url: raw, type: 'text' };
}

/** 第三方垃圾聚合站/广告站域名黑名单（2026-08-13 加入）：
 *  命中 notice_url/apply_url 的链接一律置空丢弃——此类站点与招聘公告无关（教程页/作弊工具广告页），
 *  且第三方源表无法修正，必须在本端入库前拦截。命中不阻止岗位入库（信息可能真实），仅丢弃错误链接。
 */
const BAD_LINK_HOSTS = ['givemeoc.com', 'playoffer.cn'];
function isBadLink(u) {
  const s = String(u || '').toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;
  try {
    const host = new URL(s).hostname;
    return BAD_LINK_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (_) { return false; }
}

function normDate(s) {
  if (!s) return '';
  s = s.trim();
  if (/招满|长期|滚动/.test(s)) return '招满即止';
  // 完整日期 2026-10-31 / 2026.10.31 / 2026年10月31日
  let m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) {
    // 日月颠倒脏数据修正：2026-26-10 → 2026-10-26（月 >12 且日 <=12 时交换）
    let mo = +m[2], d = +m[3];
    if (mo > 12 && d >= 1 && d <= 12) { const t = mo; mo = d; d = t; }
    return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // 月.日 / 月月日（无年份，如 10.31 / 10月31日）-> 用当前年份，避免被 SQLite 误判为已截止
  m = s.match(/(\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) {
    const y = new Date().getFullYear();
    const mm = String(m[1]).padStart(2, '0'), dd = String(m[2]).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  return s;
}

// ---- 来源字段 UPSERT 规则 ----
const UPSERT_BASE_COLS = ['company', 'update_date', 'company_type', 'batch', 'industry', 'position',
  'education', 'grad_year', 'city', 'publish_date', 'deadline', 'notice_url', 'apply_url',
  'apply_type', 'exam', 'referral_code', 'remark', 'parent_company', 'position_list', 'positions', 'updated_at'];
const SOURCE_COLS = ['source', 'source_url', 'raw_hash']; // 「被导入为空则保留原值」
const PRESERVE_COLS = ['first_seen'];                     // 冲突时永不覆盖，保留首次发现时间

/** 指纹专用截止日归一化：滚动类措辞统一为固定 token，避免「尽快投递/招满即止/招满为止/长期/滚动」等措辞差异造成假新增 */
function fpDdl(s) {
  if (!s) return '';
  if (/招满|尽快|立即|速投|随时|长期|滚动|持续|常年/.test(s)) return 'rolling';
  return s;
}

/** 指纹专用职位归一化：按分隔符拆分、排序、去重——职位列表顺序无业务含义，避免同一公告职位顺序被调整造成假新增 */
function fpPos(s) {
  if (!s) return '';
  return [...new Set(String(s).split(/[;,，、]/).map(t => t.trim()).filter(Boolean))].sort().join('|');
}

/** 判断是否为「文章类」公告链接（公众号文章/具体文章页）；官网列表/通用投递页会被多公告共用，不适用 URL 级去重 */
function isArticleUrl(u) {
  u = String(u || '').replace(/[?&#].*$/, '');
  if (!u) return false;
  if (/mp\.weixin\.qq\.com\/s(\/|\?)/.test(u)) return true;
  if (/\/art\/|\/article|\/job\/detail|ehire|job\.asp|\/\d{4,}\.html|\/position/i.test(u)) return true;
  if (/job\/list|recruit|zhaopin|career|campus|xiaoyuan|jiuye|jobs?\/?$|\.com\/\w*$|\.cn\/\w*$/.test(u)) return false;
  return false;
}
/** URL 归一化：去 query/fragment 与末尾斜杠；微信文章按 sn(或 mid) 唯一去重（短链 /s/xxx 与完整参数链 sn= 归一为同一 key） */
function urlKey(u) {
  const s = String(u || '').trim();
  if (/mp\.weixin\.qq\.com/.test(s)) {
    const m = s.match(/sn=([a-f0-9]+)/);
    if (m) return 'wx:' + m[1];
    const m2 = s.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (m2) return 'wx:' + m2[1];
    const m3 = s.match(/mid=(\d+)/);
    if (m3) return 'wx:' + m3[1];
  }
  return s.replace(/[?&#].*$/, '').replace(/\/+$/, '');
}

/** 构建 url_dup 判重索引：company → Set(urlKey)。预加载 active 微信文章链接，供 URL 级防新增判重用。
 *  注意：url_dup 必须按 urlKey 在内存中比较（notice_url 列存原始 URL，不能直接 SQL 匹配归一化 key）。 */
function buildUrlKeyIndex() {
  const rows = db.prepare("SELECT company, notice_url FROM jobs WHERE status='active' AND notice_url LIKE '%mp.weixin.qq.com%'").all();
  const idx = new Map();
  for (const r of rows) {
    if (!idx.has(r.company)) idx.set(r.company, new Set());
    idx.get(r.company).add(urlKey(r.notice_url));
  }
  return idx;
}

/** 计算岗位指纹（跨源去重一致）：company|position|batch|ddl|city 归一化后 MD5 */
function computeFingerprint(company, position, batch, ddl, city) {
  return md5([company, fpPos(position), batch, fpDdl(ddl), city].map(fpNorm).join('|'));
}

/** 构建 UPSERT 的 SET 子句（基础列/来源列「空则保留原值」；first_seen 永不覆盖） */
function buildSetClause() {
  const cols = [...UPSERT_BASE_COLS, ...SOURCE_COLS];
  const parts = cols.map(c => {
    if (c === 'updated_at') return `${c} = datetime('now','localtime')`;
    return `${c} = CASE WHEN excluded.${c} IS NULL OR excluded.${c} = '' THEN jobs.${c} ELSE excluded.${c} END`;
  });
  for (const p of PRESERVE_COLS) parts.push(`${p} = jobs.${p}`);
  return parts.join(', ');
}

const JOBS_COLS = `company, update_date, company_type, batch, industry, position, education, grad_year,
     city, publish_date, deadline, notice_url, apply_url, apply_type, exam, referral_code,
     remark, fingerprint, added_date, parent_company, source, source_url, first_seen, raw_hash, position_list, positions, updated_at`;

/**
 * 单条岗位入库（供自动化采集框架调用）：归一化 + 指纹去重 + 来源字段落库。
 * row 字段（均可选）：company*, position, batch, deadline, city, notice_url, apply_url,
 *   company_type, industry, education, grad_year, exam, referral_code, remark,
 *   source, source_url, first_seen, raw_hash（*=必填）
 * 返回 { inserted, existed, fingerprint, skipped }
 */
function upsertIngestJob(row) {
  const company = cleanCompany(String(row.company || '').trim());
  if (!company) return { inserted: false, existed: false, fingerprint: null, skipped: true };
  const position = String(row.position || '').trim();
  const batch = String(row.batch || '').trim();
  const ddl = normDate(String(row.deadline || ''));
  const city = normCity(String(row.city || '').replace(/、/g, ','));
  const gradYear = normGradYear(String(row.grad_year || ''));
  const industry = normIndustry(String(row.industry || ''));
  const ctype = normCompanyType(String(row.company_type || ''));
  const exam = normExam(String(row.exam || ''));
  const { url: applyUrl0, type: applyType } = cleanUrl(String(row.apply_url || ''));
  const applyUrl = isBadLink(applyUrl0) ? '' : applyUrl0;
  const fp = computeFingerprint(company, position, batch, ddl, city);
  const today = todayCN();
  const firstSeen = String(row.first_seen || today).trim();
  const existed = !!db.prepare('SELECT 1 FROM jobs WHERE fingerprint = ?').get(fp);
  // URL 级防新增：同公司 + 同文章链接已存在（active）→ 视为同一公告变体，跳过插入，避免变体行重新累积
  const noticeUrlRaw = String(row.notice_url || '').trim();
  const noticeUrl = isBadLink(noticeUrlRaw) ? '' : noticeUrlRaw;
  if (noticeUrl && isArticleUrl(noticeUrl)) {
    const hit = db.prepare("SELECT notice_url FROM jobs WHERE company = ? AND status = 'active' AND notice_url LIKE '%mp.weixin.qq.com%'").all(company);
    const dup = hit.some(r => urlKey(r.notice_url) === urlKey(noticeUrl));
    if (dup) return { inserted: false, existed: true, fingerprint: fp, skipped: true, reason: 'url_dup' };
  }
  db.prepare(`INSERT INTO jobs (${JOBS_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(fingerprint) DO UPDATE SET ${buildSetClause()} WHERE jobs.locked = 0`).run(
    company, String(row.update_date || '').trim(), ctype, batch, industry, position,
    String(row.education || '').trim(), gradYear, city, normDate(String(row.publish_date || '')),
    ddl, noticeUrl, applyUrl, applyType, exam,
    normReferral(String(row.referral_code || '')), String(row.remark || '').replace(/^\/$/, ''),
    fp, today, canonicalCompany(company),
    String(row.source || '').trim(), String(row.source_url || '').trim(), firstSeen, String(row.raw_hash || '').trim(),
    String(row.position_list || '').trim(), String(row.positions || '').trim()
  );
  return { inserted: !existed, existed, fingerprint: fp, skipped: false };
}

/**
 * 批量入库（事务 + 预编译语句，适合 1000+ 条大批量，避免逐条 prepare/fsync 卡死）
 * rows 与 upsertIngestJob 的 row 相同；按 fingerprint 幂等去重（重复自动跳过/更新）。
 * 返回 { total, inserted, existed, skipped }
 */
function batchUpsert(rows) {
  // 受限环境可能禁止 .db-journal/-wal 的磁盘写入 → 强制 journal 内存化（在事务 BEGIN 之前设置）
  try { db.exec('PRAGMA journal_mode = MEMORY'); } catch (_) { /* ignore */ }
  try { db.exec('PRAGMA temp_store = MEMORY'); } catch (_) { /* ignore */ }
  const sel = db.prepare('SELECT 1 FROM jobs WHERE fingerprint = ?');
  const ins = db.prepare(`INSERT INTO jobs (${JOBS_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(fingerprint) DO UPDATE SET ${buildSetClause()} WHERE jobs.locked = 0`);
  const urlIdx = buildUrlKeyIndex(); // 预加载同公司微信文章链接（url_dup 判重，内存比较）
  let inserted = 0, existed = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const company = cleanCompany(String(row.company || '').trim());
      if (!company) { skipped++; continue; }
      const position = String(row.position || '').trim();
      const batch = String(row.batch || '').trim();
      const ddl = normDate(String(row.deadline || ''));
      const city = normCity(String(row.city || '').replace(/、/g, ','));
      const gradYear = normGradYear(String(row.grad_year || ''));
      const industry = normIndustry(String(row.industry || ''));
      const ctype = normCompanyType(String(row.company_type || ''));
      const exam = normExam(String(row.exam || ''));
      const { url: applyUrl0, type: applyType } = cleanUrl(String(row.apply_url || ''));
      const applyUrl = isBadLink(applyUrl0) ? '' : applyUrl0;
      const fp = computeFingerprint(company, position, batch, ddl, city);
      const today = todayCN();
      const firstSeen = String(row.first_seen || today).trim();
      // URL 级防新增：**仅对新增记录**（fingerprint 未命中）做同公司+同文章链接判重；
      // 已存在记录的字段更新（如 apply_url 回补）必须放行走 UPDATE，否则被误 skip
      const noticeUrlRaw = String(row.notice_url || '').trim();
      const noticeUrl = isBadLink(noticeUrlRaw) ? '' : noticeUrlRaw;
      if (!existed && noticeUrl && isArticleUrl(noticeUrl)) {
        const keys = urlIdx.get(company);
        if (keys && keys.has(urlKey(noticeUrl))) { skipped++; continue; }
      }
      const isNew = !sel.get(fp);
      ins.run(
        company, String(row.update_date || '').trim(), ctype, batch, industry, position,
        String(row.education || '').trim(), gradYear, city, normDate(String(row.publish_date || '')),
        ddl, noticeUrl, applyUrl, applyType, exam,
        normReferral(String(row.referral_code || '')), String(row.remark || '').replace(/^\/$/, ''),
        fp, today, canonicalCompany(company),
        String(row.source || '').trim(), String(row.source_url || '').trim(), firstSeen, String(row.raw_hash || '').trim(),
        String(row.position_list || '').trim(), String(row.positions || '').trim()
      );
      // 新插入后同步更新索引，防同批次内同 URL 重复
      if (noticeUrl && isArticleUrl(noticeUrl)) {
        if (!urlIdx.has(company)) urlIdx.set(company, new Set());
        urlIdx.get(company).add(urlKey(noticeUrl));
      }
      if (isNew) inserted++; else existed++;
    }
  });
  tx();
  return { total: rows.length, inserted, existed, skipped };
}

/**
 * 导入 CSV 文本，返回 { total, inserted, updated, skipped }
 */
function importCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { total: 0, inserted: 0, updated: 0 };
  const header = rows[0].map(h => h.trim());
  const col = name => header.indexOf(name);
  const C = {
    company: col('公司名称'), update: col('更新日期'), ctype: col('企业类型'),
    batch: col('招聘批次'), industry: col('行业类别'), position: col('招聘岗位'),
    edu: col('学历要求'), year: col('毕业年份'), city: col('工作城市'),
    pub: col('发布日期'), ddl: col('截止日期'), notice: col('公告链接'),
    apply: col('投递方式'), exam: col('是否笔试'), ref: col('内推码'), remark: col('备注'),
    source: col('来源'), sourceUrl: col('来源链接'), firstSeen: col('首次发现'), rawHash: col('原始哈希'),
    positionList: col('招聘岗位表')
  };
  if (C.company < 0) throw new Error('CSV 缺少「公司名称」列，请确认表头格式');

  const today = todayCN();
  const stmt = db.prepare(`INSERT INTO jobs (${JOBS_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(fingerprint) DO UPDATE SET ${buildSetClause()} WHERE jobs.locked = 0`);
  const urlIdx = buildUrlKeyIndex(); // url_dup 判重索引（同公司+同文章链接已存在则跳过，防线上重复累积）

  let total = 0, inserted = 0, updated = 0;
  const g = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const existsStmt = db.prepare('SELECT 1 FROM jobs WHERE fingerprint = ?');

  const tx = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const company = cleanCompany(g(r, C.company));
      if (!company || /[━📜]/.test(company)) continue;              // 水印/空行
      if (g(r, C.update).startsWith('9999')) continue;               // 水印行
      total++;
      const position = g(r, C.position);
      const batch = g(r, C.batch);
      const ddl = normDate(g(r, C.ddl));
      const city = normCity(g(r, C.city).replace(/、/g, ','));
      const gradYear = normGradYear(g(r, C.year));
      const industry = normIndustry(g(r, C.industry));
      const ctype = normCompanyType(g(r, C.ctype));
      const exam = normExam(g(r, C.exam));
      const { url, type } = cleanUrl(g(r, C.apply));
      const fp = computeFingerprint(company, position, batch, ddl, city);
      const existed = existsStmt.get(fp);
      // URL 级防新增：仅对新增记录（fingerprint 未命中）判重；已存在记录放行 UPDATE（同上）
      const noticeTxt = g(r, C.notice);
      if (!existed && noticeTxt && isArticleUrl(noticeTxt)) {
        const keys = urlIdx.get(company);
        if (keys && keys.has(urlKey(noticeTxt))) { continue; }
      }
      stmt.run(
        company, g(r, C.update), ctype, batch, industry, position,
        g(r, C.edu), gradYear, city, normDate(g(r, C.pub)), ddl,
        g(r, C.notice), url, type, exam, normReferral(g(r, C.ref)),
        g(r, C.remark).replace(/^\/$/, ''), fp, today, canonicalCompany(company),
        g(r, C.source), g(r, C.sourceUrl), g(r, C.firstSeen) || today, g(r, C.rawHash),
        g(r, C.positionList), g(r, C.positions)
      );
      // 新插入后同步更新索引，防同批次内同 URL 重复
      if (noticeTxt && isArticleUrl(noticeTxt)) {
        if (!urlIdx.has(company)) urlIdx.set(company, new Set());
        urlIdx.get(company).add(urlKey(noticeTxt));
      }
      if (existed) updated++; else inserted++;
    }
  });
  tx();
  return { total, inserted, updated, skipped: total - inserted - updated };
}

module.exports = { importCSV, parseCSV, computeFingerprint, upsertIngestJob, batchUpsert, cleanUrl };
