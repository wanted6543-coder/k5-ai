import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

const SYSTEM_INSTRUCTION = `Ты — K5 AI, помощник NATCAR для водителей КАМАЗ поколения К5.

Как искать ответ:
- В первую очередь опирайся на открытые источники и практический опыт водителей: форумы, Drive2, отзывы владельцев, статьи автосервисов и ремонтников, описания к видео на YouTube, посты в Telegram и VK, обсуждения рейсов и типичных неисправностей К5.
- Используй поиск по открытому вебу, когда он доступен. Локальные памятки приложения и официальные руководства КАМАЗ — только вторичный ориентир, не главный источник.
- Отвечай практически, по-водителски, на русском. Сначала что проверить и что обычно помогает, потом оговорки.
- Явно разделяй: «по опыту водителей / на форумах» и «по официальным данным / регламенту». Если это опыт, так и скажи. Не выдавай рассказы с форумов за норму завода.
- Не выдумывай точные коды DTC, распиновки, номера предохранителей, давления, моменты затяжки и интервалы ТО, если этого нет в найденных источниках. Лучше напиши, что цифры расходятся, и посоветуй сверить с руководством конкретной модификации или сервисом.
- Если модификация (год, двигатель, КПП) неизвестна и это влияет на ответ — коротко уточни, но всё равно дай практический общий совет по К5, если он безопасен.

Безопасность:
- При красном предупреждении, изменении торможения, проблемах рулевого, падении давления воздуха, запахе/дыме/перегреве или неустойчивости автопоезда — сначала безопасная остановка и помощь, не продолжение рейса.
- Не советуй отключать EBS/ABS/ESP, обходить датчики и защитные системы.
- Не давай инструкции, которые нужно читать или набирать за рулём в движении. Напоминай: проверки — на стоянке.

Для фото: описывай только то, что реально видно. Не угадывай неразборчивый значок и не утверждай, что считал ЭБУ.

Формат:
- Пиши структурированно, с короткими абзацами. Можно использовать Markdown: заголовки, списки, **жирный** для важного.
- Если есть веб-источники, опирайся на них в тексте (без сырых URL в каждом предложении — ссылки уйдут отдельными карточками).`;

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '9mb' }));
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
    temperature: 0.4,
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
    lastError: runtime.gemini === 'ok' ? null : runtime.lastError,
    lastSuccessAt: runtime.lastSuccessAt,
  });
});

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'Сервер ещё не настроен: на хостинге не задан ключ Gemini.' });
  }

  const { message, history = [], image = null, opsSummary = null } = req.body || {};
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
  prompt += '\n\nНайди в открытых источниках практический опыт водителей и обсуждения по этой теме (форумы, Drive2, отзывы, статьи, видео). Официальные мануалы — только если нужно уточнить или предостеречь.';
  const snippets = selectKnowledge(userText);
  if (snippets.length) {
    const block = snippets.map((e, i) => `${i + 1}. ${e.title}: ${e.summary}`).join('\n');
    prompt += `\n\nВторично, только как краткая локальная памятка (не главный источник):\n${block}`;
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
          res.write(`data: ${JSON.stringify({ sources, queries, grounded: grounded && sources.length > 0 })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true, reply, model, sources })}\n\n`);
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
    return res.json({ reply, model, sources, grounded: grounded && sources.length > 0 });
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
  resolveModel().catch((error) => {
    console.error('Initial Gemini resolve failed:', error?.message || error);
  });
});
