/**
 * lib/db.js — 统一的数据库连接 + 开机自动建表
 *
 * 为什么要自动建表：这套系统的目标部署方式是"云托管平台 + 云数据库"，
 * 使用者不会打开终端手动执行 psql -f schema.sql。所以server.js和worker.js
 * 启动时都会调用 ensureSchema()，如果检测到核心表还不存在，就自动把
 * schema.sql和migration_002_auth.sql的内容跑一遍。之后每次重启这个检测
 * 都是一次廉价的SELECT，不会重复建表。
 *
 * 连接方式：
 *   - 设置了 DATABASE_URL（Render/Railway/Supabase等托管平台的标准做法）
 *     → 用连接串连接，并开启SSL（托管Postgres几乎都强制要求）。
 *   - 没设置 → 退回本地开发默认值（localhost/postgres/postgres/protodb）。
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  : new Pool({ host: 'localhost', user: 'postgres', password: 'postgres', database: 'protodb' });

async function ensureSchema() {
  // 用pg advisory lock防止server和worker两个进程同时启动时都去执行建表SQL撞车
  const LOCK_KEY = 847362910; // 任意固定数字，只用于本项目的建表互斥
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const { rows } = await client.query(`SELECT to_regclass('public.explorations') AS t`);
    if (rows[0].t) {
      console.log('[migrate] 已检测到表结构，跳过自动建表');
      return;
    }
    console.log('[migrate] 未检测到表结构，开始自动执行schema.sql + migration_002_auth.sql ...');
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    const authSql = fs.readFileSync(path.join(__dirname, '..', 'migration_002_auth.sql'), 'utf8');
    try {
      await client.query(schemaSql);
      await client.query(authSql);
      console.log('[migrate] 自动建表完成');
    } catch (e) {
      console.error('[migrate] 自动建表失败：', e.message);
      console.error('[migrate] 最常见原因：托管数据库不支持pgvector或pg_trgm扩展。' +
        '如果用Supabase，请先在 Database → Extensions 里手动勾选启用 "vector" 和 "pg_trgm"，然后重启这个服务。');
      throw e;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    client.release();
  }
}

module.exports = { pool, ensureSchema };
