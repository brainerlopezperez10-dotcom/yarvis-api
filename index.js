require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');
const TelegramBot = require('node-telegram-bot-api');

// ─── CONFIGURACIÓN Y VALIDACIÓN DE ENTORNO ─────────────────────────────────
const NOMBRE_IA = 'Yarvis';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

if (!GROQ_API_KEY) {
  console.error('❌ Falta GROQ_API_KEY en las variables de entorno. Cerrando proceso.');
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ─── LÍMITES DE HISTORIAL Y SESIONES (evita fuga de memoria) ───────────────
const MAX_MENSAJES_HISTORIAL = 20; // además del system prompt
const TTL_SESION_MS = 1000 * 60 * 60 * 2; // 2 horas de inactividad
const MAX_IMAGEN_BYTES = 8 * 1024 * 1024; // ~8MB en binario (base64 pesa ~33% más)

// historial[key] = { mensajes: [...], ultimaActividad: timestamp }
const historialConversaciones = new Map();

// Limpieza periódica de sesiones inactivas
setInterval(() => {
  const ahora = Date.now();
  for (const [key, sesion] of historialConversaciones.entries()) {
    if (ahora - sesion.ultimaActividad > TTL_SESION_MS) {
      historialConversaciones.delete(key);
    }
  }
}, 1000 * 60 * 15); // revisa cada 15 min

const PROMPTS_MODO = {
  asistente: `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual altamente eficiente. Responde de forma concisa, clara, directa y sin rodeos.`,
  explicativo: `Tu nombre es ${NOMBRE_IA}. Eres un tutor y explicador experto. Responde de forma didáctica, detallada, estructurando la información paso a paso y usando ejemplos sencillos.`,
  creativo: `Tu nombre es ${NOMBRE_IA}. Eres un compañero creativo e imaginativo. Usa un tono expresivo, fluido y original para ayudar a redactar, idear proyectos o crear contenido.`,
  busqueda: `Tu nombre es ${NOMBRE_IA}. Tienes acceso a búsqueda web en tiempo real. Úsala cuando el usuario pida información actual, noticias, precios, resultados deportivos o cualquier dato que pueda haber cambiado recientemente. Cita brevemente de dónde sale la información cuando sea relevante.`,
};

const MODOS_VALIDOS = Object.keys(PROMPTS_MODO);
const MODELO_TEXTO = 'openai/gpt-oss-20b';
const MODELO_VISION = 'qwen/qwen3.6-27b';
const MODELO_BUSQUEDA = 'groq/compound'; // modelo gratuito de Groq con búsqueda web integrada
const MODELO_STT = 'whisper-large-v3-turbo'; // voz -> texto
const MODELO_TTS = 'playai-tts'; // texto -> voz (verifica en console.groq.com si tu cuenta lo tiene habilitado/gratuito)
const VOZ_TTS = 'Aaliyah-PlayAI';
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // ~15MB en binario

// ─── APP EXPRESS ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '15mb' })); // suficiente para imágenes base64 + margen

app.use(
  cors(
    ALLOWED_ORIGINS.length > 0
      ? { origin: ALLOWED_ORIGINS }
      : {} // si no se define, permite todo (recomendado solo en desarrollo)
  )
);

app.use(express.static(path.join(__dirname, 'public')));

// Limita abusos al endpoint de chat (100 solicitudes cada 15 min por IP)
const limitadorChat = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
});

// ─── UTILIDADES DE HISTORIAL ────────────────────────────────────────────────
function obtenerHistorial(sessionId, modo) {
  const keySesion = `${sessionId}_${modo}`;
  const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;

  if (!historialConversaciones.has(keySesion)) {
    historialConversaciones.set(keySesion, {
      mensajes: [{ role: 'system', content: promptSistema }],
      ultimaActividad: Date.now(),
    });
  }

  const sesion = historialConversaciones.get(keySesion);
  sesion.ultimaActividad = Date.now();
  return sesion;
}

// Mantiene el system prompt + últimos N mensajes para no exceder tokens/costo
function recortarHistorial(sesion) {
  const [system, ...resto] = sesion.mensajes;
  if (resto.length > MAX_MENSAJES_HISTORIAL) {
    sesion.mensajes = [system, ...resto.slice(resto.length - MAX_MENSAJES_HISTORIAL)];
  }
}

// ─── LÓGICA PRINCIPAL DE IA ─────────────────────────────────────────────────
async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType) {
  const modoFinal = MODOS_VALIDOS.includes(modo) ? modo : 'asistente';
  const sesion = obtenerHistorial(sessionId, modoFinal);

  let modelo = MODELO_TEXTO;
  let mensajesPayload;

  try {
    if (imagen && mimeType) {
      // Valida tamaño aproximado antes de enviarlo (protege memoria/costo)
      const bytesAprox = Buffer.byteLength(imagen, 'base64');
      if (bytesAprox > MAX_IMAGEN_BYTES) {
        throw new Error('La imagen supera el tamaño máximo permitido (8MB).');
      }

      modelo = MODELO_VISION;
      const promptSistema = PROMPTS_MODO[modoFinal];
      mensajesPayload = [
        { role: 'system', content: promptSistema },
        {
          role: 'user',
          content: [
            { type: 'text', text: mensaje || '¿Qué observas en esta foto?' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imagen}` } },
          ],
        },
      ];
    } else {
      if (modoFinal === 'busqueda') {
        modelo = MODELO_BUSQUEDA;
      }
      sesion.mensajes.push({ role: 'user', content: mensaje });
      recortarHistorial(sesion);
      mensajesPayload = sesion.mensajes;
    }

    const completion = await groq.chat.completions.create({
      messages: mensajesPayload,
      model: modelo,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const respuestaTexto = completion.choices[0]?.message?.content || 'No pude generar una respuesta.';

    if (!imagen) {
      sesion.mensajes.push({ role: 'assistant', content: respuestaTexto });
      recortarHistorial(sesion);
    }

    return respuestaTexto;
  } catch (error) {
    console.error('[Groq Error]:', error.message);
    // Mensaje genérico hacia el cliente; el detalle queda solo en el log del servidor
    throw new Error('Ocurrió un error al generar la respuesta. Intenta de nuevo.');
  }
}

// ─── ENDPOINT /chat ─────────────────────────────────────────────────────────
app.post('/chat', limitadorChat, async (req, res) => {
  try {
    const { mensaje, sessionId = 'default_user', modo = 'asistente', imagen, mimeType } = req.body;

    if (!mensaje && !imagen) {
      return res.status(400).json({ error: 'Envía un mensaje o una imagen.' });
    }
    if (typeof sessionId !== 'string' || sessionId.length > 100) {
      return res.status(400).json({ error: 'sessionId inválido.' });
    }
    if (imagen && !mimeType) {
      return res.status(400).json({ error: 'Falta mimeType para la imagen.' });
    }

    const respuestaTexto = await procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType);
    res.json({ ia: NOMBRE_IA, respuesta: respuestaTexto });
  } catch (error) {
    console.error('Error final en /chat:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de salud, útil para monitoreo/despliegues
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ia: NOMBRE_IA, sesionesActivas: historialConversaciones.size });
});

// ─── VOZ: TRANSCRIPCIÓN (audio -> texto) ───────────────────────────────────
app.post('/transcribir', limitadorChat, async (req, res) => {
  let rutaTemporal = null;
  try {
    const { audio, mimeType = 'audio/webm' } = req.body;
    if (!audio) return res.status(400).json({ error: 'Envía el audio en base64 en el campo "audio".' });

    const bytesAprox = Buffer.byteLength(audio, 'base64');
    if (bytesAprox > MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'El audio supera el tamaño máximo permitido (15MB).' });
    }

    // Groq necesita un archivo real (stream), así que lo guardamos temporalmente
    const extension = mimeType.includes('mp3') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'webm';
    rutaTemporal = path.join(os.tmpdir(), `yarvis_${crypto.randomUUID()}.${extension}`);
    fs.writeFileSync(rutaTemporal, Buffer.from(audio, 'base64'));

    const transcripcion = await groq.audio.transcriptions.create({
      file: fs.createReadStream(rutaTemporal),
      model: MODELO_STT,
    });

    res.json({ texto: transcripcion.text || '' });
  } catch (error) {
    console.error('[Groq STT Error]:', error.message);
    res.status(500).json({ error: 'No se pudo transcribir el audio. Intenta de nuevo.' });
  } finally {
    if (rutaTemporal && fs.existsSync(rutaTemporal)) fs.unlinkSync(rutaTemporal);
  }
});

// ─── VOZ: SÍNTESIS (texto -> audio) ─────────────────────────────────────────
app.post('/hablar', limitadorChat, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Envía el texto a convertir en voz.' });
    if (texto.length > 2000) return res.status(400).json({ error: 'El texto es demasiado largo (máx. 2000 caracteres).' });

    const respuestaGroq = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELO_TTS,
        input: texto,
        voice: VOZ_TTS,
        response_format: 'mp3',
      }),
    });

    if (!respuestaGroq.ok) {
      const detalle = await respuestaGroq.text();
      throw new Error(`Groq TTS respondió ${respuestaGroq.status}: ${detalle}`);
    }

    const arrayBuffer = await respuestaGroq.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
    res.json({ audio: audioBase64, mimeType: 'audio/mpeg' });
  } catch (error) {
    console.error('[Groq TTS Error]:', error.message);
    res.status(500).json({ error: 'No se pudo generar el audio. Intenta de nuevo.' });
  }
});

// ─── BOT DE TELEGRAM ────────────────────────────────────────────────────────
if (TELEGRAM_TOKEN) {
  const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { autoStart: true, params: { timeout: 10 } },
  });

  bot.on('polling_error', (error) => console.log('Aviso Telegram:', error.code || error.message));

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeTexto = msg.text || msg.caption || '';
    const sessionKey = `telegram_${chatId}`;

    if (mensajeTexto === '/reset') {
      // Borra solo la sesión de este chat, no toda la memoria del bot
      for (const key of historialConversaciones.keys()) {
        if (key.startsWith(sessionKey)) historialConversaciones.delete(key);
      }
      return bot.sendMessage(chatId, `🧠 Memoria de ${NOMBRE_IA} reiniciada para este chat.`);
    }

    if (mensajeTexto === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. Puedes enviarme textos o imágenes. Usa /buscar seguido de tu pregunta para búsquedas con información actual de internet.`);
    }

    if (mensajeTexto.startsWith('/buscar')) {
      const pregunta = mensajeTexto.replace('/buscar', '').trim();
      if (!pregunta) {
        return bot.sendMessage(chatId, 'Escribe tu pregunta después de /buscar. Ejemplo: /buscar clima hoy en Bogotá');
      }
      try {
        bot.sendChatAction(chatId, 'typing');
        const respuesta = await procesarRespuestaIA(pregunta, sessionKey, 'busqueda', null, null);
        return bot.sendMessage(chatId, respuesta);
      } catch (error) {
        console.error('Error Telegram (/buscar):', error.message);
        return bot.sendMessage(chatId, `⚠️ ${error.message}`);
      }
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileUrl = await bot.getFileLink(fileId);

        const responseImage = await fetch(fileUrl);
        if (!responseImage.ok) throw new Error('No se pudo descargar la imagen de Telegram.');

        const arrayBuffer = await responseImage.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGEN_BYTES) {
          return bot.sendMessage(chatId, '⚠️ La imagen es demasiado grande (máx. 8MB).');
        }

        const base64Image = Buffer.from(arrayBuffer).toString('base64');
        const respuesta = await procesarRespuestaIA(mensajeTexto, sessionKey, 'asistente', base64Image, 'image/jpeg');
        bot.sendMessage(chatId, respuesta);
      } else if (mensajeTexto) {
        const respuesta = await procesarRespuestaIA(mensajeTexto, sessionKey, 'asistente', null, null);
        bot.sendMessage(chatId, respuesta);
      }
    } catch (error) {
      console.error('Error Telegram:', error.message);
      bot.sendMessage(chatId, `⚠️ ${error.message}`);
    }
  });

  console.log('Bot de Telegram activo.');
}

// ─── ARRANQUE Y CIERRE ORDENADO ─────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));

process.on('SIGTERM', () => {
  console.log('Cerrando servidor...');
  server.close(() => process.exit(0));
});
  
