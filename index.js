const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const apiKey = process.env.GEMINI_API_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

// Almacenamiento temporal del historial de conversación por ID de sesión/usuario
const conversaciones = new Map();

// Instrucción de sistema para definir el rol de Yarvis
const SYSTEM_INSTRUCTION = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, atento y capaz. Mantén un tono amigable, claro y servicial. Recuerda los detalles que el usuario comparte contigo durante la conversación.`;

// Función para obtener o iniciar una sesión de chat con historial
function obtenerChatSesion(sessionId) {
  if (!conversaciones.has(sessionId)) {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      systemInstruction: SYSTEM_INSTRUCTION
    });

    const chat = model.startChat({
      history: []
    });

    conversaciones.set(sessionId, chat);
  }

  return conversaciones.get(sessionId);
}

// Endpoint de verificación
app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está activo y listo.` });
});

// Endpoint HTTP con soporte de historial (/chat)
app.post('/chat', async (req, res) => {
  try {
    const { mensaje, sessionId = 'default_user' } = req.body;
    if (!mensaje) return res.status(400).json({ error: "Escribe un mensaje en el campo 'mensaje'." });
    if (!apiKey) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Render." });

    const chat = obtenerChatSesion(sessionId);
    const result = await chat.sendMessage(mensaje);
    const response = await result.response;

    res.json({ ia: NOMBRE_IA, respuesta: response.text() });
  } catch (error) {
    if (error.message.includes('429')) {
      return res.status(429).json({ error: "Límite de mensajes alcanzado. Intenta de nuevo en un minuto." });
    }
    res.status(500).json({ error: "Error en la IA", detalle: error.message });
  }
});

// Integración de Telegram con Memoria
if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { 
    polling: {
      autoStart: true,
      params: { timeout: 10 }
    } 
  });

  bot.on('polling_error', (error) => {
    console.log("Aviso Telegram:", error.code || error.message);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeUsuario = msg.text;

    if (!mensajeUsuario) return;

    // Comando para reiniciar la memoria del chat en Telegram
    if (mensajeUsuario === '/reset') {
      conversaciones.delete(`telegram_${chatId}`);
      return bot.sendMessage(chatId, `🧠 Memoria de ${NOMBRE_IA} reiniciada para este chat.`);
    }

    if (mensajeUsuario === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. Ahora recuerdo nuestras conversaciones. Escribe /reset si quieres empezar un tema nuevo desde cero.`);
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      // Se usa el chatId de Telegram para mantener la memoria individual por usuario
      const chat = obtenerChatSesion(`telegram_${chatId}`);
      const result = await chat.sendMessage(mensajeUsuario);
      const response = await result.response;

      bot.sendMessage(chatId, response.text());
    } catch (error) {
      if (error.message.includes('429')) {
        bot.sendMessage(chatId, "⚠️ Recibí demasiados mensajes seguidos. Espera 1 minuto por favor.");
      } else {
        bot.sendMessage(chatId, "Lo siento, tuve un problema al procesar tu mensaje.");
      }
    }
  });

  console.log("Bot de Telegram activo con memoria de conversación.");
} else {
  console.log("TELEGRAM_BOT_TOKEN no detectado.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
