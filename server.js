/**
 * server.js — 公共新知识空间 P0 原型后端
 *
 * 目标：真实跑通 Development Baseline v1.0 定义的核心机制，供本地演示：
 *   - Exploration三态状态机 (PRIVATE/PUBLISHED/COLLABORATED)
 *   - 身份独立维度 (NAMED/ANONYMOUS)
 *   - Pending Question 异步状态机 + 约束#12（Pending不是Node）
 *   - 第三方判断基于account_id（约束#11）
 *   - 有效第三方贡献事务性触发Collaborated
 *
 * 明确不在P0原型范围内（见README）：真实鉴权、真实LLM调用、
 * 真实异步任务队列（这里用同步处理模拟，日志会打印每个阶段）、
 * Understanding Map、Human Question Delta、治理后台、限流。
 */

const express = require('express');
const path = require('path');
const { pool, ensureSchema } = require('./lib/db');
const {
  generateAnswer,
} = require('./lib/ai');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireAuth,
  optionalAuth,
} = require('./lib/auth');

const app = express();
app.use(express.json());
// 同源托管前端静态文件，避免CORS问题：浏览器打开 http://localhost:4000/app/
app.use('/app', express.static(path.join(__dirname, 'frontend')));

const auth = requireAuth(pool);
const authOptional = optionalAuth(pool);

function log(stage, detail) {
  console.log(`  [状态] ${stage}${detail ? ' — ' + detail : ''}`);
}

// ------------------------------------------------------------
// 注册 / 登录 / 登出 —— 真实认证，取代此前"客户端自己声明account_id"的方式
// ------------------------------------------------------------
app.post('/auth/signup', async (req, res) => {
  const { email, password, display_name } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'email必填，password至少6位' });
  }
  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rows.length) return res.status(409).json({ error: '该邮箱已注册' });

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, display_name, email',
    [email, passwordHash, display_name || email.split('@')[0]]
  );
  const session = await createSession(pool, rows[0].id);
  log('SIGNUP', `user=${rows[0].id}`);
  res.status(201).json({ user: rows[0], token: session.token, expires_at: session.expiresAt });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT id, display_name, email, password_hash FROM users WHERE email=$1', [email]);
  if (!rows.length || !rows[0].password_hash) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  const ok = await verifyPassword(password, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: '邮箱或密码错误' });

  const session = await createSession(pool, rows[0].id);
  log('LOGIN', `user=${rows[0].id}`);
  res.json({
    user: { id: rows[0].id, display_name: rows[0].display_name, email: rows[0].email },
    token: session.token,
    expires_at: session.expiresAt,
  });
});

app.post('/auth/logout', auth, async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.match(/^Bearer (.+)$/)[1];
  await destroySession(pool, token);
  log('LOGOUT', `user=${req.user.id}`);
  res.json({ ok: true });
});

app.get('/me', auth, (req, res) => {
  res.json({ id: req.user.id, display_name: req.user.display_name });
});

// ------------------------------------------------------------
// 公共广场：列出所有PUBLISHED/COLLABORATED的探索，供发现。
// 访客(未登录)也能浏览——这是PRD核心循环"被他人发现"的关键一环，
// 之前P0版本完全没做，只有客户端本地记住"自己创建过的"，
// 导致不同账号之间互相发现不了任何内容。
// 匿名发起的探索不暴露initiator_display，只显示"匿名发起"。
// ------------------------------------------------------------
app.get('/explorations', authOptional, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       e.id, e.title, e.state, e.identity_mode, e.created_at, e.published_at, e.collaborated_at,
       CASE WHEN e.identity_mode = 'NAMED' THEN u.display_name ELSE NULL END AS initiator_display,
       (SELECT count(*) FROM nodes n WHERE n.exploration_id = e.id AND n.node_type = 'QUESTION' AND n.status = 'ACTIVE') AS question_count
     FROM explorations e
     JOIN users u ON u.id = e.initiator_id
     WHERE e.state IN ('PUBLISHED', 'COLLABORATED')
     ORDER BY e.created_at DESC
     LIMIT 50`
  );
  res.json(rows);
});

// ------------------------------------------------------------
// 创建私人探索：提交Q0 → 直接生成A0（首答不经过Gate，PRD流程A）
// initiator_id不再从请求体读取，强制来自已登录会话（req.user.id）
// ------------------------------------------------------------
app.post('/explorations', auth, async (req, res) => {
  const initiator_id = req.user.id; // ⚠️ 唯一合法来源：服务端会话，而非req.body
  const { question } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expRes = await client.query(
      `INSERT INTO explorations (initiator_id, state, identity_mode, title)
       VALUES ($1, 'PRIVATE', 'NAMED', $2) RETURNING id`,
      [initiator_id, question.slice(0, 50)]
    );
    const explorationId = expRes.rows[0].id;

    const qNode = await client.query(
      `INSERT INTO nodes (exploration_id, node_type, content, account_id, public_identity_mode)
       VALUES ($1, 'QUESTION', $2, $3, 'NAMED') RETURNING id`,
      [explorationId, question, initiator_id]
    );
    const answerText = await generateAnswer(question);
    const aNode = await client.query(
      `INSERT INTO nodes (exploration_id, parent_node_id, node_type, content, account_id, public_identity_mode)
       VALUES ($1, $2, 'ANSWER', $3, NULL, 'SYSTEM') RETURNING id`,
      [explorationId, qNode.rows[0].id, answerText]
    );
    await client.query(
      `UPDATE explorations SET root_question_id = $1 WHERE id = $2`,
      [qNode.rows[0].id, explorationId]
    );
    await client.query('COMMIT');

    log('CREATED', `exploration=${explorationId} state=PRIVATE initiator=${initiator_id}`);
    res.status(201).json({
      exploration_id: explorationId,
      state: 'PRIVATE',
      q0: { node_id: qNode.rows[0].id, content: question },
      a0: { node_id: aNode.rows[0].id, content: answerText },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// 署名/匿名公开 —— 仅发起者本人可操作
// ------------------------------------------------------------
app.post('/explorations/:id/publish', auth, async (req, res) => {
  const { id } = req.params;
  const { identity_mode } = req.body; // NAMED | ANONYMOUS

  const own = await pool.query('SELECT initiator_id, state FROM explorations WHERE id=$1', [id]);
  if (!own.rows.length) return res.status(404).json({ error: 'not found' });
  if (own.rows[0].initiator_id !== req.user.id) {
    return res.status(403).json({ error: '仅发起者可公开此探索' });
  }

  const { rows } = await pool.query(
    `UPDATE explorations SET state='PUBLISHED', identity_mode=$1, published_at=now()
     WHERE id=$2 AND state='PRIVATE' RETURNING id, state, identity_mode`,
    [identity_mode, id]
  );
  if (!rows.length) {
    return res.status(409).json({ error: '仅PRIVATE状态可公开' });
  }
  await pool.query(
    `UPDATE nodes SET public_identity_mode=$1
     WHERE id = (SELECT root_question_id FROM explorations WHERE id=$2)`,
    [identity_mode, id]
  );
  log('PUBLISHED', `exploration=${id} identity=${identity_mode} by=${req.user.id}`);
  res.json(rows[0]);
});

// ------------------------------------------------------------
// 撤回：仅发起者本人、仅PUBLISHED可撤回，COLLABORATED服务端强制拒绝
// ------------------------------------------------------------
app.post('/explorations/:id/retract', auth, async (req, res) => {
  const { id } = req.params;
  const cur = await pool.query('SELECT state, initiator_id FROM explorations WHERE id=$1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
  if (cur.rows[0].initiator_id !== req.user.id) {
    return res.status(403).json({ error: '仅发起者可撤回此探索' });
  }
  if (cur.rows[0].state === 'COLLABORATED') {
    log('RETRACT-拒绝', `exploration=${id} 已COLLABORATED，服务端硬拒绝`);
    return res.status(403).json({ error: 'COLLABORATED状态禁止撤回，这是约束#3的服务端强制执行' });
  }
  const { rows } = await pool.query(
    `UPDATE explorations SET state='PRIVATE', published_at=NULL WHERE id=$1 RETURNING id, state`,
    [id]
  );
  log('RETRACTED', `exploration=${id} by=${req.user.id}`);
  res.json(rows[0]);
});

// ------------------------------------------------------------
// 提交追问 —— v2: 真正异步 + 真实鉴权。
// submitted_by不再从请求体读取，强制来自已登录会话（req.user.id）——
// 这直接堵住了此前"任何人都能在body里冒充别人account_id"的漏洞，
// 也是约束#11（第三方判断基于account_id）能够成立的前提：
// 如果account_id可以被客户端伪造，这条约束在安全意义上就是空话。
// ------------------------------------------------------------
app.post('/explorations/:id/questions', auth, async (req, res) => {
  const { id: explorationId } = req.params;
  const submitted_by = req.user.id; // ⚠️ 唯一合法来源：服务端会话
  const { content, parent_node_id } = req.body;

  const expRow = await pool.query('SELECT id, state, initiator_id FROM explorations WHERE id=$1', [explorationId]);
  if (!expRow.rows.length) return res.status(404).json({ error: 'exploration not found' });
  if (expRow.rows[0].state === 'PRIVATE') {
    // PRD流程A：私享阶段允许发起者本人继续私下追问，只是第三方看不到这个探索、
    // 也就无从追问。真正需要拦的是"非发起者对着PRIVATE探索硬提交"这种异常请求。
    if (expRow.rows[0].initiator_id !== submitted_by) {
      log('私享追问被拒绝', `exploration=${explorationId} 请求者=${submitted_by} 真实发起者=${expRow.rows[0].initiator_id} —— 两者不一致`);
      return res.status(404).json({ error: 'exploration not found' }); // 与GET保持一致，不暴露PRIVATE探索的存在
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendingRes = await client.query(
      `INSERT INTO pending_questions (exploration_id, parent_node_id, submitted_by, content, status)
       VALUES ($1, $2, $3, $4, 'SUBMITTED') RETURNING id`,
      [explorationId, parent_node_id || null, submitted_by, content]
    );
    const pendingId = pendingRes.rows[0].id;
    await client.query(
      `INSERT INTO ai_runs (task_type, source_pending_question_id, exploration_id, model, prompt_version, status, idempotency_key)
       VALUES ('GATE_CLASSIFY', $1, $2, 'stub-gate-v1', 'v1', 'PENDING', $3)`,
      [pendingId, explorationId, `gate:${pendingId}`]
    );
    await client.query('COMMIT');
    log('SUBMITTED(已入队)', `pending=${pendingId} by=${submitted_by}`);
    res.status(202).json({ pending_id: pendingId, status: 'SUBMITTED' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// 查询pending状态 —— 仅提交者本人或探索发起者可查看
// ------------------------------------------------------------
app.get('/pending-questions/:id', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pq.*, e.initiator_id
     FROM pending_questions pq JOIN explorations e ON e.id = pq.exploration_id
     WHERE pq.id=$1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const pq = rows[0];
  if (pq.submitted_by !== req.user.id && pq.initiator_id !== req.user.id) {
    return res.status(403).json({ error: '无权查看此追问状态' });
  }
  delete pq.initiator_id;
  res.json(pq);
});

// ------------------------------------------------------------
// 探索详情 + 树 + 当前认识地图最新版本
// 访客(未登录)可看PUBLISHED/COLLABORATED；PRIVATE仅发起者本人可见
// ------------------------------------------------------------
app.get('/explorations/:id', authOptional, async (req, res) => {
  const expRes = await pool.query('SELECT * FROM explorations WHERE id=$1', [req.params.id]);
  if (!expRes.rows.length) return res.status(404).json({ error: 'not found' });
  const exploration = expRes.rows[0];

  if (exploration.state === 'PRIVATE') {
    if (!req.user || req.user.id !== exploration.initiator_id) {
      return res.status(404).json({ error: 'not found' }); // 不暴露"存在但无权限"，统一404
    }
  }

  const nodesRes = await pool.query(
    `SELECT id, parent_node_id, node_type, content, account_id, public_identity_mode, created_at
     FROM nodes WHERE exploration_id=$1 AND status='ACTIVE' ORDER BY created_at ASC`,
    [req.params.id]
  );
  const mapRes = await pool.query(
    `SELECT * FROM understanding_maps WHERE exploration_id=$1 ORDER BY version DESC LIMIT 1`,
    [req.params.id]
  );
  res.json({
    exploration,
    nodes: nodesRes.rows,
    understanding_map: mapRes.rows[0] || null,
  });
});

app.get('/explorations/:id/understanding-map/versions', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT version, summary_json, generated_at FROM understanding_maps WHERE exploration_id=$1 ORDER BY version ASC`,
    [req.params.id]
  );
  res.json(rows);
});

// ------------------------------------------------------------
// 任务队列观测：方便演示时直接看ai_runs的状态分布
// ------------------------------------------------------------
app.get('/debug/ai-runs', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, task_type, status, attempt_count, locked_by, source_pending_question_id, exploration_id, created_at, completed_at
     FROM ai_runs ORDER BY created_at ASC`
  );
  res.json(rows);
});

const PORT = process.env.PORT || 4000;
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`P0原型服务已启动: http://localhost:${PORT}`));

    // Render免费套餐不支持独立的Background Worker服务类型，
    // 所以默认在同一个进程里跑worker循环。如果以后升级到付费套餐、
    // 想用独立worker服务，把环境变量 RUN_WORKER_INLINE 设为 "false"，
    // 再单独部署一个跑 `node worker.js` 的Background Worker服务即可，
    // 处理逻辑完全不用改。
    if (process.env.RUN_WORKER_INLINE !== 'false') {
      console.log('[worker-inline] 在web进程内启动任务队列worker循环');
      const { loop } = require('./worker');
      loop().catch((e) => console.error('[worker-inline] worker循环异常退出:', e.message));
    }
  })
  .catch((e) => {
    console.error('启动失败，数据库自动建表出错，服务不会启动:', e.message);
    process.exit(1);
  });
