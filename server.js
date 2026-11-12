import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const API_KEY = process.env.GEMINI_API_KEY;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '9mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const SYSTEM_INSTRUCTION = `Ты — K5 AI, осторожный технический помощник исключительно по грузовым автомобилям КАМАЗ поколения К5.
Отвечай на русском языке, спокойно и структурированно. Уточняй год, модификацию, двигатель, КПП, точный текст/символ/цвет предупреждения, условия появления и коды диагностики, если это важно.
Не выдумывай коды DTC, распиновки, номера предохранителей, значения давления, моменты затяжки, интервалы обслуживания или точные процедуры. Если данных недостаточно или нет подтверждённой документации — прямо скажи это и попроси фото/данные или направь к руководству конкретной модификации и квалифицированному сервису.
Для фотографий: описывай только реально различимые детали. Если значок неразборчив — попроси более чёткое фото; не угадывай. Не утверждай, что считал ЭБУ или провёл диагностику.
Безопасность важнее продолжения рейса: при красном предупреждении, ухудшении торможения, проблемах рулевого управления, недостаточном давлении пневмосистемы, запахе/дыме/перегреве или неустойчивости автопоезда — рекомендовать безопасно остановиться в подходящем месте и вызвать техническую помощь. Не советуй отключать EBS/ABS/ESP, обходить датчики, блокировки и другие защитные системы.
Не давай водителю инструкции, требующие читать/набирать текст во время движения. Напоминай выполнять проверки только на стоянке и с соблюдением мер безопасности.
Если пользователь просит точную инструкцию, но модификация неизвестна, сначала уточни её. Отделяй подтверждённые факты от предположений.`;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(API_KEY), model: MODEL });
});

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Сервер ещё не настроен: добавь GEMINI_API_KEY в .env.' });
  const { message, history = [], image = null } = req.body || {};
  if (typeof message !== 'string' || message.length > 6000) {
    return res.status(400).json({ error: 'Текст вопроса пустой или слишком длинный (максимум 6000 символов).' });
  }
  if (!Array.isArray(history) || history.length > 12) {
    return res.status(400).json({ error: 'Слишком большая история диалога. Начни новый вопрос.' });
  }
  const contents = history
    .filter(x => x && ['user', 'model'].includes(x.role) && typeof x.text === 'string')
    .map(x => ({ role: x.role, parts: [{ text: x.text.slice(0, 4000) }] }));
  const parts = [];
  if (image) {
    if (typeof image.data !== 'string' || image.data.length > 8_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
      return res.status(400).json({ error: 'Неподдерживаемое или слишком большое изображение. Используй JPEG, PNG или WebP до 6 МБ.' });
    }
    parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
  }
  parts.push({ text: message || 'Проанализируй приложенное изображение приборной панели КАМАЗ К5.' });
  contents.push({ role: 'user', parts });

  try {
    const ai = new GoogleGenAI({ apiKey: API_KEY });
    const result = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.25,
        maxOutputTokens: 1300
      }
    });
    const reply = result.text?.trim();
    if (!reply) return res.status(502).json({ error: 'Модель не вернула текстовый ответ. Попробуй ещё раз.' });
    res.json({ reply, model: MODEL });
  } catch (error) {
    console.error('Gemini request failed:', error?.status || error?.message || 'unknown error');
    const status = Number(error?.status) === 429 ? 429 : 502;
    res.status(status).json({ error: status === 429 ? 'Достигнут лимит бесплатного тарифа Gemini. Попробуй позже.' : 'Gemini временно недоступен. Проверь API-ключ, доступ к модели и подключение сервера.' });
  }
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`K5 AI listening on port ${PORT}; model=${MODEL}`));
