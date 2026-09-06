/**
 * lib/ai-stub.js
 *
 * ⚠️ 本文件里的函数全部是P0演示用的占位实现，不是产品最终方案。
 * 每个函数对应《技术实施蓝图》§19 / 《Development Baseline》§8
 * 定义的五个AI角色之一。接入真实模型时，只需要替换这个文件里的
 * 函数实现，不需要改动 server.js 里的状态机和事务逻辑——
 * 这正是"不要用一个超级Prompt/超级函数承担所有职责"这条原则
 * 在代码层面的体现。
 */

const KEYWORD_ABUSE = ['傻逼', '滚', '垃圾平台', '骗子']; // 演示用极简关键词表，真实应接安全模型

/**
 * 角色1: Answer —— 真实实现应调用主力LLM，输入当前Question+parent链+Map摘要
 * 这里返回一个可辨识的占位回答，方便你在演示里一眼看出这是stub。
 */
function generateAnswerStub(questionContent, context = {}) {
  return `[AI占位回答] 针对"${questionContent}"，当前可给出的初步回应是：这是一个值得继续探索的问题。` +
    (context.parentContent ? ` （追问自："${context.parentContent.slice(0, 20)}..."）` : '') +
    ` 真实环境中此处应调用Answer Prompt生成实质内容。`;
}

/**
 * 角色2: Gate —— 真实实现应综合Map摘要+去重候选做语义判断
 * 这里用极简规则模拟分类逻辑，规则本身不是产品设计，只是让状态机可演示。
 */
function classifyStub(content, { isDuplicate, isAbuse }) {
  if (isAbuse) return { classification: 'ABUSE', reason: '命中占位关键词表' };
  if (isDuplicate) return { classification: 'DUPLICATE', reason: 'trigram相似度超过阈值' };
  if (content.trim().length < 2) return { classification: 'OFF_TOPIC', reason: '内容过短，占位规则判定为无效' };
  return { classification: 'VALID_NEW', reason: '未命中任何拒绝规则，占位规则判定为有效新问题' };
}

function isAbusive(content) {
  return KEYWORD_ABUSE.some((w) => content.includes(w));
}

/**
 * 角色3: Duplicate Judge —— 真实实现应基于pgvector embedding余弦相似度
 * 这里改用Postgres pg_trgm的similarity()函数做真实的（非模拟的）
 * 字符串相似度计算——这是一个能在没有外部AI服务时也真实工作的降级方案，
 * 不是伪造数据；只是相似度的"质量"不如语义embedding。
 */
async function findDuplicateCandidate(pool, explorationId, content, threshold = 0.35) {
  const { rows } = await pool.query(
    `SELECT id, content, similarity(content, $2) AS sim
     FROM nodes
     WHERE exploration_id = $1 AND node_type = 'QUESTION' AND status = 'ACTIVE'
     ORDER BY sim DESC
     LIMIT 1`,
    [explorationId, content]
  );
  if (rows.length && rows[0].sim >= threshold) {
    return { nodeId: rows[0].id, similarity: rows[0].sim, matchedContent: rows[0].content };
  }
  return null;
}

/**
 * 角色4: Map Updater —— 真实实现应按固定JSON Schema异步更新Understanding Map
 * P0演示阶段先不接，占位返回null，server.js里会跳过实际调用。
 */
function updateMapStub() {
  return null; // TODO: 接入真实Map Updater
}

/**
 * 角色5: Prediction —— 后台预测问题，绝不展示给用户
 * P0演示阶段先不接。
 */
function predictNextQuestionsStub() {
  return []; // TODO: 接入真实Prediction Prompt
}

module.exports = {
  generateAnswerStub,
  classifyStub,
  isAbusive,
  findDuplicateCandidate,
  updateMapStub,
  predictNextQuestionsStub,
};
