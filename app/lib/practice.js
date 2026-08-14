/* 校招练习服务：题库 / 题目 / 判分 / 错题集 / 进度 / 后台CRUD
 * 客观题（单选/多选/判断）：后端直接比对标准答案判分，返回解析（零成本）。
 * 主观题（简答/行为/编程）：调用混元 LLM 评分+指导；密钥缺失时降级为自评。
 */
const db = require('../db');
const config = require('../config');
const llm = require('./llm');

const OBJ_TYPES = new Set(['单选', '多选', '判断']);
const SUB_TYPES = new Set(['简答', '行为', '编程']);

// ---------- 题库 ----------
function listBanks({ kind, company_type, position } = {}) {
  const where = ["status='active'"];
  const params = [];
  if (kind) { where.push('kind=?'); params.push(kind); }
  if (company_type) { where.push('company_type=?'); params.push(company_type); }
  if (position) { where.push('position=?'); params.push(position); }
  const sql = `SELECT b.*,
    (SELECT COUNT(*) FROM practice_questions q WHERE q.bank_id=b.id) AS q_count
    FROM practice_banks b WHERE ${where.join(' AND ')} ORDER BY b.id DESC`;
  return db.prepare(sql).all(...params);
}

function getBankMeta(bankId) {
  return db.prepare('SELECT * FROM practice_banks WHERE id=?').get(bankId);
}

/** 取题库题目（不含答案/解析，作答后由 attempt 接口返回） */
function getBankQuestions(bankId) {
  const rows = db.prepare(`SELECT id, q_type, stem, options, order_no
    FROM practice_questions WHERE bank_id=? ORDER BY order_no, id`).all(bankId);
  return rows.map(r => ({ ...r, options: safeJson(r.options) }));
}

// ---------- 判分 ----------
function gradeObjective(q, userAnswer) {
  // userAnswer: 单选/判断 -> 选项索引字符串；多选 -> JSON 数组字符串
  const correct = String(q.answer || '').trim();
  let score, ok;
  if (q.q_type === '多选') {
    let sel = [];
    try { sel = JSON.parse(userAnswer || '[]'); } catch { sel = []; }
    if (typeof sel === 'string') sel = [sel];
    const correctArr = (() => { try { return JSON.parse(correct); } catch { return []; } })();
    const selSet = new Set(sel.map(String));
    const corrSet = new Set(correctArr.map(String));
    const hit = [...selSet].filter(x => corrSet.has(x)).length;
    const wrong = [...selSet].filter(x => !corrSet.has(x)).length;
    const raw = corrSet.size ? (hit - wrong) / corrSet.size * 100 : 0;
    score = Math.max(0, Math.min(100, Math.round(raw)));
    ok = (wrong === 0 && hit === corrSet.size);
  } else {
    ok = (correct === String(userAnswer).trim());
    score = ok ? 100 : 0;
  }
  const feedback = ok ? '回答正确！' : `回答有误。正确答案：${formatAnswer(q)}`;
  return { score, feedback, correct_answer: formatAnswer(q), explanation: q.explanation || '' };
}

function formatAnswer(q) {
  if (q.q_type === '多选') {
    let arr = [];
    try { arr = JSON.parse(q.answer || '[]'); } catch {}
    const opts = safeJson(q.options) || [];
    return arr.map(i => `${letter(i)}. ${opts[i] || ''}`).join('；');
  }
  const opts = safeJson(q.options) || [];
  return `${letter(q.answer)}. ${opts[Number(q.answer)] || ''}`;
}

function letter(i) { return String.fromCharCode(65 + Number(i)); }

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** 对单题判分并落库（客观题本地即时判分；主观题调 LLM 评分）。返回该次作答结果。 */
async function gradeAndPersist(q, userId, bankId, answer, position) {
  let score, feedback, explanation = q.explanation || '';
  let revealed = null;

  if (OBJ_TYPES.has(q.q_type)) {
    const g = gradeObjective(q, answer);
    score = g.score; feedback = g.feedback; explanation = g.explanation; revealed = g.correct_answer;
  } else if (SUB_TYPES.has(q.q_type)) {
    const r = await llm.gradeSubjective({
      stem: q.stem, qType: q.q_type, answerRef: q.answer, rubric: q.rubric, userAnswer: answer
    });
    if (r) {
      score = r.score; feedback = r.feedback || '';
    } else {
      // 降级：未启用 AI 评分，按自评处理，不计错题
      score = null;
      feedback = `暂未启用 AI 评分，请对照以下要点自行评估：\n评分要点：${q.rubric || '（无）'}\n参考答案/要点：${q.answer || '（无）'}`;
    }
  } else {
    throw new Error('未知题型：' + q.q_type);
  }

  const isWrong = (score !== null && score < config.WRONG_SCORE_THRESHOLD) ? 1 : 0;
  const info = db.prepare(`INSERT INTO user_practice_attempts
    (user_id, anon_id, question_id, bank_id, answer, score, max_score, feedback, is_wrong, position)
    VALUES (?,?,?,?,?,?,100,?,?,?)`).run(
    userId || null, null, q.id, bankId, String(answer ?? ''), score, feedback, isWrong,
    position || q.position || null
  );
  return {
    attemptId: info.lastInsertRowid,
    question_id: q.id,
    q_type: q.q_type,
    exam_stage: q.exam_stage || '笔试',
    stem: q.stem,
    options: safeJson(q.options),
    score, feedback, explanation,
    is_wrong: isWrong,
    answer: revealed,                              // 客观题揭示的正确答案
    reference: SUB_TYPES.has(q.q_type) ? (q.answer || '') : null  // 主观题参考答案/要点
  };
}

/** 提交一次作答并判分（兼容单题接口，如测试脚本）。 */
async function submitAttempt({ userId, questionId, bankId, answer }) {
  const q = db.prepare('SELECT * FROM practice_questions WHERE id=? AND bank_id=?').get(questionId, bankId);
  if (!q) throw new Error('题目不存在');
  return gradeAndPersist(q, userId, bankId, answer);
}

/** 整卷统一提交并判分：收集所有作答，逐题判分（主观题并行调 LLM），一次性返回结果数组。
 *  入参 { userId, bankId, answers:[{question_id, answer}] }；返回 { results:[{question_id, q_type, score, is_wrong, feedback, explanation, answer, reference}] } */
async function submitAttemptBatch({ userId, bankId, answers }) {
  const bank = getBankMeta(bankId);
  if (!bank) throw new Error('题库不存在');
  if (!Array.isArray(answers) || !answers.length) throw new Error('未提交任何作答');
  const results = await Promise.all(answers.map(async (a) => {
    const q = db.prepare('SELECT * FROM practice_questions WHERE id=? AND bank_id=?').get(a.question_id, bankId);
    if (!q) return { question_id: a.question_id, q_type: null, score: null, is_wrong: 0, error: '题目不存在' };
    return gradeAndPersist(q, userId, bankId, a.answer);
  }));
  return { results };
}

// ================= 岗位维度（改版主线） =================

/** 练习入口：Top-N 岗位卡片（含题量与在招数） */
function listPositions() {
  return db.prepare(`SELECT p.id, p.name, p.job_count, p.intro, p.sort_no,
      (SELECT COUNT(*) FROM practice_questions q WHERE q.position=p.name) AS q_count,
      (SELECT COUNT(*) FROM practice_questions q WHERE q.position=p.name AND q.exam_stage='笔试') AS written_count,
      (SELECT COUNT(*) FROM practice_questions q WHERE q.position=p.name AND q.exam_stage='面试') AS interview_count
    FROM practice_positions p
    WHERE p.status='active'
    ORDER BY p.sort_no, p.id`).all();
}

function getPosition(name) {
  return db.prepare("SELECT * FROM practice_positions WHERE name=? AND status='active'").get(name);
}

/** 洗牌 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 随机组卷：在该岗位题库中按 80% 笔试 / 20% 面试 抽题，默认 10 题。
 * 某一侧题量不足时，用另一侧回填，保证总题数尽量达标。
 * 特殊入口「综合测评」：独立大厂网测题库，全部为测评选择题（单选/多选），每卷 10 题。
 */
function buildPaper(positionName, { size = config.PAPER_SIZE || 10, writtenRatio = 0.8 } = {}) {
  if (positionName === '综合测评') {
    const total = db.prepare("SELECT COUNT(*) c FROM practice_questions WHERE position='综合测评'").get().c;
    if (!total) throw new Error('综合测评题库暂未就绪');
    const picked = db.prepare(
      `SELECT id, bank_id, q_type, stem, options, order_no, exam_stage, position
       FROM practice_questions WHERE position='综合测评' ORDER BY RANDOM() LIMIT ?`
    ).all(size);
    const questions = picked.map((q, i) => ({ ...q, options: safeJson(q.options), order_no: i + 1 }));
    return {
      position: '综合测评',
      intro: '大厂网测综合测评：言语理解 / 逻辑推理 / 数量关系 / 资料分析 / 图形推理 / 常识判断',
      job_count: 0,
      size: questions.length,
      written: 0,
      interview: questions.length,
      assessment: questions.length,
      questions
    };
  }
  const pos = getPosition(positionName);
  if (!pos) throw new Error('岗位不存在或已下线：' + positionName);

  const wantWritten = Math.round(size * writtenRatio);
  const wantInterview = size - wantWritten;

  const pick = (stage, n) => n <= 0 ? [] : db.prepare(
    `SELECT id, bank_id, q_type, stem, options, order_no, exam_stage, position
     FROM practice_questions WHERE position=? AND exam_stage=? ORDER BY RANDOM() LIMIT ?`
  ).all(positionName, stage, n);

  let written = pick('笔试', wantWritten);
  let interview = pick('面试', wantInterview);

  // 回填：任一侧不足时，从另一侧多抽（排除已选）
  const shortfall = size - written.length - interview.length;
  if (shortfall > 0) {
    const chosen = new Set([...written, ...interview].map(q => q.id));
    const extra = db.prepare(
      `SELECT id, bank_id, q_type, stem, options, order_no, exam_stage, position
       FROM practice_questions WHERE position=? ORDER BY RANDOM() LIMIT ?`
    ).all(positionName, shortfall + chosen.size).filter(q => !chosen.has(q.id)).slice(0, shortfall);
    written = written.concat(extra.filter(q => q.exam_stage === '笔试'));
    interview = interview.concat(extra.filter(q => q.exam_stage !== '笔试'));
  }

  // 笔试在前、面试在后，各自内部打乱（贴近真实流程）
  const questions = [...shuffle(written), ...shuffle(interview)]
    .map((q, i) => ({ ...q, options: safeJson(q.options), order_no: i + 1 }));

  return {
    position: pos.name,
    intro: pos.intro,
    job_count: pos.job_count,
    size: questions.length,
    written: questions.filter(q => q.exam_stage === '笔试').length,
    interview: questions.filter(q => q.exam_stage !== '笔试').length,
    questions
  };
}

/** 整卷提交（岗位维度）：answers=[{question_id, answer}]，一次性判分返回全卷结果 */
async function submitPaper({ userId, position, answers }) {
  if (!Array.isArray(answers) || !answers.length) throw new Error('未提交任何作答');
  const results = await Promise.all(answers.map(async (a) => {
    const q = db.prepare('SELECT * FROM practice_questions WHERE id=?').get(a.question_id);
    if (!q) return { question_id: a.question_id, q_type: null, score: null, is_wrong: 0, error: '题目不存在' };
    return gradeAndPersist(q, userId, q.bank_id, a.answer, position || q.position);
  }));

  const scored = results.filter(r => typeof r.score === 'number');
  const summary = {
    total: results.length,
    graded: scored.length,
    correct: results.filter(r => typeof r.score === 'number' && r.score >= config.WRONG_SCORE_THRESHOLD).length,
    wrong: results.filter(r => r.is_wrong).length,
    avg_score: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null
  };
  return { position, summary, results };
}

/** 岗位维度进度 */
function getPositionProgress(userId, positionName) {
  const total = db.prepare('SELECT COUNT(*) c FROM practice_questions WHERE position=?').get(positionName).c;
  const att = db.prepare(`SELECT COUNT(DISTINCT question_id) done,
      SUM(CASE WHEN is_wrong=1 THEN 1 ELSE 0 END) wrong,
      AVG(CASE WHEN score IS NOT NULL THEN score END) avg_score
    FROM user_practice_attempts WHERE user_id=? AND position=?`).get(userId, positionName);
  return {
    position: positionName,
    total,
    done: att.done || 0,
    wrong: att.wrong || 0,
    avg_score: att.avg_score != null ? Math.round(att.avg_score) : null,
    mastery: total ? Math.round((att.done || 0) / total * 100) : 0
  };
}

// ---------- 错题集 ----------
function getWrongSet(userId, bankId, position) {
  const where = ['a.user_id=?', 'a.is_wrong=1'];
  const params = [userId];
  if (bankId) { where.push('a.bank_id=?'); params.push(bankId); }
  if (position) { where.push('COALESCE(a.position, q.position)=?'); params.push(position); }
  return db.prepare(`SELECT a.id AS attempt_id, a.question_id, a.bank_id, a.answer AS my_answer,
    a.score, a.feedback, a.created_at, q.q_type, q.stem, q.options, q.answer AS correct_answer,
    q.rubric, q.explanation, q.exam_stage,
    COALESCE(a.position, q.position) AS position, b.title AS bank_title
    FROM user_practice_attempts a
    JOIN practice_questions q ON q.id=a.question_id
    LEFT JOIN practice_banks b ON b.id=a.bank_id
    WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC`).all(...params)
    .map(r => ({ ...r, options: safeJson(r.options) })); // options 统一解析为数组（再练本题用）
}

/** 标记某次作答已掌握（移出错题集） */
function resolveWrong(attemptId, userId) {
  db.prepare('UPDATE user_practice_attempts SET is_wrong=0 WHERE id=? AND user_id=?').run(attemptId, userId);
}

// ---------- 进度 ----------
function getProgress(userId, bankId) {
  const bank = getBankMeta(bankId);
  if (!bank) throw new Error('题库不存在');
  const total = db.prepare('SELECT COUNT(*) c FROM practice_questions WHERE bank_id=?').get(bankId).c;
  const att = db.prepare(`SELECT COUNT(DISTINCT question_id) done,
    SUM(CASE WHEN is_wrong=1 THEN 1 ELSE 0 END) wrong,
    AVG(CASE WHEN score IS NOT NULL THEN score END) avg_score
    FROM user_practice_attempts WHERE user_id=? AND bank_id=?`).get(userId, bankId);
  return {
    bank_id: bankId,
    bank_title: bank.title,
    total,
    done: att.done || 0,
    wrong: att.wrong || 0,
    avg_score: att.avg_score != null ? Math.round(att.avg_score) : null,
    mastery: total ? Math.round((att.done || 0) / total * 100) : 0
  };
}

// ---------- 后台 CRUD ----------
function createBank({ kind, company, company_type, position, industry, title, description, difficulty, source_material_id }) {
  const info = db.prepare(`INSERT INTO practice_banks
    (kind, company, company_type, position, industry, title, description, difficulty, source_material_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    kind, company || null, company_type || null, position || null, industry || null,
    title, description || null, difficulty || null, source_material_id || null
  );
  return info.lastInsertRowid;
}

function addQuestion({ bank_id, q_type, stem, options, answer, rubric, explanation, order_no }) {
  const info = db.prepare(`INSERT INTO practice_questions
    (bank_id, q_type, stem, options, answer, rubric, explanation, order_no)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    bank_id, q_type, stem, options || null, answer || null, rubric || null, explanation || null,
    order_no || 0
  );
  return info.lastInsertRowid;
}

// 按岗位解析/创建题库（标题 = `${position}·岗位练习题库`）
// 特殊：综合测评 → kind='测评'、title='综合测评·大厂评测题库'
function getOrCreateBank(position, intro) {
  if (position === '综合测评') {
    const row = db.prepare("SELECT id FROM practice_banks WHERE title='综合测评·大厂评测题库'").get();
    if (row) return row.id;
    const info = db.prepare(`INSERT INTO practice_banks (kind, position, title, description, status)
      VALUES ('测评', ?, '综合测评·大厂评测题库', ?, 'active')`)
      .run(position, intro || '综合测评题库：言语理解/逻辑推理/数量关系/资料分析/图形推理/情景判断，对标大厂网测');
    return info.lastInsertRowid;
  }
  const row = db.prepare('SELECT id FROM practice_banks WHERE title=?').get(`${position}·岗位练习题库`);
  if (row) return row.id;
  const info = db.prepare(`INSERT INTO practice_banks (kind, position, title, description, status)
    VALUES ('综合', ?, ?, ?, 'active')`)
    .run(position, `${position}·岗位练习题库`, intro || `${position}岗位练习题库`);
  return info.lastInsertRowid;
}

/**
 * 批量导入岗位练习数据（本地 → 线上 幂等同步）
 *  - positions: [{name, job_count, intro, sort_no}]，按 name UPSERT，只增不删用户数据
 *  - questions: [{position, exam_stage, q_type, stem, options, answer, rubric, explanation, order_no}]
 *    按 (position, 规范化题干) 去重，题库由 position 自动解析
 */
function importPractice({ positions = [], questions = [] } = {}) {
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, '');
  const getBank = db.prepare('SELECT id FROM practice_banks WHERE title=?');
  const upPos = db.prepare(`INSERT INTO practice_positions (name, job_count, intro, sort_no, status, updated_at)
    VALUES (?,?,?,?,'active',datetime('now','localtime'))
    ON CONFLICT(name) DO UPDATE SET
      job_count=excluded.job_count,
      intro=COALESCE(excluded.intro, practice_positions.intro),
      sort_no=excluded.sort_no,
      status='active',
      updated_at=excluded.updated_at`);
  const chk = db.prepare('SELECT 1 FROM practice_questions WHERE position=? AND REPLACE(stem,\' \',\'\')=?');
  const insQ = db.prepare(`INSERT INTO practice_questions
    (bank_id, q_type, stem, options, answer, rubric, explanation, order_no, position, exam_stage, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,'llm')`);
  const maxNo = db.prepare('SELECT COALESCE(MAX(order_no),0) m FROM practice_questions WHERE bank_id=?');

  let posUps = 0, qIns = 0, qSkip = 0;
  const tx = db.transaction(() => {
    for (const p of positions) {
      upPos.run(p.name, Number(p.job_count) || 0, p.intro || null, Number(p.sort_no) || 0);
      posUps++;
    }
    for (const q of questions) {
      if (!q || !q.position || !q.stem) { qSkip++; continue; }
      const bankId = getOrCreateBank(q.position, null);
      if (chk.get(q.position, norm(q.stem))) { qSkip++; continue; }
      const orderNo = maxNo.get(bankId).m + 1;
      insQ.run(bankId, q.q_type, q.stem, q.options ?? null, q.answer ?? null,
        q.rubric ?? null, q.explanation ?? '', orderNo, q.position, q.exam_stage || '笔试');
      qIns++;
    }
  });
  tx();
  return { positions_upserted: posUps, questions_inserted: qIns, questions_skipped: qSkip };
}

module.exports = {
  OBJ_TYPES, SUB_TYPES,
  // 岗位维度（改版主线）
  listPositions, getPosition, buildPaper, submitPaper, getPositionProgress,
  // 题库维度（保留兼容）
  listBanks, getBankMeta, getBankQuestions,
  submitAttempt, submitAttemptBatch, getWrongSet, resolveWrong, getProgress,
  createBank, addQuestion, getOrCreateBank, importPractice
};
