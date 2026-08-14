/* 薪资/Offer 数据库 —— 业务逻辑库
 * 层1：单条爆料（offer_salaries）；层2：薪资参考区间（offer_reference）
 */
const db = require('../db');
const { canonicalCompany } = require('./brands');
const tax = require('./position_taxonomy');

// ---------- 单条爆料 ----------

function searchOffers({ company, position, education, city, grad_year, sort, limit = 50 }) {
  const conds = [];
  const params = [];
  if (company) { conds.push("(o.parent_company LIKE ? OR o.company LIKE ?)"); params.push('%' + company + '%', '%' + company + '%'); }
  if (position) { conds.push("o.position = ?"); params.push(position); }
  if (education) { conds.push("o.education LIKE ?"); params.push('%' + education + '%'); }
  if (city) { conds.push("o.city LIKE ?"); params.push('%' + city + '%'); }
  if (grad_year) { conds.push("o.grad_year = ?"); params.push(grad_year); }
  const where = 'WHERE o.status=\'active\'' + (conds.length ? ' AND ' + conds.join(' AND ') : '');
  const order = sort === 'total_desc' ? 'o.total_max DESC' : 'o.grad_year DESC, o.total_max DESC';
  const list = db.prepare(`SELECT o.* FROM offer_salaries o ${where} ORDER BY ${order} LIMIT ?`).all(...params, limit);
  // 聚合统计
  const stats = db.prepare(`SELECT COUNT(*) cnt, ROUND(AVG((o.total_min+o.total_max)/2),1) avg_total, ROUND(AVG(o.total_min),1) min_avg, ROUND(AVG(o.total_max),1) max_avg FROM offer_salaries o ${where}`).get(...params);
  return { list, stats: stats || { cnt: 0 } };
}

function getOfferStats() {
  const total = db.prepare("SELECT COUNT(*) c FROM offer_salaries WHERE status='active'").get().c || 0;
  const companies = db.prepare("SELECT COUNT(DISTINCT parent_company) c FROM offer_salaries WHERE status='active' AND parent_company IS NOT NULL").get().c || 0;
  const byYear = db.prepare("SELECT grad_year, COUNT(*) c FROM offer_salaries WHERE status='active' GROUP BY grad_year ORDER BY grad_year DESC").all();
  const bySource = db.prepare("SELECT source, COUNT(*) c FROM offer_salaries WHERE status='active' GROUP BY source").all();
  return { total, companies, byYear, bySource };
}

function reportOffer({ company, position, education, city, salary_text, month_min, month_max, months, total_min, total_max, grad_year, user_id }) {
  const parent = canonicalCompany(company) || company;
  const info = db.prepare(`INSERT INTO offer_salaries (company,parent_company,position,education,city,salary_text,month_min,month_max,months,total_min,total_max,grad_year,source,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    company, parent, position || null, education || null, city || null,
    salary_text || null, month_min || null, month_max || null, months || null,
    total_min || null, total_max || null, grad_year || null,
    'ugc', 'pending'  // UGC 爆料默认待审核
  );
  return { id: Number(info.lastInsertRowid), status: 'pending' };
}

function reviewOffer(id, action) {
  if (action === 'approve') db.prepare("UPDATE offer_salaries SET status='active' WHERE id=?").run(id);
  else if (action === 'reject') db.prepare("UPDATE offer_salaries SET status='rejected' WHERE id=?").run(id);
  return { ok: true };
}

// ---------- 薪资参考区间 ----------

function getReference({ company, position, education, city, grad_year }) {
  const conds = [];
  const params = [];
  if (company) { conds.push("company LIKE ?"); params.push('%' + company + '%'); }
  if (position) { conds.push("position = ?"); params.push(position); }
  if (education) { conds.push("education LIKE ?"); params.push('%' + education + '%'); }
  if (city) { conds.push("city LIKE ?"); params.push('%' + city + '%'); }
  if (grad_year) { conds.push("grad_year = ?"); params.push(grad_year); }
  const where = 'WHERE 1=1' + (conds.length ? ' AND ' + conds.join(' AND ') : '');
  const list = db.prepare(`SELECT * FROM offer_reference ${where} ORDER BY grad_year DESC, salary_max DESC`).all(...params);
  return { list };
}

// ---------- 岗位上下文 ----------

function getJobContext(jobId) {
  const job = db.prepare("SELECT * FROM jobs WHERE id=? AND status='active'").get(jobId);
  if (!job) return null;
  const { industry, company_type, parent_company, position } = job;

  // 同行业近期招聘（取20条）
  const sameInd = industry
    ? db.prepare(`SELECT id,company,position,city,grad_year,publish_date,deadline FROM jobs WHERE status='active' AND industry=? AND id!=? AND publish_date IS NOT NULL ORDER BY publish_date DESC LIMIT 20`).all(industry, jobId)
    : [];

  // 同类公司（同行业+同企业类型，按公司聚合）
  const simCos = industry && company_type
    ? db.prepare(`SELECT parent_company, COALESCE(ci.slug, parent_company) AS slug, COUNT(*) job_count FROM jobs LEFT JOIN company_index ci ON ci.name=jobs.parent_company WHERE status='active' AND industry=? AND company_type=? GROUP BY parent_company ORDER BY job_count DESC LIMIT 15`).all(industry, company_type)
    : [];

  // 该岗位笔面经
  const posts = parent_company
    ? db.prepare(`SELECT * FROM posts WHERE status='published' AND company=? ORDER BY created_at DESC LIMIT 10`).all(parent_company)
    : [];

  // 该岗位薪资参考
  const salaryRef = (position && parent_company)
    ? db.prepare("SELECT * FROM offer_reference WHERE company LIKE ? OR position=? ORDER BY grad_year DESC LIMIT 10").all('%' + parent_company + '%', position)
    : [];

  // 求职攻略
  const guides = position
    ? db.prepare("SELECT * FROM career_guides WHERE position=? AND status='active' ORDER BY created_at DESC LIMIT 5").all(position)
    : [];

  return { sameInd, simCos, posts, salaryRef, guides };
}

// ---------- 求职攻略 ----------

function listGuides(position) {
  const sql = position
    ? "SELECT * FROM career_guides WHERE position=? AND status='active' ORDER BY created_at DESC"
    : "SELECT * FROM career_guides WHERE status='active' ORDER BY position, created_at DESC";
  const params = position ? [position] : [];
  return db.prepare(sql).all(...params);
}

function upsertGuide({ position, stage, title, content, source }) {
  // 去重键 = 岗位 + 板块：每个岗位每个板块只保留一条攻略（重跑/改 prompt 时原地替换，不累积重复）
  const exist = db.prepare("SELECT id FROM career_guides WHERE position=? AND stage=?").get(position, stage || null);
  if (exist) {
    db.prepare("UPDATE career_guides SET title=?, content=? WHERE id=?").run(title || '', content || '', exist.id);
    return { id: exist.id, updated: true };
  }
  const info = db.prepare("INSERT INTO career_guides (position,stage,title,content,source) VALUES (?,?,?,?,?)").run(position, stage || null, title, content || '', source || 'ai');
  return { id: Number(info.lastInsertRowid), updated: false };
}

// 岗位说明书（B2）：按归一化岗位名匹配 career_guides(stage='说明书')
function getManual(position) {
  if (!position) return null;
  let names = [];
  try { names = tax.classify(position); } catch { names = []; }
  // 仅当岗位归一化为「唯一」规范名时展示说明书：
  // - 多岗位混列的招聘信息（如「后端/前端」）→ names>1，不展示单一说明书（避免张冠李戴）
  // - 同一岗位的不同叫法（如「后端开发工程师/Java开发」）→ 归一化为同一规范名，names=1，正常展示
  if (names.length !== 1) return null;
  const name = names[0];
  const row = db.prepare(`SELECT position, stage, title, content, source FROM career_guides WHERE position = ? AND stage='说明书' AND status='active' ORDER BY created_at DESC LIMIT 1`).get(name);
  return row || null;
}

/**
 * 多岗位说明书：一条招聘可能含多个岗位（如"饮料产品经理品牌经理数字营销设计类"），
 * 现对归一化出的每个规范岗位各取一份「说明书」，供详情页分别展示。
 * 返回 { multi, positions:[规范名], manuals:[{position,title,content,source}] }
 * - multi=false 且 manuals 有 1 条：单岗位，保持原模式（链接到该岗位攻略）
 * - multi=true：多岗位，页面按岗位分别介绍；"查看求职攻略"链接改指 /guides 栏目
 */
function getManuals(position) {
  if (!position) return { multi: false, positions: [], manuals: [] };
  let names = [];
  try { names = tax.classify(position); } catch { names = []; }
  if (!names.length) return { multi: false, positions: [], manuals: [] };
  const manuals = [];
  for (const name of names) {
    const row = db.prepare(`SELECT position, stage, title, content, source FROM career_guides WHERE position = ? AND stage='说明书' AND status='active' ORDER BY created_at DESC LIMIT 1`).get(name);
    if (row) manuals.push(row);
  }
  return { multi: names.length > 1, positions: names, manuals };
}

module.exports = { searchOffers, getOfferStats, reportOffer, reviewOffer, getReference, getJobContext, listGuides, upsertGuide, getManual, getManuals };
