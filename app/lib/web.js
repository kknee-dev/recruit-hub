/* 极简 Web 框架（零依赖，替代 express） */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2'
};

function createApp() {
  const routes = [];
  const middlewares = [];

  let onErrorHandler = null;
  const app = {
    use: fn => middlewares.push(fn),
    static: dir => { app._static = dir; },
    listen: (port, cb) => server.listen(port, cb),
    // 全局错误钩子：由 server.js 注入 monitor.handleWebError 实现捕获/自恢复/上报
    onError: fn => { onErrorHandler = fn; }
  };
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
    app[m.toLowerCase()] = (pattern, ...handlers) => {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:[^/]+/g, s => { keys.push(s.slice(1)); return '([^/]+)'; }) + '$');
      routes.push({ method: m, re, keys, handlers });
    };
  }

  function decorate(res) {
    res.status = code => { res.statusCode = code; return res; };
    // 安全响应头（全站统一，2026-08-09 加固）：防 MIME 嗅探 / 点击劫持 / 信息泄露
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '1; mode=block'); // 兼容旧浏览器
    res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
    res.sendFile = (fp, reqUrl = '') => {
      fs.readFile(fp, (err, buf) => {
        if (err) { res.statusCode = 404; return res.end('Not Found'); }
        const ext = path.extname(fp).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        // 缓存策略：
        // - HTML（index.html）：no-cache，每次回源验证 → 版本号更新后立即生效，杜绝"刷新还是老样子"
        // - 带 ?v= 版本号的资源（js/css）：immutable 长缓存（URL 变化即代表新内容）
        // - 其余静态资源（png/svg/ico/manifest）：1 天短缓存
        if (ext === '.html' || fp.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (/[?&]v=\d+/.test(reqUrl)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(buf);
      });
    };
    res.redirect = (code, loc) => {
      res.statusCode = code || 302;
      res.setHeader('Location', loc);
      res.end();
    };
  }

  function readBody(req, limit = 30 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    decorate(res);
    // HEAD 请求：降级为 GET 路由匹配（健康检查/监控探针），仅回响应头不回 body
    const isHead = req.method === 'HEAD';
    if (isHead) {
      req.method = 'GET';
      const _end = res.end.bind(res);
      res.end = (data, ...rest) => _end(undefined, ...rest);
      res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(undefined); };
    }
    try {
      await dispatch(req, res);
    } catch (e) {
      // 全局错误钩子：优先交给监控模块做捕获/自恢复/上报；无钩子时回退默认 500
      if (onErrorHandler) {
        try { await onErrorHandler(e, req, res, () => dispatch(req, res)); }
        catch { if (!res.writableEnded) res.status(500).json({ error: '服务器内部错误' }); }
      } else {
        console.error(e);
        if (!res.writableEnded) res.status(500).json({ error: '服务器内部错误' });
      }
    }
  });

  // 单次请求分发（抽离以便错误钩子重试）
  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://x');
    try { req.path = decodeURIComponent(url.pathname); }
    catch { req.path = url.pathname; }
    req.query = Object.fromEntries(url.searchParams);
    // body
    if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) { try { req.body = JSON.parse(raw.toString('utf8') || '{}'); } catch { req.body = {}; } }
      else if (ct.startsWith('text/')) req.body = raw.toString('utf8');
      else req.body = raw;
    }
    // 全局中间件
    for (const mw of middlewares) { await mw(req, res, () => {}); if (res.writableEnded) return; }
    // 路由
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = req.path.match(r.re);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => { try { req.params[k] = decodeURIComponent(m[i + 1]); } catch { req.params[k] = m[i + 1]; } });
      let i = 0;
      const next = async () => { const h = r.handlers[i++]; if (h && !res.writableEnded) await h(req, res, next); };
      await next();
      return;
    }
    // 静态文件
    if (req.method === 'GET' && app._static) {
      const safe = path.normalize(req.path).replace(/^([.][.][\\/])+/, '');
      let fp = path.join(app._static, safe);
      if (!fp.startsWith(app._static)) { res.statusCode = 403; return res.end(); }
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return res.sendFile(fp, req.url);
      if (!req.path.startsWith('/api/')) return res.sendFile(path.join(app._static, 'index.html'), req.url);
    }
    res.status(404).json({ error: 'Not Found' });
  }

  return app;
}

module.exports = { createApp };
