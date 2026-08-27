const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

// Servir la interfaz gráfica desde la carpeta public
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.GEMINI_API_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

const conversaciones = new Map();

const PROMPTS_MODO = {
  asistente: `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual highly eficiente. Responde de forma muy concisa, clara, directa y sin rodeos.`,
  explicativo: `Tu nombre es ${NOMBRE_IA}. Eres un tutor y explicador experto. Responde de forma didáctica, detallada, estructurando la información paso a paso y usando ejemplos sencillos.`,
  creativo: `Tu nombre es ${NOMBRE_IA}. Eres un compañero creativo e imaginativo. Usa un tono expresivo, fluido y original para ayudar a redactar, idear proyectos o crear contenido.`
};

// LISTA DE MODELOS FLASH CON GEMINI 3.6 FLASH INCLUIDO
const MODELOS_GRATUITOS = [
  'gemini-3.6-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest'
];

async function obtenerChatSesion(sessionId, modo = 'asistente', modeloNombre = 'gemini-3.6-flash') {
  const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;
  const keySesion = `${sessionId}_${modo}`;

  if (!conversaciones.has(keySesion)) {
    const model = genAI.getGenerativeModel({ 
      model: modeloNombre,
      systemInstruction: promptSistema
    });

    const chat = model.startChat({ history: [] });
    conversaciones.set(keySesion, chat);
  }
  return conversaciones.get(keySesion);
}

// PROCESAMIENTO CON FALLBACK EN MODELOS FLASH
async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType) {
  const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;
  let ultimoError = null;

  for (const modeloActual of MODELOS_GRATUITOS) {
    try {
      if (imagen && mimeType) {
        const model = genAI.getGenerativeModel({ 
          model: modeloActual,
          systemInstruction: promptSistema
        });

        const partImagen = { inlineData: { data: imagen, mimeType: mimeType } };
        const result = await model.generateContent([mensaje || "¿Qué observas en esta foto?", partImagen]);
        const response = await result.response;
        return response.text();
      } else {
        const chat = await obtenerChatSesion(sessionId, modo, modeloActual);
        const result = await chat.sendMessage(mensaje);
        const response = await result.response;
        return response.text();
      }
    } catch (error) {
      console.error(`[IA] Error con el modelo ${modeloActual}: ${error.message}`);
      ultimoError = error;
      
      // Borrar sesión previa si falló para probar el siguiente modelo limpiamente
      conversaciones.delete(`${sessionId}_${modo}`);
    }
  }

  throw new Error(`No se pudo conectar a los modelos de Google. Detalle: ${ultimoError?.message}`);
}

// ENDPOINT /chat
app.post('/chat', async (req, res) => {
  try {
    const { mensaje, sessionId = 'default_user', modo = 'asistente', imagen, mimeType } = req.body;
    if (!mensaje && !imagen) return res.status(400).json({ error: "Envía un mensaje o una imagen." });
    if (!apiKey) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en las variables de entorno." });

    const respuestaTexto = await procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType);
    res.json({ ia: NOMBRE_IA, respuesta: respuestaTexto });
  } catch (error) {
    console.error("Error final en /chat:", error.message);
    res.status(500).json({ error: `Error de Google API: ${error.message}` });
  }
});

// BOT DE TELEGRAM
if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { 
    polling: { autoStart: true, params: { timeout: 10 } } 
  });

  bot.on('polling_error', (error) => console.log("Aviso Telegram:", error.code || error.message));

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeTexto = msg.text || msg.caption || "";

    if (mensajeTexto === '/reset') {
      conversaciones.clear();
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
      bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
    }
  });

  console.log("Bot de Telegram activo.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
