// 笔面经 / 口碑精华聚合：按 笔试/面试/口碑 维度聚合 essence
// 仅聚合「已提炼精华（essence）」的帖子（牛客来源）；用户原创暂不展示；不返回原始 content（避免侵权）
// 注：技术/非技术维度经实测区分无效，已于 2026-08-11 取消

function dimOf(type) {
  if (type === '笔经') return 'written';
  if (type === '面经') return 'interview';
  if (type === '口碑') return 'review';
  return null;
}

function newCell() { return { count: 0, tags: [], keypoints: [], tips: [], advice: [] }; }

function topTags(arr, n) {
  const m = {};
  for (const t of arr) { const k = (t || '').trim(); if (k) m[k] = (m[k] || 0) + 1; }
  return Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, n);
}

function dedupeTop(arr, n) {
  const seen = new Set(); const out = [];
  for (const x of arr) {
    const k = (x || '').trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(x.trim()); }
    if (out.length >= n) break;
  }
  return out;
}

// 返回 { exam, review, total }，exam = 笔试 + 面试 合并，review = 公司口碑（不再分技术/非技术）
function buildExperienceSummary(posts) {
  const R = {
    exam: newCell(),
    review: newCell(),
    total: 0
  };
  for (const p of posts || []) {
    if (!p.essence || !String(p.essence).trim()) continue;
    let e; try { e = JSON.parse(p.essence); } catch { continue; }
    const dim = dimOf(p.type);
    if (!dim) continue;
    const c = (dim === 'review') ? R.review : R.exam; // 笔试/面试 合并为「笔面试经验」
    c.count++; R.total++;
    if (Array.isArray(e.tags)) c.tags.push(...e.tags);
    if (Array.isArray(e.keypoints)) c.keypoints.push(...e.keypoints);
    if (Array.isArray(e.tips)) c.tips.push(...e.tips);
    if (Array.isArray(e.advice)) c.advice.push(...e.advice);
  }
  for (const key of ['exam', 'review']) {
    const c = R[key];
    c.tags = topTags(c.tags, 8);
    c.keypoints = dedupeTop(c.keypoints, 6);
    c.tips = dedupeTop(c.tips, 5);
    c.advice = dedupeTop(c.advice, 5);
  }
  return R;
}

module.exports = { buildExperienceSummary };
