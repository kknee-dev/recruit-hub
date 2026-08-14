#!/usr/bin/env node
/**
 * 生成开源版演示数据 examples/seed.sqlite（完全脱敏，虚构公司名 + 通用岗位）
 * 用途：git clone 后首次启动自动加载 seed → 立即可见成品站效果。
 * 用法：node examples/gen_seed.js [输出路径]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const OUT = process.argv[2] || path.join(__dirname, 'seed.sqlite');

// —— 虚构公司 + 通用岗位（脱敏：不引用任何真实企业数据）——
const SEED = [
  // [公司, 公司类型, 行业, 岗位, 批次, 城市, 学历, 截止, 发布日期, 届别]
  ['星辰科技', '民营', '互联网', '后端开发工程师', '秋招', '北京', '本科', '2026-10-31', '2026-08-10', '2026,2027'],
  ['星辰科技', '民营', '互联网', '前端开发工程师', '秋招', '北京', '本科', '2026-10-31', '2026-08-10', '2026,2027'],
  ['星辰科技', '民营', '互联网', '算法工程师', '秋招', '北京', '硕士', '2026-10-31', '2026-08-10', '2026,2027'],
  ['星辰科技', '民营', '互联网', '产品经理', '秋招', '上海', '本科', '2026-10-15', '2026-08-09', '2026,2027'],
  ['青云网络', '民营', '互联网', '运维工程师', '提前批', '杭州', '本科', '2026-09-30', '2026-08-08', '2027'],
  ['青云网络', '民营', '互联网', '数据分析师', '秋招', '杭州', '本科', '2026-11-15', '2026-08-08', '2026,2027'],
  ['远航汽车', '民营', '新能源汽车', '电控系统工程师', '秋招', '上海', '硕士', '2026-10-31', '2026-08-07', '2026,2027'],
  ['远航汽车', '民营', '新能源汽车', '电池研发工程师', '秋招', '上海', '博士', '2026-10-31', '2026-08-07', '2026,2027'],
  ['远航汽车', '民营', '新能源汽车', '智能制造工程师', '校招', '常州', '本科', '2026-09-30', '2026-08-06', '2026'],
  ['江海重工', '国企', '机械制造', '机械设计工程师', '校招', '大连', '本科', '2026-10-20', '2026-08-06', '2026'],
  ['江海重工', '国企', '机械制造', '电气工程师', '校招', '大连', '本科', '2026-10-20', '2026-08-06', '2026'],
  ['华信银行', '国企', '金融', '管理培训生', '秋招', '全国', '硕士', '2026-11-30', '2026-08-05', '2026,2027'],
  ['华信银行', '国企', '金融', '金融科技岗', '秋招', '北京', '本科', '2026-11-30', '2026-08-05', '2026,2027'],
  ['华信银行', '国企', '金融', '风险管理岗', '秋招', '上海', '硕士', '2026-11-30', '2026-08-05', '2026,2027'],
  ['星河半导体', '民营', '半导体', '模拟IC设计工程师', '秋招', '无锡', '硕士', '2026-10-31', '2026-08-04', '2026,2027'],
  ['星河半导体', '民营', '半导体', '数字IC设计工程师', '秋招', '无锡', '硕士', '2026-10-31', '2026-08-04', '2026,2027'],
  ['星河半导体', '民营', '半导体', '芯片验证工程师', '秋招', '上海', '本科', '2026-10-31', '2026-08-04', '2026,2027'],
  ['绿能集团', '国企', '能源', '新能源开发工程师', '秋招', '成都', '本科', '2026-10-15', '2026-08-03', '2026,2027'],
  ['绿能集团', '国企', '能源', '储能系统工程师', '秋招', '成都', '硕士', '2026-10-15', '2026-08-03', '2026,2027'],
  ['绿能集团', '国企', '能源', '财务专员', '秋招', '成都', '本科', '2026-10-15', '2026-08-03', '2026,2027'],
  ['瑞丰医药', '民营', '医药', '药品研发员', '秋招', '苏州', '硕士', '2026-11-10', '2026-08-02', '2026,2027'],
  ['瑞丰医药', '民营', '医药', '临床研究员', '秋招', '苏州', '本科', '2026-11-10', '2026-08-02', '2026,2027'],
  ['蓝海电商', '民营', '电商', '运营专员', '秋招', '深圳', '本科', '2026-09-30', '2026-08-01', '2026,2027'],
  ['蓝海电商', '民营', '电商', '供应链管培生', '秋招', '深圳', '本科', '2026-09-30', '2026-08-01', '2026,2027'],
  ['蓝海电商', '民营', '电商', '数据分析岗', '秋招', '杭州', '本科', '2026-09-30', '2026-08-01', '2026,2027'],
  ['智联教育', '民营', '教育', '学科教研员', '校招', '武汉', '本科', '2026-10-10', '2026-07-30', '2026'],
  ['智联教育', '民营', '教育', '产品经理', '校招', '武汉', '本科', '2026-10-10', '2026-07-30', '2026'],
  ['天际航天', '国企', '航天', '飞行器设计工程师', '秋招', '西安', '硕士', '2026-10-31', '2026-07-29', '2026,2027'],
  ['天际航天', '国企', '航天', '制导控制工程师', '秋招', '西安', '硕士', '2026-10-31', '2026-07-29', '2026,2027'],
  ['云帆软件', '民营', '软件', 'Java开发工程师', '秋招', '广州', '本科', '2026-11-20', '2026-07-28', '2026,2027'],
  ['云帆软件', '民营', '软件', '测试开发工程师', '秋招', '广州', '本科', '2026-11-20', '2026-07-28', '2026,2027'],
  ['云帆软件', '民营', '软件', '项目经理助理', '秋招', '广州', '本科', '2026-11-20', '2026-07-28', '2026,2027'],
  ['正泰电器', '民营', '电气', '电气研发工程师', '校招', '南京', '本科', '2026-10-08', '2026-07-25', '2026'],
  ['正泰电器', '民营', '电气', '嵌入式软件工程师', '校招', '南京', '本科', '2026-10-08', '2026-07-25', '2026'],
  ['中粮食品', '国企', '食品', '食品研发工程师', '秋招', '长沙', '本科', '2026-10-30', '2026-07-24', '2026,2027'],
  ['中粮食品', '国企', '食品', '质量检测员', '校招', '长沙', '大专', '2026-10-30', '2026-07-24', '2026'],
  ['中粮食品', '国企', '食品', '市场营销岗', '秋招', '北京', '本科', '2026-10-30', '2026-07-24', '2026,2027'],
  ['数联科技', '民营', '大数据', '大数据开发工程师', '秋招', '重庆', '本科', '2026-10-25', '2026-07-22', '2026,2027'],
  ['数联科技', '民营', '大数据', '算法工程师', '秋招', '重庆', '硕士', '2026-10-25', '2026-07-22', '2026,2027'],
  ['乐赢游戏', '民营', '游戏', '游戏客户端开发', '秋招', '成都', '本科', '2026-11-05', '2026-07-20', '2026,2027'],
  ['乐赢游戏', '民营', '游戏', '游戏美术设计', '秋招', '成都', '大专', '2026-11-05', '2026-07-20', '2026,2027'],
  ['乐赢游戏', '民营', '游戏', '游戏策划', '秋招', '成都', '本科', '2026-11-05', '2026-07-20', '2026,2027'],
  ['海云通信', '国企', '通信', '通信算法工程师', '秋招', '武汉', '硕士', '2026-10-20', '2026-07-18', '2026,2027'],
  ['海云通信', '国企', '通信', '无线射频工程师', '秋招', '武汉', '本科', '2026-10-20', '2026-07-18', '2026,2027'],
  ['弘毅咨询', '民营', '咨询', '管理咨询顾问', '秋招', '北京', '硕士', '2026-10-31', '2026-07-16', '2026,2027'],
  ['弘毅咨询', '民营', '咨询', '数据分析顾问', '秋招', '北京', '本科', '2026-10-31', '2026-07-16', '2026,2027'],
  ['恒安保险', '国企', '保险', '精算岗', '秋招', '北京', '硕士', '2026-11-15', '2026-07-14', '2026,2027'],
  ['恒安保险', '国企', '保险', '核保岗', '秋招', '上海', '本科', '2026-11-15', '2026-07-14', '2026,2027'],
  ['恒安保险', '国企', '保险', '理赔管理岗', '校招', '天津', '本科', '2026-10-31', '2026-07-14', '2026'],
  ['领航物流', '民营', '物流', '管培生', '秋招', '厦门', '本科', '2026-10-20', '2026-07-12', '2026,2027'],
  ['领航物流', '民营', '物流', '运营分析岗', '秋招', '厦门', '本科', '2026-10-20', '2026-07-12', '2026,2027'],
  ['晟源材料', '民营', '新材料', '材料研发工程师', '秋招', '宁波', '硕士', '2026-10-18', '2026-07-10', '2026,2027'],
  ['晟源材料', '民营', '新材料', '工艺工程师', '校招', '宁波', '本科', '2026-10-18', '2026-07-10', '2026'],
  ['新界传媒', '民营', '传媒', '内容运营', '校招', '上海', '本科', '2026-09-30', '2026-07-08', '2026'],
  ['新界传媒', '民营', '传媒', '短视频编导', '校招', '上海', '本科', '2026-09-30', '2026-07-08', '2026'],
  ['拓维农业', '国企', '农业', '农技推广员', '校招', '郑州', '本科', '2026-10-10', '2026-07-06', '2026'],
  ['拓维农业', '国企', '农业', '供应链管理岗', '校招', '郑州', '本科', '2026-10-10', '2026-07-06', '2026'],
  ['九鼎科技', '民营', '人工智能', 'AI应用开发工程师', '秋招', '北京', '硕士', '2026-11-25', '2026-07-04', '2026,2027'],
  ['九鼎科技', '民营', '人工智能', '大模型算法工程师', '秋招', '北京', '博士', '2026-11-25', '2026-07-04', '2026,2027'],
  ['九鼎科技', '民营', '人工智能', '产品运营', '秋招', '深圳', '本科', '2026-11-25', '2026-07-04', '2026,2027'],
];

const PROFILES = [
  ['星辰科技', '国内领先的智能终端与云计算服务企业，业务覆盖消费电子、企业服务与智能硬件，员工规模超万人。', '北京/上海/杭州'],
  ['青云网络', '以云计算和数据智能为核心的技术公司，专注行业数字化解决方案。', '杭州'],
  ['远航汽车', '专注新能源汽车整车与核心部件研发制造的企业，产品覆盖乘用车与商用车。', '上海/常州'],
  ['江海重工', '大型装备制造国有企业，业务涵盖船舶、港口机械与重型装备。', '大连'],
  ['华信银行', '全国性股份制商业银行，提供综合金融服务。', '北京/上海/全国'],
  ['星河半导体', '集成电路设计企业，专注模拟与数字芯片研发。', '无锡/上海'],
  ['绿能集团', '新能源综合开发企业，业务覆盖风光储一体化。', '成都'],
  ['瑞丰医药', '医药研发与生产企业，专注创新药与仿制药。', '苏州'],
  ['蓝海电商', '跨境电商零售平台，覆盖全球主要市场。', '深圳/杭州'],
  ['智联教育', '在线教育服务企业，专注 K12 与职业教育。', '武汉'],
  ['天际航天', '航天装备研发制造企业，参与多项国家重点工程。', '西安'],
  ['云帆软件', '企业级软件与服务提供商，专注金融与政务行业。', '广州'],
  ['正泰电器', '电气设备制造企业，专注低压电器与自动化。', '南京'],
  ['中粮食品', '食品加工与贸易企业，产品覆盖粮油、饮料与休闲食品。', '长沙/北京'],
  ['数联科技', '大数据技术服务商，提供数据平台与分析工具。', '重庆'],
  ['乐赢游戏', '游戏研发与发行企业，专注移动游戏。', '成都'],
  ['海云通信', '通信设备制造企业，专注无线通信与网络设备。', '武汉'],
  ['弘毅咨询', '管理咨询公司，专注战略与运营咨询。', '北京'],
  ['恒安保险', '综合性保险公司，提供财产与人寿保险服务。', '北京/上海'],
  ['领航物流', '综合物流服务企业，提供仓储、运输与供应链解决方案。', '厦门'],
  ['晟源材料', '新材料研发与制造企业，专注电子级材料。', '宁波'],
  ['新界传媒', '内容创作与数字传媒企业，覆盖图文与短视频。', '上海'],
  ['拓维农业', '农业产业服务企业，提供供应链与农技推广。', '郑州'],
  ['九鼎科技', '人工智能应用研发企业，专注大模型应用与行业方案。', '北京/深圳'],
];

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

const db = new DatabaseSync(OUT);
// 重建表（幂等）：先 DROP 再 CREATE，避免对已有库重复插入导致 fingerprint UNIQUE 冲突
db.exec('DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS company_profiles;');
// 详情/攻略/练习/薪资相关表（drop+create 跟随 standalone；server 启动 db.js 已 CREATE IF NOT EXISTS）
db.exec('DROP TABLE IF EXISTS career_guides; DROP TABLE IF EXISTS practice_positions; DROP TABLE IF EXISTS practice_banks; DROP TABLE IF EXISTS practice_questions; DROP TABLE IF EXISTS offer_reference;');
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL, update_date TEXT, company_type TEXT, batch TEXT, industry TEXT,
  position TEXT, education TEXT, grad_year TEXT, city TEXT, publish_date TEXT, deadline TEXT,
  notice_url TEXT, apply_url TEXT, apply_type TEXT DEFAULT 'link', exam TEXT, referral_code TEXT,
  remark TEXT, fingerprint TEXT UNIQUE, added_date TEXT, parent_company TEXT,
  status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','localtime')),
  dup_of INTEGER, notice_summary TEXT, source TEXT, source_url TEXT, first_seen TEXT, raw_hash TEXT,
  position_list TEXT, positions TEXT, publisher TEXT, apply_method TEXT,
  needs_review INTEGER DEFAULT 0, quality_issue TEXT, salary TEXT, org_intro TEXT,
  locked INTEGER DEFAULT 0, quality_score INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS company_profiles (
  name TEXT PRIMARY KEY, intro TEXT, locations TEXT, website TEXT, logo TEXT
);
`);
const ins = db.prepare('INSERT INTO jobs (company, company_type, industry, position, batch, city, education, grad_year, publish_date, deadline, apply_url, exam, fingerprint, added_date, parent_company) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
let i = 0;
for (const [company, ctype, industry, position, batch, city, edu, ddl, pub, grad] of SEED) {
  // 发布日期相对今天（近 14 天），保证演示数据始终"新鲜"（支撑 CI 每日刷新信号）
  const pubDate = new Date(Date.now() - (i % 14) * 86400000).toISOString().slice(0, 10);
  const fp = md5([company, position, batch, edu, city].join('|'));
  const applyUrl = `https://example.com/apply/${i}`;
  ins.run(company, ctype, industry, position, batch, city, edu, grad, pubDate, ddl, applyUrl, '未明确', fp, '2026-08-14', company);
  i++;
}
const pin = db.prepare('INSERT OR REPLACE INTO company_profiles (name, intro, locations) VALUES (?,?,?)');
for (const [name, intro, loc] of PROFILES) pin.run(name, intro, loc);

// —— 详情/攻略/练习/薪资：最小示例（避免 SSR 退化）——
db.exec(`
CREATE TABLE IF NOT EXISTS career_guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT, position TEXT NOT NULL, stage TEXT,
  title TEXT, content TEXT, source TEXT DEFAULT 'ai', status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS practice_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  job_count INTEGER DEFAULT 0, intro TEXT, sort_no INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', updated_at TEXT DEFAULT (datetime('now','localtime'))
);
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
CREATE TABLE IF NOT EXISTS practice_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bank_id INTEGER NOT NULL,
  q_type TEXT NOT NULL, stem TEXT NOT NULL, options TEXT, answer TEXT,
  rubric TEXT, explanation TEXT, order_no INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS offer_reference (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT, position TEXT,
  education TEXT, city TEXT, tier TEXT, salary_min REAL, salary_max REAL,
  grad_year TEXT, source TEXT, source_url TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// 攻略示例（algorithm-engineer overview）
db.prepare(`INSERT INTO career_guides (position, stage, title, content) VALUES (?,?,?,?)`).run(
  '算法工程师', 'overview',
  '算法工程师校招指南（演示）',
  '## 岗位画像\n面向机器学习/搜索/推荐/NLP 等方向的数据建模与系统实现。\n## 笔试重点\n编程（中等难度）、机器学习理论、概率统计。\n## 面试核心\n项目深挖 + 模型原理 + 业务落地能力。'
);
// 实践岗位示例
const ppos = db.prepare(`INSERT INTO practice_positions (name, job_count, intro, sort_no) VALUES (?,?,?,?)`);
ppos.run('算法工程师', 1249, '数据建模与系统实现', 1);
ppos.run('软件开发', 1163, '后端/前端/全栈开发', 2);
// 题库 + 题目示例
db.prepare(`INSERT INTO practice_banks (id, kind, position, title, description, difficulty) VALUES (?,?,?,?,?,?)`).run(1, '笔试', '算法工程师', '算法工程师-校招冲刺题库（演示）', '覆盖机器学习/编程/概率统计高频考点', '中');
const pqs = db.prepare(`INSERT INTO practice_questions (bank_id, q_type, stem, options, answer, explanation, order_no) VALUES (?,?,?,?,?,?,?)`);
pqs.run(1, '单选', '以下哪个算法不属于监督学习？', JSON.stringify(['线性回归','决策树','K-means','SVM']), 'K-means', 'K-means 是无监督聚类算法，其他均为监督学习。', 1);
pqs.run(1, '判断', '梯度下降法一定可以找到全局最优解。', JSON.stringify(['正确','错误']), '错误', '非凸函数可能收敛到局部最优。', 2);
// 薪资示例
const ofr = db.prepare(`INSERT INTO offer_reference (company, position, education, city, tier, salary_min, salary_max, grad_year, source) VALUES (?,?,?,?,?,?,?,?,?)`);
ofr.run('星辰科技', '算法工程师', '硕士', '北京', 'sp', 25, 40, '2026', '公开汇总');
ofr.run('云帆软件', '软件开发', '本科', '广州', 'p5', 15, 25, '2026', '公开汇总');

db.close();

console.log(`✅ 演示数据已生成：${SEED.length} 条岗位 + ${PROFILES.length} 家企业档案 + 2 条攻略/练习示例 + 2 条薪资参考 → ${OUT}`);
console.log('首次启动时若主库为空，将自动加载本 seed（见 README「一键体验」）。');
