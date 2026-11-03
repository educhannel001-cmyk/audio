import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));

// Shared Gemini client utility with User-Agent header for telemetry
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

// TTS generation endpoint
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voiceName, seed } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text prompt is required.' });
    }

    const ai = getGeminiClient();

    let response;
    const modelsToTry = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];
    let lastError: any = null;

    for (const model of modelsToTry) {
      try {
        response = await ai.models.generateContent({
          model,
          contents: [{ parts: [{ text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            seed: typeof seed === 'number' ? seed : undefined,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceName || 'Puck' },
              },
            },
          },
        });
        if (response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
          lastError = null;
          break;
        }
      } catch (err: any) {
        console.warn(`TTS generation with model ${model} failed:`, err?.message || err);
        lastError = err;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    const part = response.candidates?.[0]?.content?.parts?.[0];
    const audioData = part?.inlineData?.data;
    const mimeType = part?.inlineData?.mimeType;

    if (!audioData) {
      return res.status(500).json({ error: 'No audio data received from Gemini model.' });
    }

    return res.json({ audioData, mimeType });
  } catch (error: any) {
    console.error('Server TTS Error:', error);
    const message = error instanceof Error ? error.message : String(error);
    const isSpendingCap = /spending cap|monthly spending cap/i.test(message);
    const isQuota = isSpendingCap || error?.status === 429 || /429|quota|exhausted|rate limit|too many requests/i.test(message);
    const status = isQuota ? 429 : (error?.status || 500);

    let userFacingMessage = message;
    if (isSpendingCap) {
      userFacingMessage = 'Google AI Studio 프로젝트의 월간 지출 한도(Monthly Spending Cap)가 초과되었습니다. ai.studio/spend 에서 한도를 상향 조정하거나 새 프로젝트/계정으로 실행해주세요.';
    } else {
      try {
        const parsed = JSON.parse(message);
        if (parsed?.error?.message) {
          userFacingMessage = parsed.error.message;
        }
      } catch (e) {}
    }

    return res.status(status).json({ error: userFacingMessage, isQuota, isSpendingCap });
  }
});

// Streaming TTS endpoint for progressive audio chunks
app.post('/api/tts/stream', async (req, res) => {
  try {
    const { text, voiceName, seed } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text prompt is required.' });
    }

    const ai = getGeminiClient();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        seed: typeof seed === 'number' ? seed : undefined,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName || 'Puck' },
          },
        },
      },
    });

    for await (const chunk of responseStream) {
      const data = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (data) {
        res.write(`data: ${JSON.stringify({ audio: data })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Server TTS Stream Error:', error);
    if (!res.headersSent) {
      const status = error?.status || 500;
      const message = error instanceof Error ? error.message : String(error);
      return res.status(status).json({ error: message });
    }
    res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
    res.end();
  }
});

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
