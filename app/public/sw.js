/* 校招宝 PWA Service Worker —— 离线缓存（2026-08-09）
 * 策略：核心壳（js/css/icon）安装时预缓存；页面请求 network-first（保证数据最新），
 * 失败时回退缓存（离线可看首页/详情壳）。版本号随 ?v= 一起 bump。
 */
const VERSION = 'xzb-v29';
const CORE = [
  '/css/app.css?v=52',
  '/js/app.js?v=76',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 仅同源 GET；API 请求不做离线缓存（数据类走 network-only，失败直接报错即可）
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 公安备案博客页（域名根路径）：始终走网络、不缓存、不拦截，确保审核页由服务端实时返回
  const BLOG = ['/', '/resume-writing', '/resume-delivery', '/written-test', '/interview-skills', '/salary-negotiation', '/onboarding-prep', '/job-resources'];
  if (BLOG.includes(url.pathname)) return;

  // 带 ?v= 的静态资源（js/css）：cache-first，URL 变化即新内容
  if (/[?&]v=\d+/.test(url.search)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, clone));
      return res;
    })));
    return;
  }

  // HTML/其他：network-first，离线回退缓存
  e.respondWith(fetch(e.request).then(res => {
    if (res && res.status === 200) {
      const clone = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, clone));
    }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
