/**
 * lib/auth.js — P0原型的简化认证模块
 *
 * 真实实现的部分：
 *   - bcrypt密码哈希（不存明文，不存可逆加密）
 *   - crypto.randomBytes生成的高熵会话token（不是可预测的自增ID）
 *   - 会话有过期时间，中间件会校验过期并拒绝
 *   - requireAuth中间件是唯一能把 req.user.id 注入请求的地方——
 *     业务代码从今以后必须从 req.user.id 取账户身份，
 *     不能再信任请求体里客户端自己填的 account_id/submitted_by/initiator_id。
 *
 * 明确说明：这不是生产级认证系统（没有密码强度策略、没有邮箱验证、
 * 没有限流防暴力破解、没有刷新token机制）。生产环境应替换为
 * Auth.js/Clerk/Supabase Auth（见Development Baseline §11技术栈冻结）。
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7天

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(pool, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}

async function destroySession(pool, token) {
  await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
}

/**
 * requireAuth: 从 Authorization: Bearer <token> 头部解析会话，
 * 校验存在且未过期，把用户信息挂到 req.user 上。
 * 这是全局唯一"客户端说的话被信任为身份"的地方——而且客户端说的
 * 只是token，不是账户id本身，账户id永远由服务端从会话表查出来。
 */
function requireAuth(pool) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ error: '缺少Authorization: Bearer <token>' });
    }
    const token = match[1];
    const { rows } = await pool.query(
      `SELECT s.user_id, s.expires_at, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token]
    );
    if (!rows.length) {
      return res.status(401).json({ error: '无效的会话token' });
    }
    if (new Date(rows[0].expires_at) < new Date()) {
      await destroySession(pool, token);
      return res.status(401).json({ error: '会话已过期，请重新登录' });
    }
    req.user = { id: rows[0].user_id, display_name: rows[0].display_name };
    next();
  };
}

/**
 * optionalAuth: 有token就解析出req.user，没有也放行（用于"访客可浏览，
 * 但登录用户看到的内容可能不同"的场景，比如判断PRIVATE探索的可见性）。
 */
function optionalAuth(pool) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return next();
    const token = match[1];
    const { rows } = await pool.query(
      `SELECT s.user_id, s.expires_at, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token]
    );
    if (rows.length && new Date(rows[0].expires_at) >= new Date()) {
      req.user = { id: rows[0].user_id, display_name: rows[0].display_name };
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireAuth,
  optionalAuth,
};
