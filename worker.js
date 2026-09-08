/**
 * worker.js — P0原型的任务队列worker
 *
 * 落实 Development Baseline §12 对异步任务队列的冻结要求：
 *   - 任务领取必须用 FOR UPDATE SKIP LOCKED 或等价机制，防止多worker重复处理同一任务
 *   - 任务状态至少 PENDING/PROCESSING/DONE/FAILED/DEAD
 *   - 必须有最大重试次数、退避、最终失败记录
 *   - Map更新等任务必须幂等
 *
 * 可以同时启动多个worker进程（node worker.js worker-A / worker-B），
 * 用来验证不会有两个worker抢到同一条任务。
 */

const { pool, ensureSchema } = require('./lib/db');
const {
  isAbusive,
  findDuplicateCandidate,
  classify,
  generateAnswer,
} = require('./lib/ai');

const WORKER_ID = process.argv[2] || `worker-${process.pid}`;

function log(stage, detail) {
  console.log(`[${WORKER_ID}] [${stage}]${detail ? ' — ' + detail : ''}`);
}

// ------------------------------------------------------------
// 任务领取：短事务内 FOR UPDATE SKIP LOCKED，领到就立刻标记PROCESSING并提交，
// 不把长时间的AI处理过程留在同一个事务里持锁。
// ------------------------------------------------------------
async function claimNextTask() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM ai_runs
       WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const task = rows[0];
    await client.query(
      `UPDATE ai_runs SET status='PROCESSING', locked_by=$2, locked_at=now(), attempt_count=attempt_count+1
       WHERE id=$1`,
      [task.id, WORKER_ID]
    );
    await client.query('COMMIT');
    return task;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function markDone(taskId) {
  await pool.query(`UPDATE ai_runs SET status='DONE', completed_at=now() WHERE id=$1`, [taskId]);
}

async function markFailedOrDead(task, err) {
  const attempts = task.attempt_count + 1; // 已经在claim时+1过一次，这里是这次失败后的计数参考
  const dead = attempts >= task.max_attempts;
  const backoffSeconds = Math.min(60, 2 ** attempts); // 指数退避，封顶60秒
  await pool.query(
    `UPDATE ai_runs SET status=$2, last_error=$3, next_retry_at=$4 WHERE id=$1`,
    [task.id, dead ? 'DEAD' : 'PENDING', err.message, dead ? null : new Date(Date.now() + backoffSeconds * 1000)]
  );
  log(dead ? 'DEAD(超过最大重试)' : 'FAILED(将退避重试)', `task=${task.id} attempts=${attempts} error=${err.message}`);
}

async function enqueue(taskType, { pendingQuestionId, explorationId, sourceNodeId, idempotencyKey }) {
  // ON CONFLICT DO NOTHING：idempotency_key冲突时静默跳过，防止重复入队
  await pool.query(
    `INSERT INTO ai_runs (task_type, source_pending_question_id, exploration_id, source_node_id, model, prompt_version, status, idempotency_key)
     VALUES ($1, $2, $3, $4, 'stub-v1', 'v1', 'PENDING', $5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [taskType, pendingQuestionId || null, explorationId || null, sourceNodeId || null, idempotencyKey]
  );
}

// ------------------------------------------------------------
// 处理 GATE_CLASSIFY
// ------------------------------------------------------------
async function handleGateClassify(task) {
  const pq = (await pool.query('SELECT * FROM pending_questions WHERE id=$1', [task.source_pending_question_id])).rows[0];
  if (!pq) throw new Error('pending_question not found');

  await pool.query(`UPDATE pending_questions SET status='CLASSIFYING' WHERE id=$1`, [pq.id]);
  log('CLASSIFYING', `pending=${pq.id}`);

  const abusive = isAbusive(pq.content);
  const dup = abusive ? null : await findDuplicateCandidate(pool, pq.exploration_id, pq.content);
  const gate = await classify(pq.content, { isDuplicate: !!dup, isAbuse: abusive });

  if (gate.classification === 'DUPLICATE') {
    await pool.query(
      `UPDATE pending_questions SET status='DUPLICATE', duplicate_of_node_id=$2, updated_at=now() WHERE id=$1`,
      [pq.id, dup.nodeId]
    );
    log('DUPLICATE', `pending=${pq.id} → ${dup.nodeId} (相似度${dup.similarity.toFixed(2)})`);
    return; // 终态，不再入队后续任务
  }
  if (gate.classification === 'ABUSE') {
    await pool.query(`UPDATE pending_questions SET status='ABUSE', updated_at=now() WHERE id=$1`, [pq.id]);
    log('ABUSE', `pending=${pq.id}`);
    return;
  }
  if (gate.classification === 'OFF_TOPIC') {
    await pool.query(`UPDATE pending_questions SET status='OFF_TOPIC', redirect_hint=$2, updated_at=now() WHERE id=$1`,
      [pq.id, '内容过短或跑题，建议重新表述']);
    log('OFF_TOPIC', `pending=${pq.id}`);
    return;
  }

  await pool.query(`UPDATE pending_questions SET status='ANSWERING', classification=$2, updated_at=now() WHERE id=$1`,
    [pq.id, gate.classification]);
  log('ANSWERING(排队)', `pending=${pq.id} classification=${gate.classification}`);

  await enqueue('ANSWER', {
    pendingQuestionId: pq.id,
    explorationId: pq.exploration_id,
    idempotencyKey: `answer:${pq.id}`,
  });
}

// ------------------------------------------------------------
// 处理 ANSWER：生成回答 + 原子提交（约束#12）+ 判断Collaborated
// ------------------------------------------------------------
async function handleAnswer(task) {
  const pq = (await pool.query('SELECT * FROM pending_questions WHERE id=$1', [task.source_pending_question_id])).rows[0];
  if (!pq) throw new Error('pending_question not found');
  if (pq.status === 'COMPLETED') { log('跳过(幂等)', `pending=${pq.id} 已是COMPLETED`); return; }

  const exploration = (await pool.query('SELECT * FROM explorations WHERE id=$1', [pq.exploration_id])).rows[0];
  const answerText = await generateAnswer(pq.content, {});

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE pending_questions SET status='COMMITTING', updated_at=now() WHERE id=$1`, [pq.id]);

    const qNode = await client.query(
      `INSERT INTO nodes (exploration_id, parent_node_id, node_type, content, account_id, public_identity_mode, source_pending_question_id)
       VALUES ($1, $2, 'QUESTION', $3, $4, 'NAMED', $5) RETURNING id`,
      [pq.exploration_id, pq.parent_node_id, pq.content, pq.submitted_by, pq.id]
    );
    const aNode = await client.query(
      `INSERT INTO nodes (exploration_id, parent_node_id, node_type, content, account_id, public_identity_mode, source_pending_question_id)
       VALUES ($1, $2, 'ANSWER', $3, NULL, 'SYSTEM', $4) RETURNING id`,
      [pq.exploration_id, qNode.rows[0].id, answerText, pq.id]
    );
    await client.query(
      `INSERT INTO question_meta (node_id, classification, accepted_into_tree, is_new_branch)
       VALUES ($1, $2, true, true)`,
      [qNode.rows[0].id, pq.classification]
    );

    const isThirdParty = String(pq.submitted_by) !== String(exploration.initiator_id);
    let collaborated = false;
    if (isThirdParty && exploration.state === 'PUBLISHED') {
      await client.query(`UPDATE explorations SET state='COLLABORATED', collaborated_at=now() WHERE id=$1`, [pq.exploration_id]);
      collaborated = true;
    }

    await client.query(
      `INSERT INTO metric_events (exploration_id, node_id, event_type, payload_json)
       VALUES ($1, $2, 'NEW_BRANCH', $3)`,
      [pq.exploration_id, qNode.rows[0].id, JSON.stringify({ classification: pq.classification })]
    );

    await client.query(
      `UPDATE pending_questions SET status='COMPLETED', committed_question_node_id=$2, committed_answer_node_id=$3, updated_at=now()
       WHERE id=$1`,
      [pq.id, qNode.rows[0].id, aNode.rows[0].id]
    );

    await client.query('COMMIT');

    log('COMMITTED', `pending=${pq.id} → question=${qNode.rows[0].id}`);
    if (collaborated) log('COLLABORATED触发', `exploration=${pq.exploration_id}`);
    else if (!isThirdParty) log('未触发Collaborated', `submitted_by与initiator是同一account_id`);

    // 通知：对应PRD §16两类场景。放在事务外执行，通知失败不应该让追问本身失败。
    try {
      await notifyOnCommit({
        explorationId: pq.exploration_id,
        parentNodeId: pq.parent_node_id,
        submittedBy: pq.submitted_by,
        newQuestionNodeId: qNode.rows[0].id,
      });
    } catch (e) {
      log('通知发送失败(不影响追问结果)', e.message);
    }

    await enqueue('MAP_UPDATE', {
      explorationId: pq.exploration_id,
      sourceNodeId: qNode.rows[0].id,
      idempotencyKey: `map:${qNode.rows[0].id}`,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    await pool.query(`UPDATE pending_questions SET status='FAILED', last_error=$2, updated_at=now() WHERE id=$1`, [pq.id, e.message]);
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 通知逻辑：PRD §16定义的三类场景里，先实现前两个：
//   1. NAMED_NODE_FOLLOWUP —— 有人对你的署名节点继续追问
//   2. FOLLOWED_EXPLORATION_NEW_DIRECTION —— 你关注的探索出现新追问
// "当前认识发生重大修正"那一类需要真实语义判断，P0阶段先不做。
// ------------------------------------------------------------
async function notifyOnCommit({ explorationId, parentNodeId, submittedBy, newQuestionNodeId }) {
  if (parentNodeId) {
    const parent = await pool.query(
      `SELECT account_id, public_identity_mode FROM nodes WHERE id=$1`,
      [parentNodeId]
    );
    if (parent.rows.length) {
      const { account_id, public_identity_mode } = parent.rows[0];
      if (account_id && public_identity_mode === 'NAMED' && String(account_id) !== String(submittedBy)) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, target_id) VALUES ($1, 'NAMED_NODE_FOLLOWUP', $2)`,
          [account_id, newQuestionNodeId]
        );
      }
    }
  }

  const followers = await pool.query(
    `SELECT follower_id FROM follows WHERE target_type='EXPLORATION' AND target_id=$1 AND follower_id != $2`,
    [explorationId, submittedBy]
  );
  for (const row of followers.rows) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, target_id) VALUES ($1, 'FOLLOWED_EXPLORATION_NEW_DIRECTION', $2)`,
      [row.follower_id, explorationId]
    );
  }
}

// ------------------------------------------------------------
// 处理 MAP_UPDATE：版本号分配用行锁序列化，避免并发写出重复版本号
// ------------------------------------------------------------
async function handleMapUpdate(task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 用SELECT ... FOR UPDATE锁定exploration行，序列化同一探索的版本号分配
    await client.query('SELECT id FROM explorations WHERE id=$1 FOR UPDATE', [task.exploration_id]);

    const existing = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM understanding_maps WHERE exploration_id=$1',
      [task.exploration_id]
    );
    const nextVersion = existing.rows[0].max_version + 1;

    const nodes = await client.query(
      `SELECT content FROM nodes WHERE exploration_id=$1 AND node_type='QUESTION' AND status='ACTIVE' ORDER BY created_at`,
      [task.exploration_id]
    );

    // 占位摘要生成：真实实现应调用Map Updater Prompt，按固定JSON Schema输出
    const summary = {
      current_consensus: [`已收集到${nodes.rows.length}个有效问题，占位摘要待真实Map Updater替换`],
      major_branches: nodes.rows.map((n) => n.content.slice(0, 20)),
      disagreements: [],
      revised_conclusions: [],
      open_questions: [],
      recent_new_directions: [nodes.rows[nodes.rows.length - 1]?.content.slice(0, 30) || ''],
    };

    await client.query(
      `INSERT INTO understanding_maps (exploration_id, version, summary_json, source_tree_version, last_material_change_node_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [task.exploration_id, nextVersion, JSON.stringify(summary), nodes.rows.length, task.source_node_id]
    );

    await client.query('COMMIT');
    log('MAP更新', `exploration=${task.exploration_id} version=${nextVersion}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const HANDLERS = {
  GATE_CLASSIFY: handleGateClassify,
  ANSWER: handleAnswer,
  MAP_UPDATE: handleMapUpdate,
};

async function loop() {
  log('启动', `轮询间隔300ms`);
  while (true) {
    let task;
    try {
      task = await claimNextTask();
    } catch (e) {
      log('领取任务出错', e.message);
      await sleep(500);
      continue;
    }
    if (!task) {
      await sleep(300);
      continue;
    }
    log('领取任务', `id=${task.id} type=${task.task_type}`);
    try {
      const handler = HANDLERS[task.task_type];
      if (!handler) throw new Error(`未知task_type: ${task.task_type}`);
      await handler(task);
      await markDone(task.id);
    } catch (e) {
      await markFailedOrDead(task, e);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ------------------------------------------------------------
// 两种启动方式：
//   1. 独立进程运行（node worker.js worker-A）—— 适合付费套餐的Background Worker服务
//   2. 被server.js以模块方式引入，在同一个Web Service进程里跑循环 ——
//      这是Render免费套餐的方案，因为免费套餐不支持Background Worker服务类型。
// 两种方式跑的是同一份处理逻辑，唯一区别是"谁调用loop()"。
// ------------------------------------------------------------
if (require.main === module) {
  // 作为独立进程启动（node worker.js worker-A）
  ensureSchema()
    .then(() => loop())
    .catch((e) => {
      console.error('启动失败，数据库自动建表出错，worker不会启动:', e.message);
      process.exit(1);
    });
}

module.exports = { loop, ensureSchema };
