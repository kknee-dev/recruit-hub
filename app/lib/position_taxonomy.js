'use strict';
/**
 * 岗位归一化词典：把 jobs.position 的自由文本合并到规范岗位大类。
 * 规则：按 rules 顺序匹配（先具体后宽泛），命中即归类。
 * 一条 position 文本可能包含多个岗位（如"市场营销实习生、数字金融实习生"），
 * 因此支持 multi 匹配，每个命中的大类各计一次。
 */

// 需要剔除的无效/占位描述
const NOISE_RE = /^(未明确|详情.*|众多岗位.*|下属.*岗位.*|具体见.*|见详情|多个岗位|若干|不限|其他|\s*)$/;

// [规范名, 关键词数组]，顺序敏感：具体的排前面
const RULES = [
  ['算法工程师',     ['算法', '机器学习', '深度学习', '人工智能', '自然语言', 'nlp', '计算机视觉', 'cv工程', '大模型', 'ai工程']],
  ['数据分析',       ['数据分析', '数据挖掘', '大数据', '数据工程', '数据科学', 'bi工程', '数据开发', '数据产品']],
  ['前端开发',       ['前端', 'web开发', 'h5开发']],
  ['测试工程师',     ['测试', 'qa工程', '质量保障']],
  ['运维与IT',       ['运维', 'sre', 'it支持', 'it工程', '系统集成', '网络工程', '信息技术']],
  ['软件开发',       ['软件开发', '后端', '服务端', 'java', 'c++', 'python开发', 'golang', '程序员', '软件工程', '开发工程师', '研发工程师', '软件研发', '客户端', 'android', 'ios开发']],
  ['硬件与芯片',     ['硬件', '芯片', '集成电路', 'ic设计', 'fpga', '嵌入式', '电路', '射频', '模拟设计', '数字ic', '版图']],
  ['机械工程',       ['机械', '结构工程', '机构设计', '模具', '机电']],
  ['电气工程',       ['电气', '电力', '供电', '变电', '输电', '配电', '电网']],
  ['土木建筑',       ['土建', '土木', '建筑', '施工', '造价', '工程管理', '监理', '给排水', '暖通', '市政']],
  ['化工材料',       ['化工', '材料', '工艺工程', '高分子', '冶金', '化学工程', '应用化学', '化学专业', '有机化学', '无机化学', '分析化学', '化学类']],
  ['医药生物',       ['医药', '生物', '临床', '药学', '制药', '医疗器械', '医学', '药物']],
  ['产品经理',       ['产品经理', '产品策划', '产品助理', '产品实习']],
  ['设计',           ['设计师', 'ui设计', '平面设计', '交互设计', '工业设计', '美工', '设计实习', '设计岗', '设计']],
  ['运营',           ['运营']],
  ['品牌经理',       ['品牌经理', '品牌专员', '品牌营销', 'branding', '品牌策划']],
  ['市场营销',       ['市场', '营销', '推广', '公关', '广告']],
  ['销售',           ['销售', '客户经理', 'business', '商务拓展', '渠道']],
  ['人力资源',       ['人力资源', 'hr', '招聘专员', '薪酬', '组织发展']],
  ['财务会计',       ['财务', '会计', '审计', '税务', '出纳', '成本核算']],
  ['金融与银行',     ['金融', '银行', '柜员', '理财', '投资', '风控', '信贷', '证券', '保险', '基金', '投行', '量化', '精算', '资管']],
  ['法务合规',       ['法务', '律师', '合规', '书记员', '法律', '知识产权']],
  ['编辑与传媒',     ['编辑', '记者', '新闻', '传媒', '文案', '采编', '主持']],
  ['采购供应链',     ['采购', '供应链', '物流', '仓储', '关务', '计划员']],
  ['质量管理',       ['质量', '质检', '品控', 'qc工程', '体系工程']],
  ['教师教研',       ['教师', '教研', '讲师', '辅导员', '教学']],
  ['科研岗',         ['博士后', '研究员', '科研', '研究院', '研究所']],
  ['咨询顾问',       ['咨询', '顾问']],
  ['行政职能',       ['行政', '文秘', '秘书', '综合管理', '党务', '办公室', '职能部门', '综合岗']],
  ['管培生',         ['管培生', '管理培训生', '储备干部', '培养生', 'u培生', '培生']],
  ['校园大使',       ['校园大使', '校园招聘大使']],
  ['技术支持',       ['技术支持', '售前', '售后', '实施工程']],
  ['生产制造',       ['生产', '制造', '工厂', '车间', '设备工程', '工艺员']],
];

/** 把一段 position 文本切成候选片段（支持顿号/逗号/斜杠分隔的多岗位） */
function splitPositions(text) {
  if (!text) return [];
  return String(text)
    .split(/[、，,;；/｜|]+/)
    .map(s => s.trim())
    .filter(s => s && s.length <= 40 && !NOISE_RE.test(s));
}

/** 单个片段 → 规范岗位名（未命中返回 null）。
 *  命中多个规则时，取「关键词最长」的那个（更具体优先），避免短关键词抢匹配。 */
function classifyOne(seg) {
  const s = String(seg || '').toLowerCase();
  if (!s) return null;
  let best = null, bestLen = 0;
  for (const [canon, kws] of RULES) {
    for (const kw of kws) {
      if (kw.length > bestLen && s.includes(kw)) { best = canon; bestLen = kw.length; }
    }
  }
  return best;
}

/** 全文关键词扫描：仅作为「无分隔符长串拼接」的兜底（如"饮料产品经理品牌经理数字营销设计类"）。
 *  已用顿号/逗号等明确分段的文本不应走这里，否则 "强化学习" 里的 "化学" 会误命中 化工材料。 */
function scanAll(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  if (!s) return out;
  for (const [canon, kws] of RULES) {
    for (const kw of kws) {
      if (s.includes(kw)) { out.add(canon); break; }
    }
  }
  return out;
}

/** 一条 position 文本 → 命中的规范岗位集合（去重） */
function classify(text) {
  const raw = String(text || '').trim();
  if (!raw || NOISE_RE.test(raw)) return [];
  const segs = splitPositions(raw);
  const out = new Set();
  // 已分段（≥2 个片段）：逐片段精确匹配，禁止整串扫描，避免短关键词在长词内部误命中。
  if (segs.length >= 2) {
    for (const seg of segs) {
      const c = classifyOne(seg);
      if (c) out.add(c);
    }
    return [...out];
  }
  // 单片段 / 无分隔符的长串（爬取拼接的脏数据）：才使用整串关键词扫描兜底。
  for (const c of scanAll(raw)) out.add(c);
  return [...out];
}

/** 统计全库岗位分布，返回 [{name, count}] 降序 */
function rankPositions(db, { limit = 20, minCount = 1 } = {}) {
  const rows = db.prepare(
    "SELECT position, industry FROM jobs WHERE status='active' AND position IS NOT NULL AND position<>''"
  ).all();
  const tally = new Map();
  for (const r of rows) {
    for (const c of classify(r.position)) {
      tally.set(c, (tally.get(c) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter(x => x.count >= minCount)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

module.exports = { RULES, splitPositions, classifyOne, classify, rankPositions };
