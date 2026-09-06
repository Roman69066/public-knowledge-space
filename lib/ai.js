/**
 * lib/ai.js — 真实AI角色的统一入口
 *
 * 这是 server.js / worker.js 应该导入的模块（而不是直接导入 ai-stub.js）。
 * 行为：
 *   - 设置了 ANTHROPIC_API_KEY 环境变量 → 调用真实Claude API
 *   - 没设置，或者调用失败/返回格式不对 → 自动降级到 ai-stub.js 里的占位逻辑，
 *     并打印一条清晰的日志说明发生了降级，不会静默失败也不会让整个请求500。
 *
 * 五个AI角色里，这里接入了真实模型的是 Answer / Gate / Duplicate Judge 三个
 * （Map Updater / Prediction 仍是占位，见worker.js里的TODO）。
 */

const { callClaude, hasApiKey } = require('./llm-client');
const stub = require('./ai-stub');

let warnedNoKey = false;
function warnOnce() {
  if (!warnedNoKey) {
    console.warn('[ai] 未设置ANTHROPIC_API_KEY，使用占位AI逻辑。' +
      '设置该环境变量后（export ANTHROPIC_API_KEY=sk-ant-...）会自动切换到真实Claude调用。');
    warnedNoKey = true;
  }
}

// ------------------------------------------------------------
// Answer角色
// ------------------------------------------------------------
async function generateAnswer(questionContent, context = {}) {
  if (!hasApiKey()) {
    warnOnce();
    return stub.generateAnswerStub(questionContent, context);
  }
  const system = '你是"公共新知识空间"里的Answer角色。只负责针对当前问题给出扎实、简洁、有实质内容的回答，' +
    '不要评论这个问题是否重复、是否应该被接受——那是Gate的职责，不是你的。用中文回答，控制在200字以内。';
  const userMsg = context.parentContent
    ? `这是一次追问，上一轮的问题/回答是：${context.parentContent}\n\n当前追问：${questionContent}`
    : `当前问题：${questionContent}`;
  try {
    const text = await callClaude({ system, messages: [{ role: 'user', content: userMsg }], maxTokens: 500 });
    return text.trim();
  } catch (e) {
    console.error('[ai] 真实Answer调用失败，回退到占位逻辑:', e.message);
    return stub.generateAnswerStub(questionContent, context);
  }
}

// ------------------------------------------------------------
// Gate角色：注意——ABUSE和DUPLICATE的判断在调用这个函数之前已经
// 由本地关键词检测(isAbusive)和trgm检索(findDuplicateCandidate)完成，
// 传进来的isDuplicate/isAbuse是那两步的结果，这里只需要处理
// VALID_NEW / OFF_TOPIC 这个还需要语义判断的分支，避免不必要的模型调用。
// ------------------------------------------------------------
async function classify(content, { isDuplicate, isAbuse }) {
  if (isAbuse) return { classification: 'ABUSE', reason: '命中本地关键词表，未调用模型' };
  if (isDuplicate) return { classification: 'DUPLICATE', reason: '去重检索阶段已确认' };

  if (!hasApiKey()) {
    warnOnce();
    return stub.classifyStub(content, { isDuplicate, isAbuse });
  }

  const system = `你是"公共新知识空间"里的Gate角色，只负责判断一个新提交的问题是否是有效的新知识贡献。
只输出严格的JSON，不要有任何多余文字、不要用markdown代码块包裹，格式必须是：
{"classification": "VALID_NEW", "reason": "一句话理由"} 或 {"classification": "OFF_TOPIC", "reason": "一句话理由"}
规则：反对当前结论、质疑前提、要求证据都属于高价值候选，绝不能仅因立场与共识不同就判定为OFF_TOPIC。
只有内容确实过短、空洞、不包含实际问题意图时才判OFF_TOPIC，其余情况一律VALID_NEW。`;
  try {
    const raw = await callClaude({ system, messages: [{ role: 'user', content }], maxTokens: 200 });
    const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
    if (!['VALID_NEW', 'OFF_TOPIC'].includes(parsed.classification)) {
      throw new Error('模型返回了非法分类值: ' + parsed.classification);
    }
    return parsed;
  } catch (e) {
    console.error('[ai] 真实Gate调用失败或解析失败，回退到占位逻辑:', e.message);
    return stub.classifyStub(content, { isDuplicate, isAbuse });
  }
}

// ------------------------------------------------------------
// Duplicate Judge角色：两段式去重，对应蓝图§20成本控制原则——
// 便宜的trgm检索先筛，只有"疑似但不确定"的中间地带才调用模型。
//   相似度 >= 0.6  → 直接判定重复，不调用模型（省成本，人工可事后抽查误判率）
//   0.15 <= 相似度 < 0.6 → 调用Duplicate Judge做语义确认
//   相似度 < 0.15  → 不构成候选
// ------------------------------------------------------------
const HIGH_CONFIDENCE_THRESHOLD = 0.6;
const CANDIDATE_THRESHOLD = 0.15;
const FALLBACK_THRESHOLD_NO_KEY = 0.35; // 没有key时退化为原来的单阈值行为

async function findDuplicateCandidate(pool, explorationId, content) {
  const candidate = await stub.findDuplicateCandidate(pool, explorationId, content, CANDIDATE_THRESHOLD);
  if (!candidate) return null;

  if (candidate.similarity >= HIGH_CONFIDENCE_THRESHOLD) {
    return { ...candidate, judged_by: 'trgm-high-confidence' };
  }

  if (!hasApiKey()) {
    warnOnce();
    return candidate.similarity >= FALLBACK_THRESHOLD_NO_KEY ? candidate : null;
  }

  const system = `你是"公共新知识空间"里的Duplicate Judge角色。给定一个新问题和一个已有的候选问题，
只判断它们是否在讨论同一件事（duplicate），还是不同的问题（unrelated）。
只输出严格JSON，不要markdown代码块：{"verdict": "duplicate", "reason": "..."} 或 {"verdict": "unrelated", "reason": "..."}`;
  const userMsg = `新问题：${content}\n已有候选问题：${candidate.matchedContent}`;
  try {
    const raw = await callClaude({ system, messages: [{ role: 'user', content: userMsg }], maxTokens: 150 });
    const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
    if (parsed.verdict === 'duplicate') {
      return { ...candidate, judged_by: 'claude-duplicate-judge', judge_reason: parsed.reason };
    }
    return null;
  } catch (e) {
    console.error('[ai] Duplicate Judge调用失败或解析失败，回退到trgm阈值判断:', e.message);
    return candidate.similarity >= FALLBACK_THRESHOLD_NO_KEY ? candidate : null;
  }
}

module.exports = {
  generateAnswer,
  classify,
  findDuplicateCandidate,
  isAbusive: stub.isAbusive, // 本地关键词检测，不涉及模型调用，直接复用
};
