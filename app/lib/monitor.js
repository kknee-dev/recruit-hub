/* 网站运行监控：错误捕获、分类、安全自恢复、结构化日志、自动上报待办
 * 设计原则（已与用户确认）：
 *  - 仅做「安全自恢复」：DB 锁重试、缓存复位、客户端错误优雅降级、限流退避；
 *  - 对无法自动修复的代码 Bug / 未知异常 => 写入 site_errors 并自动生成 work_suggestions 待办（去重），交由用户判断；
 *  - 绝不擅自改写源码或重启服务。
 */
const db = require('../db');
const config = require('../config');

// 服务端缓存复位回调（由 server.js 注入：清空 meta 缓存等热点缓存）
let cacheReset = () => {};
function setCacheReset(fn) { cacheReset = typeof fn === 'function' ? fn : cacheReset; }

const MAX_ERR_MSG = 500;
const trim = (s, n = MAX_ERR_MSG) => String(s == null ? '' : s).slice(0, n);

function clientIp(req) {
  try {
    const xff = req && req.headers && req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return (req && req.socket && (req.socket.remoteAddress || (req.socket.address && req.socket.address().address))) || '';
  } catch { return ''; }
}

/** 错误分类：返回 { kind, severity, autoAction } */
function classify(e) {
  const msg = String(e && e.message ? e.message : e);
  const code = e && e.code;
  const name = e && e.name;
  // 数据库锁 / 忙（瞬态，可重试）
  if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg)) {
    return { kind: 'sqlite_busy', severity: 'warn', autoAction: 'retry_once' };
  }
  // 网络瞬态（上游/代理/客户端断连）
  if (/ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|ECONNREFUSED|ENOTFOUND/i.test(msg) || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return { kind: 'network', severity: 'warn', autoAction: 'retry_once' };
  }
  // 请求体异常（客户端问题，非服务端 Bug）
  if (/请求体过大|payload too large/i.test(msg) || name === 'SyntaxError') {
    return { kind: 'body_parse', severity: 'info', autoAction: 'skip' };
  }
  // 代码层 Bug（函数缺失/未定义/空引用）
  if (name === 'TypeError' || name === 'ReferenceError' || name === 'RangeError' || /is not a function|Cannot read|undefined|null/.test(msg)) {
    return { kind: 'code_bug', severity: 'error', autoAction: 'flag' };
  }
  // 其它未知
  return { kind: 'unknown', severity: 'error', autoAction: 'flag' };
}

/** 写一条错误日志；flag 类自动生成待办建议（按签名去重） */
function logError({ err, req, ctx = {}, autoAction, autoResult, status }) {
  const cl = classify(err);
  const kind = cl.kind;
  const severity = cl.severity;
  autoAction = autoAction || cl.autoAction;
  status = status || (autoAction === 'flag' ? 'flagged' : 'open');
  const route = req && (req.path || (req.url && new URL(req.url, 'http://x').pathname)) || ctx.route || '';
  const method = req && req.method || ctx.method || '';
  const context = {
    query: req && req.query, params: req && req.params, ua: req && req.headers && req.headers['user-agent'],
    ip: clientIp(req), ...ctx
  };
  let rowId = null;
  try {
    const info = db.prepare(`INSERT INTO site_errors (kind, severity, route, method, message, stack, context_json, auto_action, auto_result, status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      kind, severity, route, method, trim(err && err.message ? err.message : String(err)),
      trim(err && err.stack ? err.stack : '', 2000),
      JSON.stringify(context).slice(0, 2000), autoAction || '', autoResult || '', status
    );
    rowId = info.lastInsertRowid;
  } catch (e2) {
    // 连日志都写不进（极端 DB 故障）：至少打到控制台，避免静默丢失
    console.error('[monitor] 写错误日志失败:', e2.message);
  }
  console.error(`[monitor] ${severity}/${kind} @${method} ${route} -> ${autoAction}:${autoResult || status} | ${(err && err.message || err)}`);

  // flag 类（代码 Bug / 未知）=> 自动生成待办建议（去重，避免刷屏）
  if (autoAction === 'flag') {
    try {
      const sig = kind + '::' + trim(err && err.message ? err.message : String(err), 80);
      const recent = db.prepare(`SELECT id FROM work_suggestions WHERE source='error' AND status='pending' AND source_refs LIKE ? AND ts >= datetime('now','localtime','-7 days') LIMIT 1`)
        .get('%' + JSON.stringify(sig).slice(1, -1) + '%');
      if (!recent) {
        const title = `[运行错误] ${kind}：${trim(err && err.message ? err.message : String(err), 60)}`;
        const detail = `路由 ${method} ${route}\n类型 ${kind}（${severity}）\n错误：${trim(err && err.message ? err.message : String(err), 300)}\n\n堆栈摘要：\n${trim(err && err.stack ? err.stack : '', 800)}\n\n建议核查该路由/handler 逻辑，必要时修复后部署。`;
        const ins = db.prepare(`INSERT INTO work_suggestions (source, source_refs, title, detail, priority, status) VALUES ('error',?,?,?,'高','pending')`)
          .run(JSON.stringify([rowId, sig]), title, detail);
        // 回写关联
        if (rowId != null) db.prepare(`UPDATE site_errors SET suggestion_id=? WHERE id=?`).run(ins.lastInsertRowid, rowId);
      }
    } catch (e3) { console.error('[monitor] 生成错误待办失败:', e3.message); }
  }
  return rowId;
}

/** 供 web 框架在全局 catch 中调用。retryDispatch 为可选的重试函数（重试一次路由分发）。 */
async function handleWebError(e, req, res, retryDispatch) {
  const cl = classify(e);
  // 安全自恢复：瞬态错误，复位缓存后重试一次
  if (cl.autoAction === 'retry_once' && typeof retryDispatch === 'function' && res && !res.writableEnded) {
    try {
      cacheReset();
      await retryDispatch();
      if (res.writableEnded) {
        logError({ err: e, req, autoAction: 'retry_once', autoResult: 'recovered', status: 'recovered' });
        return; // 已自恢复
      }
    } catch (e2) {
      // 重试仍失败：按真实错误记录
      return failWith(e2, req, res, 'retry_once', 'failed');
    }
  }
  // 客户端错误（body_parse）：优雅返回 400，不计入服务端故障
  if (cl.autoAction === 'skip') {
    if (res && !res.writableEnded) res.status(400).json({ error: '请求解析失败' });
    logError({ err: e, req, autoAction: 'skip', autoResult: 'skipped', status: 'resolved' });
    return;
  }
  // 其余：记录并标记/上报，返回 500
  failWith(e, req, res, cl.autoAction, null);
}

function failWith(e, req, res, autoAction, autoResult) {
  logError({ err: e, req, autoAction, autoResult });
  if (res && !res.writableEnded) {
    try { res.status(500).json({ error: '服务器内部错误' }); } catch { /* ignore */ }
  }
}

/** 进程级兜底：捕获未处理异常/拒绝，记录为 critical 并标记（不主动退出，由 systemd 保活） */
function initProcessHandlers() {
  process.on('uncaughtException', (e) => {
    logError({ err: e, ctx: { phase: 'uncaughtException' }, autoAction: 'flag', autoResult: 'captured', status: 'flagged' });
  });
  process.on('unhandledRejection', (reason) => {
    const e = reason instanceof Error ? reason : new Error('UnhandledRejection: ' + trim(String(reason), 200));
    logError({ err: e, ctx: { phase: 'unhandledRejection' }, autoAction: 'flag', autoResult: 'captured', status: 'flagged' });
  });
}

module.exports = { classify, logError, handleWebError, initProcessHandlers, setCacheReset, clientIp };
