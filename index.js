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

// Almacenamiento temporal del historial de conversación por usuario/sesión
const conversaciones = new Map();

const SYSTEM_INSTRUCTION = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, atento y amigable. Responde de forma clara y útil.`;

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

// 1. PÁGINA PRINCIPAL INTERACTIVA (Interfaz Web de Chat en Render)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${NOMBRE_IA} - Chat Web</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, sans-serif; }
        body { background: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 10px; }
        .chat-card { background: #1e293b; width: 100%; max-width: 500px; height: 90vh; border-radius: 16px; border: 1px solid #334155; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        .header { background: #0f172a; padding: 16px; text-align: center; border-bottom: 1px solid #334155; }
        .header h2 { color: #38bdf8; font-size: 18px; }
        .chat-box { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
        .user { background: #0284c7; align-self: flex-end; }
        .yarvis { background: #334155; align-self: flex-start; border-left: 3px solid #38bdf8; }
        .input-area { padding: 12px; background: #0f172a; display: flex; gap: 8px; border-top: 1px solid #334155; }
        input { flex: 1; background: #1e293b; border: 1px solid #334155; padding: 10px; border-radius: 8px; color: #fff; outline: none; }
        button { background: #38bdf8; color: #0f172a; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="chat-card">
        <div class="header">
          <h2>🤖 ${NOMBRE_IA} Online</h2>
        </div>
        <div class="chat-box" id="chat">
          <div class="msg yarvis">¡Hola! Soy ${NOMBRE_IA}. ¿En qué te puedo ayudar hoy?</div>
        </div>
        <div class="input-area">
          <input type="text" id="inputMsg" placeholder="Escribe un mensaje..." onkeypress="if(event.key==='Enter') enviar()">
          <button onclick="enviar()">Enviar</button>
        </div>
      </div>
      <script>
        async function enviar() {
          const input = document.getElementById('inputMsg');
          const txt = input.value.trim();
          if(!txt) return;
          input.value = '';

          const chat = document.getElementById('chat');
          chat.innerHTML += '<div class="msg user">' + txt + '</div>';
          chat.scrollTop = chat.scrollHeight;

          try {
            const res = await fetch('/chat', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ mensaje: txt, sessionId: 'web_session' })
            });
            const data = await res.json();
            const resp = data.respuesta || data.error;
            chat.innerHTML += '<div class="msg yarvis">' + resp + '</div>';
            chat.scrollTop = chat.scrollHeight;
          } catch(e) {
            chat.innerHTML += '<div class="msg yarvis">Error al conectar con la IA.</div>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. ENDPOINT API HTTP (/chat)
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
    console.error("Error HTTP Chat:", error);
    if (error.message.includes('429')) {
      return res.status(429).json({ error: "Límite de mensajes alcanzado. Espera un minuto." });
    }
    // Si la memoria falla, reiniciamos la sesión y reintentamos una vez de forma segura
    conversaciones.delete(req.body.sessionId || 'default_user');
    res.status(500).json({ error: "Error procesando la solicitud", detalle: error.message });
  }
});

// 3. BOT DE TELEGRAM (Con manejo seguro de errores)
if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { 
    polling: {
      autoStart: true,
      params: { timeout: 10 }
    } 
  });

  bot.on('polling_error', (error) => {
    console.log("Aviso Telegram Polling:", error.code || error.message);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeUsuario = msg.text;

    if (!mensajeUsuario) return;

    if (mensajeUsuario === '/reset') {
      conversaciones.delete(`telegram_${chatId}`);
      return bot.sendMessage(chatId, `🧠 Memoria de ${NOMBRE_IA} reiniciada para este chat.`);
    }

    if (mensajeUsuario === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. Escribe tu mensaje o usa /reset para reiniciar la conversación.`);
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      const chat = obtenerChatSesion(`telegram_${chatId}`);
      const result = await chat.sendMessage(mensajeUsuario);
      const response = await result.response;

      bot.sendMessage(chatId, response.text());
    } catch (error) {
      console.error("Error Telegram:", error);

      if (error.message && error.message.includes('429')) {
        bot.sendMessage(chatId, "⚠️ Recibí demasiados mensajes seguidos. Espera 1 minuto por favor.");
      } else {
        // En caso de fallo en la sesión guardada, se limpia la memoria para desbloquear al usuario
        conversaciones.delete(`telegram_${chatId}`);
        bot.sendMessage(chatId, "Tuve un pequeño problema con la memoria previa del chat, pero ya la reinicié. Por favor vuelve a enviarme tu mensaje.");
      }
    }
  });

  console.log("Bot de Telegram activo correctamente.");
} else {
  console.log("TELEGRAM_BOT_TOKEN no configurado.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
