const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
// Aumentamos el límite del cuerpo JSON a 20mb para permitir el envío de fotografías
app.use(express.json({ limit: '20mb' }));
app.use(cors());

const apiKey = process.env.GEMINI_API_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

// Lista de modelos multimodal (texto + imágenes)
const MODELOS_GRATUITOS = [
  "gemini-3.6-flash",
  "gemini-3.0-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

let modeloActivoConfirmado = null;
const conversaciones = new Map();
const SYSTEM_INSTRUCTION = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, atento y amigable. Tienes capacidad de ver fotografías. Responde de forma clara y útil sobre lo que ves o se te consulta.`;

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

  return "gemini-3.6-flash";
}

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

// 1. INTERFAZ WEB CON BOTÓN DE ADJUNTAR IMAGEN
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
        .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; word-break: break-word; }
        .user { background: #0284c7; align-self: flex-end; }
        .yarvis { background: #334155; align-self: flex-start; border-left: 3px solid #38bdf8; }
        .msg img { max-width: 100%; border-radius: 8px; margin-bottom: 8px; display: block; }
        .preview-area { padding: 8px 15px; background: #0f172a; display: none; align-items: center; gap: 10px; border-top: 1px solid #334155; }
        .preview-area img { height: 50px; border-radius: 6px; border: 1px solid #38bdf8; }
        .preview-area button { background: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
        .input-area { padding: 15px; background: #1e293b; display: flex; gap: 8px; border-top: 1px solid #334155; align-items: center; }
        input[type="text"] { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; outline: none; }
        .btn-plus { width: 42px; height: 42px; border-radius: 8px; border: 1px solid #38bdf8; background: transparent; color: #38bdf8; font-size: 22px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .btn-send { padding: 12px 18px; border-radius: 8px; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; cursor: pointer; }
        input[type="file"] { display: none; }
      </style>
    </head>
    <body>
      <header>
        <h1>🤖 ${NOMBRE_IA} Online</h1>
      </header>
      
      <div class="chat-box" id="chat">
        <div class="msg yarvis">¡Hola! Soy ${NOMBRE_IA}. Ahora puedes presionar el botón <b>+</b> para enviarme fotos y las analizaré.</div>
      </div>

      <div class="preview-area" id="previewArea">
        <img id="imgPreview" src="" alt="Vista previa">
        <span style="font-size: 12px; color: #94a3b8;">Foto adjunta</span>
        <button onclick="quitarImagen()">✕</button>
      </div>

      <div class="input-area">
        <button class="btn-plus" onclick="document.getElementById('fileInput').click()">+</button>
        <input type="file" id="fileInput" accept="image/*" onchange="seleccionarImagen(event)">
        <input type="text" id="mensaje" placeholder="Escribe tu mensaje o pregunta sobre la foto..." onkeypress="if(event.key==='Enter') enviar()">
        <button class="btn-send" onclick="enviar()">Enviar</button>
      </div>

      <script>
        let imagenBase64 = null;
        let imagenMimeType = null;

        function seleccionarImagen(e) {
          const file = e.target.files[0];
          if (!file) return;

          imagenMimeType = file.type;
          const reader = new FileReader();
          reader.onload = function(evt) {
            imagenBase64 = evt.target.result.split(',')[1];
            document.getElementById('imgPreview').src = evt.target.result;
            document.getElementById('previewArea').style.display = 'flex';
          };
          reader.readAsDataURL(file);
        }

        function quitarImagen() {
          imagenBase64 = null;
          imagenMimeType = null;
          document.getElementById('fileInput').value = '';
          document.getElementById('previewArea').style.display = 'none';
        }

        async function enviar() {
          const input = document.getElementById('mensaje');
          const texto = input.value.trim();
          
          if (!texto && !imagenBase64) return;

          const chat = document.getElementById('chat');
          let contenidoUsuario = '';

          if (imagenBase64) {
            contenidoUsuario += '<img src="data:' + imagenMimeType + ';base64,' + imagenBase64 + '">';
          }
          if (texto) {
            contenidoUsuario += '<div>' + texto + '</div>';
          }

          chat.innerHTML += '<div class="msg user">' + contenidoUsuario + '</div>';
          
          const payload = {
            mensaje: texto || "¿Qué ves en esta imagen?",
            sessionId: 'web_session',
            imagen: imagenBase64,
            mimeType: imagenMimeType
          };

          input.value = '';
          quitarImagen();
          chat.scrollTop = chat.scrollHeight;

          try {
            const res = await fetch('/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
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

// 2. ENDPOINT /chat ADAPTADO PARA VISIÓN MULTIMODAL
app.post('/chat', async (req, res) => {
  try {
    const { mensaje, sessionId = 'default_user', imagen, mimeType } = req.body;
    if (!mensaje && !imagen) return res.status(400).json({ error: "Envía un mensaje o una imagen." });
    if (!apiKey) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Render." });

    let respuestaTexto = "";
    const nombreModelo = await obtenerModeloValido();

    // Si viene una imagen adjunta, la procesamos directamente con el modelo multimodal
    if (imagen && mimeType) {
      const model = genAI.getGenerativeModel({ 
        model: nombreModelo,
        systemInstruction: SYSTEM_INSTRUCTION
      });

      const partImagen = {
        inlineData: {
          data: imagen,
          mimeType: mimeType
        }
      };

      const result = await model.generateContent([mensaje || "¿Qué observas en esta foto?", partImagen]);
      const response = await result.response;
      respuestaTexto = response.text();
    } else {
      // Flujo conversacional normal sólo texto
      try {
        const chat = await obtenerChatSesion(sessionId);
        const result = await chat.sendMessage(mensaje);
        const response = await result.response;
        respuestaTexto = response.text();
      } catch (e) {
        conversaciones.delete(sessionId);
        modeloActivoConfirmado = null;
        const model = genAI.getGenerativeModel({ model: nombreModelo });
        const result = await model.generateContent(`Tu nombre es ${NOMBRE_IA}. Responde: "${mensaje}"`);
        const response = await result.response;
        respuestaTexto = response.text();
      }
    }

    res.json({ ia: NOMBRE_IA, respuesta: respuestaTexto });
  } catch (error) {
    console.error("Error en /chat:", error.message);
    if (error.message.includes('429')) {
      return res.status(429).json({ error: "Límite de mensajes alcanzado. Espera un minuto." });
    }
    res.status(500).json({ error: "Error procesando la solicitud", detalle: error.message });
  }
});

// 3. BOT DE TELEGRAM (SOPORTE PARA FOTOS EN TELEGRAM)
if (telegramToken) {
  const bot = new TelegramBot(telegramToken, { 
    polling: { autoStart: true, params: { timeout: 10 } } 
  });

  bot.on('polling_error', (error) => console.log("Aviso Telegram:", error.code || error.message));

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const mensajeTexto = msg.text || msg.caption || "";

    if (mensajeTexto === '/reset') {
      conversaciones.delete(`telegram_${chatId}`);
      return bot.sendMessage(chatId, `🧠 Memoria de ${NOMBRE_IA} reiniciada.`);
    }

    if (mensajeTexto === '/start') {
      return bot.sendMessage(chatId, `¡Hola! Soy ${NOMBRE_IA}. Puedes enviarme textos o fotografías y las analizaré.`);
    }

    try {
      bot.sendChatAction(chatId, 'typing');
      const nombreModelo = await obtenerModeloValido();

      if (msg.photo) {
        // Obtenemos la foto de mayor resolución enviada por el usuario
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileUrl = await bot.getFileLink(fileId);
        
        // Descargamos la imagen como buffer y la convertimos a base64
        const responseImage = await fetch(fileUrl);
        const arrayBuffer = await responseImage.arrayBuffer();
        const base64Image = Buffer.from(arrayBuffer).toString('base64');

        const model = genAI.getGenerativeModel({ 
          model: nombreModelo,
          systemInstruction: SYSTEM_INSTRUCTION
        });

        const partImagen = {
          inlineData: {
            data: base64Image,
            mimeType: 'image/jpeg'
          }
        };

        const result = await model.generateContent([mensajeTexto || "¿Qué ves en esta foto?", partImagen]);
        const response = await result.response;
        bot.sendMessage(chatId, response.text());
      } else if (mensajeTexto) {
        const sessionKey = `telegram_${chatId}`;
        try {
          const chat = await obtenerChatSesion(sessionKey);
          const result = await chat.sendMessage(mensajeTexto);
          const response = await result.response;
          bot.sendMessage(chatId, response.text());
        } catch (e) {
          conversaciones.delete(sessionKey);
          modeloActivoConfirmado = null;
          const model = genAI.getGenerativeModel({ model: nombreModelo });
          const result = await model.generateContent(`Tu nombre es ${NOMBRE_IA}. Responde: "${mensajeTexto}"`);
          const response = await result.response;
          bot.sendMessage(chatId, response.text());
        }
      }
    } catch (error) {
      console.error("Error Telegram:", error.message);
      bot.sendMessage(chatId, "Tuve un inconveniente al procesar tu mensaje o foto.");
    }
  });

  console.log("Bot de Telegram activo con visión.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
