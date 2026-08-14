const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

/**
 * 解析实际数据库路径。
 * config.DB_PATH 为唯一权威文件：存在且可写则直接用它；不可写（受限环境）则复制一份接力使用。
 * 仅当权威文件不存在时，才从目录中按 mtime 选取最新的 xzb*.db 作为兜底（正常部署不应走到此分支）。
 * 注意：不再默认按 mtime 覆盖 config.DB_PATH，避免多副本时误选到不一致的数据快照。
 */
function resolveDbPath() {
  if (fs.existsSync(config.DB_PATH)) {
    try {
      fs.closeSync(fs.openSync(config.DB_PATH, 'r+'));
      return config.DB_PATH; // 权威文件可写，直接用
    } catch {
      const next = path.join(path.dirname(config.DB_PATH), `xzb-${Date.now()}.db`);
      fs.copyFileSync(config.DB_PATH, next);
      console.log(`[db] 权威库不可写，已接力复制 -> ${path.basename(next)}`);
      return next;
    }
  }
  const dir = path.dirname(config.DB_PATH);
  const candidates = fs.readdirSync(dir)
    .filter(f => /^xzb(-\d+)?\.db$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!candidates.length) return config.DB_PATH;
  const latest = path.join(dir, candidates[0].f);
  try {
    fs.closeSync(fs.openSync(latest, 'r+'));
    return latest; // 可写，直接用
  } catch {
    const next = path.join(dir, `xzb-${Date.now()}.db`);
    fs.copyFileSync(latest, next);
    console.log(`[db] 旧库不可写，已接力复制 -> ${path.basename(next)}`);
    return next;
  }
}

const db = new DatabaseSync(resolveDbPath());
// 该环境不支持 WAL 的共享内存映射 → 默认切回 DELETE；若库被其他连接占用（如外部工具打开），
// 切换失败时保持当前模式继续运行（WAL 在本机同样可读写）
try { db.exec('PRAGMA journal_mode = DELETE'); }
catch (e) { console.log('[db] journal_mode 切换失败（可能被其他连接占用），沿用当前模式:', e.message); }

// 事务辅助（兼容 better-sqlite3 风格）
db.transaction = fn => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  update_date TEXT,
  company_type TEXT,
  batch TEXT,
  industry TEXT,
  position TEXT,
  education TEXT,
  grad_year TEXT,
  city TEXT,
  publish_date TEXT,
  deadline TEXT,
  notice_url TEXT,
  apply_url TEXT,
  apply_type TEXT DEFAULT 'link',
  exam TEXT,
  referral_code TEXT,
  remark TEXT,
  fingerprint TEXT UNIQUE,
  added_date TEXT,
  parent_company TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  dup_of INTEGER,
  notice_summary TEXT,
  source TEXT,
  source_url TEXT,
  first_seen TEXT,
  raw_hash TEXT,
  position_list TEXT,
  positions TEXT,
  publisher TEXT,
  apply_method TEXT,
  needs_review INTEGER DEFAULT 0,
  quality_issue TEXT,
  salary TEXT,
  org_intro TEXT,
  locked INTEGER DEFAULT 0,
  quality_score INTEGER,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch);
CREATE INDEX IF NOT EXISTS idx_jobs_publish ON jobs(publish_date);
CREATE INDEX IF NOT EXISTS idx_jobs_added ON jobs(added_date);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  nickname TEXT,
  trial_end TEXT,
  paid_end TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT,
  filters_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS subscription_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subscription_id INTEGER,
  log_date TEXT NOT NULL,
  hits_count INTEGER DEFAULT 0,
  jobs_json TEXT,
  email TEXT,
  sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  type TEXT DEFAULT '面经',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'created',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS company_profiles (
  name TEXT PRIMARY KEY,
  intro TEXT,
  locations TEXT,
  website TEXT,
  logo TEXT
);

-- 逐公告「本次招聘画像」：按 notice_url 存该条官方公告对应的校招画像（与 company_profiles.campus_recruit 企业级概览分离，避免一条公告画像套到企业所有岗位）
CREATE TABLE IF NOT EXISTS notice_recruit (
  notice_url TEXT PRIMARY KEY,
  company TEXT,
  data TEXT,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_nr_company ON notice_recruit(company);

CREATE TABLE IF NOT EXISTS company_index (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS job_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  stages_json TEXT DEFAULT '[]',
  current TEXT DEFAULT '已跟踪',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, job_id)
);

CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  company TEXT,
  industry TEXT,
  source TEXT,
  summary TEXT,
  file_path TEXT,
  file_type TEXT,
  file_name TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== 校招练习（资料频道改版：在线笔试/面试辅导） =====
CREATE TABLE IF NOT EXISTS practice_banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- '笔试' | '面试'
  company TEXT,                  -- 企业名（可空=通用）
  company_type TEXT,             -- 央国企/民企/外资/银行...
  position TEXT,                 -- 岗位类型（后端/产品/通用...）
  industry TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source_material_id INTEGER,    -- 关联 materials.id（语料来源，不下载）
  difficulty TEXT,               -- 易/中/难
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pb_kind ON practice_banks(kind);
CREATE INDEX IF NOT EXISTS idx_pb_type ON practice_banks(company_type);
CREATE INDEX IF NOT EXISTS idx_pb_position ON practice_banks(position);

CREATE TABLE IF NOT EXISTS practice_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL,
  q_type TEXT NOT NULL,          -- '单选'|'多选'|'判断'|'简答'|'编程'|'行为'
  stem TEXT NOT NULL,            -- 题干
  options TEXT,                  -- JSON 选项数组（客观题）
  answer TEXT,                   -- 标准答案/要点（客观题直接判；主观题作参考）
  rubric TEXT,                   -- 评分要点/打分维度（主观题）
  explanation TEXT,              -- 解析
  order_no INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pq_bank ON practice_questions(bank_id);

CREATE TABLE IF NOT EXISTS user_practice_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,               -- 登录用户；匿名时 NULL（本改版要求登录，常态为登录）
  anon_id TEXT,                  -- 匿名标识（预留，未启用）
  question_id INTEGER NOT NULL,
  bank_id INTEGER NOT NULL,
  answer TEXT,                   -- 用户作答
  score REAL,                    -- 得分 0~100
  max_score REAL DEFAULT 100,
  feedback TEXT,                 -- 指导/改进建议
  is_wrong INTEGER DEFAULT 0,    -- score < 阈值(默认60) 标记错题
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON user_practice_attempts(user_id, bank_id);
CREATE INDEX IF NOT EXISTS idx_attempts_anon ON user_practice_attempts(anon_id, bank_id);

-- 练习入口：由招聘库 jobs.position 归一化统计得到的 Top-N 岗位
CREATE TABLE IF NOT EXISTS practice_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,     -- 规范岗位名（如 软件开发/算法工程师）
  job_count INTEGER DEFAULT 0,   -- 招聘库中该岗位在招数量（用于排序与展示）
  intro TEXT,                    -- 岗位一句话说明
  sort_no INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ppos_sort ON practice_positions(status, sort_no);
`);

// 增量迁移：旧库补列（已存在则忽略）
try { db.exec('ALTER TABLE jobs ADD COLUMN dup_of INTEGER'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN notice_summary TEXT'); } catch { /* 列已存在 */ }
// 练习改版：题目挂到岗位维度，并标注笔试/面试
try { db.exec('ALTER TABLE practice_questions ADD COLUMN position TEXT'); } catch { /* 列已存在 */ }
try { db.exec("ALTER TABLE practice_questions ADD COLUMN exam_stage TEXT DEFAULT '笔试'"); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE practice_questions ADD COLUMN source TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE user_practice_attempts ADD COLUMN position TEXT'); } catch { /* 列已存在 */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_pq_pos ON practice_questions(position, exam_stage)'); } catch { /* ignore */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_attempts_pos ON user_practice_attempts(user_id, position)'); } catch { /* ignore */ }

// 薪资/Offer 数据库
db.exec(`
-- 单条爆料（开源 guka + UGC）
CREATE TABLE IF NOT EXISTS offer_salaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT,
  parent_company TEXT,
  position TEXT,
  education TEXT,
  city TEXT,
  salary_text TEXT,
  month_min REAL,
  month_max REAL,
  months REAL,
  total_min REAL,
  total_max REAL,
  grad_year TEXT,
  source TEXT,
  source_url TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_offer_co ON offer_salaries(parent_company);
CREATE INDEX IF NOT EXISTS idx_offer_pos ON offer_salaries(position);
CREATE INDEX IF NOT EXISTS idx_offer_year ON offer_salaries(grad_year);

-- 薪资参考区间（2025/2026 届公开汇总）
CREATE TABLE IF NOT EXISTS offer_reference (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT,
  position TEXT,
  education TEXT,
  city TEXT,
  tier TEXT,
  salary_min REAL,
  salary_max REAL,
  grad_year TEXT,
  source TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_oref_year ON offer_reference(grad_year);

-- 求职攻略知识库
CREATE TABLE IF NOT EXISTS career_guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT NOT NULL,
  stage TEXT,
  title TEXT,
  content TEXT,
  source TEXT DEFAULT 'ai',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cg_pos ON career_guides(position);

-- 动态生成的「单岗位精准说明书」缓存（按 公司|岗位|行业 指纹去重）
-- 与 career_guides（静态大类说明书）互补：本表提供「一岗一书」的精准版，命中失败回退静态类。
CREATE TABLE IF NOT EXISTS job_manuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,           -- MD5(company|position|industry)
  company TEXT,
  position TEXT,
  industry TEXT,
  title TEXT,
  content TEXT,
  model TEXT,
  source TEXT DEFAULT 'ai',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_jm_fp ON job_manuals(fingerprint);
`);

// ===== 时效采集：数据源注册表 + 岗位来源字段 =====
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,                 -- 数据源显示名（如「清华大学就业网」）
  type TEXT NOT NULL,                        -- university | niuke | haitou | company | wechat
  url TEXT,                                  -- 主页/入口
  fetch_method TEXT NOT NULL,                -- university | rss | api | html
  config TEXT,                               -- JSON：列表URL、选择器、分页、关键词等
  cron_expr TEXT DEFAULT '0 */2 * * *',      -- 抓取频率（默认每 2 小时）
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  last_success TEXT,
  last_count INTEGER DEFAULT 0,
  health TEXT DEFAULT 'unknown',             -- ok | warn | error | unknown
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled);
`);
// jobs 来源字段（已存在则忽略）：source=来源名, source_url=原始公告外链, first_seen=首次发现, raw_hash=来源条目指纹
try { db.exec('ALTER TABLE jobs ADD COLUMN source TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN source_url TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN first_seen TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN raw_hash TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN positions TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN position_list TEXT'); } catch { /* 列已存在：尾部招聘岗位表(净化HTML) */ }
// company_profiles.locked：人工种子化/修正的简介受保护，enrich/fix 类工具不再覆盖
try { db.exec('ALTER TABLE company_profiles ADD COLUMN locked INTEGER DEFAULT 0'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN locked INTEGER DEFAULT 0'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN updated_at TEXT'); } catch { /* 列已存在 */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source)'); } catch { /* ignore */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_firstseen ON jobs(first_seen)'); } catch { /* ignore */ }

// 简历优化使用次数（每账号上限，防恶意使用）
db.exec(`
CREATE TABLE IF NOT EXISTS resume_usage (
  user_id INTEGER PRIMARY KEY,
  n INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// ===== 运维监控 + 用户反馈 + 待办建议 =====
db.exec(`
-- 网站运行错误日志（由 monitor 模块结构化写入）
CREATE TABLE IF NOT EXISTS site_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),   -- 发生时间
  kind TEXT,                                        -- 错误类别（sqlite_busy/network/code_bug/body_parse/unknown...）
  severity TEXT DEFAULT 'error',                    -- info|warn|error|critical
  route TEXT,                                       -- 触发路由（如有）
  method TEXT,
  message TEXT,                                     -- 错误消息（截断 500）
  stack TEXT,                                       -- 完整堆栈
  context_json TEXT,                                -- 附加上下文（query/params/ua/ip）
  auto_action TEXT,                                 -- 自动处置动作（如 retry_once/clear_cache/degrade）
  auto_result TEXT,                                 -- 自动处置结果（recovered/failed/skipped）
  status TEXT DEFAULT 'open',                       -- open|recovered|flagged|resolved
  suggestion_id INTEGER,                            -- 关联 work_suggestions.id（若已生成待办）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_err_ts ON site_errors(ts);
CREATE INDEX IF NOT EXISTS idx_err_status ON site_errors(status);

-- 匿名用户反馈
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),
  category TEXT DEFAULT '其他',                     -- 功能建议|内容纠错|体验问题|其他
  text TEXT NOT NULL,                               -- 反馈内容
  page TEXT,                                        -- 提交时所在页面路径
  ua TEXT,                                          -- User-Agent
  ip TEXT,                                          -- 来源 IP（仅用于限流/风控，不对外展示）
  status TEXT DEFAULT 'new',                        -- new|reviewed|archived
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fb_ts ON feedback(ts);
CREATE INDEX IF NOT EXISTS idx_fb_status ON feedback(status);

-- 待安排工作建议（反馈分析 / 错误标记 沉淀而来，等待用户判断执行）
CREATE TABLE IF NOT EXISTS work_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),
  source TEXT DEFAULT 'feedback',                   -- feedback|error|manual
  source_refs TEXT,                                 -- 关联来源 id 列表（JSON 数组）
  title TEXT NOT NULL,                              -- 建议标题
  detail TEXT,                                      -- 建议详情 / 分析
  priority TEXT DEFAULT '中',                        -- 高|中|低
  status TEXT DEFAULT 'pending',                    -- pending|accepted|rejected|done
  note TEXT,                                        -- 用户处理备注
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ws_status ON work_suggestions(status);

-- 简单键值表（记录上次反馈分析时间等）
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

module.exports = db;
