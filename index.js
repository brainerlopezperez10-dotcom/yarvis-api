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

// Configuración de la API HTTP
app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está activo y listo.` });
});

app.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ error: "Escribe un mensaje." });

    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
    const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente. Responde: "${mensaje}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.json({ ia: NOMBRE_IA, respuesta: response.text() });
  } catch (error) {
    res.status(500).json({ error: "Error en la IA", detalle: error.message });
  }
});

// Configuración del Bot de Telegram (Polling)
if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeUsuario = msg.text;

    if (!mensajeUsuario) return;

    if (mensajeUsuario === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. ¿En qué te puedo ayudar hoy?`);
    }

    try {
      // Indicador visual de "escribiendo..." en Telegram
      bot.sendChatAction(chatId, 'typing');

      const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
      const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente amigable de Telegram. Responde al usuario: "${mensajeUsuario}"`;
      const result = await model.generateContent(prompt);
      const response = await result.response;

      bot.sendMessage(chatId, response.text());
    } catch (error) {
      console.error("Error en Telegram:", error);
      bot.sendMessage(chatId, "Lo siento, tuve un problema al procesar tu mensaje.");
    }
  });

  console.log("Bot de Telegram iniciado correctamente.");
} else {
  console.log("TELEGRAM_BOT_TOKEN no configurado.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
