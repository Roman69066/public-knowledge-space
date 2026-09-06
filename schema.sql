-- ============================================================
-- 公共新知识空间 · 成熟V1 · PostgreSQL Schema (v1.1)
-- 基线：Development Baseline v1.0（施工冻结版）
--
-- 相对 v1.0 的变更（核对Development Baseline后修订）：
--   1. 新增 pending_questions 表：落实约束#12
--      "Pending Question 不是 Knowledge Node"——追问提交后先落入此表，
--      只有 Gate accepted 且 AI Answer 成功，才在同一事务里
--      原子性写入 nodes(QUESTION)+nodes(ANSWER)，并据此判断是否切换Collaborated。
--   2. question_meta 移除 duplicate_of 字段：重复问题永远不会提交成为node，
--      所以"重复指向哪个节点"这件事只应记录在pending_questions里，不应出现在
--      与已提交node一一对应的question_meta中。
--   3. question_meta.classification 语义收窄为仅 VALID_NEW / VALID_RELATED
--      （因为只有这两类会产生node），保留完整枚举类型是为了与pending_questions
--      共用同一个分类枚举，避免定义两套。
--   4. ai_runs.status 枚举对齐基线§12最低要求：
--      PENDING / PROCESSING / DONE / FAILED / DEAD，并新增 next_retry_at
--      支撑指数退避；DEAD表示超过max_attempts后的最终失败状态。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------
-- 枚举类型
-- ------------------------------------------------------------
CREATE TYPE exploration_state AS ENUM ('PRIVATE', 'PUBLISHED', 'COLLABORATED');
CREATE TYPE identity_mode AS ENUM ('NAMED', 'ANONYMOUS');
CREATE TYPE node_type AS ENUM ('QUESTION', 'ANSWER');
CREATE TYPE node_identity_mode AS ENUM ('NAMED', 'ANONYMOUS', 'SYSTEM');
CREATE TYPE node_status AS ENUM ('ACTIVE', 'HIDDEN', 'REMOVED');

-- 与Gate分类结果共用；node_meta中实际只会出现VALID_NEW/VALID_RELATED
CREATE TYPE question_classification AS ENUM (
  'VALID_NEW', 'VALID_RELATED', 'DUPLICATE', 'OFF_TOPIC', 'ABUSE', 'SAFETY_BLOCK'
);

-- Pending Question 异步状态机（Development Baseline §5，本轮冻结新增）
CREATE TYPE pending_question_status AS ENUM (
  'SUBMITTED', 'CLASSIFYING', 'DUPLICATE', 'OFF_TOPIC', 'ABUSE', 'SAFETY_BLOCK',
  'ANSWERING', 'COMMITTING', 'COMPLETED', 'FAILED'
);

CREATE TYPE ai_task_type AS ENUM (
  'ANSWER', 'GATE_CLASSIFY', 'DUPLICATE_JUDGE', 'MAP_UPDATE', 'QUESTION_PREDICTION'
);

-- 对齐基线§12最低要求：PENDING/PROCESSING/DONE/FAILED/DEAD
CREATE TYPE ai_run_status AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD');

CREATE TYPE follow_target_type AS ENUM ('USER', 'EXPLORATION');
CREATE TYPE notification_type AS ENUM (
  'NAMED_NODE_FOLLOWUP', 'FOLLOWED_EXPLORATION_NEW_DIRECTION', 'MAJOR_UNDERSTANDING_REVISION',
  'PENDING_QUESTION_COMPLETED' -- 支撑基线§17"用户离开页面不取消任务，完成后可通知"
);
CREATE TYPE governance_target_type AS ENUM ('NODE', 'EXPLORATION', 'USER');
CREATE TYPE metric_event_type AS ENUM (
  'NEW_BRANCH', 'NEW_EVIDENCE', 'COUNTEREXAMPLE', 'PREMISE_CHALLENGE',
  'CROSS_DOMAIN_LINK', 'SUMMARY_REVISION', 'CONCLUSION_REVISION', 'DUPLICATE', 'NOISE'
);

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  avatar_url    text,
  email         text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- explorations
-- ------------------------------------------------------------
CREATE TABLE explorations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_question_id  uuid, -- FK补充在nodes建表后
  initiator_id      uuid NOT NULL REFERENCES users(id),
  state             exploration_state NOT NULL DEFAULT 'PRIVATE',
  identity_mode     identity_mode NOT NULL DEFAULT 'NAMED',
  title             text,
  published_at      timestamptz,
  collaborated_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- nodes（Question / Answer 统一表 —— 只存放已COMMIT的正式知识节点）
-- 约束#12：任何未经Gate accepted + Answer成功的内容，绝不能出现在这张表里。
-- ------------------------------------------------------------
CREATE TABLE nodes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exploration_id         uuid NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
  parent_node_id         uuid REFERENCES nodes(id),
  node_type              node_type NOT NULL,
  content                text NOT NULL,
  account_id             uuid REFERENCES users(id), -- AI回答时可为NULL
  public_identity_mode   node_identity_mode NOT NULL DEFAULT 'SYSTEM',
  depth                  int NOT NULL DEFAULT 0,
  ancestor_path          text, -- 短编码路径，见下方closure table说明
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  status                 node_status NOT NULL DEFAULT 'ACTIVE',
  embedding              vector(1536),
  embedding_model_version text,
  source_pending_question_id uuid, -- 追溯该QUESTION节点由哪条pending记录提交而来
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE explorations
  ADD CONSTRAINT fk_explorations_root_question
  FOREIGN KEY (root_question_id) REFERENCES nodes(id);

-- 闭包表：支持任意深度祖先查询与分支折叠（比把UUID塞进ltree label更安全，见风险评估#3）
CREATE TABLE node_ancestors (
  ancestor_id    uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  descendant_id  uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth          int NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);

-- ------------------------------------------------------------
-- pending_questions（新增于v1.1）
-- 落实 Development Baseline §5 异步状态机 与 约束#12
-- ------------------------------------------------------------
CREATE TABLE pending_questions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exploration_id         uuid NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
  parent_node_id         uuid REFERENCES nodes(id), -- 针对哪个已有节点追问；根探索的Q0时为NULL
  submitted_by           uuid NOT NULL REFERENCES users(id), -- 必须是account_id，供"提问者≠initiator"判断使用
  content                text NOT NULL,
  status                 pending_question_status NOT NULL DEFAULT 'SUBMITTED',
  classification         question_classification, -- Gate完成后填入；未分类前为NULL
  duplicate_of_node_id   uuid REFERENCES nodes(id), -- 仅DUPLICATE状态时填入
  redirect_hint          text, -- OFF_TOPIC时给用户的"建议转到/新建"提示文本
  committed_question_node_id uuid REFERENCES nodes(id), -- COMPLETED后指向正式Question节点
  committed_answer_node_id   uuid REFERENCES nodes(id), -- COMPLETED后指向正式Answer节点
  retry_count            int NOT NULL DEFAULT 0,
  last_error             text,
  embedding              vector(1536),
  embedding_model_version text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_questions_exploration ON pending_questions (exploration_id);
CREATE INDEX idx_pending_questions_status ON pending_questions (status)
  WHERE status NOT IN ('COMPLETED', 'FAILED');
CREATE INDEX idx_pending_questions_submitter ON pending_questions (submitted_by);

ALTER TABLE nodes
  ADD CONSTRAINT fk_nodes_source_pending_question
  FOREIGN KEY (source_pending_question_id) REFERENCES pending_questions(id);

-- ------------------------------------------------------------
-- question_meta（仅对应已COMMIT的node；只会出现VALID_NEW/VALID_RELATED两种分类）
-- v1.1变更：移除duplicate_of（重复问题不会有对应node，该字段迁移到pending_questions）
-- ------------------------------------------------------------
CREATE TABLE question_meta (
  node_id                uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  classification         question_classification NOT NULL
    CHECK (classification IN ('VALID_NEW', 'VALID_RELATED')),
  accepted_into_tree     boolean NOT NULL DEFAULT true,
  related_to             uuid REFERENCES nodes(id), -- VALID_RELATED时指向被延伸的节点
  semantic_cluster_id    uuid,
  branch_type            text,
  novelty_score          numeric(5,4),
  is_new_branch          boolean NOT NULL DEFAULT false,
  caused_summary_revision    boolean NOT NULL DEFAULT false,
  caused_conclusion_revision boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- ai_runs（AI任务可追踪；状态枚举对齐基线§12最低要求）
-- ------------------------------------------------------------
CREATE TABLE ai_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type         ai_task_type NOT NULL,
  source_node_id            uuid REFERENCES nodes(id),
  source_pending_question_id uuid REFERENCES pending_questions(id),
  exploration_id    uuid REFERENCES explorations(id),
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  status            ai_run_status NOT NULL DEFAULT 'PENDING',
  input_tokens      int,
  output_tokens     int,
  cost_usd          numeric(10,6),
  attempt_count     int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 3,
  next_retry_at     timestamptz, -- 支撑指数/分级退避
  last_error        text,
  locked_by         text,      -- 配合 FOR UPDATE SKIP LOCKED 式任务领取
  locked_at         timestamptz,
  idempotency_key   text UNIQUE, -- 防止Map更新/Prediction重复执行产生重复版本（基线§12）
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

-- ------------------------------------------------------------
-- understanding_maps（版本化认识地图）
-- ------------------------------------------------------------
CREATE TABLE understanding_maps (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exploration_id         uuid NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
  version                int NOT NULL,
  summary_json           jsonb NOT NULL,
  source_tree_version    bigint NOT NULL,
  last_material_change_node_id uuid REFERENCES nodes(id),
  generated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exploration_id, version)
);

-- ------------------------------------------------------------
-- ai_question_predictions（AI后台预测问题，绝不直接展示给用户）
-- ------------------------------------------------------------
CREATE TABLE ai_question_predictions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_answer_id        uuid NOT NULL REFERENCES nodes(id),
  prediction_text         text NOT NULL,
  embedding               vector(1536),
  embedding_model_version text,
  rank                    int,
  model                   text NOT NULL,
  prompt_version          text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE human_question_delta_checks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  human_node_id         uuid NOT NULL REFERENCES nodes(id),
  best_matched_prediction_id uuid REFERENCES ai_question_predictions(id),
  similarity_score      numeric(5,4),
  is_delta_candidate    boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- follows / notifications
-- ------------------------------------------------------------
CREATE TABLE follows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id  uuid NOT NULL REFERENCES users(id),
  target_type  follow_target_type NOT NULL,
  target_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (follower_id, target_type, target_id)
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  type        notification_type NOT NULL,
  target_id   uuid NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- governance_events（治理审计）
-- ------------------------------------------------------------
CREATE TABLE governance_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  governance_target_type NOT NULL,
  target_id    uuid NOT NULL,
  reason       text NOT NULL,
  action       text NOT NULL,
  actor        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- metric_events（Knowledge Gain 原始事件）
-- ------------------------------------------------------------
CREATE TABLE metric_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exploration_id  uuid NOT NULL REFERENCES explorations(id),
  node_id         uuid REFERENCES nodes(id),
  event_type      metric_event_type NOT NULL,
  payload_json    jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 索引
-- ============================================================
CREATE INDEX idx_nodes_exploration_id ON nodes (exploration_id);
CREATE INDEX idx_nodes_parent_node_id ON nodes (parent_node_id);
CREATE INDEX idx_nodes_created_at ON nodes (created_at);
CREATE INDEX idx_question_meta_accepted ON question_meta (accepted_into_tree);
CREATE INDEX idx_node_ancestors_descendant ON node_ancestors (descendant_id);

CREATE INDEX idx_nodes_embedding_hnsw
  ON nodes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_predictions_embedding_hnsw
  ON ai_question_predictions USING hnsw (embedding vector_cosine_ops);

-- Q0全局查重专用：只在root question（parent_node_id IS NULL）且探索已公开时检索
CREATE INDEX idx_root_question_embedding_hnsw
  ON nodes USING hnsw (embedding vector_cosine_ops)
  WHERE node_type = 'QUESTION' AND parent_node_id IS NULL;

-- 任务队列领取：配合 SELECT ... FOR UPDATE SKIP LOCKED 使用
CREATE INDEX idx_ai_runs_pending_pickup ON ai_runs (status, next_retry_at)
  WHERE status IN ('PENDING', 'FAILED') ;

CREATE INDEX idx_explorations_state ON explorations (state);
CREATE INDEX idx_notifications_user_unread ON notifications (user_id, read_at);
CREATE INDEX idx_follows_target ON follows (target_type, target_id);

-- ============================================================
-- 关键约束注释
-- ============================================================
COMMENT ON COLUMN nodes.account_id IS
  '内部真实账户ID，任何"是否第三方"判断必须比较此字段，而非public_identity_mode（约束#11）';
COMMENT ON TABLE pending_questions IS
  '追问在被Gate接受并生成AI回答之前的处理态，绝不是正式知识节点（约束#12）';
COMMENT ON COLUMN ai_runs.idempotency_key IS
  'Map更新/Prediction等任务必须携带幂等键，防止重复执行产生重复版本或重复预测（基线§12）';

-- ============================================================
-- P0原型演示专用补充：用pg_trgm做去重相似度检测的占位方案
-- （真实生产环境应替换为pgvector+embedding，见schema主体的HNSW索引设计；
--   trgm是"不需要外部AI服务也能真实运行"的降级替代，不是产品最终方案）
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_nodes_content_trgm ON nodes USING gin (content gin_trgm_ops);
