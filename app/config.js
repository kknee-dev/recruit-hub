// 极简 .env 加载（零依赖，仅当文件存在时；.env 文件优先于已存在的 process.env）
// 说明：强制覆盖，避免外部 shell 环境里混入的残缺/错误同名变量（如 DEEPSEEK_SECRET_KEY）
//       导致签名失败；部署侧 .env 由 systemd EnvironmentFile 注入，取值一致。
try {
  const fs = require('node:fs');
  const ep = require('node:path').join(__dirname, '..', '.env');
  if (fs.existsSync(ep)) {
    for (const line of fs.readFileSync(ep, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (e) { /* .env 不存在或解析失败则忽略 */ }

// 安全加固（2026-08-06）：不再提供公开可预测的默认 JWT_SECRET / ADMIN_KEY。
// - JWT_SECRET 未配置时每次启动随机生成（绝不用固定公开值；线上 .env 已配置，重启不失效）。
// - ADMIN_KEY 未配置时为空串 → requireAdmin 一律 403，管理接口显式不可用。
const crypto = require('node:crypto');

module.exports = {
  PORT: process.env.PORT || 3600,
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  TRIAL_DAYS: 15,
  VIP_PRICE: 99,
  VIP_DAYS: 365,
  // 数据库放在系统盘用户目录（D盘项目目录为云同步盘，SQLite 文件锁不兼容）
  DB_PATH: process.env.XZB_DB || require('path').join(require('os').homedir(), '.xiaozhaobao', 'xzb.db'),
  // SMTP 邮件配置（注册验证码 / 订阅邮件）。未配置时验证码走演示模式（接口直接返回验证码）
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: process.env.SMTP_PORT || 465,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  MAIL_FROM: process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@xiaozhaobao.com',
  // 腾讯云邮件推送（SES）API 发信配置：个人认证不支持 SMTP，改用 API（模板）发信
  // 使用模板发送：先创建通用模板（setup_ses_template.js）拿到 TemplateID 填入下面
  SES_SECRET_ID: process.env.SES_SECRET_ID || '',
  SES_SECRET_KEY: process.env.SES_SECRET_KEY || '',
  SES_REGION: process.env.SES_REGION || 'ap-guangzhou',   // 广州区；香港区填 ap-hongkong
  SES_FROM: process.env.SES_FROM || 'noreply@mail.xiaozhaobao.com.cn',  // 已验证的发信地址
  SES_TEMPLATE_ID: process.env.SES_TEMPLATE_ID ? Number(process.env.SES_TEMPLATE_ID) : 0,
  SES_DIGEST_TEMPLATE_ID: process.env.SES_DIGEST_TEMPLATE_ID ? Number(process.env.SES_DIGEST_TEMPLATE_ID) : 0, // 订阅通知模板 ID
  SITE_URL: process.env.SITE_URL || 'http://localhost:3600',
  CODE_TTL_MIN: 10,          // 验证码有效期（分钟）
  CODE_RESEND_SEC: 60,       // 重发间隔（秒）
  // 腾讯混元大模型（主观题自动评分与个性化指导），走腾讯云 TokenHub OpenAI 兼容端点。
  // DeepSeek 官方大模型（岗位说明书/主观题评分等 AI 功能），OpenAI 兼容端点。
  // 鉴权：Bearer Token（DeepSeek 开放平台 API Key，形如 sk-...）。
  // 获取方式：https://platform.deepseek.com 创建 API Key；缺失时主观题降级为「对照要点自评 + 展示参考答案」。
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_ENDPOINT: process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  // 练习：得分低于该阈值(0~100)标记进入错题集
  WRONG_SCORE_THRESHOLD: process.env.WRONG_SCORE_THRESHOLD ? Number(process.env.WRONG_SCORE_THRESHOLD) : 60,
  // 每份练习卷题数（按 80% 笔试 + 20% 面试 随机组卷）
  PAPER_SIZE: process.env.PAPER_SIZE ? Number(process.env.PAPER_SIZE) : 10,
  // 主观题LLM评分缓存时长（秒），相同(题+作答)命中缓存不重复计费
  LLM_CACHE_SEC: 3600
};
