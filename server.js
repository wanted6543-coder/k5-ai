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
const PREFERRED_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const FALLBACK_MODELS = [
  PREFERRED_MODEL,
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
].filter((m, i, a) => a.indexOf(m) === i);

const REQUEST_TIMEOUT_MS = 28_000;

const SYSTEM_INSTRUCTION = `Ты — K5 AI, помощник NATCAR (АО «Национальный перевозчик», дочернее предприятие ПАО «КАМАЗ») для водителей грузовых автомобилей КАМАЗ поколения К5.
Отвечай на русском языке, спокойно и структурированно. Уточняй год, модификацию, двигатель, КПП, точный текст/символ/цвет предупреждения, условия появления и коды диагностики, если это важно.
Не выдумывай коды DTC, распиновки, номера предохранителей, значения давления, моменты затяжки, интервалы обслуживания или точные процедуры. Если данных недостаточно или нет подтверждённой документации — прямо скажи это и попроси фото/данные или направь к руководству конкретной модификации и квалифицированному сервису.
Для фотографий: описывай только реально различимые детали. Если значок неразборчив — попроси более чёткое фото; не угадывай. Не утверждай, что считал ЭБУ или провёл диагностику.
Безопасность важнее продолжения рейса: при красном предупреждении, ухудшении торможения, проблемах рулевого управления, недостаточном давлении пневмосистемы, запахе/дыме/перегреве или неустойчивости автопоезда — рекомендовать безопасно остановиться в подходящем месте и вызвать техническую помощь. Не советуй отключать EBS/ABS/ESP, обходить датчики, блокировки и другие защитные системы.
Не давай водителю инструкции, требующие читать/набирать текст во время движения. Напоминай выполнять проверки только на стоянке и с соблюдением мер безопасности.
Если пользователь просит точную инструкцию, но модификация неизвестна, сначала уточни её. Отделяй подтверждённые факты от предположений.
Если водителю приложен краткий учёт топлива или ТО, используй его только как ориентир с устройства и не выдавай его за официальную диагностику.
Не используй разметку Markdown (звёздочки, решётки, обратные кавычки) — пиши обычным текстом с абзацами и нумерованными списками.`;

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  // Allow the official mark and same-origin assets in a PWA context
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

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

function selectKnowledge(query, limit = 3) {
  const entries = knowledgeBase?.entries;
  if (!Array.isArray(entries) || !query) return [];
  const terms = norm(query).split(/\s+/).filter((w) => w.length > 2);
  if (!terms.length) return [];
  return entries
    .map((e) => {
      const hay = {
        title: norm(e.title),
        tags: norm((e.tags || []).join(' ')),
        summary: norm(e.summary),
        content: norm(e.content),
        category: norm(e.category),
      };
      let score = 0;
      for (const t of terms) {
        if (hay.title.includes(t)) score += 5;
        if (hay.tags.includes(t)) score += 4;
        if (hay.summary.includes(t)) score += 2;
        if (hay.content.includes(t)) score += 1;
        if (hay.category.includes(t)) score += 2;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e }) => ({
      title: e.title,
      category: e.category,
      summary: String(e.summary || '').slice(0, 400),
      content: String(e.content || '').slice(0, 700),
    }));
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

async function pingModel(model) {
  const ai = getClient();
  const result = await withTimeout(
    ai.models.generateContent({
      model,
      contents: 'Ответь одним словом: ок',
      config: { temperature: 0, maxOutputTokens: 8 },
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

async function generateStreamOnce(model, contents, systemInstruction) {
  const ai = getClient();
  return withTimeout(
    ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction,
        temperature: 0.25,
        maxOutputTokens: 1300,
      },
    }),
    REQUEST_TIMEOUT_MS,
    'generate-timeout',
  );
}

async function openStream(contents, systemInstruction) {
  const models = [runtime.model, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);
  let lastError;
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const stream = await generateStreamOnce(model, contents, systemInstruction);
        runtime.model = model;
        return { stream, model };
      } catch (error) {
        lastError = error;
        console.error(`Gemini stream failed (${model}, try ${attempt + 1}):`, error?.status || error?.message || 'unknown');
        const tryAgain = isTransient(error) && attempt === 0;
        if (tryAgain) continue;
        break;
      }
    }
  }
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
  const snippets = selectKnowledge(userText);
  let prompt = userText;
  if (snippets.length) {
    const block = snippets
      .map((e, i) => `${i + 1}. ${e.title} (${e.category})\n${e.summary}\n${e.content}`)
      .join('\n\n');
    prompt += `\n\nКраткие фрагменты локального справочника (неполный источник, не выдумывай сверх них):\n${block}`;
  }
  if (typeof opsSummary === 'string' && opsSummary.trim()) {
    prompt += `\n\nКраткий учёт с устройства водителя (ориентир, не диагностика):\n${opsSummary.trim().slice(0, 800)}`;
  }
  parts.push({ text: prompt });
  contents.push({ role: 'user', parts });

  const wantsStream = String(req.headers.accept || '').includes('text/event-stream');

  try {
    const { stream, model } = await openStream(contents, SYSTEM_INSTRUCTION);

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({ model })}\n\n`);

      let full = '';
      try {
        for await (const chunk of stream) {
          const delta = chunk.text || '';
          if (!delta) continue;
          full += delta;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
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
          res.write(`data: ${JSON.stringify({ done: true, reply, model })}\n\n`);
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
    for await (const chunk of stream) {
      full += chunk.text || '';
    }
    const reply = full.trim();
    if (!reply) {
      runtime.gemini = 'error';
      runtime.lastError = 'Модель не вернула текстовый ответ. Попробуй ещё раз.';
      runtime.lastErrorAt = new Date().toISOString();
      return res.status(502).json({ error: runtime.lastError });
    }
    runtime.gemini = 'ok';
    runtime.lastError = null;
    runtime.lastSuccessAt = new Date().toISOString();
    return res.json({ reply, model });
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
