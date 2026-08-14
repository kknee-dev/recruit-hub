/* 腾讯混元大模型客户端（零依赖，走腾讯云 TokenHub OpenAI 兼容端点）
 * 用途：主观题（简答/行为/编程）自动评分 + 个性化指导。
 * 鉴权：Bearer Token（TokenHub 独立 API Key，形如 sk-...，非腾讯云 SecretId/Key）。
 * 端点：https://tokenhub.tencentmaas.com/v1/chat/completions
 * 健壮性：对 5xx/网关超时/网络抖动做指数退避重试（网关冷启动偶发 504）。
 * 未配置密钥时 gradeSubjective 返回 null，上层降级为「对照要点自评 + 展示参考答案」。
 */
const https = require('node:https');
const config = require('../config');

// WorkBuddy 2026-08-12：LLM_PROVIDER=deepseek 时走 DeepSeek（DEEPSEEK_*），默认混元（HUNYUAN_*）
const PROVIDER = (process.env.LLM_PROVIDER || 'hunyuan').toLowerCase();
const P = PROVIDER === 'deepseek' ? 'DEEPSEEK' : 'HUNYUAN';

const MAX_RETRY = 3;
const SOCKET_TIMEOUT_MS = 60000;

/** 是否可用（TokenHub 密钥与端点已配置） */
function isConfigured() {
  return !!(config[P + '_API_KEY'] && config[P + '_ENDPOINT']);
}

// 兼容两种消息格式：{role,content}（OpenAI）或 {Role,Content}（旧腾讯格式）
function normalizeMsg(m) {
  return { role: m.role || m.Role, content: m.content || m.Content };
}

function chatOnce(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(config[P + '_ENDPOINT']);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: SOCKET_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config[P + '_API_KEY'],
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('TokenHub HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        }
        try {
          const j = JSON.parse(data);
          const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(c ? String(c) : '');
        } catch (e) {
          reject(new Error('TokenHub 响应解析失败: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('TokenHub socket timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 调用 TokenHub ChatCompletions，返回文本内容；未配置密钥返回 null。对 5xx/网络抖动重试。 */
function chat(messages, { temperature = 0.7, maxTokens = 1500, attempt = 0 } = {}) {
  if (!isConfigured()) return Promise.resolve(null);
  const body = JSON.stringify({
    model: config[P + '_MODEL'],
    messages: (messages || []).map(normalizeMsg),
    temperature,
    max_tokens: maxTokens,
    stream: false
  });
  return chatOnce(body).catch(async (e) => {
    const retryable = /504|502|503|gateway|timeout|ECONNRESET|ETIMEDOUT|socket/i.test(e.message);
    if (!retryable || attempt >= MAX_RETRY - 1) throw e;
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    return chat(messages, { temperature, maxTokens, attempt: attempt + 1 });
  });
}

/** 主观题评分 + 指导。返回 {score:0~100, feedback} 或 null（需降级） */
async function gradeSubjective({ stem, qType, answerRef, rubric, userAnswer }) {
  const sys = `你是校招笔试/面试辅导老师。请基于题目、参考答案与评分要点，对学生作答评分(0-100整数)并给出中文改进建议。
只输出一个纯JSON对象，格式：{"score":<整数0-100>,"feedback":"<中文建议>"},不要包含任何额外说明、前缀或markdown代码块。`;
  const user = `题目类型: ${qType || '简答'}\n题目: ${stem || ''}\n参考答案/要点: ${answerRef || '（无）'}\n评分要点: ${rubric || '（无）'}\n学生作答: ${userAnswer || ''}\n请评分并给出改进建议。`;
  const text = await chat([
    { Role: 'system', Content: sys },
    { Role: 'user', Content: user }
  ], { temperature: 0.3, maxTokens: 800 });
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : text);
    const score = Math.max(0, Math.min(100, Math.round(Number(obj.score) || 0)));
    return { score, feedback: String(obj.feedback || '') };
  } catch {
    // 解析失败：把模型原文作为建议返回，分数记 0（由上层按阈值处理）
    return { score: 0, feedback: text.slice(0, 500) };
  }
}

module.exports = { chat, gradeSubjective, isConfigured };
