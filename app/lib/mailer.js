/* 邮件客户端：两种发信方式，按配置自动选择
 * 1) 腾讯云邮件推送(SES) API 发信（模板模式，零依赖 TC3-HMAC-SHA256 签名）
 *    —— 个人认证账号不支持 SMTP，用 API 发信；需先建模板拿 TemplateID。
 *    ⚠️ 重要：SES 模板的 TemplateData 变量值【不能是 HTML】且【总长 ≤ 800 字节】，
 *       所以只能传小变量（验证码 code、订阅条数 count 等），整封 HTML 不能当变量传。
 *       因此验证码/订阅邮件都用「固定版式模板 + 小变量」方式发送。
 * 2) 零依赖 SMTP（465 SMTPS / 587 STARTTLS，AUTH LOGIN）—— 兼容旧配置/本地测试。
 * 两者都未配置时 isConfigured() 返回 false，上层走演示模式（验证码直接返回）。
 */
const tls = require('node:tls');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const config = require('../config');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

/** 是否配置了可用的邮件发送方式 */
function isConfigured() {
  if (config.SES_SECRET_ID && config.SES_SECRET_KEY) return true; // API 模式（需模板 ID）
  if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS) return true; // SMTP 模式
  return false;
}

// ============================================================
// 腾讯云 API 3.0 调用（TC3-HMAC-SHA256 签名，零依赖）
// ============================================================
function callTencentApi({ secretId, secretKey, service, host, region, action, version, payload }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC 日期 YYYY-MM-DD
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedPayload = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')}`;
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  const secretDate = hmac('TC3' + secretKey, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const body = Buffer.from(payload, 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request(`https://${host}/`, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': version,
        'X-TC-Region': region
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Response && json.Response.Error) {
            return reject(new Error(`腾讯云API错误 [${json.Response.Error.Code}] ${json.Response.Error.Message}`));
          }
          resolve(json.Response || json);
        } catch (e) { reject(new Error('解析腾讯云响应失败: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// 模板创建（固定版式 + 小变量）
// ============================================================

/** 验证码模板：固定 HTML 版式，仅 {{code}} 一个变量
 *  ⚠️ 腾讯云 SES 模板变量语法为 {{变量名}}（无点号），且普通发送(SendEmail)模板只支持单一变量；
 *    有效期写死为 10 分钟，不传第二个变量。 */
async function createTemplate() {
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7ff;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)">
    <h2 style="color:#3b5bfd;margin:0 0 12px">🎯 校招宝</h2>
    <p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 8px">你正在注册校招宝账号，邮箱验证码为：</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#3b5bfd;padding:14px 0">${'{{code}}'}</div>
    <p style="color:#888;font-size:13px;margin:0">验证码 10 分钟内有效。如非本人操作请忽略本邮件。</p>
  </div></body></html>`;
  const text = `校招宝注册验证码：{{code}}（10 分钟内有效）`;
  const payload = JSON.stringify({
    TemplateName: 'xzb-code',
    TemplateContent: {
      Html: b64(html),
      Text: b64(text)
    }
  });
  return callTencentApi({
    secretId: config.SES_SECRET_ID, secretKey: config.SES_SECRET_KEY,
    service: 'ses', host: 'ses.tencentcloudapi.com', region: config.SES_REGION,
    action: 'CreateEmailTemplate', version: '2020-10-02', payload
  });
}

/** 订阅通知模板：固定版式，仅 {{count}} 一个变量
 *  ⚠️ 腾讯云 SES 模板变量语法 {{变量名}}（无点号），普通发送(SendEmail)模板只支持单一变量；
 *    日期放在邮件标题(Subject)中、链接域名+路径全部写死，均不进模板变量。
 *  审核注意（2026-08-06）：模板链接必须写死完整域名，内容不能过于简单。 */
async function createDigestTemplate() {
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7ff;padding:24px;font-family:-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)">
    <div style="border-bottom:2px solid #3b5bfd;padding-bottom:12px;margin-bottom:16px">
      <h2 style="margin:0;color:#3b5bfd;font-size:20px">📮 校招宝订阅情报</h2>
      <p style="margin:4px 0 0;color:#999;font-size:12px">应届生校招情报站 · 每日为你聚合符合条件的校招信息</p>
    </div>
    <p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 10px">你好，你关注的岗位今日有 <b style="color:#3b5bfd;font-size:18px">{{count}}</b> 条新匹配的校招信息。</p>
    <p style="color:#666;font-size:13px;line-height:1.7;margin:0 0 16px">点击下方按钮即可查看匹配详情（公司、岗位、城市、截止日期与投递入口）。每天 09:00 为你准时推送，不错过任何一个投递机会。</p>
    <p style="margin:0 0 16px"><a href="https://xiaozhaobao.com.cn/subs" style="display:inline-block;background:#3b5bfd;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">点击查看匹配详情 ›</a></p>
    <p style="color:#999;font-size:12px;line-height:1.7;margin:0 0 4px">管理订阅：<a href="https://xiaozhaobao.com.cn/subs" style="color:#3b5bfd">https://xiaozhaobao.com.cn/subs</a></p>
    <p style="color:#bbb;font-size:11px;line-height:1.6;margin:0;border-top:1px solid #eee;padding-top:12px">本邮件由校招宝自动发送，若不想继续接收，可前往订阅页关闭订阅。<br>校招宝 · 应届生校招情报站 · xiaozhaobao.com.cn</p>
  </div></body></html>`;
  const text = `校招宝订阅情报\n\n你关注的岗位今日有 {{count}} 条新匹配。\n点击查看匹配详情：https://xiaozhaobao.com.cn/subs\n\n管理订阅：https://xiaozhaobao.com.cn/subs\n本邮件由校招宝自动发送，可前往订阅页关闭。`;
  const payload = JSON.stringify({
    TemplateName: 'xzb-digest',
    TemplateContent: {
      Html: b64(html),
      Text: b64(text)
    }
  });
  return callTencentApi({
    secretId: config.SES_SECRET_ID, secretKey: config.SES_SECRET_KEY,
    service: 'ses', host: 'ses.tencentcloudapi.com', region: config.SES_REGION,
    action: 'CreateEmailTemplate', version: '2020-10-02', payload
  });
}

// ============================================================
// 方式 A：腾讯云邮件推送 SES API（模板发送，TC3 签名，零依赖）
// ============================================================

/** 发送注册验证码（使用验证码模板 xzb-code，模板仅 {{code}} 单变量） */
async function sendCode({ to, code, expireMin }) {
  if (!config.SES_TEMPLATE_ID) throw new Error('未设置 SES_TEMPLATE_ID，请先运行 scripts/setup_ses_template.js 创建验证码模板');
  const payload = JSON.stringify({
    FromEmailAddress: config.SES_FROM,
    Destination: Array.isArray(to) ? to : [to],
    Subject: `【校招宝】注册验证码：${code}（${expireMin} 分钟内有效）`,
    Template: {
      TemplateID: Number(config.SES_TEMPLATE_ID),
      TemplateData: JSON.stringify({ code })
    },
    TriggerType: 1,   // 1=触发类（即时投递，如验证码）
    Unsubscribe: '0'  // 0=不添加退订链接（事务邮件）
  });
  return callTencentApi({
    secretId: config.SES_SECRET_ID, secretKey: config.SES_SECRET_KEY,
    service: 'ses', host: 'ses.tencentcloudapi.com', region: config.SES_REGION,
    action: 'SendEmail', version: '2020-10-02', payload
  });
}

/** 发送每日订阅通知（使用订阅模板 xzb-digest，模板仅 {{count}} 单变量；
 *  日期放标题、链接写死进模板，符合腾讯云普通发送单变量要求） */
async function sendDigest({ to, subject, count }) {
  if (!config.SES_DIGEST_TEMPLATE_ID) throw new Error('未设置 SES_DIGEST_TEMPLATE_ID，请先运行 scripts/setup_ses_template.js 创建订阅模板');
  const payload = JSON.stringify({
    FromEmailAddress: config.SES_FROM,
    Destination: Array.isArray(to) ? to : [to],
    Subject: subject,
    Template: {
      TemplateID: Number(config.SES_DIGEST_TEMPLATE_ID),
      TemplateData: JSON.stringify({ count: String(count) })
    },
    TriggerType: 0,   // 0=非触发类（订阅/营销类）
    Unsubscribe: '1'  // 1=简体中文退订链接（订阅邮件建议加，避免被投诉垃圾邮件）
  });
  return callTencentApi({
    secretId: config.SES_SECRET_ID, secretKey: config.SES_SECRET_KEY,
    service: 'ses', host: 'ses.tencentcloudapi.com', region: config.SES_REGION,
    action: 'SendEmail', version: '2020-10-02', payload
  });
}

// ============================================================
// 方式 B：零依赖 SMTP（兼容旧配置 / 本地测试）
// ============================================================
function smtpSession(socket, timeoutMs = 15000) {
  let buffer = '';
  let pending = null;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && /^\d{3} /.test(last)) {
      const resp = buffer; buffer = '';
      if (pending) { const p = pending; pending = null; p.resolve(resp); }
    }
  });
  socket.on('error', e => { if (pending) { const p = pending; pending = null; p.reject(e); } });
  const waitResp = () => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    setTimeout(() => { if (pending) { pending = null; reject(new Error('SMTP 响应超时')); } }, timeoutMs);
  });
  const cmd = async (line, expect) => {
    const p = waitResp();
    if (line !== null) socket.write(line + '\r\n');
    const resp = await p;
    const code = parseInt(resp.slice(0, 3));
    if (expect && !expect.includes(code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'GREETING'} 失败: ${resp.trim().slice(0, 120)}`);
    return resp;
  };
  return { cmd, waitResp };
}

async function sendViaSmtp({ to, subject, html }) {
  const host = config.SMTP_HOST, port = Number(config.SMTP_PORT) || 465;
  const useTlsDirect = port === 465;
  let socket = useTlsDirect
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  await new Promise((res, rej) => {
    socket.once(useTlsDirect ? 'secureConnect' : 'connect', res);
    socket.once('error', rej);
    setTimeout(() => rej(new Error('SMTP 连接超时')), 10000);
  });
  let s = smtpSession(socket);
  await s.cmd(null, [220]);
  await s.cmd('EHLO xiaozhaobao.local', [250]);
  if (!useTlsDirect) {
    await s.cmd('STARTTLS', [220]);
    socket = tls.connect({ socket, servername: host });
    await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
    s = smtpSession(socket);
    await s.cmd('EHLO xiaozhaobao.com', [250]);
  }
  await s.cmd('AUTH LOGIN', [334]);
  await s.cmd(b64(config.SMTP_USER), [334]);
  await s.cmd(b64(config.SMTP_PASS), [235]);
  await s.cmd(`MAIL FROM:<${config.MAIL_FROM}>`, [250]);
  await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
  await s.cmd('DATA', [354]);
  const headers = [
    `From: =?UTF-8?B?${b64('校招宝')}?= <${config.MAIL_FROM}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '', ''
  ].join('\r\n');
  const body = b64(html).replace(/(.{76})/g, '$1\r\n');
  await s.cmd(headers + body + '\r\n.', [250]);
  await s.cmd('QUIT', [221]).catch(() => {});
  socket.end();
  return true;
}

// ============================================================
// 统一入口：按配置自动选择发信方式
//   code 场景 → 验证码模板；digest 场景 → 订阅通知模板；SMTP 兜底用 html
// ============================================================
async function sendMail({ to, subject, html, code, expireMin, digest, date, count, link, path }) {
  if (config.SES_SECRET_ID && config.SES_SECRET_KEY) {
    if (code !== undefined) return await sendCode({ to, code, expireMin });
    if (digest) return await sendDigest({ to, subject, count });
    throw new Error('SES API 模式下 sendMail 需要 code 或 digest 参数（模板不支持传完整 HTML，详见 mailer.js 顶部说明）');
  }
  if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS) {
    return await sendViaSmtp({ to, subject, html });
  }
  throw new Error('邮件服务未配置（需 SES 密钥+模板 或 SMTP）');
}

module.exports = { sendMail, sendCode, sendDigest, isConfigured, createTemplate, createDigestTemplate, callTencentApi };
