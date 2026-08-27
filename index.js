const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

// Aumentamos el límite del body a 50mb para recibir capturas de pantalla de alta resolución
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

const apiKey = process.env.GEMINI_API_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está activo y listo.` });
});

// Ruta normal de texto
app.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ error: "Escribe un mensaje en el campo 'mensaje'." });
    if (!apiKey) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Render." });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente. Responde: "${mensaje}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.json({ ia: NOMBRE_IA, respuesta: response.text() });
  } catch (error) {
    if (error.message.includes('429')) {
      return res.status(429).json({ error: "Límite de mensajes alcanzado. Intenta de nuevo en un minuto." });
    }
    res.status(500).json({ error: "Error en la IA", detalle: error.message });
  }
});

// NUEVA RUTA: Procesamiento de visión (Pantalla + Texto)
app.post('/chat-vision', async (req, res) => {
  try {
    const { mensaje, imagenBase64 } = req.body;

    if (!apiKey) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Render." });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Convertimos la imagen recibida
    const partes = [];
    
    // Si viene una imagen de la pantalla
    if (imagenBase64) {
      // Limpiamos la cabecera del base64 si la incluye
      const base64Puro = imagenBase64.replace(/^data:image\/(png|jpg|jpeg);base64,/, "");
      partes.push({
        inlineData: {
          data: base64Puro,
          mimeType: "image/png"
        }
      });
    }

    const textoPrompt = mensaje 
      ? `Tu nombre es ${NOMBRE_IA}. Analiza la captura de pantalla del usuario y responde a su petición: "${mensaje}"`
      : `Tu nombre es ${NOMBRE_IA}. Observa detenidamente la pantalla del usuario y describe brevemente qué ves o qué ayuda podrías ofrecerle.`;

    partes.push(textoPrompt);

    const result = await model.generateContent(partes);
    const response = await result.response;

    res.json({ ia: NOMBRE_IA, respuesta: response.text() });
  } catch (error) {
    console.error("Error en visión:", error);
    res.status(500).json({ error: "Error procesando la pantalla", detalle: error.message });
  }
});

// Configuración del Bot de Telegram (Mantenemos tu bot activo)
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

    if (mensajeUsuario === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. ¿En qué te puedo ayudar hoy?`);
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente amigable de Telegram. Responde al usuario: "${mensajeUsuario}"`;
      const result = await model.generateContent(prompt);
      const response = await result.response;

      bot.sendMessage(chatId, response.text());
    } catch (error) {
      if (error.message.includes('429')) {
        bot.sendMessage(chatId, "⚠️ He recibido demasiados mensajes seguidos. Espera 1 minuto.");
      } else {
        bot.sendMessage(chatId, "Lo siento, tuve un problema al procesar tu mensaje.");
      }
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
