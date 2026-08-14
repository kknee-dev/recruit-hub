// 岗位名 → URL slug 映射（手写英文 slug，避免中文出现在 URL 中）
// 仅用于 /guide/:slug 路由与所有攻略链接；数据库仍用中文岗位名，本文件不引入运行时依赖。
const NAME_TO_SLUG = {
  '产品经理': 'product-manager',
  '人力资源': 'human-resources',
  '化工材料': 'chemical-materials',
  '医药生物': 'biopharma',
  '咨询顾问': 'consulting',
  '土木建筑': 'civil-construction',
  '市场营销': 'marketing',
  '教师教研': 'education-teacher',
  '数据分析': 'data-analytics',
  '机械工程': 'mechanical-engineering',
  '校园大使': 'campus-ambassador',
  '法务合规': 'legal-compliance',
  '测试工程师': 'test-engineer',
  '生产制造': 'manufacturing',
  '电气工程': 'electrical-engineering',
  '硬件与芯片': 'hardware-chip',
  '科研岗': 'research-scientist',
  '算法工程师': 'algorithm-engineer',
  '管培生': 'management-trainee',
  '编辑与传媒': 'editor-media',
  '行政职能': 'admin-functions',
  '设计': 'design',
  '财务会计': 'finance-accounting',
  '质量管理': 'quality-management',
  '软件开发': 'software-development',
  '运维与IT': 'devops-it',
  '运营': 'operations',
  '采购供应链': 'procurement-supply-chain',
  '金融与银行': 'finance-banking',
  '销售': 'sales',
  '品牌经理': 'brand-manager',
  '前端开发': 'frontend-developer',
  '技术支持': 'tech-support'
};

const SLUG_TO_NAME = Object.fromEntries(
  Object.entries(NAME_TO_SLUG).map(([name, slug]) => [slug, name])
);

// 中文岗位名 → 英文 slug；找不到返回 null
function slugOf(name) {
  return NAME_TO_SLUG[name] || null;
}

// URL 片段（可能是 slug 或中文名）→ 中文岗位名；找不到返回 null
function nameOfSlug(key) {
  let decoded = key;
  try { decoded = decodeURIComponent(key); } catch { decoded = key; } // 路由已解码过；原始中文 URL 再次解码会抛 URIError
  if (SLUG_TO_NAME[decoded]) return SLUG_TO_NAME[decoded]; // 命中 slug
  if (NAME_TO_SLUG[decoded]) return decoded;               // 直接传了中文名
  return null;
}

module.exports = { NAME_TO_SLUG, SLUG_TO_NAME, slugOf, nameOfSlug };
