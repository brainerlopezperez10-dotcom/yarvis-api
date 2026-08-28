const express = require('express');
const cors = require('cors');
const path = require('path');
const Groq = require('groq-sdk');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

app.use(express.static(path.join(__dirname, 'public')));

const groqApiKey = process.env.GROQ_API_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';

const groq = new Groq({ apiKey: groqApiKey });
const NOMBRE_IA = "Yarvis";

const historialConversaciones = new Map();

const PROMPTS_MODO = {
  asistente: `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual altamente eficiente. Responde de forma concisa, clara, directa y sin rodeos.`,
  explicativo: `Tu nombre es ${NOMBRE_IA}. Eres un tutor y explicador experto. Responde de forma didáctica, detallada, estructurando la información paso a paso y usando ejemplos sencillos.`,
  creativo: `Tu nombre es ${NOMBRE_IA}. Eres un compañero creativo e imaginativo. Usa un tono expresivo, fluido y original para ayudar a redactar, idear proyectos o crear contenido.`
};

// MODELOS ACTIVOS DE GROQ
const MODELO_TEXTO = 'llama-3.1-8b-instant';
const MODELO_VISION = 'llama-3.2-11b-vision-preview';

function obtenerHistorial(sessionId, modo) {
  const keySesion = `${sessionId}_${modo}`;
  if (!historialConversaciones.has(keySesion)) {
    const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;
    historialConversaciones.set(keySesion, [
      { role: 'system', content: promptSistema }
    ]);
  }
  return historialConversaciones.get(keySesion);
}

async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType) {
  if (!groqApiKey) {
    throw new Error("Falta configurar GROQ_API_KEY en las variables de entorno.");
  }

  const historial = obtenerHistorial(sessionId, modo);

  try {
    let modelo = MODELO_TEXTO;
    let mensajesPayload = [];

    if (imagen && mimeType) {
      modelo = MODELO_VISION;
      const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;
      mensajesPayload = [
        { role: 'system', content: promptSistema },
        {
          role: 'user',
          content: [
            { type: 'text', text: mensaje || "¿Qué observas en esta foto?" },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imagen}`
              }
            }
          ]
        }
      ];
    } else {
      historial.push({ role: 'user', content: mensaje });
      mensajesPayload = historial;
    }

    const completion = await groq.chat.completions.create({
      messages: mensajesPayload,
      model: modelo,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const respuestaTexto = completion.choices[0]?.message?.content || "No pude generar una respuesta.";

    if (!imagen) {
      historial.push({ role: 'assistant', content: respuestaTexto });
    }

    return respuestaTexto;
  } catch (error) {
    console.error(`[Groq Error]:`, error.message);
    throw new Error(`Error en el servicio de Groq: ${error.message}`);
  }
}

app.post('/chat', async (req, res) => {
  try {
    const { mensaje, sessionId = 'default_user', modo = 'asistente', imagen, mimeType } = req.body;
    if (!mensaje && !imagen) return res.status(400).json({ error: "Envía un mensaje o una imagen." });

    const respuestaTexto = await procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType);
    res.json({ ia: NOMBRE_IA, respuesta: respuestaTexto });
  } catch (error) {
    console.error("Error final en /chat:", error.message);
    res.status(500).json({ error: error.message });
  }
});

if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { 
    polling: { autoStart: true, params: { timeout: 10 } } 
  });

  bot.on('polling_error', (error) => console.log("Aviso Telegram:", error.code || error.message));

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeTexto = msg.text || msg.caption || "";

    if (mensajeTexto === '/reset') {
      historialConversaciones.clear();
      return bot.sendMessage(chatId, `🧠 Memoria de ${NOMBRE_IA} reiniciada.`);
    }

    if (mensajeTexto === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. Puedes enviarme textos o imágenes.`);
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileUrl = await bot.getFileLink(fileId);
        
        const responseImage = await fetch(fileUrl);
        const arrayBuffer = await responseImage.arrayBuffer();
        const base64Image = Buffer.from(arrayBuffer).toString('base64');

        const respuesta = await procesarRespuestaIA(mensajeTexto, `telegram_${chatId}`, 'asistente', base64Image, 'image/jpeg');
        bot.sendMessage(chatId, respuesta);
      } else if (mensajeTexto) {
        const respuesta = await procesarRespuestaIA(mensajeTexto, `telegram_${chatId}`, 'asistente', null, null);
        bot.sendMessage(chatId, respuesta);
      }
    } catch (error) {
      console.error("Error Telegram:", error.message);
      bot.sendMessage(chatId, `⚠️ ${error.message}`);
    }
  });

  console.log("Bot de Telegram activo.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
