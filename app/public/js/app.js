/* 校招宝 前端 SPA */
(() => {
  const $ = sel => document.querySelector(sel);
  const view = $('#view');

  // 基路径：站点挂在子目录（如 /xzb2026）下时，所有站内导航带上前缀，
  // 保证 校招宝 在子目录中完全自包含、内部链接关系不变。根路径部署时 APP_BASE 为空。
  const APP_BASE = (location.pathname === '/xzb2026' || location.pathname.startsWith('/xzb2026/')) ? '/xzb2026' : '';
  const absUrl = p => (APP_BASE && typeof p === 'string' && p.startsWith('/') ? APP_BASE + p : p);

  // ---------- 状态 ----------
  const store = {
    get token() { return localStorage.getItem('xzb_token') || ''; },
    set token(v) { v ? localStorage.setItem('xzb_token', v) : localStorage.removeItem('xzb_token'); },
  };
  let ME = null;      // /api/me 缓存
  let META = null;

  // ---------- 工具 ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 截断职位名：在逗号边界截断，避免词语中间被切断（如"电子/半"）
  const posShort = (s, max = 40) => { s = String(s || ''); if (s.length <= max) return s; const cut = Math.max(s.lastIndexOf('，', max), s.lastIndexOf(',', max)); return (cut > max * 0.5 ? s.slice(0, cut) : s.slice(0, max)) + '…'; };
  // 企业简介：剥离「校招情报」标记块（已由「校招画像」区块承载），仅展示基础简介文本
  function renderIntel(intro) {
    if (!intro) return '';
    const base = intro.replace(/<!--XZB_INTEL-->[\s\S]*?<!--\/XZB_INTEL-->/, '').trim();
    if (!base) return '';
    return `<p style="line-height:1.7;color:var(--text);font-size:14px;margin:0">${esc(base)}</p>`;
  }
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
  // 搜索历史（最近 5 条，localStorage）
  const SH_KEY = 'xzb_search_hist';
  const getHist = () => { try { const a = JSON.parse(localStorage.getItem(SH_KEY) || '[]'); return Array.isArray(a) ? a.slice(0, 5) : []; } catch { return []; } };
  const addHist = q => { q = (q || '').trim(); if (!q) return; const h = [q, ...getHist().filter(x => x !== q)].slice(0, 5); localStorage.setItem(SH_KEY, JSON.stringify(h)); };
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', ms);
  }
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (store.token) headers.Authorization = 'Bearer ' + store.token;
    const send = { ...opts, headers };
    if (send.body && typeof send.body === 'object' && !(send.body instanceof FormData) && !(send.body instanceof Blob) && !(send.body instanceof ArrayBuffer)) {
      send.body = JSON.stringify(send.body);
    }
    const res = await fetch(path, send);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || '请求失败'); e.code = data.code; e.status = res.status; throw e; }
    return data;
  }
  // ---------- SEO：动态设置 title/description/OG/JSON-LD ----------
  function upsertMeta(sel, attr, key, val) {
    let el = document.head.querySelector(sel);
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
    el.setAttribute('content', val);
  }
  function setMeta({ title, description, ogTitle, jsonLd }) {
    if (title) document.title = title;
    if (description) {
      upsertMeta('meta[name="description"]', 'name', 'description', description);
      upsertMeta('meta[property="og:description"]', 'property', 'og:description', description);
    }
    if (ogTitle) upsertMeta('meta[property="og:title"]', 'property', 'og:title', ogTitle);
    let ld = document.getElementById('ld-json');
    if (jsonLd) {
      if (!ld) { ld = document.createElement('script'); ld.type = 'application/ld+json'; ld.id = 'ld-json'; document.head.appendChild(ld); }
      ld.textContent = JSON.stringify(jsonLd);
    } else if (ld) { ld.remove(); }
  }

  async function loadMe(force) {
    if (!store.token) { ME = null; return null; }
    if (ME && !force) return ME;
    try { ME = await api('/api/me'); }
    catch (e) {
      // 仅在明确 401/403 时清除 token；网络/瞬时错误保留，避免被静默登出
      if (e.status === 401 || e.status === 403) { ME = null; store.token = ''; }
      else { ME = null; }
    }
    return ME;
  }
  async function loadMeta() { if (!META) META = await api('/api/meta'); return META; }

  function ddlHtml(d) {
    if (!d) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return `<span class="ddl ok">${esc(d)}</span>`;
    const days = Math.ceil((new Date(d + 'T23:59:59') - Date.now()) / 86400000);
    if (days < 0) return `<span class="ddl ddl-end">已截止</span>`;
    if (days <= 3) return `<span class="ddl ddl-urgent">剩 ${days} 天</span>`;
    if (days <= 7) return `<span class="ddl ddl-soon">剩 ${days} 天</span>`;
    return `<span class="ddl">截止 ${esc(d)}</span>`;
  }
  // 公司字母头像：按行业映射语义色
  function avatarCls(industry) {
    const s = industry || '';
    if (/互联|科技|软件|网络|信息|数据/.test(s)) return 'avatar-tech';
    if (/金融|银行|证券|保险|基金|信托|期货/.test(s)) return 'avatar-fin';
    if (/制造|机械|汽车|电子|电气|化工|材料|能源|建筑|工程/.test(s)) return 'avatar-mfg';
    if (/医药|生物|医疗|健康|制药/.test(s)) return 'avatar-med';
    if (/教育|大学|学院|学校/.test(s)) return 'avatar-edu';
    if (/政府|事业|机关|部队|军队/.test(s)) return 'avatar-gov';
    if (/通信|电信|运营商/.test(s)) return 'avatar-ind';
    return 'avatar-def';
  }
  const avatarHtml = (company, industry) => `<span class="avatar ${avatarCls(industry)}">${esc(String(company || '?')[0])}</span>`;
  function isJobExpired(j) {
    const d = j && j.deadline;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
    return (Date.now() - new Date(d + 'T23:59:59').getTime()) / 86400000 >= 0;
  }
  const todayStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  // ===== 笔面经精华渲染（LLM 提炼：tags/keypoints/tips/advice）=====
  function parseEssence(p) {
    if (!p || !p.essence) return null;
    try { const e = JSON.parse(p.essence); return (e && (e.tags || e.keypoints || e.tips || e.advice)) ? e : null; }
    catch { return null; }
  }
  // 精华卡片 HTML（公司页主展示）
  function postEssenceHtml(p) {
    const e = parseEssence(p);
    if (!e) return '';
    const tags = (e.tags || []).map(t => `<span class="es-tag">${esc(t)}</span>`).join('');
    const kp = (e.keypoints || []).map(x => `<li>${esc(x)}</li>`).join('');
    const tips = (e.tips || []).map(x => `<li>${esc(x)}</li>`).join('');
    const adv = (e.advice || []).map(x => `<li>${esc(x)}</li>`).join('');
    return `<div class="es">
      ${tags ? `<div class="es-tags">${tags}</div>` : ''}
      ${kp ? `<div class="es-sec"><b class="es-h">🔑 核心要点</b><ul>${kp}</ul></div>` : ''}
      ${tips ? `<div class="es-sec"><b class="es-h">⚠️ 注意事项</b><ul>${tips}</ul></div>` : ''}
      ${adv ? `<div class="es-sec"><b class="es-h">💡 实用建议</b><ul>${adv}</ul></div>` : ''}
    </div>`;
  }
  // 招聘详情页 miniPost 的一句话精华预览
  function postEssencePreview(p) {
    const e = parseEssence(p);
    if (!e) return '';
    const lead = (e.keypoints && e.keypoints[0]) || (e.tags && e.tags[0]) || '';
    return lead ? `<div class="mp-es">${esc(lead)}</div>` : '';
  }
  // ===== 笔面经/口碑精华聚合视图（不展示原文，仅展示提炼精华）=====
  function expBlock(title, cell) {
    if (!cell || !cell.count) return '';
    const tags = (cell.tags || []).map(t => `<span class="exp-tag">${esc(t)}</span>`).join('');
    const kp = (cell.keypoints || []).map(x => `<li>${esc(x)}</li>`).join('');
    const tips = (cell.tips || []).map(x => `<li>${esc(x)}</li>`).join('');
    const adv = (cell.advice || []).map(x => `<li>${esc(x)}</li>`).join('');
    return `<div class="exp-role">
      <div class="exp-role-h">${title} <span class="exp-n">${cell.count} 篇</span></div>
      ${tags ? `<div class="exp-tags">${tags}</div>` : ''}
      ${kp ? `<div class="exp-sec"><b class="exp-h">🔑 核心要点</b><ul>${kp}</ul></div>` : ''}
      ${tips ? `<div class="exp-sec"><b class="exp-h">⚠️ 注意事项</b><ul>${tips}</ul></div>` : ''}
      ${adv ? `<div class="exp-sec"><b class="exp-h">💡 实用建议</b><ul>${adv}</ul></div>` : ''}
    </div>`;
  }
  function experienceAggregateHtml(sum) {
    if (!sum || !sum.total) return '<div class="empty">暂无笔面经精华，来写第一篇吧 ✍️</div>';
    const ex = expBlock('✍️ 笔面试经验', sum.exam);
    const rev = expBlock('🏢 公司口碑', sum.review);
    let h = ex + rev;
    h += `<div class="exp-src">数据来源：牛客网用户匿名分享，经校招宝提炼聚合展示，原始内容不提供。</div>`;
    return h;
  }
  function expTeaserHtml(sum, slug) {
    if (!sum || !sum.total) return '';
    return `<a class="morelink" href="/company/${encodeURIComponent(slug)}">📊 已聚合 ${sum.total} 篇精华，点击查看笔面试经验 ›</a>`;
  }
  // 校招画像（公众号官方公告自动提炼）：两档分离
  //  - 企业级概览：company_profiles.campus_recruit 中批次无关的字段（价值亮点/岗位方向/企业简介/投递要点），适用该企业所有岗位
  //  - 本次招聘画像：job.notice_recruit（按本条公告 notice_url 生成）的批次相关字段，仅展示与当前岗位同一公告的画像，避免错配
  function campusRecruitHtml(profile, noticeRecruitJson) {
    let co = null, nr = null;
    if (profile && profile.campus_recruit) { try { co = JSON.parse(profile.campus_recruit); } catch { co = null; } }
    if (noticeRecruitJson) { try { nr = JSON.parse(noticeRecruitJson); } catch { nr = null; } }
    if (!co && !nr) return '';
    const row = (k, v) => v ? `<div class="cr-row"><span class="cr-k">${k}</span><span class="cr-v">${esc(v)}</span></div>` : '';
    const desc = (label, v) => v ? `<div class="cr-desc"><div class="cr-dt">${label}</div><div class="cr-dv">${esc(v)}</div></div>` : '';

    // 有本条公告画像 → 两档：企业概览 + 本次招聘画像
    if (nr && nr.summary) {
      const ovBits = [
        row('💡 价值亮点', co && co.value ? co.value : ''),
        row('🧭 岗位方向', co && co.positions ? co.positions : ''),
      ].join('');
      const ovDescs = [
        desc('🏢 企业简介', co && co.org_intro ? co.org_intro : ''),
        desc('🚀 投递要点', co && co.apply_tips ? co.apply_tips : ''),
      ].join('');
      const overview = `<div class="section cp-campus company-overview"><h2>🏢 企业概览 · 来自官方公告</h2>
        ${ovDescs ? `<div class="cr-descs">${ovDescs}</div>` : ''}
        ${ovBits ? `<div class="cr-box">${ovBits}</div>` : ''}
        <div class="cr-note">由公众号官方招聘公告自动提炼，仅供参考</div></div>`;
      const nBits = [
        row('🎓 校招对象', (nr.grad_classes || []).join('、')),
        row('🗓️ 毕业窗口', nr.grad_time || ''),
        row('🎯 面向对象', (nr.targets || []).join('，')),
        row('💰 薪资参考', nr.salary || ''),
      ].join('');
      const nDescs = [
        desc('📋 招聘情况', nr.situation || ''),
        desc('💡 价值亮点', nr.value || ''),
        desc('🧭 岗位方向', nr.positions || ''),
        desc('🚀 投递要点', nr.apply_tips || ''),
      ].join('');
      const notice = `<div class="section cp-campus notice-recruit"><h2>📢 本次招聘画像 · 来自本条官方公告</h2>
        <div class="cr-summary">${esc(nr.summary)}</div>
        ${nBits ? `<div class="cr-box">${nBits}</div>` : ''}
        ${nDescs ? `<div class="cr-descs">${nDescs}</div>` : ''}
        <div class="cr-note">由本条官方招聘公告自动提炼，仅供参考</div></div>`;
      return overview + notice;
    }

    // 无本条公告画像（尚未回填）→ 退回单块企业级画像（保持现状，回填后自动升级为两档）
    if (co && co.summary) {
      const bits = [
        row('🎓 校招对象', (co.grad_classes || []).join('、')),
        row('🗓️ 毕业窗口', co.grad_time || ''),
        row('🎯 面向对象', (co.targets || []).join('，')),
        row('💰 薪资参考', co.salary || ''),
      ].join('');
      const descs = [
        desc('📋 招聘情况', co.situation || ''),
        desc('💡 价值亮点', co.value || ''),
        desc('🧭 岗位方向', co.positions || ''),
        desc('🚀 投递要点', co.apply_tips || ''),
      ].join('');
      return `<div class="section cp-campus"><h2>📢 校招画像 · 来自官方公告</h2>
        <div class="cr-summary">${esc(co.summary)}</div>
        ${bits ? `<div class="cr-box">${bits}</div>` : ''}
        ${descs ? `<div class="cr-descs">${descs}</div>` : ''}
        <div class="cr-note">由公众号官方招聘公告自动提炼，仅供参考</div></div>`;
    }
    return '';
  }

  function jobCard(j, fav) {
    // 分行/同职位聚合卡（后端已合并为一条，点开看各分行投递入口）
    if (j.group && j.group.count > 1) return groupCard(j, fav);
    // NEW 标签：仅最近 10 天内发布的显示
    const isNew = (() => {
      const d = j.publish_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
      const diff = (Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000;
      return diff >= 0 && diff < 10;
    })();
    return `<a class="jcard" href="/job/${j.id}">
      <div class="row1">
        ${avatarHtml(j.company, j.industry)}
        <span class="co">${esc(j.company)}</span>
        ${isNew ? '<span class="tag new">NEW</span>' : ''}
        <span class="tag batch">${esc(j.batch || '校招')}</span>
        ${j.company_type ? `<span class="tag ct">${esc(j.company_type)}</span>` : ''}
        ${j.quality_score >= 70 ? '<span class="tag qual hi" title="信息质量高">✦</span>' : ''}
        <span class="fav-star" onclick="event.preventDefault(); event.stopPropagation(); toggleFav(${j.id}, this)">${fav ? '★' : '☆'}</span>
      </div>
      <div class="pos">${esc(j.position)}</div>
      <div class="meta">
        ${j.city ? `<span>📍 <b>${esc(j.city.split(',').slice(0, 3).join('/'))}${j.city.split(',').length > 3 ? '等' : ''}</b></span>` : ''}
        ${j.grad_year ? `<span>🎓 ${esc(j.grad_year.split(',').slice(0, 3).join('/'))}</span>` : ''}
        ${j.publish_date ? `<span>📅 ${esc(j.publish_date)}</span>` : ''}
        ${ddlHtml(j.deadline)}
      </div>
    </a>`;
  }

  // 分行聚合卡：主卡显示聚合公司/职位/城市，点开展开各分行投递入口
  function groupCard(j, fav) {
    const g = j.group;
    const allCities = [];
    for (const c of g.cities) {
      for (const cc of String(c || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)) {
        if (!allCities.includes(cc)) allCities.push(cc);
      }
    }
    const cityShow = allCities.length > 4
      ? `${allCities.slice(0, 4).join('/')} 等 ${allCities.length} 城`
      : allCities.join('/');
    const members = g.member_ids.map((id, i) => {
      const c = g.member_companies[i] || '';
      const cs = String(g.cities[i] || '').split(/[,，]/).filter(Boolean).slice(0, 2).join('/');
      return `<a class="grp-member" href="/job/${id}"><span class="gm-co">${esc(c)}</span><span class="gm-city">${esc(cs)}</span><span class="gm-go">投递 ›</span></a>`;
    }).join('');
    return `<div class="jcard group-card" onclick="toggleGroup(this)">
      <div class="row1">
        ${avatarHtml(j.company, j.industry)}
        <span class="co">${esc(j.company)}</span>
        <span class="tag grp">${g.count} 个分行</span>
        <span class="tag batch">${esc(j.batch || '校招')}</span>
        ${j.company_type ? `<span class="tag ct">${esc(j.company_type)}</span>` : ''}
        <span class="fav-star" onclick="event.stopPropagation(); event.preventDefault(); toggleFav(${j.id}, this)">${fav ? '★' : '☆'}</span>
      </div>
      <div class="pos">${esc(j.position)}</div>
      <div class="meta">
        <span>📍 <b>${esc(cityShow)}</b></span>
        ${j.grad_year ? `<span>🎓 ${esc(j.grad_year.split(',').slice(0, 3).join('/'))}</span>` : ''}
        ${j.publish_date ? `<span>📅 ${esc(j.publish_date)}</span>` : ''}
        ${ddlHtml(j.deadline)}
      </div>
      <div class="grp-body" style="display:none">${members}</div>
      <div class="grp-toggle">查看全部 ${g.count} 个分行投递入口 <span class="gt-arr">▾</span></div>
    </div>`;
  }

  window.toggleGroup = (card) => {
    const body = card.querySelector('.grp-body');
    const arr = card.querySelector('.gt-arr');
    const on = body.style.display !== 'none';
    body.style.display = on ? 'none' : 'block';
    if (arr) arr.textContent = on ? '▾' : '▴';
  };

  window.toggleFav = async (jobId, el) => {
    const token = store.token;
    if (!token) { location.href = loginHref(); return; }
    try {
      const r = await fetch('/api/favorites/' + jobId, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '操作失败');
      el.textContent = d.fav ? '★' : '☆';
      el.classList.toggle('on', !!d.fav);
      toast(d.fav ? '已收藏' : '已取消收藏');
    } catch (e) { toast(e.message); }
  };

  function expiredCard(j) {
    return `<a class="jcard expired-card" href="/job/${j.id}">
      <div class="row1">
        <span class="co">${esc(j.company)}</span>
        <span class="tag batch">${esc(j.batch || '校招')}</span>
        ${j.company_type ? `<span class="tag ct">${esc(j.company_type)}</span>` : ''}
      </div>
      <div class="pos">${esc(j.position)}</div>
      <div class="meta">
        ${j.city ? `<span>📍 <b>${esc(j.city.split(',').slice(0, 3).join('/'))}${j.city.split(',').length > 3 ? '等' : ''}</b></span>` : ''}
        ${j.publish_date ? `<span>📅 ${esc(j.publish_date)}</span>` : ''}
        ${j.deadline ? `<span class="ddl">截止 ${esc(j.deadline)}</span>` : ''}
        <span class="expired-badge">已截止</span>
      </div>
    </a>`;
  }

  function modal(html) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
    root.querySelector('.modal-mask').addEventListener('click', e => { if (e.target.classList.contains('modal-mask')) closeModal(); });
    return root;
  }
  const closeModal = () => {
    const r = $('#modal-root');
    r.querySelectorAll('.drawer, .drawer-mask, .modal-mask').forEach(el => el.classList.add('closing'));
    setTimeout(() => r.innerHTML = '', 230);
  };
  window._closeModal = closeModal;
  // 数字滚动（count-up）：仅首页大数字使用，滚动到可视区触发
  function countUp(el) {
    const target = parseInt(el.dataset.n || el.textContent, 10);
    if (isNaN(target) || target === parseInt(el.textContent, 10)) { el.textContent = target; return; }
    const dur = 650, t0 = performance.now();
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // 骨架屏：列表加载占位
  function skelList(n = 3) {
    return `<div class="skel-list">${Array(n).fill(`<div class="skel-card"><div class="skel-row w40 h16"></div><div class="skel-row w90"></div><div class="skel-row w70"></div></div>`).join('')}</div>`;
  }

  // 内页通用页头：返回按钮 + 标题 + 右侧「🎯 校招宝」(点击回主页)
  function pageHead(title) {
    return `<div class="pagehead"><button class="back" onclick="history.back()">‹</button><h1>${esc(title)}</h1><a class="ph-brand" href="/">${LOGO_IC}<span class="ph-name">校招宝</span></a></div>`;
  }
  // 登录/注册入口：携带当前页面路径，登录成功后回跳并刷新
  function loginHref() {
    return APP_BASE + '/login?redirect=' + encodeURIComponent(location.pathname + location.search + location.hash);
  }
  // 资料下载：未登录引导登录，否则用 fetch + blob 下载（解决 window.open 不带 Authorization header 的问题）
  window.downloadMat = async id => {
    if (!store.token) { location.href = loginHref(); return; }
    try {
      const res = await fetch('/m/' + id, {
        headers: { 'Authorization': 'Bearer ' + store.token }
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || '下载失败'); return; }
      // 从 Content-Disposition 提取文件名
      const cd = res.headers.get('Content-Disposition') || '';
      const name = cd.match(/filename\*=UTF-8''([^;]+)/) ? decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)[1]) :
                    cd.match(/filename="?([^";]+)"?/) ? cd.match(/filename="?([^";]+)"?/)[1] : 'material';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { alert('下载失败：' + e.message); }
  };
  const canPreview = ft => ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'txt', 'csv'].includes((ft || '').toLowerCase());
  window.previewMat = async id => {
    if (!store.token) { location.href = loginHref(); return; }
    try {
      const res = await fetch('/p/' + id, {
        headers: { 'Authorization': 'Bearer ' + store.token }
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || '预览失败'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { alert('预览失败：' + e.message); }
  };

  // ---------- 路由 ----------
  const routes = [];
  const route = (re, fn) => routes.push([re, fn]);
  async function render() {
    // SSR 标记检测：移除 SSR meta 后让 SPA 路由完整渲染所有页面（含交互元素）
    const ssrMeta = document.querySelector('meta[name="ssr"]');
    if (ssrMeta) { ssrMeta.remove(); }
    let path = location.pathname || '/';
    // 子目录部署：去掉基路径前缀后再做路由匹配，使 /xzb2026/xxx 等价于根目录 /xxx
    if (APP_BASE && path.startsWith(APP_BASE)) path = path.slice(APP_BASE.length) || '/';
    // 招聘详情页有固定投递栏(applybar)，隐藏底部导航避免两层固定层重叠（tabbar 会挡住 applybar）
    const tab = document.getElementById('tabbar');
    if (tab) tab.style.display = /^\/job\//.test(path) ? 'none' : '';
    for (const [re, fn] of routes) {
      const m = path.match(re);
      if (m) {
        document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === path.split('?')[0] || (a.dataset.tab === 'home' && path === '/')));
        window.scrollTo(0, 0);
        try { await fn(...m.slice(1).map(decodeURIComponent)); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
        return;
      }
    }
    location.href = absUrl('/');
  }
  window.addEventListener('popstate', render);
  window.addEventListener('DOMContentLoaded', render);

  // 子目录部署（/xzb2026）：把站内绝对链接改写为 BASE+原路径，站内跳转不跳出子目录、链接关系不变。
  // 仅捕获 <a href="/..."> 站内绝对链接；hash 链接、外链、新窗口/下载链接不受影响。
  if (APP_BASE && !window.__xzbBaseHook) {
    window.__xzbBaseHook = true;
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a');
      if (!a) return;
      const raw = a.getAttribute('href');
      if (!raw || !raw.startsWith('/')) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      e.preventDefault();
      location.href = APP_BASE + raw;
    }, true);
  }

  // ================= 意见反馈（匿名，常驻悬浮入口） =================
  function initFeedbackFab() {
    if (document.getElementById('fb-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'fb-fab';
    fab.innerHTML = '💬<span>反馈</span>';
    fab.setAttribute('aria-label', '意见反馈');
    fab.onclick = openFeedback;
    document.body.appendChild(fab);
  }
  function openFeedback() {
    const cats = ['功能建议', '内容纠错', '体验问题', '其他'];
    modal(`
      <h3 style="margin:0 0 12px;font-size:16px">📣 意见反馈</h3>
      <p style="margin:0 0 12px;color:var(--muted,#888);font-size:12px">匿名提交，无需登录。我们会每日汇总分析，认真考虑每一条建议。</p>
      <div class="fb-field">
        <label>类型</label>
        <div class="fb-cats">
          ${cats.map((c, i) => `<button type="button" class="fb-cat${i === 0 ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('')}
        </div>
      </div>
      <div class="fb-field">
        <label>内容</label>
        <textarea id="fb-text" maxlength="1000" rows="5" placeholder="说说你的想法、遇到的问题或想要的功能…"></textarea>
      </div>
      <div class="fb-field">
        <label>联系方式（选填，便于回复）</label>
        <input id="fb-contact" type="text" maxlength="60" placeholder="邮箱 / 微信，留空则匿名" style="width:100%;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
        <button class="ghost" onclick="window._closeModal()">取消</button>
        <button id="fb-submit">提交反馈</button>
      </div>
    `);
    let cat = '功能建议';
    const root = document.getElementById('modal-root');
    root.querySelectorAll('.fb-cat').forEach(b => b.onclick = () => {
      root.querySelectorAll('.fb-cat').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); cat = b.dataset.cat;
    });
    root.querySelector('#fb-submit').onclick = async () => {
      const text = root.querySelector('#fb-text').value.trim();
      const contact = root.querySelector('#fb-contact').value.trim();
      if (text.length < 2) return toast('请先填写反馈内容');
      const btn = root.querySelector('#fb-submit');
      btn.disabled = true; btn.textContent = '提交中…';
      try {
        await api('/api/feedback', { method: 'POST', body: { category: cat, text: contact ? text + '\n[联系方式] ' + contact : text, page: location.pathname + location.search } });
        window._closeModal();
        toast('✅ 已收到，感谢你的反馈！');
      } catch (e) {
        btn.disabled = false; btn.textContent = '提交反馈';
        toast('提交失败：' + (e.message || '网络错误'));
      }
    };
  }
  initFeedbackFab();

  // ================= 首页：情报列表 =================
  const F = { q: '', batch: '', company_type: '', city: '', grad_year: '', education: '', industry: '', exam: '', sort: '' };
  let page = 1, loading = false, listDone = false;
  // 返回上一页/刷新后保留搜索结果：把筛选状态写入地址栏，重载时从地址栏还原
  let pendingHomeScroll = null; // 返回首页时待还原的滚动位置

  const FKEYS = ['q', 'batch', 'company_type', 'city', 'grad_year', 'education', 'industry', 'exam', 'sort'];
  function buildQuery() {
    const p = new URLSearchParams();
    for (const k of FKEYS) {
      const v = F[k];
      if (Array.isArray(v) ? v.length : v) p.set(k, Array.isArray(v) ? v.join(',') : v);
    }
    if (page > 1) p.set('page', page);
    return p.toString();
  }
  function syncUrl(push) {
    const q = buildQuery();
    const url = absUrl('/' + (q ? '?' + q : ''));
    if (push) history.pushState({ xzbHome: true }, '', url);
    else history.replaceState({ xzbHome: true }, '', url);
  }
  function loadFfromUrl() {
    const p = new URLSearchParams(location.search);
    for (const k of FKEYS) {
      const raw = p.get(k) || '';
      F[k] = k === 'city' ? (raw ? raw.split(/[,，]/).map(s => s.trim()).filter(Boolean) : '') : raw;
    }
    page = Math.max(1, parseInt(p.get('page')) || 1);
  }
  // 离开首页（点岗位/企业等进入详情）时记录滚动位置，配合 URL 中的搜索状态，返回后还原
  if (!window.__xzbLeaveHook) {
    window.__xzbLeaveHook = true;
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a');
      if (a && a.href && a.origin === location.origin && a.getAttribute('href') !== '/' && !a.getAttribute('href').startsWith('/?')) {
        try { sessionStorage.setItem('xzb_home_restore', String(window.scrollY)); } catch {}
      }
    }, true);
  }

  route(/^\/$/, async () => {
    await loadMeta(); await loadMe();
    loadFfromUrl();
    // 从地址栏还原滚动位置（仅在返回上一页时存在）
    pendingHomeScroll = null;
    try { const s = sessionStorage.getItem('xzb_home_restore'); if (s != null) pendingHomeScroll = parseInt(s, 10) || 0; } catch {}
    try { sessionStorage.removeItem('xzb_home_restore'); } catch {}
    setMeta({
      title: '校招宝 · 应届生校招情报站',
      description: '校招宝聚合秋招、春招、实习、提前批等校招信息，支持精准筛选、企业档案、笔面经与每日订阅情报邮件，解决校招信息不对称。',
      ogTitle: '校招宝 · 应届生校招情报站'
    });
    const fcount = ['company_type', 'city', 'grad_year', 'education', 'industry', 'exam'].filter(k => Array.isArray(F[k]) ? F[k].length : F[k]).length;
    view.innerHTML = `
      <div class="hero">
        <div class="brand">
          <div><div class="logo"><span class="logo-ic"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="18"/><circle cx="24" cy="24" r="10"/><circle cx="24" cy="24" r="2.5"/><line x1="24" y1="24" x2="38" y2="10"/><line x1="42" y1="24" x2="38" y2="24"/><line x1="24" y1="42" x2="24" y2="38"/></svg></span>校招宝</div><div class="slogan">应届生校招情报站 · 不错过任何一个机会</div></div>
          <div class="stat">已收录 <b class="hero-count" data-n="${META.total}">${META.total}</b> 条<div class="stat-sub">今日新增 <b class="hero-count" data-n="${META.today_added || 0}">${META.today_added || 0}</b> 条</div></div>
        </div>
        <div class="searchbar">
          <span>🔍</span>
          <input id="q" placeholder="搜公司 / 岗位 / 行业，如：腾讯、算法" value="${esc(F.q)}" autocomplete="off">
          <button class="go" id="qgo">搜索</button>
        </div>
        <div class="shist" id="shist" style="display:none"></div>
      </div>
      <div class="filterrow">
        <button class="fbtn ${F.batch === '' ? 'on' : ''}" id="ball">全部</button>
        <button class="fbtn ${fcount ? 'hasf' : ''}" id="fopen">⚙️ 筛选${fcount ? `(${fcount})` : ''}</button>
        <button class="fbtn ${!F.sort ? 'on' : ''}" id="snew">最新发布</button>
        <button class="fbtn ${F.sort === 'deadline' ? 'on' : ''}" id="sdead">即将截止 <b>${META.soon_expiring || 0}</b> 条</button>
        ${fcount ? '<button class="fbtn" id="fclear">✕ 清空</button>' : ''}
      </div>
      <div class="list" id="list"></div>
      <div id="more"></div>
      <div class="notice">数据每日更新 · 信息来源于公开渠道，投递前请核实</div>`;

    // 搜索历史：聚焦/输入为空时展示最近 5 条
    const shBox = $('#shist');
    const hideHist = () => { shBox.style.display = 'none'; };
    const showHist = () => {
      const h = getHist();
      if (!h.length || $('#q').value.trim()) { hideHist(); return; }
      shBox.innerHTML = h.map(k => `<button class="sh-item" data-k="${esc(k)}">🕘 ${esc(k)}</button>`).join('') +
        `<button class="sh-clear" id="shclear">✕ 清除</button>`;
      shBox.style.display = 'flex';
      shBox.querySelectorAll('.sh-item').forEach(b => b.onmousedown = e => {
        e.preventDefault();
        $('#q').value = b.dataset.k; F.q = b.dataset.k; addHist(F.q); hideHist(); resetList();
      });
      $('#shclear').onmousedown = e => { e.preventDefault(); localStorage.removeItem(SH_KEY); hideHist(); };
    };
    const doSearch = () => { F.q = $('#q').value.trim(); addHist(F.q); hideHist(); pendingHomeScroll = null; try { sessionStorage.removeItem('xzb_home_restore'); } catch {}; syncUrl(true); resetList(); };
    $('#qgo').onclick = doSearch;
    $('#q').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
    $('#q').onfocus = showHist;
    $('#q').oninput = showHist;
    $('#q').onblur = () => setTimeout(hideHist, 150);
    $('#ball').onclick = () => { F.batch = ''; page = 1; syncUrl(false); render(); };
    $('#fopen').onclick = openFilterDrawer;
    $('#snew').onclick = () => { F.sort = ''; page = 1; syncUrl(false); render(); };
    $('#sdead').onclick = () => { F.sort = 'deadline'; page = 1; syncUrl(false); render(); };
    if ($('#fclear')) $('#fclear').onclick = () => { Object.assign(F, { company_type: '', city: '', grad_year: '', education: '', industry: '', exam: '' }); page = 1; syncUrl(false); render(); };
    view.querySelectorAll('.hero-count').forEach(countUp);
    resetList();
  });

  // 编号分页控件（SEO 友好：每页独立可访问）
  function pagerHtml(total, page, size) {
    const pages = Math.ceil(total / size);
    if (pages <= 1) return total === 0 ? '<div class="empty">😅 没有符合条件的信息，换个条件试试</div>' : '<div class="notice">— 共 ' + total + ' 条 —</div>';
    let s = '<div class="pager">';
    if (page > 1) s += `<button class="pg" data-pg="${page - 1}">‹ 上一页</button>`;
    const win = [];
    for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 2) win.push(i);
    let prev = 0;
    for (const i of win) { if (i - prev > 1) s += '<span class="pg-ell">…</span>'; s += `<button class="pg ${i === page ? 'on' : ''}" data-pg="${i}">${i}</button>`; prev = i; }
    if (page < pages) s += `<button class="pg" data-pg="${page + 1}">下一页 ›</button>`;
    s += `<span class="pg-info">第 ${page}/${pages} 页</span></div>`;
    return s;
  }
  function resetList() { page = 1; listDone = false; const l = $('#list'); if (l) l.innerHTML = skelList(3); loadPage(); }
  async function loadPage() {
    if (loading || listDone) return;
    loading = true;
    const more = $('#more');
    if (more) more.innerHTML = '';
    const qs = new URLSearchParams();
    for (const k in F) if (F[k]) qs.set(k, F[k]);
    qs.set('page', page); qs.set('size', 50);
    const data = await api('/api/jobs?' + qs);
    const l = $('#list');
    if (!l) { loading = false; return; }
    let favSet = new Set();
    if (store.token) { try { const f = await api('/api/favorites'); favSet = new Set(f.list.map(x => x.id)); } catch {} }
    l.innerHTML = data.list.map(j => jobCard(j, favSet.has(j.id))).join('');
    l.classList.remove('view-in'); void l.offsetWidth; l.classList.add('view-in');
    listDone = page * data.size >= data.total;
    if (more) {
      more.innerHTML = pagerHtml(data.total, page, data.size);
      more.querySelectorAll('.pg[data-pg]').forEach(b => b.onclick = () => {
        page = parseInt(b.dataset.pg); syncUrl(false);
        window.scrollTo(0, 0);   // 翻页回到列表头部
        l.innerHTML = skelList(3); listDone = false; loadPage();
      });
    }
    // 返回上一页时还原滚动位置（仅首页第 1 页；翻页不再二次还原）
    if (pendingHomeScroll !== null) {
      if (page === 1) window.scrollTo(0, pendingHomeScroll);
      pendingHomeScroll = null;
    }
    loading = false;
  }

  function openFilterDrawer() {
    const groups = [
      ['batch', '招聘批次'],
      ['company_type', '企业类型'], ['city', '工作城市'], ['grad_year', '毕业届别'],
      ['education', '学历要求'], ['industry', '行业类别'], ['exam', '笔试情况']
    ];
    const MULTI = ['city']; // 支持多选的字段（后端 /api/jobs 已支持数组/逗号分隔 OR 匹配）
    const tmp = { ...F, city: Array.isArray(F.city) ? [...F.city] : (F.city ? String(F.city).split(/[,，]/).map(s => s.trim()).filter(Boolean) : []) };
    const root = $('#modal-root');
    const isOn = (k, v) => MULTI.includes(k)
      ? (Array.isArray(tmp[k]) ? tmp[k].includes(v) : false)
      : tmp[k] === v;
    const gHtml = groups.map(([k, label]) => `
      <div class="fgroup"><div class="gt">${label}${MULTI.includes(k) ? '<span class="gt-multi">可多选</span>' : ''}</div>
        <div class="fopts" data-k="${k}">
          ${META[k].map(v => `<button class="fopt ${isOn(k, v) ? 'on' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}
        </div></div>`).join('');
    root.innerHTML = `<div class="drawer-mask"></div>
      <div class="drawer">
        <div class="dh">筛选条件 <button class="back" id="dclose">✕</button></div>
        <div class="db">${gHtml}</div>
        <div class="df">
          <button class="btn btn-ghost" id="dreset">重置</button>
          <button class="btn btn-primary" id="dok">确定</button>
        </div>
      </div>`;
    root.querySelector('.drawer-mask').onclick = closeModal;
    $('#dclose').onclick = closeModal;
    $('#dreset').onclick = () => { groups.forEach(([k]) => tmp[k] = MULTI.includes(k) ? [] : ''); root.querySelectorAll('.fopt.on').forEach(o => o.classList.remove('on')); };
    root.querySelectorAll('.fopts').forEach(box => box.onclick = e => {
      const v = e.target.dataset.v; if (v === undefined) return;
      const k = box.dataset.k;
      if (MULTI.includes(k)) {
        let arr = Array.isArray(tmp[k]) ? [...tmp[k]] : [];
        arr = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
        tmp[k] = arr;
        box.querySelectorAll('.fopt').forEach(o => o.classList.toggle('on', arr.includes(o.dataset.v)));
      } else {
        tmp[k] = tmp[k] === v ? '' : v;
        box.querySelectorAll('.fopt').forEach(o => o.classList.toggle('on', o.dataset.v === tmp[k]));
      }
    });
    $('#dok').onclick = () => { Object.assign(F, tmp); page = 1; closeModal(); syncUrl(false); render(); };
  }

  // ================= 详情页 =================
  route(/^\/job\/(\d+)$/, async id => {
    await loadMe();
    const d = await api('/api/jobs/' + id);
    const j = d.job, locked = d.locked, tier = d.tier, fav = d.fav, manual = d.manual;
    let track = d.track;
    const parent = j.parent_company || j.company;
    setMeta({
      title: `${j.company} ${posShort(j.position)} 招聘 - 校招宝`,
      description: `${j.company} 招聘 ${posShort(j.position)}（${j.batch || '校招'}）｜工作地：${j.city || '未注明'}｜截止：${j.deadline || '未注明'}。校招宝聚合校招情报。`,
      ogTitle: `${j.company} ${posShort(j.position)} 招聘`,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'JobPosting',
        title: `${posShort(j.position)} - ${j.company}`,
        hiringOrganization: { '@type': 'Organization', name: parent },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: (j.city || '').split(',')[0] } },
        description: `${j.company} 招聘 ${posShort(j.position)}（${j.batch || '校招'}），工作地：${j.city || '未注明'}，截止：${j.deadline || '未注明'}。来源：校招宝。`
      }
    });
    let comp = null;
    try { comp = await api('/api/companies/' + encodeURIComponent(parent)); } catch (e) { comp = null; }
    const kv = (k, v, html) => v ? `<div class="kv"><div class="k">${k}</div><div class="v">${html || esc(v)}</div></div>` : '';
    // 敏感字段门控：未登录提示登录，登录后展示
    const gate = (txt) => `<div class="gate"><span class="g-ic">🔒</span><span class="g-txt">${txt}</span><a class="g-link" href="${loginHref()}">登录后查看 ›</a></div>`;
    const loginTag = locked
      ? `<div class="loginflag guest">未登录 · <a href="${loginHref()}">去登录 / 注册</a></div>`
      : `<div class="loginflag ok">✅ 已登录${ME && ME.email ? ' · ' + esc(ME.email) : ''}</div>`;

    const otherJobs = comp ? comp.jobs.filter(x => String(x.id) !== String(j.id)).slice(0, 6) : [];
    const posts = comp ? comp.posts : [];

    const expired = isJobExpired(j);
    let applyBar;
    if (!locked) {
      const applyBtn = expired
        ? `<a class="btn btn-primary" href="${esc(j.notice_url || j.apply_url || '#')}" target="_blank" rel="noopener">📋 查看详情</a>`
        : j.apply_type === 'email'
        ? `<a class="btn btn-primary" href="mailto:${esc(j.apply_url)}">📧 邮箱投递</a>`
        : j.apply_type === 'link'
          ? `<a class="btn btn-primary" href="${esc(j.apply_url)}" target="_blank" rel="noopener">🚀 立即投递</a>`
          : `<button class="btn btn-primary" onclick="_copy('${esc(j.apply_url)}')">📋 复制投递方式</button>`;
      applyBar = `<div class="applybar"><button class="btn btn-ghost" id="favbtn">${fav ? '★ 已收藏' : '☆ 收藏'}</button><button class="btn btn-ghost" id="sharebtn">分享</button>${applyBtn}</div>`;
    } else {
      const cta = `<a class="btn btn-primary" href="${loginHref()}">登录解锁投递</a>`;
      applyBar = `<div class="applybar"><button class="btn btn-ghost" id="sharebtn">分享</button>${cta}</div>`;
    }

    // 1) 官方公告：总结对所有可见，原文链接登录后展示
    const noticeBlock = `
      ${j.notice_summary ? `<p class="nsum">${esc(j.notice_summary)}</p>` : ''}
      ${locked
        ? gate('官方公告原文链接')
        : (j.notice_url ? `<a class="notice-link" href="${esc(j.notice_url)}" target="_blank" rel="noopener">查看官方公告原文 ›</a>` : '<span class="muted">暂无官方公告</span>')}`;
    // 2) 投递链接：登录后展示
    const applyBlock = locked
      ? gate('投递入口（网申链接）')
      : (expired
          ? `<a class="btn btn-primary btn-block" href="${esc(j.notice_url || j.apply_url || '#')}" target="_blank" rel="noopener">📋 查看详情</a>`
          : (j.apply_url
              ? (j.apply_type === 'email'
                  ? `<a class="btn btn-primary btn-block" href="mailto:${esc(j.apply_url)}">📧 邮箱投递：${esc(j.apply_url)}</a>`
                  : j.apply_type === 'link'
                    ? `<a class="btn btn-primary btn-block" href="${esc(j.apply_url)}" target="_blank" rel="noopener">🚀 立即投递</a>`
                    : `<button class="btn btn-primary btn-block" onclick="_copy('${esc(j.apply_url)}')">📋 复制投递方式：${esc(j.apply_url)}</button>`)
              : '<span class="muted">暂无投递入口</span>'));
    // 3) 内推码：无则显示"无"；有则拆分成多个独立复制按钮（支持多码分别复制）
    // 防御：过滤超长段（>15 位视为脏数据，如误粘连的长串），仅展示正常码
    const refBlock = !j.referral_code
      ? '<span class="muted">无</span>'
      : (locked ? gate('内推码') : (() => {
          const codes = String(j.referral_code).split(/\s*[/;；,，、]\s*/).map(s => s.trim()).filter(Boolean).filter(s => s.length <= 15);
          if (!codes.length) return '<span class="muted">无</span>';
          if (codes.length <= 1) {
            return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:17px">${esc(codes[0])}</b> <button class="fbtn" onclick="_copy('${esc(codes[0])}')">复制</button></div>`;
          }
          return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${codes.map((c, i) =>
            `<b style="font-size:16px">${esc(c)}</b> <button class="fbtn" onclick="_copy('${esc(c)}','${esc('内推码 ' + (i + 1))}')">复制 ${i + 1}</button>`
          ).join('<span style="opacity:.3;margin:0 2px">|</span>')}</div>`;
        })());

    // 4+5) 企业档案：最下方统一展示「公司概览 + 在招岗位 + 笔面经」
    const companyProfileHtml = comp ? `
      <div class="section company-profile">
        <h2>🏢 企业档案 · ${esc(parent)}</h2>
        <a class="cp-card" href="/company/${encodeURIComponent(comp.slug || parent)}">
          <div class="cp-avatar ${avatarCls(j.industry)}">${esc((parent[0] || '?'))}</div>
          <div class="cp-main">
            <div class="cp-name">${esc(parent)}</div>
            <div class="cp-tags">
              ${j.company_type ? `<span class="tag ct">${esc(j.company_type)}</span>` : ''}
              ${j.industry ? `<span class="tag batch">${esc(j.industry)}</span>` : ''}
              <span class="tag">${comp.jobs.length} 条招聘记录</span>
            </div>
          </div>
          <div class="cp-arrow">›</div>
        </a>
        ${otherJobs.length ? `
          <div class="cp-sub">
            <h3>📋 在招岗位（${comp.jobs.length}）</h3>
            ${otherJobs.map(x => `<a class="miniJob" href="/job/${x.id}">
              <div class="mj-pos">${esc(x.position.slice(0, 42))}</div>
              <div class="mj-meta">${esc((x.city || '').split(',').slice(0, 2).join('/'))} ${ddlHtml(x.deadline)}</div></a>`).join('')}
            <a class="morelink" href="/company/${encodeURIComponent(comp.slug || parent)}">查看全部 ${comp.jobs.length} 条招聘 ›</a>
          </div>` : ''}
        ${(comp.experience_summary && comp.experience_summary.total) ? `
          <div class="cp-sub">
            <h3>📝 笔面经精华（${comp.experience_summary.total}）</h3>
            ${expTeaserHtml(comp.experience_summary, comp.slug || parent)}
          </div>` : ''}
        ${!otherJobs.length && !posts.length ? `<div class="cp-empty">暂无更多档案信息，<a class="morelink" href="/company/${encodeURIComponent(comp.slug || parent)}">查看企业主页 ›</a></div>` : ''}
      </div>` : '';

    view.innerHTML = `
      ${pageHead('招聘详情')}
      ${loginTag}
      <div class="detail-top">
        <div class="co">${esc(j.company)}</div>
        <div class="tags">
          <span class="tag">${esc(j.batch || '校招')}</span>
          ${j.company_type ? `<span class="tag">${esc(j.company_type)}</span>` : ''}
          ${j.industry ? `<span class="tag">${esc(j.industry)}</span>` : ''}
        </div>
      </div>
      ${comp && comp.profile && comp.profile.intro ? `
      <div class="section"><h2>🏢 企业简介</h2>${renderIntel(comp.profile.intro)}</div>` : ''}
      ${comp && comp.profile && comp.profile.locations && comp.profile.locations.length ? `
      <div class="section" style="padding-top:0">
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px">📍 主要办公地点</div>
        <div class="loc-tags">${comp.profile.locations.slice(0, 10).map(l => `<span class="loc-tag">${esc(l)}</span>`).join('')}</div>
      </div>` : ''}
      ${campusRecruitHtml(comp.profile, j.notice_recruit)}
      <div class="section"><h2>岗位信息</h2>
        ${j.positions ? kv('招聘岗位', j.positions, `<div class="pos-chips">${j.positions.split(/[、,，]/).map(p => `<span class="chip">${esc(p.trim())}</span>`).join('')}</div>`) : kv('招聘岗位', j.position, posChips(j.position))}
        ${kv('工作城市', j.city, esc((j.city || '').split(',').join('、')))}
        ${kv('毕业届别', j.grad_year)}
        ${kv('学历要求', j.education)}
        ${j.salary ? kv('💰 薪资参考', j.salary) : ''}
        ${kv('是否笔试', j.exam || '未明确')}
        ${kv('发布日期', j.publish_date)}
        ${kv('截止日期', j.deadline, ddlHtml(j.deadline))}
        ${kv('备注', j.remark)}
      </div>
      ${j.org_intro ? `<div class="section"><h2>🏛️ 公司简介</h2><p style="line-height:1.7;color:var(--text);font-size:14px;margin:0">${esc(j.org_intro)}</p></div>` : ''}
      <div class="section"><h2>官方公告</h2>${noticeBlock}</div>
      <div class="section"><h2>内推码</h2>${refBlock}</div>
      <div class="section"><h2>投递链接</h2>${applyBlock}</div>
      ${j.position_list ? `<div class="section"><h2>📋 招聘岗位</h2><div class="pos-table-wrap">${j.position_list}</div></div>` : ''}
      <div class="detail-actions">
        <button class="qbtn" id="sharetop">🔗 分享给同学</button>
        <button class="qbtn ${track ? 'tracking' : ''} ${expired ? 'disabled' : ''}" id="trackbtn" ${expired ? 'disabled' : ''}>${track ? '📌 跟踪中 · ' + esc(track.current || '已跟踪') : (expired ? '📌 已截止不可跟踪' : '📌 纳入跟踪')}</button>
        <button class="qbtn ${fav ? 'on' : ''}" id="detailfavbtn">${fav ? '★ 已收藏' : '☆ 加入收藏'}</button>
      </div>
      ${companyProfileHtml}
      ${(() => {
        const ms = d.manuals;
        if (!ms || !ms.manuals || !ms.manuals.length) return '';
        const multi = ms.multi;
        const total = ms.manuals.length;
        let h = `<div class="section" id="manual-section"><h2>📋 岗位说明书${multi ? `（共 ${total} 个岗位${total > 3 ? '，展示前 3 个' : ''}）` : ''}</h2>`;
        if (multi) h += `<div class="manual-note">本招聘含多个岗位，以下分别介绍；薪资数据来自站内真实爆料，仅供参考。</div>`;
        const shown = multi ? ms.manuals.slice(0, 3) : ms.manuals;
        for (const m of shown) h += `<div class="manual-card"><div class="manual-pos">${esc(m.position)}</div><div class="manual-box">${md2html(m.content)}</div></div>`;
        if (multi && total > 3) h += `<div class="manual-more"><a class="morelink" href="/guides">查看全部 ${total} 个岗位的求职攻略 ›</a></div>`;
        else if (multi) h += `<a class="morelink" href="/guides">查看全部岗位的求职攻略 ›</a>`;
        else h += `<a class="morelink" href="/guide/${encodeURIComponent(ms.manuals[0].position)}">查看 ${esc(ms.manuals[0].position)} 完整求职攻略 ›</a>`;
        h += `</div>`;
        return h;
      })()}
      <div id="ctx-salary-area"></div>
      <div id="ctx-area"></div>
      <div style="height:70px"></div>
      ${applyBar}`;

    // 岗位上下文：异步加载，不阻塞主内容渲染
    (async () => {
      try {
        const ctx = await api('/api/jobs/' + id + '/context');
        if (!ctx) return;
        // 💰 薪资参考
        if (ctx.salaryRef && ctx.salaryRef.length) {
          let h = '<div class="ctx-wrap"><div class="section ctx-sec"><h2>💰 薪资参考</h2>';
          h += ctx.salaryRef.slice(0, 6).map(s => `<div class="ctx-salary">${esc(s.company)} ${esc(s.position)} ${s.tier||''} ${s.grad_year||''}届：<b>${s.salary_min}-${s.salary_max}万</b></div>`).join('');
          h += '</div></div>';
          const el = view.querySelector('#ctx-salary-area'); if (el) el.innerHTML = h;
        }
        // 📎 岗位上下文
        if ((ctx.sameInd&&ctx.sameInd.length)||(ctx.simCos&&ctx.simCos.length)||(ctx.guides&&ctx.guides.length)) {
          let h = '<div class="ctx-wrap"><div class="section ctx-sec"><h2>📎 岗位上下文</h2>';
          if (ctx.sameInd&&ctx.sameInd.length) { h += '<div class="ctx-block"><div class="ctx-title">同行业近期招聘</div>'; h += ctx.sameInd.slice(0,8).map(j2=>`<a class="ctx-link" href="/job/${j2.id}">${esc(j2.company)} · ${esc(j2.position)}</a>`).join(''); h += '</div>'; }
          if (ctx.simCos&&ctx.simCos.length) { h += '<div class="ctx-block"><div class="ctx-title">同类公司</div><div class="ctx-tags">'; h += ctx.simCos.map(c=>`<a class="ctx-tag" href="/company/${encodeURIComponent(c.slug || c.parent_company)}">${esc(c.parent_company)}<small>${c.job_count}条</small></a>`).join(''); h += '</div></div>'; }
          if (ctx.guides&&ctx.guides.length) { h += '<div class="ctx-block"><div class="ctx-title">📖 求职攻略</div>'; h += ctx.guides.slice(0,3).map(g=>`<div class="ctx-guide"><span class="tag stage-w">${esc(g.stage||'综合')}</span> ${esc(g.title)}</div>`).join(''); h += '</div>'; }
          h += '</div></div>';
          const el = view.querySelector('#ctx-area'); if (el) el.innerHTML = h;
        }
      } catch {}
    })();

    // 单岗位精准说明书：懒加载 AI「一岗一书」版，覆盖通用大类说明书（多岗位不替换）
    (async () => {
      try {
        if (d.manuals && d.manuals.multi) return;          // 多岗位保持分别介绍
        const tm = await api('/api/job-manual/' + id);
        if (!tm || !tm.tailored) return;                   // 回退/未生成则保留静态大类
        const sec = view.querySelector('#manual-section');
        if (!sec) return;
        sec.innerHTML = `<h2>📋 岗位说明书 <span style="font-size:11px;background:#EAF3DE;color:#3B6D11;padding:2px 7px;border-radius:10px;font-weight:500;vertical-align:middle">AI 精准匹配</span></h2>`
          + `<div class="manual-card"><div class="manual-pos">${esc(tm.position || j.position)}</div><div class="manual-box">${md2html(tm.content)}</div></div>`
          + `<a class="morelink" href="/guides">查看全部岗位的求职攻略 ›</a>`;
      } catch {}
    })();

    if ($('#favbtn')) $('#favbtn').onclick = async () => {
      try { const r = await api('/api/favorites/' + j.id, { method: 'POST' }); $('#favbtn').textContent = r.fav ? '★ 已收藏' : '☆ 收藏'; if ($('#detailfavbtn')) { $('#detailfavbtn').textContent = r.fav ? '★ 已收藏' : '☆ 加入收藏'; $('#detailfavbtn').classList.toggle('on', !!r.fav); } toast(r.fav ? '已收藏' : '已取消收藏'); }
      catch (e) { toast(e.message); }
    };
    if ($('#detailfavbtn')) $('#detailfavbtn').onclick = async () => {
      try { const r = await api('/api/favorites/' + j.id, { method: 'POST' }); $('#detailfavbtn').textContent = r.fav ? '★ 已收藏' : '☆ 加入收藏'; $('#detailfavbtn').classList.toggle('on', !!r.fav); if ($('#favbtn')) $('#favbtn').textContent = r.fav ? '★ 已收藏' : '☆ 收藏'; toast(r.fav ? '已收藏' : '已取消收藏'); }
      catch (e) { toast(e.message); }
    };
    $('#sharebtn').onclick = () => openShare(`${j.company} ${j.batch}`);
    if ($('#sharetop')) $('#sharetop').onclick = () => openShare(`${j.company} ${String(j.position).slice(0, 30)}`);
    $('#trackbtn').onclick = async () => {
      if (!store.token) { location.href = loginHref(); return; }
      try {
        if (!track) {
          await api('/api/tracks/' + j.id, { method: 'POST' });
          track = { current: '已跟踪', stages: [] };
          toast('已纳入跟踪');
        }
        openTrackEditor(j.id, `${j.company} · ${j.position.slice(0, 20)}`, track.stages, updated => {
          if (updated === null) { track = null; $('#trackbtn').textContent = '📌 纳入跟踪'; $('#trackbtn').classList.remove('tracking'); }
          else { track = updated; $('#trackbtn').textContent = '📌 跟踪中 · ' + (updated.current || '已跟踪'); $('#trackbtn').classList.add('tracking'); }
        });
      } catch (e) { toast(e.message); }
    };
  });

  // ---------- 求职跟踪编辑器（详情页 & 跟踪列表共用） ----------
  // stages: [{type:'投递'|'测评'|'笔试'|'面试'|'offer'|'被拒', date:'YYYY-MM-DD', n?, note?}]
  const STAGE_OPTS = ['投递', '测评', '笔试', '面试', 'offer', '被拒'];
  const stageText = s => s.type === '面试' ? `第${s.n || 1}面` : s.type;
  function openTrackEditor(jobId, title, stages, onDone) {
    let list = (stages || []).map(s => ({ ...s }));
    const root = modal(`<h3>📌 跟踪进展 · ${esc(title)}</h3>
      <div id="tk-list"></div>
      <div class="tk-add" id="tk-add">${STAGE_OPTS.map(t => `<button class="fbtn" data-t="${t}">＋ ${t}</button>`).join('')}</div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-ghost" id="tk-del" style="color:var(--red)">取消跟踪</button>
        <button class="btn btn-ghost" onclick="_closeModal()">关闭</button>
        <button class="btn btn-primary" style="flex:1" id="tk-save">保存</button>
      </div>`);
    const draw = () => {
      $('#tk-list').innerHTML = list.length ? list.map((s, i) => `
        <div class="tk-row">
          <span class="tk-type">${esc(stageText(s))}</span>
          ${s.type === '面试' ? `<input class="tk-n" type="number" min="1" max="20" value="${s.n || 1}" data-i="${i}" title="第几面">` : ''}
          <input class="tk-date" type="date" value="${esc(s.date || '')}" data-i="${i}">
          <input class="tk-note" placeholder="备注(可选)" value="${esc(s.note || '')}" data-i="${i}">
          <button class="tk-x" data-i="${i}">✕</button>
        </div>`).join('') : '<div class="notice" style="padding:10px 0">点下方按钮添加进展节点 ↓</div>';
      $('#tk-list').querySelectorAll('.tk-date').forEach(el => el.onchange = () => list[el.dataset.i].date = el.value);
      $('#tk-list').querySelectorAll('.tk-note').forEach(el => el.onchange = () => list[el.dataset.i].note = el.value.trim());
      $('#tk-list').querySelectorAll('.tk-n').forEach(el => el.onchange = () => list[el.dataset.i].n = parseInt(el.value) || 1);
      $('#tk-list').querySelectorAll('.tk-x').forEach(el => el.onclick = () => { list.splice(el.dataset.i, 1); draw(); });
    };
    draw();
    $('#tk-add').onclick = e => {
      const t = e.target.dataset.t; if (!t) return;
      const item = { type: t, date: todayStr() };
      if (t === '面试') item.n = list.filter(x => x.type === '面试').length + 1;
      list.push(item); draw();
    };
    $('#tk-save').onclick = async () => {
      try {
        const r = await api('/api/tracks/' + jobId, { method: 'PUT', body: JSON.stringify({ stages: list }) });
        closeModal(); toast('已保存'); onDone && onDone({ current: r.current, stages: r.stages });
      } catch (e) { toast(e.message); }
    };
    $('#tk-del').onclick = async () => {
      if (!confirm('确定取消跟踪该岗位？进展记录将被删除')) return;
      try { await api('/api/tracks/' + jobId, { method: 'DELETE' }); closeModal(); toast('已取消跟踪'); onDone && onDone(null); }
      catch (e) { toast(e.message); }
    };
  }

  // ================= 我的跟踪列表 =================
  route(/^\/tracks$/, async () => {
    await loadMe();
    if (!ME) { location.href = loginHref(); return; }
    setMeta({ title: '求职跟踪 - 校招宝' });
    const d = await api('/api/tracks');
    let showAllTk = false;
    const draw = () => {
      const items = showAllTk ? d.list : d.list.slice(0, 10);
      view.innerHTML = `${pageHead('求职跟踪')}
        <div class="notice" style="padding:10px 12px 0">共跟踪 ${d.list.length} 个岗位 · 在岗位详情页点「📌 纳入跟踪」添加</div>
        <div class="list">${d.list.length ? items.map((t, i) => `
          <div class="jcard tkcard">
            <div class="row1">
              <span class="co">${esc(t.company)}</span>
              <span class="tag batch">${esc(t.batch || '校招')}</span>
              <span class="tag tk-cur">${esc(t.current || '已跟踪')}</span>
            </div>
            <div class="pos">${esc(t.position.slice(0, 50))}</div>
            ${t.stages.length ? `<div class="tk-line">${t.stages.map(s => `<span class="tk-node">${esc(stageText(s))}<small>${esc((s.date || '').slice(5))}</small></span>`).join('<span class="tk-arrow">→</span>')}</div>` : ''}
            <div class="meta" style="margin-top:6px">
              <button class="fbtn" data-edit="${i}">✏️ 记录进展</button>
              <a class="fbtn" href="/job/${t.job_id}">查看岗位 ›</a>
            </div>
          </div>`).join('') : '<div class="empty">还没有跟踪任何岗位<br>在招聘详情页点「📌 纳入跟踪」开始记录求职进展</div>'}</div>
        ${!showAllTk && d.list.length > 10 ? `<div style="padding:10px 12px"><button class="btn btn-ghost" style="width:100%" id="tkmore">查看更多（共 ${d.list.length} 条）</button></div>` : ''}`;
      if ($('#tkmore')) $('#tkmore').onclick = () => { showAllTk = true; draw(); };
      view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
        const t = d.list[b.dataset.edit];
        openTrackEditor(t.job_id, `${t.company} · ${t.position.slice(0, 20)}`, t.stages, updated => {
          if (updated === null) d.list.splice(b.dataset.edit, 1);
          else { t.stages = updated.stages; t.current = updated.current; }
          draw();
        });
      });
    };
    draw();
  });

  // ================= 已截止招聘信息 =================
  route(/^\/expired$/, async () => {
    setMeta({ title: '已截止校招信息 - 校招宝', description: '已截止的校招信息汇总，仅供参考，不可再投递或纳入跟踪。' });
    view.innerHTML = `
      ${pageHead('已截止校招信息')}
      <div class="notice" style="padding:10px 12px 0">以下为已截止的校招信息（仅供参考，已不可投递 / 跟踪）</div>
      <div class="list" id="elist"></div><div id="emore"></div>`;
    let epage = 1;
    async function loadE(reset) {
      if (reset) { epage = 1; $('#elist').innerHTML = ''; }
      const d = await api(`/api/jobs?expired=1&page=${epage}&size=50`);
      if (!d.list.length && epage === 1) { $('#elist').innerHTML = '<div class="empty">😅 暂无已截止信息</div>'; return; }
      $('#elist').insertAdjacentHTML('beforeend', d.list.map(expiredCard).join(''));
      const more = $('#emore');
      more.innerHTML = pagerHtml(d.total, epage, d.size);
      more.querySelectorAll('.pg[data-pg]').forEach(b => b.onclick = () => { epage = parseInt(b.dataset.pg); window.scrollTo(0, 0); $('#elist').innerHTML = ''; loadE(); });
    }
    loadE(true);
  });

  window._copy = async (text, label) => {
    const ok = () => toast(`已复制${label ? ' · ' + label : ''}`);
    try {
      await navigator.clipboard.writeText(text);
      ok();
    } catch {
      // clipboard API 不可用（非安全上下文等）：隐藏 textarea 兜底，不弹窗
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.select();
        const done = document.execCommand('copy');
        document.body.removeChild(ta);
        if (done) { ok(); return; }
      } catch (e) {}
      toast('复制失败，请长按选择文本复制');
    }
  };

  // 已截止校招信息：默认折叠，点击展开/收起
  window.toggleExpired = btn => {
    const sec = btn.closest('.expired-section');
    if (!sec) return;
    const body = sec.querySelector('.expired-body');
    const arrow = btn.querySelector('.et-arrow');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    arrow.textContent = open ? '▸ 点击展开' : '▾ 点击收起';
  };
  // 分享：仅提供「分享到微信（二维码）」与「复制链接」两种方式
  function openShare(title) {
    const url = location.href;
    modal(`<h3>分享 · ${esc(title)}</h3>
      <div class="share-grid">
        <button class="share-opt" id="swx"><span class="so-ic">🟢</span><div class="so-t">分享到微信</div></button>
        <button class="share-opt" id="scopy"><span class="so-ic">🔗</span><div class="so-t">复制链接</div></button>
      </div>
      <div id="wxbox" style="display:none;text-align:center;margin-top:14px">
        <img id="wxqr" style="width:180px;height:180px;border:1px solid var(--line);border-radius:10px;background:#fff" alt="二维码">
        <div style="font-size:12px;color:var(--text2);margin-top:8px">微信「扫一扫」打开，或截图发给好友</div>
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--text2);word-break:break-all;background:var(--bg);padding:8px 10px;border-radius:8px">${esc(url)}</div>`);
    $('#scopy').onclick = () => { _copy(url); toast('链接已复制，去分享给同学吧'); };
    $('#swx').onclick = () => {
      const box = $('#wxbox'); box.style.display = 'block';
      const img = $('#wxqr');
      img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=' + encodeURIComponent(url);
      img.onerror = () => { box.innerHTML = '<div style="font-size:13px;color:var(--text2)">二维码生成失败，已为你复制链接</div>'; _copy(url); };
    };
  }

  // ================= 企业列表 =================
  route(/^\/companies$/, async () => {
    await loadMeta();
    setMeta({ title: '企业档案库 - 校招宝', description: '按母公司聚合的校招企业档案库，查看每家企业的全部在招岗位、笔面经与招聘动态。' });
    view.innerHTML = `
      ${pageHead('企业档案库')}
      <div class="hero">
        <div class="brand"><div><div class="logo">${LOGO_IC}企业档案库</div><div class="slogan">每家校招企业的完整档案</div></div></div>
        <div class="searchbar"><span>🔍</span><input id="cq" placeholder="搜索企业名称"><button class="go" id="cgo">搜索</button></div>
      </div>
      <div class="quicktabs" id="cctabs"><button class="qt on" data-ct="">全部</button>${META.company_type.map(t => `<button class="qt" data-ct="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <div class="list" id="clist"></div><div id="cmore"></div>`;
    let cpage = 1, cq = '', ctype = '';
    async function loadC(reset) {
      if (reset) { cpage = 1; $('#clist').innerHTML = ''; }
      const ctq = ctype ? `&company_type=${encodeURIComponent(ctype)}` : '';
      const d = await api(`/api/companies?q=${encodeURIComponent(cq)}${ctq}&page=${cpage}&size=50`);
      $('#clist').insertAdjacentHTML('beforeend', d.list.map(c => `
        <a class="ccard" href="/company/${encodeURIComponent(c.slug || c.company)}">
          <div class="avatar ${avatarCls(c.industry)}">${esc(c.company[0])}</div>
          <div class="cinfo">
            <div class="cn">${esc(c.company)}</div>
            <div class="cm">${esc(c.company_type || '')} ${c.industry ? '· ' + esc(c.industry) : ''} · ${esc((c.batches || '').split(',').slice(0, 3).join('/'))}</div>
          </div>
          <div class="cnum">${c.job_count}<small>条在招</small></div>
        </a>`).join(''));
      const more = $('#cmore');
      more.innerHTML = pagerHtml(d.total, cpage, d.size);
      more.querySelectorAll('.pg[data-pg]').forEach(b => b.onclick = () => { cpage = parseInt(b.dataset.pg); window.scrollTo(0, 0); $('#clist').innerHTML = ''; loadC(); });
    }
    $('#cgo').onclick = () => { cq = $('#cq').value.trim(); loadC(true); };
    $('#cq').onkeydown = e => { if (e.key === 'Enter') { cq = $('#cq').value.trim(); loadC(true); } };
    $('#cctabs').onclick = e => { const ct = e.target.dataset.ct; if (ct === undefined) return; ctype = ct; $('#cctabs').querySelectorAll('.qt').forEach(x => x.classList.toggle('on', x.dataset.ct === ct)); loadC(true); };
    loadC(true);
  });

  // ================= 备考资料库（P1：眼哥职说等外部资料） =================
  // ================= 校招练习（资料频道改版：在线笔试/面试辅导） =================
  route(/^\/materials$/, async () => {
    await loadMe();
    const guest = !store.token;   // 游客：可浏览首页与样题，仅交卷判分/错题需登录
    setMeta({ title: '校招练习 - 校招宝', description: '按岗位在线练习：每份练习卷随机抽取 10 题（80% 笔试 + 20% 面试），整卷统一交卷判分与解析，错题可反复练习。' });
    const letter = i => String.fromCharCode(65 + Number(i));

    // ---- 入口：Top20 岗位 + 综合测评 ----
    async function renderHub() {
      view.innerHTML = `
        ${pageHead('校招练习')}
        ${guest ? `<div class="guest-banner">🎯 先逛逛看：所有岗位和样题都能<b>免费浏览</b>。<a href="${loginHref()}">登录 / 注册</a> 后即可在线答题、交卷判分、记录错题、使用全部功能。</div>` : ''}
        <div class="hero practice-hero">
          <div class="brand"><div><div class="logo">${LOGO_IC}校招练习</div><div class="slogan">按岗位练 · 每卷10题 · 含大厂综合测评</div></div></div>
        </div>
        <div class="assess-card" id="assess">
          <span class="assess-ic">🧪</span>
          <div class="assess-body">
            <div class="assess-name">综合测评 <span class="assess-tag">大厂网测同款</span></div>
            <div class="assess-desc">言语理解 · 逻辑推理 · 数量关系 · 资料分析 · 图形推理 · 常识判断</div>
          </div>
          <span class="assess-go" id="assessgo">每卷 10 题 →</span>
        </div>
        <div class="practice-tip">
          <div class="pt-title">🎯 岗位练习</div>
          <div class="pt-desc">选择目标岗位开始练习，系统会从该岗位题库随机组卷（约 80% 笔试 + 20% 面试）</div>
        </div>
        <div class="poslist" id="poslist"><div class="empty">加载中…</div></div>
        <div class="pmenu">
          <button class="pmbtn" id="gwrong">📕 我的错题集</button>
        </div>`;
      $('#gwrong').onclick = () => { if (guest) { location.href = loginHref(); return; } location.hash = 'wrong'; };

      const d = await api('/api/practice/positions');
      const ac = $('#assess');
      if (ac) {
        const go = $('#assessgo');
        if (d.assessment > 0) {
          go.textContent = `共 ${d.assessment} 题 · 每卷 10 题 →`;
          ac.onclick = () => { location.hash = 'paper/' + encodeURIComponent('综合测评'); };
        } else {
          go.textContent = '题库生成中…';
          ac.style.opacity = '.5';
        }
      }
      const list = (d.list || []).filter(p => p.q_count > 0);
      $('#poslist').innerHTML = list.length ? list.map(p => `
        <div class="poscard" data-n="${esc(p.name)}">
          <div class="pos-head">
            <span class="pos-name">${esc(p.name)}</span>
            <span class="pos-jobs">${p.job_count} 个在招</span>
          </div>
          ${p.intro ? `<div class="pos-intro">${esc(p.intro)}</div>` : ''}
          <div class="pos-foot">
            <span class="pos-q">题库 ${p.q_count} 题（笔试${p.written_count} · 面试${p.interview_count}）</span>
            <span class="go">开始练习 →</span>
          </div>
        </div>`).join('') : '<div class="empty">题库正在生成中，请稍后再来</div>';

      $('#poslist').querySelectorAll('.poscard').forEach(c => {
        c.onclick = () => { location.hash = 'paper/' + encodeURIComponent(c.dataset.n); };
      });
    }

    // ---- 子视图：一份随机练习卷 ----
    async function renderPaper(posName) {
      const d = await api('/api/practice/paper?position=' + encodeURIComponent(posName));
      if (!d.questions || !d.questions.length) {
        view.innerHTML = `${pageHead('校招练习')}<div class="empty">「${esc(posName)}」题库暂无题目</div>`;
        return;
      }
      const answers = {};            // questionId -> 用户作答（本地暂存，不逐题提交）
      let idx = 0, results = null;
      const isSubj = t => t === '简答' || t === '行为' || t === '编程';

      function displayAnswer(q, ans) {
        if (ans === undefined || ans === '' || ans == null) return '（未作答）';
        const opts = q.options || [];
        if (q.q_type === '单选' || q.q_type === '判断') {
          const i = Number(ans); return `${letter(i)}. ${esc(opts[i] || '')}`;
        }
        if (q.q_type === '多选') {
          let sel = []; try { sel = JSON.parse(ans); } catch {}
          return sel.length ? sel.map(i => `${letter(Number(i))}. ${esc(opts[i] || '')}`).join('；') : '（未作答）';
        }
        return esc(ans);
      }

      function collect() {
        const q = d.questions[idx];
        let a;
        if (q.q_type === '多选') a = JSON.stringify([...view.querySelectorAll('input[name=ans]:checked')].map(x => x.value));
        else if (q.q_type === '单选' || q.q_type === '判断') { const el = view.querySelector('input[name=ans]:checked'); a = el ? el.value : (answers[q.id] || ''); }
        else { a = $('#ans').value.trim(); }
        if (a !== undefined && a !== '') answers[q.id] = a;
      }

      function renderQ() {
        const q = d.questions[idx];
        const opts = q.options || [];
        const saved = answers[q.id];
        let inputHtml;
        if (q.q_type === '单选' || q.q_type === '判断') {
          inputHtml = opts.map((o, i) => `<label class="opt"><input type="radio" name="ans" value="${i}" ${saved === String(i) ? 'checked' : ''}><span>${letter(i)}. ${esc(o)}</span></label>`).join('');
        } else if (q.q_type === '多选') {
          const sel = saved ? (() => { try { return JSON.parse(saved); } catch { return []; } })() : [];
          inputHtml = opts.map((o, i) => `<label class="opt"><input type="checkbox" name="ans" value="${i}" ${sel.includes(String(i)) ? 'checked' : ''}><span>${letter(i)}. ${esc(o)}</span></label>`).join('');
        } else {
          inputHtml = `<textarea id="ans" class="ansbox" placeholder="在此作答，交卷后由 AI 统一给出评分与改进建议…">${saved ? esc(saved) : ''}</textarea>`;
        }
        const isLast = idx === d.questions.length - 1;
        const stage = q.exam_stage || '笔试';
        const answered = d.questions.filter(x => answers[x.id]).length;
        view.innerHTML = `
          ${pageHead('校招练习')}
          ${guest ? `<div class="guest-banner">👀 正在浏览样题。想<b>交卷判分</b>、记录错题？<a href="${loginHref()}">登录 / 注册</a>后即可使用全部功能。</div>` : ''}
          <div class="qwrap">
            <div class="paper-bar">
              <span class="paper-pos">${esc(d.position)}</span>
              <span class="paper-count">已答 ${answered}/${d.questions.length}</span>
              <a class="qlink" href="#hub">‹ 换岗位</a>
            </div>
            <div class="qmeta">
              <span class="tag stage-${stage === '面试' ? 'i' : 'w'}">${esc(stage)}</span>
              <span class="tag">${esc(q.q_type)}</span>
              <span class="qidx">第 ${idx + 1}/${d.questions.length} 题</span>
            </div>
            <div class="qstem">${esc(q.stem)}</div>
            <div class="opts">${inputHtml}</div>
            <div class="qprogress-tip">作答暂存在本机，最后一题统一交卷判分</div>
            <div class="qactions">${guest ? (isLast ? `<button class="btn btn-primary" id="submit">登录后交卷并查看成绩</button>` : '') : (isLast ? `<button class="btn btn-primary" id="submit">提交并交卷</button>` : '')}</div>
            <div id="result"></div>
            <div class="qnav">
              <button id="prev" ${idx === 0 ? 'disabled' : ''}>上一题</button>
              ${isLast ? '' : `<button id="next">下一题</button>`}
            </div>
          </div>`;
        if (idx > 0) $('#prev').onclick = () => { collect(); idx--; renderQ(); };
        if (!isLast) $('#next').onclick = () => {
          collect();
          if (!answers[q.id]) { toast('请先作答本题，再进入下一题'); return; }
          idx++; renderQ();
        };
        if (isLast) {
          const sb = $('#submit');
          if (guest) {
            sb.onclick = () => { location.href = loginHref(); };
          } else {
            sb.onclick = async () => {
              collect();
              if (!answers[q.id]) { toast('请先作答本题'); return; }
              const missing = d.questions.filter(x => !answers[x.id]);
              if (missing.length) { toast('还有 ' + missing.length + ' 题未作答'); return; }
              const btn = $('#submit');
              btn.disabled = true; btn.textContent = 'AI 判卷中，请稍候…';
              try {
                const r = await api('/api/practice/paper/submit', {
                  method: 'POST',
                  body: JSON.stringify({ position: d.position, answers: d.questions.map(x => ({ question_id: x.id, answer: answers[x.id] })) })
                });
                results = {}; (r.results || []).forEach(o => { if (o.question_id) results[o.question_id] = o; });
                renderResults(r.summary);
              } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '提交并交卷'; }
            };
          }
        }
      }

      function renderResults(summary) {
        const s = summary || {};
        const total = s.total != null ? s.total : d.questions.length;
        const avg = s.avg_score;
        const wrong = s.wrong != null ? s.wrong : d.questions.filter(q => results[q.id] && results[q.id].is_wrong).length;
        const rightCount = s.correct != null ? s.correct : 0;
        let html = `
          ${pageHead('校招练习')}
          <div class="qwrap result-page">
            <div class="res-head">
              <div class="res-title">📋 ${esc(d.position)} · 答卷批改完成</div>
              <div class="res-summary">
                <span>总题数 <b>${total}</b></span>
                <span>答对 <b>${rightCount}</b></span>
                <span>错题 <b>${wrong}</b></span>
                <span>平均分 <b>${avg != null ? avg : '—'}</b></span>
              </div>
            </div>
            <div class="res-list">`;
        d.questions.forEach((q, i) => {
          const r = results[q.id] || {};
          const myAns = displayAnswer(q, answers[q.id]);
          const correct = isSubj(q.q_type) ? (r.reference || '') : (r.answer || '');
          const stage = q.exam_stage || '笔试';
          html += `
            <div class="res-item ${r.is_wrong ? 'bad' : 'good'}">
              <div class="res-qtop"><span class="tag stage-${stage === '面试' ? 'i' : 'w'}">${esc(stage)}</span><span class="tag">${esc(q.q_type)}</span><span class="res-idx">第 ${i + 1} 题</span>${r.score !== undefined ? `<span class="res-score">得分 ${r.score != null ? r.score : '自评'}</span>` : ''}${r.is_wrong ? '<span class="res-wrong">已入错题集</span>' : ''}</div>
              <div class="res-stem">${esc(q.stem)}</div>
              <div class="res-my">你的作答：${myAns}</div>
              ${correct ? `<div class="res-correct">${isSubj(q.q_type) ? '参考答案/要点' : '正确答案'}：${esc(correct)}</div>` : ''}
              ${r.explanation ? `<div class="res-exp">解析：${esc(r.explanation)}</div>` : ''}
              ${r.feedback ? `<div class="res-fb">建议：${esc(r.feedback).replace(/\\n|\n/g, '<br>')}</div>` : ''}
            </div>`;
        });
        html += `</div>
            <div class="res-actions">
              <button class="btn btn-primary" id="redo">重做本卷</button>
              <a class="btn btn-ghost" href="#hub">返回题库</a>
            </div>
          </div>`;
        view.innerHTML = html;
        $('#redo').onclick = () => { location.hash = 'paper/' + encodeURIComponent(d.position) + '?t=' + Date.now(); renderPaper(d.position); };
      }
      renderQ();
    }

    async function renderWrong() {
      if (guest) {
        view.innerHTML = `${pageHead('校招练习')}
          <div class="gate-wrap"><div class="gate"><span class="g-ic">🔒</span><span class="g-txt">登录后查看你的专属错题集</span><a class="g-link" href="${loginHref()}">登录 / 注册 ›</a></div></div>`;
        return;
      }
      const d = await api('/api/practice/wrong-set');
      view.innerHTML = `${pageHead('校招练习')}<h2 class="ph2">📕 我的错题集</h2>
        <div class="list">${d.list.length ? d.list.map(a => `
          <div class="wcard" data-p="${esc(a.position || '')}" data-att="${a.attempt_id}">
            <div class="w-top">
              <span class="tag stage-${a.exam_stage === '面试' ? 'i' : 'w'}">${esc(a.exam_stage || '笔试')}</span>
              <span class="tag">${esc(a.q_type)}</span>
              ${a.position ? `<span class="tag ct">${esc(a.position)}</span>` : ''}
              <span class="wscore">得分 ${a.score}</span>
            </div>
            <div class="w-stem">${esc(a.stem)}</div>
            <div class="w-my">我的作答：${esc(a.my_answer || '（未作答）')}</div>
            <div class="w-actions"><button class="btn btn-ghost w-redo">✍️ 再练本题</button><button class="btn btn-ghost w-resolve">标记掌握</button></div>
          </div>`).join('') : '<div class="empty">暂无错题，太棒了！</div>'}</div>`;
      view.querySelectorAll('.wcard').forEach(c => {
        const att = Number(c.dataset.att);
        const item = d.list.find(x => x.attempt_id === att);
        const redo = c.querySelector('.w-redo');
        if (redo && item) redo.onclick = () => renderRedo(item);
        c.querySelector('.w-resolve').onclick = async () => {
          try { await api('/api/practice/wrong-set/resolve', { method: 'POST', body: JSON.stringify({ attempt_id: Number(c.dataset.att) }) }); toast('已移出错题集'); c.remove(); } catch (e) { toast(e.message); }
        };
      });
    }

    // 单题重练：仅重做这一道错题，作答后即时判分
    function renderRedo(a) {
      let opts = a.options;
      if (typeof opts === 'string') { try { opts = JSON.parse(opts); } catch { opts = []; } }  // 兼容历史接口返回的 JSON 字符串
      opts = Array.isArray(opts) ? opts : [];
      const isMulti = a.q_type === '多选';
      const isSubj = !opts.length;  // 无选项 = 主观题（简答/行为）
      view.innerHTML = `${pageHead('校招练习')}
        <h2 class="ph2">✍️ 再练本题</h2>
        <div class="qwrap">
          <div class="w-top">
            <span class="tag stage-${a.exam_stage === '面试' ? 'i' : 'w'}">${esc(a.exam_stage || '笔试')}</span>
            <span class="tag">${esc(a.q_type)}</span>
            ${a.position ? `<span class="tag ct">${esc(a.position)}</span>` : ''}
            <span class="wscore">上次得分 ${a.score}</span>
          </div>
          <div class="w-stem" style="font-size:15px;line-height:1.7">${esc(a.stem)}</div>
          ${opts.length ? `<div class="redo-opts">${opts.map((o, i) => `
            <label class="opt"><input type="${isMulti ? 'checkbox' : 'radio'}" name="redo" value="${i}"><span>${letter(i)}. ${esc(o)}</span></label>`).join('')}</div>`
          : `<div class="redo-opts"></div><textarea id="rdans" class="rdans" placeholder="请输入你的作答…"></textarea>`}
          <div style="margin-top:12px"><button class="btn btn-primary" id="rdsubmit">提交判分</button></div>
          <div id="rdresult" style="margin-top:12px"></div>
          <div class="res-actions" style="margin-top:14px"><button class="btn btn-ghost" id="rdback">← 返回错题集</button></div>
        </div>`;
      // 直接重渲染错题集（此时 hash 已是 wrong，设相同 hash 不会触发 hashchange）
      $('#rdback').onclick = () => { renderWrong(); };
      $('#rdsubmit').onclick = async () => {
        const ta = $('#rdans');
        let ans;
        if (ta) {
          ans = ta.value.trim();
          if (!ans) { toast('请先作答本题'); return; }
        } else {
          const sel = [...view.querySelectorAll('input[name=redo]:checked')].map(x => x.value);
          if (!sel.length) { toast('请先作答本题'); return; }
          ans = isMulti ? JSON.stringify(sel) : sel[0];
        }
        const btn = $('#rdsubmit'); btn.disabled = true; btn.textContent = '判分中…';
        try {
          const r = await api('/api/practice/attempt', { method: 'POST', body: JSON.stringify({ question_id: a.question_id, bank_id: a.bank_id, answer: ans }) });
          const rr = r && r.question_id != null ? r : (r.result || r);
          const score = rr.score != null ? rr.score : '—';
          const good = rr.is_wrong ? false : true;
          $('#rdresult').innerHTML = `<div class="res-item ${good ? 'good' : 'bad'}">
            <div class="res-qtop"><span class="tag">本次得分 ${score}</span>${good ? '<span class="res-wrong" style="color:var(--ok)">✓ 答对了</span>' : '<span class="res-wrong">仍答错</span>'}</div>
            ${rr.answer ? `<div class="res-correct">正确答案：${esc(rr.answer)}</div>` : ''}
            ${rr.explanation ? `<div class="res-exp">解析：${esc(rr.explanation)}</div>` : ''}
            ${rr.feedback && !good ? `<div class="res-fb">建议：${esc(rr.feedback).replace(/\n/g, '<br>')}</div>` : ''}
          </div>`;
          if (good) toast('答对了！可点击「标记掌握」移出错题集');
        } catch (e) { toast(e.message); }
        btn.disabled = false; btn.textContent = '提交判分';
      };
    }

    // 统一子视图分发（监听 hashchange，但仅在 /materials 下生效）
    if (window.__practiceHash) window.removeEventListener('hashchange', window.__practiceHash);
    window.__practiceHash = async function () {
      // 兼容 /xzb2026 基路径部署：剥离 base 后判断（与 render() 路由逻辑一致）
      const pp = APP_BASE && location.pathname.startsWith(APP_BASE)
        ? (location.pathname.slice(APP_BASE.length) || '/') : location.pathname;
      if (pp !== '/materials') return;
      const h = (location.hash || '').replace(/^#/, '');
      try {
        if (h.startsWith('paper/')) await renderPaper(decodeURIComponent(h.slice(6).split('?')[0]));
        else if (h === 'wrong') await renderWrong();
        else await renderHub();
      } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    window.addEventListener('hashchange', window.__practiceHash);
    await window.__practiceHash();
  });

  // ================= 薪资/Offer 数据库 =================
  route(/^\/offers$/, async () => {
    await loadMe();
    setMeta({ title: '校招薪资参考 - 校招宝', description: '校招Offer薪资参考数据库：覆盖互联网大厂各岗位校招薪资区间，支持按公司/岗位/学历/城市/届别筛选对比。数据来源：公开薪资汇总+用户匿名爆料。' });

    // 拉参考区间 + 单条爆料统计
    const refD = await api('/api/offer/reference');
    const statsD = await api('/api/offer/stats');
    const refList = refD.list || [];

    function renderOffers(searchResult) {
      const sr = searchResult || { list: [], stats: { cnt: 0 } };
      const allCompanies = [...new Set([...refList.map(r => r.company), ...sr.list.map(o => o.parent_company || o.company)])].sort().slice(0, 40);
      const allPositions = [...new Set(refList.map(r => r.position))].filter(Boolean).sort();

      view.innerHTML = `
        ${pageHead('💰 薪资参考')}
        <div class="hero practice-hero" style="margin-bottom:4px">
          <div class="brand"><div><div class="logo">${LOGO_IC}校招薪资参考</div><div class="slogan">已有 <b>${statsD.total || 0}</b> 条爆料 + ${refList.length} 条参考区间（持续更新）</div></div></div>
        </div>
        <div class="offer-sources"><span class="os-tag">数据来源：公开薪资汇总（2025届）+ 开源匿名爆料 + 用户投稿</span><span class="os-tag warn">仅供参考，以实际 offer 为准</span></div>
        <div class="offilter" id="offilter">
          <input id="of-q" placeholder="搜公司名" value="" autocomplete="off">
          <select id="of-pos"><option value="">全部岗位</option>${allPositions.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select>
          <select id="of-edu"><option value="">全部学历</option><option>本科</option><option>硕士</option><option>博士</option></select>
          <select id="of-year"><option value="">全部届别</option><option>2025</option><option>2024</option><option>2023</option><option>2019</option><option>2018</option></select>
          <button class="btn btn-primary" id="of-go" style="padding:6px 14px;font-size:13px">筛选</button>
        </div>
        <div id="of-result"></div>
        ${store.token ? `<div class="offer-cta"><button class="btn btn-ghost" id="of-report">📤 匿名爆料我的 Offer</button></div>` : ''}
      `;

      function drawResult(data) {
        const d = data || sr;
        const list = d.list || [];
        let html = '';
        if (d.stats && d.stats.cnt > 0 && d.stats.cnt >= 3) {
          const s = d.stats;
          const lo = Number(s.min_avg) || 0, hi = Number(s.max_avg) || 0, avg = Number(s.avg_total) || 0;
          const pct = v => Math.max(2, Math.min(100, hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50));
          const bar = `<div class="salbar-wrap"><div class="salbar">
              <span class="range" style="left:2%;width:96%"></span>
              <span class="avg" style="left:${pct(avg)}%"></span>
            </div><div class="salbar-scale"><span>${esc(lo)}万</span><span>均值 ${esc(avg)}万</span><span>${esc(hi)}万</span></div></div>`;
          html += `<div class="offer-stats">📊 符合条件共 <b>${s.cnt}</b> 条，平均年薪约 <b>${esc(s.avg_total || '—')}万</b>（区间 ${esc(s.min_avg || '—')}~${esc(s.max_avg || '—')}万）${bar}</div>`;
        } else if (d.stats && d.stats.cnt > 0) {
          html += `<div class="offer-stats dim">📊 符合条件仅 ${d.stats.cnt} 条（样本不足，暂不展示统计）</div>`;
        }
        if (!list.length) {
          html += '<div class="empty">暂无匹配数据（试试切换岗位/学历/届别，或搜公司名）</div>';
        } else {
          html += list.map(o => {
            const total = o.total_min ? (o.total_min === o.total_max ? `${o.total_max}万` : `${o.total_min}-${o.total_max}万`) : (o.salary_text || '—');
            return `<div class="ocard">
              <div class="oc-top">
                <span class="oc-co">${esc(o.parent_company || o.company || '')}</span>
                <span class="oc-pos">${esc(o.position || '')}</span>
                <span class="oc-year">${esc(o.grad_year || '')}届</span>
              </div>
              <div class="oc-mid">
                <span class="oc-total">💰 ${esc(total)}</span>
                ${o.education ? `<span class="oc-edu">${esc(o.education)}</span>` : ''}
                ${o.city ? `<span class="oc-city">📍 ${esc(o.city)}</span>` : ''}
                ${o.tier ? `<span class="tag stage-w">${esc(o.tier)}</span>` : ''}
              </div>
              <div class="oc-src">来源：${esc(o.source || '匿名爆料')}</div>
            </div>`;
          }).join('');
        }
        // 如果只是参考区间数据且结果为空，展示参考区间
        if (!list.length && refList.length) {
          const matchRef = refList.filter(r => {
            const q = ($('#of-q')?.value || '').trim().toLowerCase();
            const pos = $('#of-pos')?.value || '';
            const yr = $('#of-year')?.value || '';
            if (q && !r.company.toLowerCase().includes(q)) return false;
            if (pos && r.position !== pos) return false;
            if (yr && r.grad_year !== yr) return false;
            return true;
          });
          if (matchRef.length) {
            html += '<div class="offer-stats">📚 未找到单条爆料，以下是 2025 届薪资参考区间（公开汇总）：</div>';
            html += matchRef.slice(0, 20).map(r => `
              <div class="ocard ref">
                <div class="oc-top"><span class="oc-co">${esc(r.company)}</span><span class="oc-pos">${esc(r.position)}</span><span class="oc-year">${esc(r.grad_year||'')}届</span>${r.tier?`<span class="tag stage-w">${esc(r.tier)}</span>`:''}</div>
                <div class="oc-mid"><span class="oc-total">💰 ${r.salary_min}-${r.salary_max}万</span>${r.education?`<span class="oc-edu">${esc(r.education)}</span>`:''}</div>
              </div>`).join('');
          }
        }
        // 如果用户搜了但无结果
        const q = ($('#of-q')?.value || '').trim();
        if (!list.length && !refList.filter(r => q && r.company.toLowerCase().includes(q)).length && q) {
          html += `<div class="offer-stats dim">🔍 未找到"${esc(q)}"的薪资数据。试试输入公司全名，或查看上方参考区间。</div>`;
          // 从参考区间搜索
          const companyRefs = refList.filter(r => q && r.company.toLowerCase().includes(q));
          if (companyRefs.length) {
            html += companyRefs.slice(0, 10).map(r => `
              <div class="ocard ref">
                <div class="oc-top"><span class="oc-co">${esc(r.company)}</span><span class="oc-pos">${esc(r.position)}</span><span class="oc-year">${esc(r.grad_year||'')}届</span></div>
                <div class="oc-mid"><span class="oc-total">💰 ${r.salary_min}-${r.salary_max}万</span></div>
              </div>`).join('');
          }
        }
        $('#of-result').innerHTML = html;
      }

      drawResult();

      // 筛选/搜索
      $('#of-go').onclick = async () => {
        const params = new URLSearchParams();
        const q = ($('#of-q').value || '').trim(); if (q) params.set('company', q);
        const pos = $('#of-pos').value; if (pos) params.set('position', pos);
        const edu = $('#of-edu').value; if (edu) params.set('education', edu);
        const yr = $('#of-year').value; if (yr) params.set('grad_year', yr);
        try {
          const r = await api('/api/offer/search?' + params.toString());
          drawResult(r);
        } catch (e) { toast(e.message); }
      };

      // 回车搜索
      $('#of-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('#of-go').click(); });

      // UGC 爆料
      if ($('#of-report')) $('#of-report').onclick = () => {
        modal(`<h3>📤 匿名爆料 Offer</h3>
          <div class="of-form">
            <input id="rpt-co" placeholder="公司名（必填）">
            <input id="rpt-pos" placeholder="岗位（如 后端开发）">
            <input id="rpt-edu" placeholder="学历（如 硕士985）">
            <input id="rpt-city" placeholder="城市">
            <input id="rpt-sal" placeholder="薪资（如 24k×16 / 38万 / 35-40w）">
            <input id="rpt-year" placeholder="届别（如 2025）">
          </div>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn btn-ghost" onclick="_closeModal()">取消</button>
            <button class="btn btn-primary" style="flex:1" id="rpt-go">提交（匿名）</button>
          </div>`);
        $('#rpt-go').onclick = async () => {
          const body = {
            company: $('#rpt-co').value.trim(),
            position: $('#rpt-pos').value.trim() || null,
            education: $('#rpt-edu').value.trim() || null,
            city: $('#rpt-city').value.trim() || null,
            salary_text: $('#rpt-sal').value.trim() || null,
            grad_year: $('#rpt-year').value.trim() || null
          };
          if (!body.company) { toast('请填写公司名'); return; }
          try {
            await api('/api/offer/report', { method: 'POST', body: JSON.stringify(body) });
            toast('爆料已提交，审核后将展示（感谢分享！）'); _closeModal();
          } catch (e) { toast(e.message); }
        };
      };
    }
    renderOffers();
  });

  // ================= 求职攻略 =================
  // 极简 Markdown → HTML（与 SSR 版一致，覆盖攻略文用到的语法）
  function md2html(md) {
    const lines = String(md || '').split(/\r?\n/);
    const out = []; let inUl = false, inOl = false;
    const flush = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
      if (!line.trim()) { flush(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { flush(); out.push(`<h${h[1].length} class="gm-h">${e(h[2])}</h${h[1].length}>`); continue; }
      const li = line.match(/^[-*]\s+(.*)/);
      if (li) { if (!inUl) { out.push('<ul class="gm-ul">'); inUl = true; } out.push(`<li>${e(li[1])}</li>`); continue; }
      const oi = line.match(/^\d+[.、]\s+(.*)/);
      if (oi) { if (!inOl) { out.push('<ol class="gm-ol">'); inOl = true; } out.push(`<li>${e(oi[1])}</li>`); continue; }
      if (/^>\s?/.test(line)) { flush(); out.push(`<blockquote class="gm-q">${e(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
      if (/^---+\s*$/.test(line)) { flush(); out.push('<hr class="gm-hr">'); continue; }
      flush(); out.push(`<p class="gm-p">${e(line)}</p>`);
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
  function gfaqHtml(content) {
    try {
      const arr = JSON.parse(content);
      if (!Array.isArray(arr)) throw new Error('x');
      return `<div class="gfaq">${arr.map(f => `<details class="gfaq-item"><summary>${esc(f.q)}</summary><div class="gfaq-a">${md2html(f.a)}</div></details>`).join('')}</div>`;
    } catch { return md2html(content); }
  }
  route(/^\/guides$/, async () => {
    await loadMe();
    setMeta({ title: '校招求职攻略大全（按岗位） - 校招宝', description: '按热门岗位整理的校招求职攻略：笔试备考、面试技巧、薪资参考与常见问答，数据来自校招宝真实招聘与题库聚合。' });
    view.innerHTML = `${pageHead('📖 求职攻略')}
      <div class="hero practice-hero"><div class="brand"><div><div class="logo">${LOGO_IC}求职攻略</div><div class="slogan">热门岗位怎么准备，一篇讲透</div></div></div></div>
      <div class="guide-notice">按岗位整理的校招备考指南：岗位全景 · 笔试真题 · 面试技巧 · 薪资参考 · 常见问答，全部基于站内真实数据 + AI 方法论整理。</div>
      <div class="list glist"><div class="empty">加载中…</div></div>`;
    try {
      const d = await api('/api/guides');
      const list = d.list || [];
      if (!list.length) { view.querySelector('.list').innerHTML = '<div class="empty">攻略整理中，稍后再来…</div>'; return; }
      view.querySelector('.list').innerHTML = list.map(p => `<a class="gcard${p.hasPractice ? '' : ' gcard-plain'}" href="/guide/${p.slug || encodeURIComponent(p.name)}">
        <div class="g-card-top"><span class="g-emoji">📖</span><span class="g-name">${esc(p.name)}</span>${p.hasPractice ? '<span class="gtag">练习</span>' : '<span class="gtag gtag-plain">攻略</span>'}<span class="g-count">${p.job_count}<small> 在招</small></span></div>
        <div class="g-meta">${p.gcount} 篇攻略${p.hasPractice ? ' · 含在线练习' : ' · 看在招岗位'} ›</div>
      </a>`).join('');
    } catch (e) { view.querySelector('.list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  });

  route(/^\/guide\/(.+)$/, async position => {
    await loadMe();
    view.innerHTML = `${pageHead('📖 求职攻略')}<div class="list"><div class="empty">加载中…</div></div>`;
    let d;
    try { d = await api('/api/guides/' + encodeURIComponent(position)); }
    catch (e) { view.innerHTML = `${pageHead('📖 求职攻略')}<div class="empty">${esc(e.message)}</div>`; return; }
    setMeta({ title: `${d.position} 校招求职攻略：笔试/面试/薪资 - 校招宝`, description: `${d.position} 校招求职攻略：岗位全景、笔试真题题型、面试技巧、薪资参考与常见问答。数据来源：校招宝。` });
    const byStage = {};
    for (const g of d.guides) byStage[g.stage] = g;
    const badges = [
      `📋 ${d.job_count} 条在招`,
      d.practiceN ? `✍️ ${d.practiceN} 道练习` : null,
      d.salaryN ? `💰 ${d.salaryN} 条薪资参考` : null
    ].filter(Boolean);
    const sections = GUIDE_STAGES.map(st => {
      const g = byStage[st.key];
      const content = g ? (st.key === 'faq' ? gfaqHtml(g.content) : md2html(g.content)) : '';
      return `<section class="gsec" id="${st.key}">
        <div class="gsec-head"><span class="gsec-ic">${st.icon}</span><div><div class="gsec-title">${st.name}</div><div class="gsec-desc">${st.desc}</div></div></div>
        <div class="gsec-body">${content || '<div class="empty">整理中…</div>'}</div>
        <div class="gsec-actions">
          ${d.hasPractice ? `<a class="btn btn-primary" href="/materials#paper/${encodeURIComponent(d.position)}">✍️ 去练习 ${esc(d.position)}</a>` : ''}
          <a class="btn btn-ghost" href="/?q=${encodeURIComponent(d.position)}">📋 看在招岗位</a>
        </div>
      </section>`;
    }).join('');
    view.innerHTML = `${pageHead('📖 求职攻略')}
      <div class="guide-detail">
        <div class="g-hero">
          <div class="g-hero-emoji">📖</div>
          <div class="g-hero-info">
            <div class="g-hero-name">${esc(d.position)} 校招攻略</div>
            <div class="g-hero-intro">${esc(d.intro || '')}</div>
            <div class="g-badges">${badges.map(b => `<span class="g-badge">${b}</span>`).join('')}</div>
          </div>
        </div>
        <nav class="g-nav">${GUIDE_STAGES.map(st => `<a href="#${st.key}" class="g-nav-item">${st.icon}${st.name}</a>`).join('')}</nav>
        ${sections}
        <div class="g-disclaimer">⚠️ 攻略中岗位数据/薪资/题型统计均来自校招宝真实数据聚合；备考方法论由 AI 生成，仅供参考，请结合自身情况制定计划。</div>
      </div>`;
  });

  // ================= 企业主页（直接列出招聘 + 笔面经） =================
  route(/^\/company\/(.+)$/, async name => {
    await loadMe();
    const d = await api('/api/companies/' + encodeURIComponent(name));
    setMeta({
      title: `${d.name} 校招档案 - 校招宝`,
      description: `${d.name} 校招档案｜${d.stats.job_count} 条在招岗位、${(d.experience_summary ? d.experience_summary.total : 0)} 篇笔面经精华。校招宝企业档案库。`,
      ogTitle: `${d.name} 校招档案`,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'Organization',
        name: d.name, description: `${d.name} 校招档案：共 ${d.stats.job_count} 条招聘记录。来源：校招宝。`
      }
    });
    view.innerHTML = `
      ${pageHead('企业档案')}
      <div class="detail-top">
        <div class="co">${esc(d.name)}</div>
        <div class="tags">
          ${d.stats.company_type ? `<span class="tag">${esc(d.stats.company_type)}</span>` : ''}
          ${d.stats.industry ? `<span class="tag">${esc(d.stats.industry)}</span>` : ''}
          <span class="tag">${d.stats.job_count} 条招聘记录</span>
        </div>
      </div>
      <div class="section"><h2>📝 笔面经精华（${d.experience_summary ? d.experience_summary.total : 0} 篇）</h2>
        <div style="padding:0 0 10px"><button class="btn btn-primary" style="width:100%" id="wpost">✍️ 写笔面经，帮助学弟学妹</button></div>
        ${experienceAggregateHtml(d.experience_summary)}
      </div>
      <div class="section"><h2>📋 招聘信息（${d.jobs.length} 条）</h2>
        <div class="timeline">
        ${d.jobs.map(j => `<div class="titem"><div style="font-size:12px;color:var(--text2)">${esc(j.publish_date)} · ${esc(j.batch)}</div>
          <a href="/job/${j.id}" style="font-size:14px"><b>${esc(j.position.slice(0, 60))}</b></a>
          <div style="font-size:12px;color:var(--text2)">${esc((j.city || '').split(',').slice(0, 3).join('/'))} ${ddlHtml(j.deadline)}</div></div>`).join('')}
        </div>
      </div>
      ${d.expired_jobs && d.expired_jobs.length ? `
      <div class="section expired-section">
        <button class="expired-toggle" onclick="toggleExpired(this)">
          <span class="et-head">🗓️ 已截止校招信息（${d.expired_jobs.length} 条 · 仅供参考）</span>
          <span class="et-arrow">▸ 点击展开</span>
        </button>
        <div class="timeline expired-body" style="display:none">
        ${d.expired_jobs.map(j => `<div class="titem expired"><div style="font-size:12px;color:var(--text2)">${esc(j.publish_date)} · ${esc(j.batch)}</div>
          <a href="/job/${j.id}" style="font-size:14px"><b>${esc(j.position.slice(0, 60))}</b></a>
          <div style="font-size:12px;color:var(--text2)">${esc((j.city || '').split(',').slice(0, 3).join('/'))} <span style="color:#999">已截止</span></div></div>`).join('')}
        </div>
      </div>` : ''}`;
    view.innerHTML = `
      ${pageHead('企业档案')}
      <div class="detail-top">
        <div class="co">${esc(d.name)}</div>
        <div class="tags">
          ${d.stats.company_type ? `<span class="tag">${esc(d.stats.company_type)}</span>` : ''}
          ${d.stats.industry ? `<span class="tag">${esc(d.stats.industry)}</span>` : ''}
          <span class="tag">${d.stats.job_count} 条招聘记录</span>
        </div>
      </div>
      ${d.apply_url ? `<a class="btn btn-primary" style="display:block;margin:12px 12px 0;text-align:center" href="${esc(d.apply_url)}" target="_blank" rel="noopener">🏢 官方投递入口 ›</a>` : ''}
      ${d.profile && d.profile.intro ? `
      <div class="section cp-intro">
        ${renderIntel(d.profile.intro)}
      </div>` : ''}
      ${d.profile && d.profile.locations && d.profile.locations.length ? `
      <div class="section" style="padding-top:0">
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px">📍 主要办公地点</div>
        <div class="loc-tags">${d.profile.locations.slice(0, 10).map(l => `<span class="loc-tag">${esc(l)}</span>`).join('')}</div>
      </div>` : ''}
      ${campusRecruitHtml(d.profile)}
      <div class="section"><h2>📝 笔面经精华（${d.experience_summary ? d.experience_summary.total : 0} 篇）</h2>
        <div style="padding:0 0 10px"><button class="btn btn-primary" style="width:100%" id="wpost">✍️ 写笔面经，帮助学弟学妹</button></div>
        ${experienceAggregateHtml(d.experience_summary)}
      </div>
      <div class="section"><h2>📋 招聘信息（${d.jobs.length} 条）</h2>
        <div class="timeline">
        ${d.jobs.map(j => `<div class="titem"><div style="font-size:12px;color:var(--text2)">${esc(j.publish_date)} · ${esc(j.batch)}</div>
          <a href="/job/${j.id}" style="font-size:14px"><b>${esc(j.position.slice(0, 60))}</b></a>
          <div style="font-size:12px;color:var(--text2)">${esc((j.city || '').split(',').slice(0, 3).join('/'))} ${ddlHtml(j.deadline)}</div></div>`).join('')}
        </div>
      </div>
      ${d.expired_jobs && d.expired_jobs.length ? `
      <div class="section expired-section">
        <button class="expired-toggle" onclick="toggleExpired(this)">
          <span class="et-head">🗓️ 已截止校招信息（${d.expired_jobs.length} 条 · 仅供参考）</span>
          <span class="et-arrow">▸ 点击展开</span>
        </button>
        <div class="timeline expired-body" style="display:none">
        ${d.expired_jobs.map(j => `<div class="titem expired"><div style="font-size:12px;color:var(--text2)">${esc(j.publish_date)} · ${esc(j.batch)}</div>
          <a href="/job/${j.id}" style="font-size:14px"><b>${esc(j.position.slice(0, 60))}</b></a>
          <div style="font-size:12px;color:var(--text2)">${esc((j.city || '').split(',').slice(0, 3).join('/'))} <span style="color:#999">已截止</span></div></div>`).join('')}
        </div>
      </div>` : ''}`;
      $('#wpost').onclick = () => {
        if (!ME) { location.href = '/register'; return; }
        modal(`<h3>发布笔面经 · ${esc(d.name)}</h3>
          <div class="field"><label>类型</label><select id="ptype"><option>面经</option><option>笔经</option><option>offer时间线</option><option>求职经验</option></select></div>
          <div class="field"><label>标题</label><input id="ptitle" placeholder="如：2027届秋招后端一面面经"></div>
          <div class="field"><label>内容</label><textarea id="pcontent" placeholder="流程、题目、建议…（审核通过后展示）"></textarea></div>
          <div style="display:flex;gap:10px"><button class="btn btn-ghost" onclick="_closeModal()">取消</button>
          <button class="btn btn-primary" style="flex:1" id="psubmit">提交</button></div>`);
        $('#psubmit').onclick = async () => {
          try {
            const r = await api('/api/posts', { method: 'POST', body: JSON.stringify({ company: d.name, type: $('#ptype').value, title: $('#ptitle').value.trim(), content: $('#pcontent').value.trim() }) });
            closeModal(); toast(r.message);
          } catch (e) { e.code === 'NEED_VIP' ? (closeModal(), toast('请先登录')) : toast(e.message); }
        };
      };
  });

  // ================= 订阅 =================
  route(/^\/subs$/, async () => {
    await loadMe(true); await loadMeta();
    if (!ME) {
      view.innerHTML = paywall('📮 每日情报邮件', '登录后设置订阅条件，每天为你精选新增校招信息，发送到邮箱', `<a class="btn btn-primary" href="/login" style="display:block" onclick="window.__xzRedirect=location.pathname">登录 / 注册</a>`);
      return;
    }
    const { list, logs } = await api('/api/subscriptions');
    const hasSub = list.length > 0;
    const sub = hasSub ? list[0] : null;
    view.innerHTML = `
      ${pageHead('我的订阅')}
      <div class="hero"><div class="brand"><div><div class="logo">${LOGO_IC}我的订阅</div><div class="slogan">每日 9:00 情报直达邮箱：${esc(ME.email)}</div></div></div></div>
      <div style="padding:12px 12px 0"><button class="btn btn-primary" style="width:100%" id="addsub">${hasSub ? '✎ 修改订阅条件' : '＋ 新建订阅条件'}</button></div>
      <div id="sublist">${hasSub ? '' : '<div class="empty">还没有订阅条件，点上方按钮创建 ↑</div>'}</div>
      <div id="reclist"></div>`;
    const sl = $('#sublist');
    sl.innerHTML += (hasSub ? list.map(s => {
      const f = s.filters;
      const chips = ['q', 'batch', 'company_type', 'city', 'grad_year', 'education', 'industry'].filter(k => f[k] && (Array.isArray(f[k]) ? f[k].length : f[k])).map(k => { const v = Array.isArray(f[k]) ? f[k].join(' / ') : f[k]; return `<span class="fchip">${esc(v)}</span>`; }).join(' ') || '<span class="fchip">全部新增</span>';
      return `<div class="section"><h2>${esc(s.name)} ${s.enabled ? '🟢' : '⚪'}</h2>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
        <div style="margin-top:12px;display:flex;gap:10px">
          <button class="fbtn" data-pv="${s.id}">预览命中</button>
          <button class="fbtn" data-del="${s.id}" style="color:var(--red)">删除订阅</button>
        </div><div id="pv-${s.id}"></div></div>`;
    }).join('') : '');
    sl.onclick = async e => {
      if (e.target.dataset.pv) {
        const d = await api(`/api/subscriptions/${e.target.dataset.pv}/preview`);
        $('#pv-' + e.target.dataset.pv).innerHTML = d.list.length
          ? '<div style="margin-top:10px">' + d.list.slice(0, 5).map(jobCard).join('') + '</div>'
          : '<div class="notice">暂无命中，等明日新数据</div>';
      }
      if (e.target.dataset.del) {
        await api('/api/subscriptions/' + e.target.dataset.del, { method: 'DELETE' });
        toast('已删除订阅'); render();
      }
    };
    // 订阅记录：仅当前用户最新生成的前 10 条
    const rl = $('#reclist');
    if (logs && logs.length) {
      rl.innerHTML = `<div class="section"><h2>📑 订阅记录（最新 ${logs.length} 条）</h2>` +
        logs.map(l => {
          const jobs = (l.jobs || []).slice(0, 5);
          const preview = jobs.length ? jobs.map(j => `<a class="fchip" href="/job/${j.id}">${esc(j.company)}${j.position ? '·' + esc(j.position) : ''}</a>`).join(' ') : '<span class="fchip">—</span>';
          return `<div class="recm"><div class="recm-h"><b>${esc(l.log_date)}</b> · 命中 <b>${l.hits_count}</b> 条 ${l.sent ? '✉️已发送' : '⏳未发送'}</div><div class="recm-jobs">${preview}</div></div>`;
        }).join('') + '</div>';
    } else {
      rl.innerHTML = `<div class="section"><h2>📑 订阅记录</h2><div class="empty">尚无生成记录，每日 9:00 自动生成</div></div>`;
    }
    $('#addsub').onclick = () => {
      const f0 = sub ? sub.filters : {};
      const sel = (id, key, label) => `<div class="field"><label>${label}</label><select id="${id}"><option value="">不限</option>${META[key].map(v => `<option ${f0[key] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>`;
      modal(`<h3>${hasSub ? '修改订阅条件' : '新建订阅条件'}</h3>
        <div class="field"><label>订阅名称</label><input id="sname" placeholder="如：2027届北京秋招" value="${esc(sub ? sub.name : '')}"></div>
        <div class="field"><label>关键词（可选）</label><input id="skw" placeholder="如：算法 / 银行" value="${esc(f0.q || '')}"></div>
        ${sel('sbatch', 'batch', '招聘批次')}${sel('sct', 'company_type', '企业类型')}<div class="field"><label>城市（可多选）</label><div class="chkbox" id="scitybox">${META.city.map(v => `<label class="ck"><input type="checkbox" value="${esc(v)}" ${(Array.isArray(f0.city) ? f0.city.includes(v) : f0.city === v) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>${sel('syear', 'grad_year', '届别')}
        <div style="display:flex;gap:10px"><button class="btn btn-ghost" onclick="_closeModal()">取消</button>
        <button class="btn btn-primary" style="flex:1" id="ssave">${hasSub ? '保存修改' : '保存订阅'}</button></div>`);
      $('#ssave').onclick = async () => {
        try {
          await api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ name: $('#sname').value.trim() || '我的订阅', filters: { q: $('#skw').value.trim(), batch: $('#sbatch').value, company_type: $('#sct').value, city: [...document.querySelectorAll('#scitybox input:checked')].map(i => i.value), grad_year: $('#syear').value } }) });
          closeModal(); toast(hasSub ? '订阅条件已更新' : '订阅已创建，每日新增命中将发送至邮箱'); render();
        } catch (e) { toast(e.message); }
      };
    };
  });

  function paywall(title, desc, btn) {
    return `${pageHead('订阅')}
      <div class="lockbox" style="margin-top:40px;padding:30px 20px">
        <div style="font-size:40px;margin-bottom:10px">📮</div>
        <div class="t" style="font-size:17px">${title}</div>
        <div class="d" style="margin:10px 0 18px">${desc}</div>${btn}</div>`;
  }

  // ================= 我的 =================
  route(/^\/me$/, async () => {
    await loadMe(true);
    if (!ME) {
      view.innerHTML = `${pageHead('个人中心')}
        <div class="me-head"><div class="em">未登录</div><div style="font-size:13px;opacity:.85;margin-top:6px">注册后无限制使用全部功能</div></div>
        <div style="padding:20px 12px"><a class="btn btn-primary" style="display:block" href="${loginHref()}">登录 / 注册</a></div>
        <div class="notice">未注册用户可浏览招聘信息，注册后解锁投递链接、收藏、笔面经、订阅等功能</div>`;
      return;
    }
    const tierText = '✅ 已开通全部功能';
    let dFav = { list: [] }, dTk = { list: [] };
    try { dFav = await api('/api/favorites'); } catch (e) {}
    try { dTk = await api('/api/tracks'); } catch (e) {}
    let favAll = false, tkAll = false;
    const tkTimeline = t => `<div class="jcard tkcard">
      <div class="row1"><span class="co">${esc(t.company)}</span><span class="tag batch">${esc(t.batch || '校招')}</span><span class="tag tk-cur">${esc(t.current || '已跟踪')}</span></div>
      <div class="pos">${esc((t.position || '').slice(0, 50))}</div>
      ${t.stages && t.stages.length ? `
      <div class="tk-timeline">
        ${t.stages.map(s => `<div class="tl-item">
          <div class="tl-dot ${s.type === 'offer' ? 'offer' : (s.type === '被拒' ? 'rej' : '')}"></div>
          <div class="tl-body">
            <div class="tl-type">${esc(stageText(s))}</div>
            ${s.date ? `<div class="tl-date">${esc(s.date)}</div>` : ''}
            ${s.note ? `<div class="tl-note">${esc(s.note)}</div>` : ''}
          </div>
        </div>`).join('')}
      </div>` : '<div class="notice" style="padding:8px 0">尚未记录进展，点「记录进展」添加时间轴</div>'}
      <div class="meta" style="margin-top:6px">
        <button class="fbtn" data-edit="${t.job_id}">✏️ 记录进展</button>
        <a class="fbtn" href="/job/${t.job_id}">查看岗位 ›</a>
      </div>
    </div>`;
    const drawMe = () => {
      const favItems = favAll ? dFav.list : dFav.list.slice(0, 10);
      const tkItems = tkAll ? dTk.list : dTk.list.slice(0, 10);
      view.innerHTML = `
        ${pageHead('个人中心')}
        <div class="me-head"><div class="em">${esc(ME.email)}</div><span class="badge ok">${tierText}</span></div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 12px 8px">
          <span style="font-weight:700;font-size:15px">⭐ 我的收藏</span>
          <a href="/fav" style="font-size:13px;color:var(--brand)">全部 ${dFav.list.length} 条 ›</a>
        </div>
        <div class="list">${favItems.length ? favItems.map(j => jobCard(j, true)).join('') : '<div class="empty">还没有收藏，去逛逛吧</div>'}</div>
        ${!favAll && dFav.list.length > 10 ? `<div style="padding:10px 12px"><button class="btn btn-ghost" style="width:100%" id="favmore">查看更多（共 ${dFav.list.length} 条）</button></div>` : ''}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 12px 8px">
          <span style="font-weight:700;font-size:15px">📌 求职跟踪</span>
          <a href="/tracks" style="font-size:13px;color:var(--brand)">全部 ${dTk.list.length} 条 ›</a>
        </div>
        <div class="list">${tkItems.length ? tkItems.map(tkTimeline).join('') : '<div class="empty">还没有跟踪任何岗位</div>'}</div>
        ${!tkAll && dTk.list.length > 10 ? `<div style="padding:10px 12px"><button class="btn btn-ghost" style="width:100%" id="tkmore">查看更多（共 ${dTk.list.length} 条）</button></div>` : ''}
        <div class="cellgroup"><a class="cell" href="/subs"><span class="ci">📮</span><span class="ct2">我的订阅</span><span class="cr">${ME.sub_count} ›</span></a></div>
        <div class="cellgroup"><a class="cell" href="/resume"><span class="ci">🎯</span><span class="ct2">AI 简历优化</span><span class="cr">免费 ›</span></a></div>
        <div class="cellgroup"><button class="cell" id="logout"><span class="ci">🚪</span><span class="ct2" style="color:var(--red)">退出登录</span></button></div>
        <div class="notice">注册时间 ${esc((ME.created_at || '').slice(0, 10))} · 校招宝 v1.0</div>`;
      if ($('#favmore')) $('#favmore').onclick = () => { favAll = true; drawMe(); };
      if ($('#tkmore')) $('#tkmore').onclick = () => { tkAll = true; drawMe(); };
      view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
        const t = dTk.list.find(x => String(x.job_id) === String(b.dataset.edit));
        if (!t) return;
        openTrackEditor(t.job_id, `${t.company} · ${(t.position || '').slice(0, 20)}`, t.stages, updated => {
          if (updated === null) { const i = dTk.list.indexOf(t); if (i >= 0) dTk.list.splice(i, 1); }
          else { t.stages = updated.stages; t.current = updated.current; }
          drawMe();
        });
      });
      if ($('#logout')) $('#logout').onclick = () => { store.token = ''; ME = null; toast('已退出'); location.href = absUrl('/'); };
    };
    drawMe();
  });

  // ================= 收藏 =================
  route(/^\/fav$/, async () => {
    await loadMe();
    if (!ME) { location.href = '/login'; return; }
    const d = await api('/api/favorites');
    if (!ME) { location.href = loginHref(); return; }
    let showAll = false;
    const drawFav = () => {
      const items = showAll ? d.list : d.list.slice(0, 10);
      view.innerHTML = `${pageHead('我的收藏')}
        <div class="list">${d.list.length ? items.map(jobCard).join('') : '<div class="empty">还没有收藏，去逛逛吧</div>'}</div>
        ${!showAll && d.list.length > 10 ? `<div style="padding:10px 12px"><button class="btn btn-ghost" style="width:100%" id="favmore">查看更多（共 ${d.list.length} 条）</button></div>` : ''}`;
      if ($('#favmore')) $('#favmore').onclick = () => { showAll = true; drawFav(); };
    };
    drawFav();
  });

  // ================= 简历文件解析（浏览器内，零依赖上传） =================
  const RESUME_CDNS = ['https://cdn.jsdelivr.net/npm', 'https://unpkg.com'];
  function loadScriptFirst(makeSrc) {
    return new Promise((resolve, reject) => {
      let lastErr;
      (async () => {
        for (const base of RESUME_CDNS) {
          try {
            await new Promise((res, rej) => {
              const s = document.createElement('script');
              s.src = base + makeSrc; s.onload = res; s.onerror = () => rej(new Error('load'));
              document.head.appendChild(s);
            });
            return resolve(base);
          } catch (e) { lastErr = e; }
        }
        reject(lastErr || new Error('CDN 不可用'));
      })();
    });
  }
  async function extractResumeText(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'txt' || ext === 'md' || ext === 'text') {
      return (await file.text()).replace(/\r\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();
    }
    if (ext === 'pdf') {
      const base = await loadScriptFirst('/pdfjs-dist@3.11.174/build/pdf.min.js');
      if (!window.pdfjsLib) throw new Error('PDF 解析库加载失败');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + '/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      const buf = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      let txt = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const c = await page.getTextContent();
        const lines = {};
        for (const it of c.items) {
          if (!it.str) continue;
          const y = Math.round(it.transform ? it.transform[5] : 0);
          (lines[y] = lines[y] || []).push(it.str);
        }
        const ys = Object.keys(lines).map(Number).sort((a, b) => b - a);
        txt += ys.map(y => lines[y].join(' ')).join('\n') + '\n';
      }
      txt = txt.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
      if (!txt) throw new Error('未能提取文字（可能是图片型/扫描件 PDF），请转成 TXT 或手动粘贴');
      return txt;
    }
    if (ext === 'docx') {
      await loadScriptFirst('/mammoth@1.6.0/mammoth.browser.min.js');
      if (!window.mammoth) throw new Error('Word 解析库加载失败');
      const buf = await file.arrayBuffer();
      const r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      const d = document.createElement('div'); d.innerHTML = r.value || '';
      const t = (d.textContent || '').replace(/\r\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();
      if (!t) throw new Error('未能从 Word 中提取到文字，请确认内容或手动粘贴');
      return t;
    }
    throw new Error('不支持的格式 .' + ext + '（请用 PDF / Word / TXT / MD）');
  }

  // ================= 简历优化（AI） =================
  route(/^\/resume$/, async () => {
    const isLogin = !!store.token;
    if (!isLogin) {
      view.innerHTML = `${pageHead('简历优化')}
      <div class="card" style="margin-top:14px;text-align:center;padding:26px">
        <div style="font-size:30px;margin-bottom:8px">🔒</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">登录后即可使用 AI 简历优化</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:16px">该功能每个账号限 10 次，登录即可使用；上传简历后 AI 推荐岗位并给出优化建议。</div>
        <button class="btn btn-primary" style="width:100%" id="rlogin">去登录 / 注册</button>
      </div>`;
      $('#rlogin').onclick = () => location.href = loginHref();
      return;
    }
    view.innerHTML = `${pageHead('简历优化')}
      <div class="card" style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div style="font-size:14px;font-weight:600">🎯 上传简历，AI 推荐岗位并优化</div>
          <span id="rquota" style="font-size:12px;color:var(--blue,#3b82f6)">剩余次数加载中…</span>
        </div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:12px">上传或粘贴简历 → AI 推荐匹配的校招岗位 → 勾选目标岗位 → 生成专属优化建议（每账号共 10 次）。</div>
        <label class="lb">简历内容</label>
        <div id="rupload" style="border:1.5px dashed var(--line);border-radius:10px;padding:18px 12px;text-align:center;margin-bottom:10px;cursor:pointer;background:var(--bg2, rgba(0,0,0,.03))">
          <div style="font-size:13px">📎 点击或拖拽上传简历</div>
          <div style="font-size:11px;color:var(--text2);margin-top:4px">支持 PDF / Word / TXT / MD，上传后自动提取文字，无需手动复制</div>
          <input type="file" id="rfile" accept=".pdf,.docx,.txt,.md" style="display:none">
        </div>
        <div class="empty" id="rparsing" style="display:none;padding:10px;color:var(--text2)">正在解析文件…</div>
        <div id="rfileinfo" style="display:none;font-size:11px;color:var(--green, #16a34a);margin-bottom:8px"></div>
        <textarea id="rresume" rows="12" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:1.6" placeholder="粘贴你的简历全文（教育经历 / 实习 / 项目 / 技能 / 获奖等，至少 50 字），或上传文件自动填充"></textarea>
        <button class="btn btn-ghost" style="width:100%;margin-top:10px" id="rrec">🤖 智能推荐岗位</button>
        <div class="empty" id="rrecing" style="display:none;padding:10px;color:var(--text2)">AI 正在分析简历并推荐岗位…</div>
        <div id="rpositions" style="display:none;margin-top:10px"></div>
        <button class="btn btn-primary" style="width:100%;margin-top:12px" id="ropt">✨ 生成优化建议</button>
        <div class="empty" id="rloading" style="display:none;padding:20px">AI 正在分析你的简历，请稍候…</div>
        <div id="rresult" style="margin-top:14px;white-space:pre-wrap;font-size:13px;line-height:1.8;display:none"></div>
      </div>`;
    const quotaEl = $('#rquota');
    try { const q = await api('/api/resume/quota'); quotaEl.textContent = `剩余 ${q.remain} / ${q.total} 次`; } catch (e) { quotaEl.textContent = ''; }
    const rfile = $('#rfile'), rupload = $('#rupload');
    rupload.onclick = () => rfile.click();
    rupload.ondragover = e => { e.preventDefault(); rupload.style.borderColor = 'var(--blue, #3b82f6)'; };
    rupload.ondragleave = () => { rupload.style.borderColor = 'var(--line)'; };
    rupload.ondrop = e => { e.preventDefault(); rupload.style.borderColor = 'var(--line)'; if (e.dataTransfer.files[0]) handleResumeFile(e.dataTransfer.files[0]); };
    rfile.onchange = () => { if (rfile.files[0]) handleResumeFile(rfile.files[0]); };
    let parsedResume = '';
    async function handleResumeFile(file) {
      const info = $('#rfileinfo'), parsing = $('#rparsing');
      parsing.style.display = 'block'; info.style.display = 'none'; info.style.color = 'var(--green, #16a34a)';
      try {
        let text = await extractResumeText(file);
        if (text.length > 10000) { text = text.slice(0, 10000); toast('简历较长，已截取前 10000 字用于分析'); }
        if (text.length < 50) throw new Error('未能从文件中提取到足够文字，请确认内容或手动粘贴');
        parsedResume = text;
        $('#rresume').value = text;
        info.textContent = '✓ 已从《' + file.name + '》提取 ' + text.length + ' 字，可点上方「智能推荐岗位」';
        info.style.display = 'block';
      } catch (e) { parsedResume = ''; info.textContent = '✗ ' + e.message; info.style.display = 'block'; info.style.color = 'var(--red, #ef4444)'; }
      parsing.style.display = 'none';
    }
    function getResumeText() { const v = $('#rresume').value.trim(); return v || parsedResume || ''; }
    $('#rrec').onclick = async () => {
      const resume = getResumeText();
      if (resume.length < 50) return toast('请先上传或粘贴简历（至少 50 字）');
      const btn = $('#rrec'); btn.disabled = true; btn.textContent = '⏳ 推荐中…';
      $('#rrecing').style.display = 'block'; $('#rpositions').style.display = 'none';
      try {
        const r = await api('/api/resume/recommend-positions', { method: 'POST', body: { resume } });
        const box = $('#rpositions');
        box.innerHTML = '<div style="font-size:12px;font-weight:600;margin-bottom:6px">✅ 为你推荐以下岗位（可多选，默认全选）：</div><div style="display:flex;flex-wrap:wrap">' +
          r.positions.map(p => `<div class="rpos-chip on" data-title="${esc(p.title)}" style="border:1px solid var(--blue,#3b82f6);border-radius:10px;padding:8px 10px;margin:4px;cursor:pointer;min-width:150px;flex:1 1 150px;background:rgba(59,130,246,.08)"><div style="font-size:13px">🎯 <b>${esc(p.title)}</b></div><div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(p.reason || '')}</div></div>`).join('') +
          '</div>';
        box.querySelectorAll('.rpos-chip').forEach(el => el.onclick = () => {
          el.classList.toggle('on');
          if (el.classList.contains('on')) { el.style.borderColor = 'var(--blue,#3b82f6)'; el.style.background = 'rgba(59,130,246,.08)'; }
          else { el.style.borderColor = 'var(--line)'; el.style.background = 'var(--bg2,#fff)'; }
        });
        box.style.display = 'block';
      } catch (e) { if (e.status === 401) { location.href = loginHref(); return; } toast(e.message); }
      $('#rrecing').style.display = 'none';
      btn.disabled = false; btn.textContent = '🤖 智能推荐岗位';
    };
    $('#ropt').onclick = async () => {
      const chips = [...document.querySelectorAll('#rpositions .rpos-chip.on')];
      const selected = chips.map(el => el.dataset.title);
      const resume = getResumeText();
      if (resume.length < 50) return toast('请先上传或粘贴简历（至少 50 字）');
      if (!selected.length) return toast('请先点「智能推荐岗位」并至少勾选一个目标岗位');
      const btn = $('#ropt'); btn.disabled = true; btn.textContent = '⏳ 生成中…';
      $('#rloading').style.display = 'block'; $('#rresult').style.display = 'none'; $('#rresult').textContent = '';
      try {
        const r = await api('/api/resume/optimize', { method: 'POST', body: { resume, positions: selected } });
        let out = '';
        for (const item of (r.results || [])) out += '\n========== 🎯 ' + item.position + ' ==========\n' + item.advice + '\n';
        $('#rresult').textContent = out.trim();
        $('#rresult').style.display = 'block';
        if (typeof r.remain === 'number') quotaEl.textContent = `剩余 ${r.remain} / ${r.total || (r.remain + selected.length)} 次`;
      } catch (e) {
        if (e.status === 401) { location.href = loginHref(); return; }
        toast(e.message);
      }
      $('#rloading').style.display = 'none';
      btn.disabled = false; btn.textContent = '✨ 生成优化建议';
    };
  });

  // ================= 登录/注册（注册需邮箱验证码） =================
  route(/^\/(login|register)$/, async mode => {
    let tab = mode === 'register' ? 'reg' : 'login';
    const gotoBack = async (token, msg) => {
      store.token = token; await loadMe(true);
      toast(msg || '登录成功');
      const params = new URLSearchParams(location.search);
      let back = params.get('redirect');
      if (!back || back.startsWith('/login') || back.startsWith('/register')) back = absUrl('/');
      location.href = back;   // 全量刷新来源页，重新按登录态渲染
    };
    const draw = (keep = {}) => {
      view.innerHTML = `${pageHead('登录 / 注册')}
        <div class="section" style="margin-top:24px">
            <div style="text-align:center;margin-bottom:16px">
              <div class="auth-logo">${LOGO_IC}</div><div style="font-weight:800;font-size:19px;margin-top:6px">校招宝</div>
            </div>
          <div class="authtabs">
            <button class="atab ${tab === 'login' ? 'on' : ''}" id="tlogin">登录</button>
            <button class="atab ${tab === 'reg' ? 'on' : ''}" id="treg">注册</button>
          </div>
          <div class="field"><label>邮箱${tab === 'reg' ? '（用于接收验证码与订阅情报邮件）' : ''}</label><input id="email" type="email" placeholder="you@example.com" value="${esc(keep.email || '')}"></div>
          ${tab === 'reg' ? `
          <div class="field"><label>邮箱验证码</label>
            <div class="codeRow">
              <input id="code" inputmode="numeric" maxlength="6" placeholder="6 位验证码" value="${esc(keep.code || '')}">
              <button class="btn btn-ghost" id="sendcode">获取验证码</button>
            </div>
          </div>` : ''}
          <div class="field"><label>密码（至少 6 位）</label><input id="pwd" type="password" placeholder="••••••" value="${esc(keep.pwd || '')}"></div>
          <button class="btn btn-primary" style="width:100%" id="go">${tab === 'reg' ? '注册（免费使用全部功能）' : '登录'}</button>
          <div style="text-align:center;margin-top:14px;font-size:13px;color:var(--text2)">${tab === 'reg' ? '验证码 10 分钟内有效 · 注册即表示同意仅用于求职学习' : '还没有账号？点上方「注册」，完成邮箱验证即可'}</div>
        </div>`;
      $('#tlogin').onclick = () => { if (tab !== 'login') { tab = 'login'; draw(snap()); } };
      $('#treg').onclick = () => { if (tab !== 'reg') { tab = 'reg'; draw(snap()); } };
      const snap = () => ({ email: $('#email').value.trim(), pwd: $('#pwd').value, code: $('#code') ? $('#code').value.trim() : '' });
      if (tab === 'reg') {
        let cd = 0, timer = null;
        $('#sendcode').onclick = async () => {
          if (cd > 0) return;
          const email = $('#email').value.trim();
          if (!email) { toast('请先填写邮箱'); return; }
          try {
            const r = await api('/api/auth/send-code', { method: 'POST', body: JSON.stringify({ email }) });
            toast(r.message);
            if (r.dev_code) { $('#code').value = r.dev_code; toast('演示模式：验证码已自动填入（' + r.dev_code + '）', 4000); }
            cd = 60;
            const btn = $('#sendcode');
            btn.disabled = true;
            timer = setInterval(() => {
              cd--;
              if (!document.body.contains(btn)) { clearInterval(timer); return; }
              if (cd <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '重新获取'; }
              else btn.textContent = cd + 's 后重发';
            }, 1000);
          } catch (e) { toast(e.message); }
        };
      }
      $('#go').onclick = async () => {
        const s = snap();
        try {
          if (tab === 'reg') {
            const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: s.email, password: s.pwd, code: s.code }) });
            await gotoBack(r.token, r.message);
          } else {
            const r = await api('/api/auth/upsert', { method: 'POST', body: JSON.stringify({ email: s.email, password: s.pwd }) });
            await gotoBack(r.token, r.message);
          }
        } catch (e) {
          if (e.code === 'NEED_REGISTER') { tab = 'reg'; draw(s); toast('该邮箱未注册，请先获取验证码完成注册'); return; }
          toast(e.message);
        }
      };
    };
    draw();
  });

  if (!document.querySelector('meta[name="ssr"]')) render();
})();
