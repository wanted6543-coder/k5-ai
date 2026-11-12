import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { dbReady, query } from './db.js';

export const COOKIE_NAME = 'k5_sid';
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 10;
const MAX_CHATS = 80;
const MAX_MIGRATE_CHATS = 40;
const MAX_MESSAGES_PER_CHAT = 200;

export function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function normalizeLogin(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const compact = s.replace(/[\s()\-.]/g, '');
  const digits = compact.replace(/\D/g, '');
  const looksPhone = /^\+?\d{10,15}$/.test(compact);
  if (looksPhone) {
    if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
    if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
    if (compact.startsWith('+')) return `+${digits}`;
    return digits;
  }
  return s.toLowerCase();
}

export function validateLogin(login) {
  if (!login || login.length < 3 || login.length > 64) {
    return 'Укажи логин (от 3 символов) или телефон.';
  }
  if (login.startsWith('+') || /^\d{10,15}$/.test(login)) return null;
  if (!/^[a-z0-9._-]{3,64}$/i.test(login)) {
    return 'Логин: латинские буквы, цифры, точка, дефис или подчёркивание. Либо укажи телефон.';
  }
  return null;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return 'Пароль должен быть от 8 до 128 символов.';
  }
  return null;
}

export function titleFrom(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return t || 'Новый чат';
}

function publicUser(row) {
  return { id: row.id, login: row.login, createdAt: row.created_at };
}

function publicChat(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: row.preview || '',
  };
}

export async function optionalUser(req, _res, next) {
  req.user = null;
  if (!dbReady()) return next();
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();
  try {
    const { rows } = await query(
      `SELECT u.id, u.login, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    if (rows[0]) req.user = publicUser(rows[0]);
  } catch (error) {
    console.error('Session lookup failed:', error.code || error.message);
  }
  return next();
}

export function requireUser(req, res, next) {
  if (!dbReady()) {
    return res.status(503).json({ error: 'Сервер истории пока недоступен. Можно пользоваться гостевым режимом.' });
  }
  if (!req.user) {
    return res.status(401).json({ error: 'Нужно войти в аккаунт.' });
  }
  return next();
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, hashToken(token), String(SESSION_DAYS)],
  );
  return token;
}

export async function destroySession(token) {
  if (!token || !dbReady()) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function registerUser(login, password) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const { rows } = await query(
      'INSERT INTO users (login, password_hash) VALUES ($1, $2) RETURNING id, login, created_at',
      [login, hash],
    );
    return publicUser(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      const err = new Error('taken');
      err.status = 409;
      throw err;
    }
    throw error;
  }
}

export async function loginUser(login, password) {
  const { rows } = await query(
    'SELECT id, login, password_hash, created_at FROM users WHERE login = $1',
    [login],
  );
  const row = rows[0];
  if (!row) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
  return publicUser(row);
}

export async function listChats(userId) {
  const { rows } = await query(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (
              SELECT m.text FROM messages m
               WHERE m.chat_id = c.id
               ORDER BY m.created_at DESC
               LIMIT 1
            ) AS preview
       FROM chats c
      WHERE c.user_id = $1
      ORDER BY c.updated_at DESC
      LIMIT $2`,
    [userId, MAX_CHATS],
  );
  return rows.map(publicChat);
}

export async function getChat(userId, chatId) {
  const { rows } = await query(
    'SELECT id, title, created_at, updated_at FROM chats WHERE id = $1 AND user_id = $2',
    [chatId, userId],
  );
  if (!rows[0]) return null;
  const messages = await query(
    `SELECT role, text, created_at
       FROM messages
      WHERE chat_id = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [chatId, MAX_MESSAGES_PER_CHAT],
  );
  return {
    ...publicChat(rows[0]),
    messages: messages.rows.map((m) => ({ role: m.role, text: m.text, createdAt: m.created_at })),
  };
}

export async function createChat(userId, title) {
  const { rows: countRows } = await query('SELECT count(*)::int AS n FROM chats WHERE user_id = $1', [userId]);
  if ((countRows[0]?.n || 0) >= MAX_CHATS) {
    const err = new Error('limit');
    err.status = 400;
    throw err;
  }
  const { rows } = await query(
    'INSERT INTO chats (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at, updated_at',
    [userId, titleFrom(title)],
  );
  return publicChat(rows[0]);
}

export async function renameChat(userId, chatId, title) {
  const { rows } = await query(
    `UPDATE chats SET title = $3, updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, title, created_at, updated_at`,
    [chatId, userId, titleFrom(title)],
  );
  return rows[0] ? publicChat(rows[0]) : null;
}

export async function deleteChat(userId, chatId) {
  const { rowCount } = await query('DELETE FROM chats WHERE id = $1 AND user_id = $2', [chatId, userId]);
  return rowCount > 0;
}

export async function appendMessages(userId, chatId, messages, title) {
  const chat = await getChat(userId, chatId);
  if (!chat) return null;
  const clean = (messages || [])
    .filter((m) => m && ['user', 'model'].includes(m.role) && typeof m.text === 'string' && m.text.trim())
    .slice(0, 40)
    .map((m) => [chatId, m.role, String(m.text).slice(0, 6000)]);
  if (!clean.length) return chat;
  const values = [];
  const params = [];
  clean.forEach((row, i) => {
    const base = i * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(...row);
  });
  await query(`INSERT INTO messages (chat_id, role, text) VALUES ${values.join(',')}`, params);
  const firstUser = clean.find((row) => row[1] === 'user');
  const nextTitle = (!chat.title || chat.title === 'Новый чат') && (title || firstUser)
    ? titleFrom(title || firstUser[2])
    : chat.title;
  const { rows } = await query(
    `UPDATE chats SET title = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, title, created_at, updated_at`,
    [chatId, nextTitle],
  );
  return publicChat(rows[0]);
}

export async function persistTurn(userId, chatId, userText, modelText) {
  let id = chatId;
  if (id) {
    const existing = await query('SELECT id FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!existing.rows[0]) id = null;
  }
  if (!id) {
    const created = await createChat(userId, userText);
    id = created.id;
  }
  await appendMessages(userId, id, [
    { role: 'user', text: userText },
    { role: 'model', text: modelText },
  ], userText);
  return id;
}

export async function migrateChats(userId, incoming) {
  if (!Array.isArray(incoming)) return { imported: 0, chats: [] };
  const existing = await listChats(userId);
  const room = Math.max(0, MAX_CHATS - existing.length);
  const batch = incoming.slice(0, Math.min(MAX_MIGRATE_CHATS, room));
  const imported = [];
  for (const item of batch) {
    const title = titleFrom(item?.title);
    const created = await createChat(userId, title);
    const messages = Array.isArray(item?.messages) ? item.messages.slice(0, MAX_MESSAGES_PER_CHAT) : [];
    if (messages.length) await appendMessages(userId, created.id, messages, title);
    imported.push(created);
  }
  const chats = await listChats(userId);
  return { imported: imported.length, chats };
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
