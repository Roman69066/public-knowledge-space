-- ============================================================
-- migration_002_auth.sql
-- P0原型专用的简化密码+会话认证。
--
-- ⚠️ 生产环境说明：技术蓝图推荐用Auth.js/Clerk/Supabase Auth这类
-- 托管认证服务，不建议自己维护密码哈希与会话表。这里是因为P0演示
-- 环境无法接入外部OAuth/托管服务，才用最小化的自建方案替代，
-- 目的是验证"account_id必须来自服务端会话，客户端不能自称任何身份"
-- 这条安全原则，不是要把这套自建认证带进正式产品。
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
