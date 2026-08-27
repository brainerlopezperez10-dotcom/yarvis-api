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

// Lista de modelos actualizada con gemini-3.6-flash
const MODELOS_GRATUITOS = [
  "gemini-3.6-flash",
  "gemini-3.0-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

// Estado global del modelo activo detectado
let modeloActivoConfirmado = null;

// Almacenamiento temporal de sesiones
const conversaciones = new Map();
const SYSTEM_INSTRUCTION = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, atento y amigable. Responde de forma clara y útil.`;

// Detectar automáticamente qué modelo está habilitado en tu API Key
async function obtenerModeloValido() {
  if (modeloActivoConfirmado) return modeloActivoConfirmado;

  for (const nombreModelo of MODELOS_GRATUITOS) {
    try {
      const model = genAI.getGenerativeModel({ model: nombreModelo });
      const test = await model.generateContent("Hola");
      const res = await test.response;
      if (res.text()) {
        console.log(`✅ Modelo verificado y activo: ${nombreModelo}`);
        modeloActivoConfirmado = nombreModelo;
        return nombreModelo;
      }
    } catch (error) {
      console.log(`⚠️ Modelo ${nombreModelo} no disponible, probando siguiente...`);
    }
  }

  // Fallback directo a gemini-3.6-flash
  return "gemini-3.6-flash";
}

// Obtener o crear sesión de chat vinculada al modelo verificado
async function obtenerChatSesion(sessionId) {
  const nombreModelo = await obtenerModeloValido();

  if (!conversaciones.has(sessionId)) {
    const model = genAI.getGenerativeModel({ 
      model: nombreModelo,
      systemInstruction: SYSTEM_INSTRUCTION
    });

    const chat = model.startChat({ history: [] });
    conversaciones.set(sessionId, chat);
  }
  return conversaciones.get(sessionId);
}

// 1. INTERFAZ WEB DE RENDER
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${NOMBRE_IA} Chat</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; justify-content: space-between; }
        header { background: #1e293b; padding: 15px; text-align: center; border-bottom: 1px solid #334155; }
        header h1 { color: #38bdf8; font-size: 20px; }
        .chat-box { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
        .user { background: #0284c7; align-self: flex-end; }
        .yarvis { background: #334155; align-self: flex-start; border-left: 3px solid #38bdf8; }
        .input-area { padding: 15px; background: #1e293b; display: flex; gap: 10px; border-top: 1px solid #334155; }
        input { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; outline: none; }
        button { padding: 12px 20px; border-radius: 8px; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; cursor: pointer; }
      </style>
    </head>
    <body>
      <header>
        <h1>🤖 ${NOMBRE_IA} Online</h1>
      </header>
      <div class="chat-box" id="chat">
        <div class="msg yarvis">¡Hola! Soy ${NOMBRE_IA}. ¿En qué te puedo ayudar hoy?</div>
      </div>
      <div class="input-area">
        <input type="text" id="mensaje" placeholder="Escribe tu mensaje..." onkeypress="if(event.key==='Enter') enviar()">
        <button onclick="enviar()">Enviar</button>
      </div>

      <script>
        async function enviar() {
          const input = document.getElementById('mensaje');
          const texto = input.value.trim();
          if(!texto) return;

          const chat = document.getElementById('chat');
          chat.innerHTML += '<div class="msg user">' + texto + '</div>';
          input.value = '';
          chat.scrollTop = chat.scrollHeight;

          try {
            const res = await fetch('/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mensaje: texto, sessionId: 'web_session' })
            });
            const data = await res.json();
            const respuesta = data.respuesta || data.error || 'Sin respuesta';
            chat.innerHTML += '<div class="msg yarvis">' + respuesta + '</div>';
            chat.scrollTop = chat.scrollHeight;
          } catch(e) {
            chat.innerHTML += '<div class="msg yarvis">Error de conexión con el servidor.</div>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. RUTA HTTP /chat
app.post('/chat', async (req, res) => {
  try {
    const { mensaje, sessionId = 'default_user' } = req.body;
    if (!mensaje) return res.status(400).json({ error: "Escribe un mensaje." });
    if (!apiKey) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Render." });

    let respuestaTexto = "";

    try {
      const chat = await obtenerChatSesion(sessionId);
      const result = await chat.sendMessage(mensaje);
      const response = await result.response;
      respuestaTexto = response.text();
    } catch (e) {
      conversaciones.delete(sessionId);
      modeloActivoConfirmado = null; // Reiniciamos verificación si falla
      const nombreModelo = await obtenerModeloValido();
      const model = genAI.getGenerativeModel({ model: nombreModelo });
      const result = await model.generateContent(`Tu nombre es ${NOMBRE_IA}. Responde: "${mensaje}"`);
      const response = await result.response;
      respuestaTexto = response.text();
    }

    res.json({ ia: NOMBRE_IA, respuesta: respuestaTexto });
  } catch (error) {
    console.error("Error en /chat:", error.message);
    if (error.message.includes('429')) {
      return res.status(429).json({ error: "Límite de mensajes alcanzado. Espera un minuto." });
    }
    res.status(500).json({ error: "Error en la IA", detalle: error.message });
  }
});

// 3. BOT DE TELEGRAM
if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { 
    polling: { autoStart: true, params: { timeout: 10 } } 
  });

  bot.on('polling_error', (error) => console.log("Aviso Telegram:", error.code || error.message));

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeUsuario = msg.text;

    if (!mensajeUsuario) return;

    if (mensajeUsuario === '/reset') {
      conversaciones.delete(`telegram_${chatId}`);
      return bot.sendMessage(chatId, `🧠 Memoria de ${NOMBRE_IA} reiniciada.`);
    }

    if (mensajeUsuario === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. ¿En qué puedo ayudarte?`);
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      let respuestaTexto = "";
      const sessionKey = `telegram_${chatId}`;

      try {
        const chat = await obtenerChatSesion(sessionKey);
        const result = await chat.sendMessage(mensajeUsuario);
        const response = await result.response;
        respuestaTexto = response.text();
      } catch (e) {
        conversaciones.delete(sessionKey);
        modeloActivoConfirmado = null;
        const nombreModelo = await obtenerModeloValido();
        const model = genAI.getGenerativeModel({ model: nombreModelo });
        const result = await model.generateContent(`Tu nombre es ${NOMBRE_IA}. Responde: "${mensajeUsuario}"`);
        const response = await result.response;
        respuestaTexto = response.text();
      }

      bot.sendMessage(chatId, respuestaTexto);
    } catch (error) {
      console.error("Error Telegram:", error.message);
      if (error.message.includes('429')) {
        bot.sendMessage(chatId, "⚠️ Recibí demasiados mensajes seguidos. Espera 1 minuto por favor.");
      } else {
        bot.sendMessage(chatId, "Lo siento, tuve un problema al procesar tu mensaje.");
      }
    }
  });

  console.log("Bot de Telegram activo.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
