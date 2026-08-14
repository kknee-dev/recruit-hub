/* 筛选项归一化：合并重复项（如 上海/上海市、2025/2025届） */

// 城市：仅去「市/省/自治区/特别行政区」后缀（注意：绝不可去掉「州」，否则 杭州→杭、广州→广）
const CITY_SUFFIX = /(市|省|自治区|特别行政区)$/;
const CITY_ALIAS = {
  '全国多地': '全国', '全国各地': '全国', '全国': '全国', '境内': '全国', '中国大陆': '全国',
  '远程': '远程', '线上': '远程', '居家办公': '远程', '居家': '远程', '异地': '远程',
  '海外': '海外', '境外': '海外', '国外': '海外'
};
function normCity(raw) {
  if (!raw) return '';
  const parts = String(raw).split(/[,，/、]/).map(s => {
    s = s.trim();
    if (!s) return '';
    if (CITY_ALIAS[s]) return CITY_ALIAS[s];
    s = s.replace(CITY_SUFFIX, '');
    return s;
  }).filter(Boolean);
  // 去重 + 排序（排序保证「北京,上海」与「上海,北京」指纹一致，避免城市顺序差异造成假新增）
  const seen = new Set(); const out = [];
  for (const p of parts) { if (!seen.has(p)) { seen.add(p); out.push(p); } }
  return out.sort().join(',');
}

// 毕业届别：去掉「届」后提取 4 位年份；无年份时返回去届后的文本（不再原样回退）
function normGradYear(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/届/g, '').trim();
  if (/未找到|无|不详|待定|暂未/.test(s)) return '';   // 垃圾值清空
  if (/不限/.test(s)) return '不限';                    // 不限届→不限
  const m = s.match(/(19|20)\d{2}/);
  return m ? m[0] : s;                                 // 25届【留】-26届 → 25【留】-26（保留区间）
}

// 行业：仅合并最明确的同义表述（保守，避免过度合并）
const INDUSTRY_ALIAS = {
  '金融业': '金融', '金融/证券': '金融',
  '银行/国有行': '银行',
  '医疗/医药/生物': '医疗/医药', '生物/医药': '医疗/医药',
  '教育/培训/科研': '教育/培训/科研', '教育/培训': '教育/培训',
  '文化/传媒/广告/体育': '文化/传媒', '影视文化': '文化/传媒', '传媒出版': '文化/传媒',
  '机械/制造业': '机械制造', '机械/电子': '机械制造',
  '汽车制造/维修/零配件': '汽车', '汽车产业': '汽车',
  '通信/电子/半导体': '通信电子', '电子/半导体': '通信电子',
  '国企': '央国企',
  '政府机关, 事业单位': '政府/事业单位', '政府机关': '政府/事业单位', '事业单位': '政府/事业单位',
  '中外合资': '合资/外资', '外企/合资': '合资/外资', '外企合资': '合资/外资', '合资': '合资/外资', '外企': '合资/外资',
  '互联网/人工智能': '互联网', 'IT/互联网/游戏': '互联网', '软件技术': '互联网', '科技': '互联网',
  '游戏动画': '游戏'
};
function normIndustry(raw) {
  if (!raw) return '';
  const v = INDUSTRY_ALIAS[String(raw).trim()];
  return v || String(raw).trim();
}

// 企业类型：合并同义
const COMPANY_TYPE_ALIAS = {
  '外企': '合资/外资', '外企/合资': '合资/外资', '外企合资': '合资/外资', '中外合资': '合资/外资', '合资': '合资/外资',
  '国企': '央国企', '央国企': '央国企',
  '政府机关, 事业单位': '政府/事业单位', '政府机关': '政府/事业单位', '事业单位': '政府/事业单位',
  '银行': '银行', '民企': '民企', '社会机构': '社会机构', '其他': '其他'
};
function normCompanyType(raw) {
  if (!raw) return '';
  const v = COMPANY_TYPE_ALIAS[String(raw).trim()];
  return v || String(raw).trim();
}

// 笔试情况：合并同义
const EXAM_ALIAS = {
  '有笔试': '有笔试', '需要笔试': '有笔试', '部分有笔试': '有笔试', '含笔试': '有笔试',
  '含免笔试': '免笔试', '免笔试（部分岗位）': '免笔试', '免笔试': '免笔试',
  '未明确': '未明确', '未知': '未明确', '仅测评': '仅测评'
};
/**
 * 归一化「是否笔试」。
 * 仅保留受控的规范值；其余一律清空（不显示该字段），避免投递方式 / 链接等
 * 误填内容（如 link、http、投递、邮箱、内推、申请、官网、扫码）污染筛选维度。
 */
function normExam(raw) {
  if (!raw) return '未明确';
  const s = String(raw).trim();
  const v = EXAM_ALIAS[s];
  if (v) return v;
  // 投递方式 / 链接类误入「是否笔试」列 -> 视为未知
  if (/link|http|url|投递|邮箱|内推|申请|官网|扫码|网申|链接/i.test(s)) return '未明确';
  // 含关键词的宽松匹配
  if (/免笔试|免试|无笔试|不用?笔试|不?用?笔试/.test(s)) return '免笔试';
  if (/有笔试|需笔试|要笔试|含笔试/.test(s)) return '有笔试';
  if (/仅测评|测评|测验/.test(s)) return '仅测评';
  if (/未知|未明|待定|不确|不清/.test(s)) return '未明确';
  // 其余无法识别（长句 / 含标点 / 链接残片）一律归为「未明确」，
  // 保证详情页始终展示「是否笔试」模块，不出现整块消失的情况
  return '未明确';
}

/**
 * 归一化「内推码」。内推码应为简短代码或链接，不应是中文描述。
 * 含中文、链接、邮箱或过长者一律清空（视为误填）。
 */
function normReferral(raw) {
  if (!raw) return '';
  let s = String(raw).trim().replace(/^\/+$/, '').trim();
  if (!s) return '';
  if (/[一-龥]/.test(s)) return '';                                  // 含中文 -> 误填描述
  if (/http|@|www\.|\.com|\.cn|邮箱|投递/i.test(s)) return '';        // 链接 / 邮箱
  if (s.length > 40) return '';                                       // 过长不像真实内推码
  return s;
}

// 企业名清洗：剥离误拼在企业名后的「岗位/项目」后缀（如 宇石空间-校园大使 → 宇石空间）
// 注意保守：仅命中明确的岗位类词汇才剥离，部门/分公司（如 腾讯-腾讯广告）不受影响
const POSITION_SUFFIX = /[-—－·]?(校园大使|管培生(项目|计划)?|实习生|培训生|主播)$/;
function cleanCompany(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  const stripped = s.replace(POSITION_SUFFIX, '');
  // 剥离后至少要剩 2 个字符，否则视为公司名本身（避免把「校园大使」类全名清空）
  if (stripped.length >= 2 && stripped !== s) s = stripped.replace(/[-—－·\s]+$/, '');
  return s;
}

// 指纹归一化：全角标点转半角、去空白、转小写——避免（）与()等差异造成重复入库
const FW_MAP = { '（': '(', '）': ')', '：': ':', '，': ',', '、': ',', '；': ';', '！': '!', '？': '?', '【': '[', '】': ']', '「': '[', '」': ']', '　': '' };
function fpNorm(s) {
  return String(s || '')
    .replace(/[（）：，、；！？【】「」　]/g, c => FW_MAP[c] ?? c)
    .replace(/\s+/g, '')
    .toLowerCase();
}

module.exports = { normCity, normGradYear, normIndustry, normCompanyType, normExam, normReferral, cleanCompany, fpNorm };
