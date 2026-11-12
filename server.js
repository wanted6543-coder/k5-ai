import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { initDb, dbReady } from './db.js';
import {
  COOKIE_NAME,
  cookieOpts,
  normalizeLogin,
  validateLogin,
  validatePassword,
  optionalUser,
  requireUser,
  createSession,
  destroySession,
  registerUser,
  loginUser,
  listChats,
  getChat,
  createChat,
  renameChat,
  deleteChat,
  appendMessages,
  persistTurn,
  migrateChats,
  isUuid,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY;
const PREFERRED_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const FAST_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
];
const SEARCH_MODELS = [
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash',
];
const FALLBACK_MODELS = [PREFERRED_MODEL, ...FAST_MODELS, ...SEARCH_MODELS]
  .filter((m, i, a) => a.indexOf(m) === i);

const REQUEST_TIMEOUT_MS = 45_000;

const SYSTEM_INSTRUCTION = `Ты — K5 AI, напарник водителя NATCAR по КАМАЗ К5. Говоришь как опытный водитель-механик: свой парень, спокойный, с лёгким юмором и участием. Обращайся на «ты».

Как отвечать:
- Живо и по-человечески, не как справка и не как колл-центр. Можно коротко отреагировать на ситуацию («о, жёлтая EBS — знакомая история»), и сразу к делу.
- По умолчанию коротко: 2–6 предложений или короткий список. Не лей воду. Не пиши простыни с оговорками.
- Если не хватает вводных (год, двигатель, КПП, цвет лампы, когда загорелась) — дай полезный первый совет и задай один уточняющий вопрос.
- Отвечай уверенно, как человек, который сам водит и чинит К5. Опирайся на практический опыт и открытые знания внутри, но НИКОГДА не говори, откуда это: никаких «на форумах пишут», «по данным Drive2», «по отзывам водителей», «согласно мануалу», «в открытых источниках», ссылок, сносок и упоминаний документов.
- Не выдумывай точные коды DTC, распиновки, номера предохранителей, давления, моменты и интервалы, если не уверен. Тогда скажи прямо и коротко, что цифру лучше сверить по своей комплектации, без отсылки к «официальному источнику».
- Редкие эмодзи, не в каждом сообщении. Без канцелярита, без стены предупреждений.

Безопасность — коротко и по делу, без лекции:
- Красная лампа, хуже тормоза, рулевое, нет воздуха, запах/дым/перегрев, автопоезд «плывёт» — сначала безопасная остановка, не геройствовать.
- Не советуй отключать EBS/ABS/ESP и обходить защиту.
- Не давай инструкции, которые надо читать за рулём в движении. Проверки — на стоянке, одной фразой.

По фото: описывай только то, что реально видно. Не угадывай мутный значок и не делай вид, что считал ЭБУ.

Формат: обычный разговорный русский, короткие абзацы, можно Markdown (списки, **жирный**), без ссылок.`

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '9mb' }));
app.use(cookieParser());
app.use('/api', optionalUser);
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Подожди несколько минут.' },
}));
app.use('/api/chat', rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

let knowledgeBase = { entries: [] };
try {
  knowledgeBase = JSON.parse(readFileSync(path.join(__dirname, 'public', 'knowledge-base.json'), 'utf8'));
} catch {
  console.error('Knowledge base not loaded; continuing without it');
}

const runtime = {
  configured: Boolean(API_KEY),
  model: PREFERRED_MODEL,
  gemini: API_KEY ? 'checking' : 'error',
  lastError: API_KEY ? null : 'На сервере не задан GEMINI_API_KEY.',
  lastErrorAt: null,
  lastSuccessAt: null,
  checking: Boolean(API_KEY),
  search: 'unknown',
};

function safeErrorMessage(error) {
  const status = Number(error?.status) || 0;
  const raw = String(error?.message || '');
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw)) {
    return 'Достигнут лимит запросов к Gemini. Подождите минуту и попробуйте снова.';
  }
  if (status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(raw)) {
    return 'Модель Gemini сейчас перегружена. Пробую запасной вариант или повторите через несколько секунд.';
  }
  if (status === 504 || /DEADLINE|timeout|TIMEOUT/i.test(raw)) {
    return 'Gemini не успел ответить вовремя. Попробуйте ещё раз.';
  }
  if (status === 404 || /NOT_FOUND|no longer available/i.test(raw)) {
    return 'Указанная модель Gemini недоступна. Переключаюсь на рабочую модель.';
  }
  if (status === 401 || status === 403 || /API_KEY|PERMISSION|UNAUTHENTICATED/i.test(raw)) {
    return 'Нет доступа к Gemini. Проверьте API-ключ на сервере.';
  }
  return 'Gemini временно недоступен. Проверьте подключение и попробуйте ещё раз.';
}

function isTransient(error) {
  const status = Number(error?.status) || 0;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const raw = String(error?.message || error?.status || '');
  return /UNAVAILABLE|DEADLINE|timeout|TIMEOUT|high demand|overloaded|ECONNRESET|ETIMEDOUT/i.test(raw);
}

function isSearchUnavailable(error) {
  const raw = String(error?.message || '');
  const status = Number(error?.status) || 0;
  return status === 429 || /RESOURCE_EXHAUSTED|quota|not supported|UNKNOWN_TOOL|googleSearch|google_search|Search Grounding/i.test(raw);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

function selectKnowledge(query, limit = 2) {
  const entries = knowledgeBase?.entries;
  if (!Array.isArray(entries) || !query) return [];
  const terms = norm(query).split(/\s+/).filter((w) => w.length > 2);
  if (!terms.length) return [];
  return entries
    .map((e) => {
      let score = 0;
      const title = norm(e.title);
      const tags = norm((e.tags || []).join(' '));
      const summary = norm(e.summary);
      const category = norm(e.category);
      for (const t of terms) {
        if (title.includes(t)) score += 5;
        if (tags.includes(t)) score += 4;
        if (summary.includes(t)) score += 2;
        if (category.includes(t)) score += 2;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e }) => ({
      title: e.title,
      summary: String(e.summary || '').slice(0, 220),
    }));
}

function extractSources(...chunks) {
  const seen = new Set();
  const sources = [];
  const queries = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    const metas = [];
    if (chunk.groundingMetadata) metas.push(chunk.groundingMetadata);
    for (const c of chunk.candidates || []) {
      if (c?.groundingMetadata) metas.push(c.groundingMetadata);
    }
    for (const meta of metas) {
      for (const q of meta.webSearchQueries || []) {
        if (q && !queries.includes(q)) queries.push(q);
      }
      for (const item of meta.groundingChunks || []) {
        const web = item.web || item.retrievedContext || {};
        const uri = String(web.uri || web.url || '').trim();
        if (!uri || seen.has(uri)) continue;
        if (!/^https?:\/\//i.test(uri)) continue;
        seen.add(uri);
        let title = String(web.title || web.domain || '').trim();
        if (!title) {
          try { title = new URL(uri).hostname.replace(/^www\./, ''); } catch { title = uri; }
        }
        sources.push({ title: title.slice(0, 120), uri });
      }
    }
  }
  return { sources, queries };
}

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.status = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getClient() {
  return new GoogleGenAI({ apiKey: API_KEY, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
}

function generationConfig(model, extras = {}) {
  const config = {
    temperature: 0.75,
    maxOutputTokens: 1800,
    ...extras,
  };
  // Lite models reject thinkingConfig as an invalid argument.
  if (!/lite/i.test(model || '')) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

async function pingModel(model) {
  const ai = getClient();
  const result = await withTimeout(
    ai.models.generateContent({
      model,
      contents: 'Ответь одним словом: ок',
      config: generationConfig(model, { temperature: 0, maxOutputTokens: 16 }),
    }),
    8_000,
    'ping-timeout',
  );
  const text = result.text?.trim();
  if (!text) {
    const err = new Error('empty-ping');
    err.status = 502;
    throw err;
  }
  return text;
}

async function resolveModel() {
  if (!API_KEY) return;
  runtime.checking = true;
  runtime.gemini = 'checking';
  let lastErr = null;
  for (const model of FALLBACK_MODELS) {
    try {
      await pingModel(model);
      runtime.model = model;
      runtime.gemini = 'ok';
      runtime.lastError = null;
      runtime.lastSuccessAt = new Date().toISOString();
      runtime.checking = false;
      console.log(`Gemini ready, model=${model}`);
      return;
    } catch (error) {
      lastErr = error;
      console.error(`Gemini ping failed for ${model}:`, error?.status || error?.message || 'unknown');
    }
  }
  runtime.gemini = 'error';
  runtime.lastError = safeErrorMessage(lastErr || new Error('no-model'));
  runtime.lastErrorAt = new Date().toISOString();
  runtime.checking = false;
  console.error('All Gemini models failed ping');
}

async function generateStreamOnce(model, contents, systemInstruction, useSearch) {
  const ai = getClient();
  const config = generationConfig(model, { systemInstruction });
  if (useSearch) config.tools = [{ googleSearch: {} }];
  return withTimeout(
    ai.models.generateContentStream({ model, contents, config }),
    REQUEST_TIMEOUT_MS,
    'generate-timeout',
  );
}

async function openStream(contents, systemInstruction) {
  let lastError;

  const tryModels = async (useSearch) => {
    const models = (useSearch
      ? [runtime.model, ...SEARCH_MODELS, ...FAST_MODELS]
      : [runtime.model, ...FAST_MODELS, ...SEARCH_MODELS]
    ).filter((m, i, a) => a.indexOf(m) === i);
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const stream = await generateStreamOnce(model, contents, systemInstruction, useSearch);
          runtime.model = model;
          if (useSearch) runtime.search = 'ok';
          return { stream, model, grounded: useSearch };
        } catch (error) {
          lastError = error;
          console.error(`Gemini stream failed (${model}, search=${useSearch}, try ${attempt + 1}):`, error?.status || error?.message || 'unknown');
          if (useSearch && isSearchUnavailable(error)) {
            runtime.search = 'quota';
            const err = new Error('search-unavailable');
            err.status = error?.status;
            err.cause = error;
            throw err;
          }
          if (isTransient(error) && attempt === 0) continue;
          break;
        }
      }
    }
    return null;
  };

  try {
    const hit = await tryModels(true);
    if (hit) return hit;
  } catch (error) {
    if (error?.message !== 'search-unavailable') lastError = error;
    console.error('Google Search grounding unavailable, falling back to model without search');
  }

  const plain = await tryModels(false);
  if (plain) return plain;
  throw lastError || new Error('Gemini unavailable');
}

app.get('/api/health', (_req, res) => {
  const ready = Boolean(API_KEY) && runtime.gemini === 'ok';
  res.json({
    ok: true,
    configured: Boolean(API_KEY),
    ready,
    gemini: runtime.gemini,
    model: runtime.model,
    search: runtime.search,
    db: dbReady() ? 'ok' : (process.env.DATABASE_URL ? 'error' : 'unset'),
    lastError: runtime.gemini === 'ok' ? null : runtime.lastError,
    lastSuccessAt: runtime.lastSuccessAt,
  });
});

function authUnavailable(res) {
  return res.status(503).json({ error: 'Сервер истории пока недоступен. Можно пользоваться гостевым режимом.' });
}

app.get('/api/me', (req, res) => {
  res.json({
    user: req.user || null,
    db: dbReady() ? 'ok' : (process.env.DATABASE_URL ? 'error' : 'unset'),
  });
});

app.post('/api/auth/register', async (req, res) => {
  if (!dbReady()) return authUnavailable(res);
  const login = normalizeLogin(req.body?.login);
  const password = req.body?.password;
  const loginErr = validateLogin(login);
  if (loginErr) return res.status(400).json({ error: loginErr });
  const passErr = validatePassword(password);
  if (passErr) return res.status(400).json({ error: passErr });
  try {
    const user = await registerUser(login, password);
    const token = await createSession(user.id);
    res.cookie(COOKIE_NAME, token, cookieOpts());
    let imported = 0;
    let chats = [];
    if (Array.isArray(req.body?.chats) && req.body.chats.length) {
      const result = await migrateChats(user.id, req.body.chats);
      imported = result.imported;
      chats = result.chats;
    }
    return res.json({ user, imported, chats });
  } catch (error) {
    if (error.status === 409 || error.message === 'taken') {
      return res.status(409).json({ error: 'Такой логин или телефон уже зарегистрирован.' });
    }
    console.error('Register failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось создать аккаунт. Попробуй ещё раз.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!dbReady()) return authUnavailable(res);
  const login = normalizeLogin(req.body?.login);
  const password = req.body?.password;
  if (!login || typeof password !== 'string') {
    return res.status(400).json({ error: 'Укажи логин или телефон и пароль.' });
  }
  try {
    const user = await loginUser(login, password);
    if (!user) return res.status(401).json({ error: 'Неверный логин/телефон или пароль.' });
    const token = await createSession(user.id);
    res.cookie(COOKIE_NAME, token, cookieOpts());
    const chats = await listChats(user.id);
    return res.json({ user, chats });
  } catch (error) {
    console.error('Login failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось войти. Попробуй ещё раз.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await destroySession(req.cookies?.[COOKIE_NAME]);
  } catch (error) {
    console.error('Logout failed:', error.code || error.message);
  }
  res.clearCookie(COOKIE_NAME, { ...cookieOpts(), maxAge: 0 });
  return res.json({ ok: true });
});

app.get('/api/chats', requireUser, async (req, res) => {
  try {
    return res.json({ chats: await listChats(req.user.id) });
  } catch (error) {
    console.error('List chats failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось загрузить чаты.' });
  }
});

app.post('/api/chats/migrate', requireUser, async (req, res) => {
  try {
    const result = await migrateChats(req.user.id, req.body?.chats);
    return res.json(result);
  } catch (error) {
    if (error.status === 400 || error.message === 'limit') {
      return res.status(400).json({ error: 'Слишком много чатов в аккаунте.' });
    }
    console.error('Migrate chats failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось перенести чаты.' });
  }
});

app.post('/api/chats', requireUser, async (req, res) => {
  try {
    const chat = await createChat(req.user.id, req.body?.title);
    return res.json({ chat });
  } catch (error) {
    if (error.status === 400 || error.message === 'limit') {
      return res.status(400).json({ error: 'Слишком много чатов в аккаунте.' });
    }
    console.error('Create chat failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось создать чат.' });
  }
});

app.get('/api/chats/:id', requireUser, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный чат.' });
  try {
    const chat = await getChat(req.user.id, req.params.id);
    if (!chat) return res.status(404).json({ error: 'Чат не найден.' });
    return res.json({ chat });
  } catch (error) {
    console.error('Get chat failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось открыть чат.' });
  }
});

app.patch('/api/chats/:id', requireUser, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный чат.' });
  try {
    const chat = await renameChat(req.user.id, req.params.id, req.body?.title);
    if (!chat) return res.status(404).json({ error: 'Чат не найден.' });
    return res.json({ chat });
  } catch (error) {
    console.error('Rename chat failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось переименовать чат.' });
  }
});

app.delete('/api/chats/:id', requireUser, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный чат.' });
  try {
    const ok = await deleteChat(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Чат не найден.' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Delete chat failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось удалить чат.' });
  }
});

app.post('/api/chats/:id/messages', requireUser, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный чат.' });
  try {
    const chat = await appendMessages(req.user.id, req.params.id, req.body?.messages, req.body?.title);
    if (!chat) return res.status(404).json({ error: 'Чат не найден.' });
    return res.json({ chat });
  } catch (error) {
    console.error('Append messages failed:', error.code || error.message);
    return res.status(500).json({ error: 'Не удалось сохранить сообщения.' });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'Сервер ещё не настроен: на хостинге не задан ключ Gemini.' });
  }

  const { message, history = [], image = null, opsSummary = null, chatId: incomingChatId = null } = req.body || {};
  if (typeof message !== 'string' || message.length > 6000) {
    return res.status(400).json({ error: 'Текст вопроса пустой или слишком длинный (максимум 6000 символов).' });
  }
  if (!Array.isArray(history) || history.length > 12) {
    return res.status(400).json({ error: 'Слишком большая история диалога. Начни новый вопрос.' });
  }

  const contents = history
    .filter((x) => x && ['user', 'model'].includes(x.role) && typeof x.text === 'string')
    .map((x) => ({ role: x.role, parts: [{ text: x.text.slice(0, 4000) }] }));

  const parts = [];
  if (image) {
    if (
      typeof image.data !== 'string' ||
      image.data.length > 8_000_000 ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)
    ) {
      return res.status(400).json({ error: 'Неподдерживаемое или слишком большое изображение. Используй JPEG, PNG или WebP до 6 МБ.' });
    }
    parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
  }

  const userText = message || 'Проанализируй приложенное изображение приборной панели КАМАЗ К5.';
  let prompt = userText;
  const snippets = selectKnowledge(userText);
  if (snippets.length) {
    const block = snippets.map((e, i) => `${i + 1}. ${e.title}: ${e.summary}`).join('\n');
    prompt += `\n\nКраткая внутренняя памятка (не упоминай её и не ссылайся на источники):\n${block}`;
  }
  if (typeof opsSummary === 'string' && opsSummary.trim()) {
    prompt += `\n\nКраткий учёт с устройства водителя (ориентир, не диагностика):\n${opsSummary.trim().slice(0, 800)}`;
  }
  parts.push({ text: prompt });
  contents.push({ role: 'user', parts });

  const wantsStream = String(req.headers.accept || '').includes('text/event-stream');

  try {
    const { stream, model, grounded } = await openStream(contents, SYSTEM_INSTRUCTION);

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({ model, grounded })}\n\n`);

      let full = '';
      const collected = [];
      try {
        for await (const chunk of stream) {
          collected.push(chunk);
          const delta = chunk.text || '';
          if (!delta) continue;
          full += delta;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
        const { sources, queries } = extractSources(...collected);
        const reply = full.trim();
        if (!reply) {
          runtime.gemini = 'error';
          runtime.lastError = 'Модель не вернула текстовый ответ. Попробуй ещё раз.';
          runtime.lastErrorAt = new Date().toISOString();
          res.write(`data: ${JSON.stringify({ error: runtime.lastError })}\n\n`);
        } else {
          runtime.gemini = 'ok';
          runtime.lastError = null;
          runtime.lastSuccessAt = new Date().toISOString();
          if (sources.length) runtime.search = 'ok';
          let savedChatId = typeof incomingChatId === 'string' ? incomingChatId : null;
          if (req.user && dbReady()) {
            try {
              savedChatId = await persistTurn(req.user.id, savedChatId, userText, reply);
            } catch (persistError) {
              console.error('Persist chat failed:', persistError.code || persistError.message);
            }
          }
          res.write(`data: ${JSON.stringify({ sources, queries, grounded: grounded && sources.length > 0 })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true, reply, model, sources, chatId: savedChatId })}\n\n`);
        }
      } catch (error) {
        const msg = safeErrorMessage(error);
        runtime.gemini = 'error';
        runtime.lastError = msg;
        runtime.lastErrorAt = new Date().toISOString();
        res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      }
      return res.end();
    }

    let full = '';
    const collected = [];
    for await (const chunk of stream) {
      collected.push(chunk);
      full += chunk.text || '';
    }
    const reply = full.trim();
    const { sources } = extractSources(...collected);
    if (!reply) {
      runtime.gemini = 'error';
      runtime.lastError = 'Модель не вернула текстовый ответ. Попробуй ещё раз.';
      runtime.lastErrorAt = new Date().toISOString();
      return res.status(502).json({ error: runtime.lastError });
    }
    runtime.gemini = 'ok';
    runtime.lastError = null;
    runtime.lastSuccessAt = new Date().toISOString();
    if (sources.length) runtime.search = 'ok';
    let savedChatId = typeof incomingChatId === 'string' ? incomingChatId : null;
    if (req.user && dbReady()) {
      try {
        savedChatId = await persistTurn(req.user.id, savedChatId, userText, reply);
      } catch (persistError) {
        console.error('Persist chat failed:', persistError.code || persistError.message);
      }
    }
    return res.json({ reply, model, sources, grounded: grounded && sources.length > 0, chatId: savedChatId });
  } catch (error) {
    const msg = safeErrorMessage(error);
    runtime.gemini = 'error';
    runtime.lastError = msg;
    runtime.lastErrorAt = new Date().toISOString();
    console.error('Gemini request failed:', error?.status || error?.message || 'unknown error');
    const status = Number(error?.status) === 429 ? 429 : 502;
    return res.status(status).json({ error: msg });
  }
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`K5 AI listening on port ${PORT}; preferred=${PREFERRED_MODEL}`);
  initDb().catch((error) => {
    console.error('Postgres init failed:', error?.message || error);
  });
  resolveModel().catch((error) => {
    console.error('Initial Gemini resolve failed:', error?.message || error);
  });
});
