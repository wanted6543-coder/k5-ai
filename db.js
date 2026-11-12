import pg from 'pg';

const { Pool } = pg;

let pool = null;
let ready = false;

function sslOption(connectionString) {
  try {
    const url = new URL(connectionString.replace(/^postgres:\/\//, 'postgresql://'));
    if (url.searchParams.get('sslmode') === 'disable') return false;
    // External Render hostnames have a domain; the private hostname is a short service id.
    if (url.hostname.includes('.')) return { rejectUnauthorized: false };
  } catch {
    return false;
  }
  return false;
}

export function dbReady() {
  return Boolean(ready && pool);
}

export function getPool() {
  return pool;
}

export async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('DATABASE_URL is not set; registration and server history are disabled');
    return false;
  }
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: sslOption(connectionString),
  });
  pool.on('error', (err) => {
    console.error('Postgres pool error:', err.code || err.message);
  });

  const schema = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS chats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Новый чат',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chats_user_updated_idx ON chats(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'model')),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chat_id, created_at);
  `;

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await pool.query(schema);
      ready = true;
      console.log('Postgres schema ready');
      return true;
    } catch (error) {
      console.error(`Postgres init failed (attempt ${attempt}):`, error.code || error.message);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return false;
}

export async function query(text, params) {
  if (!pool) throw new Error('db-unavailable');
  return pool.query(text, params);
}
