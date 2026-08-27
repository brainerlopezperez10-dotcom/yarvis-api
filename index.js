const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

const apiKey = process.env.GEMINI_API_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

// Usamos el alias explícito -latest para evitar el error 404 en la v1beta
const MODELO_PRINCIPAL = "gemini-1.5-flash-latest";

const conversaciones = new Map();

const PROMPTS_MODO = {
  asistente: `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual altamente eficiente. Responde de forma muy concisa, clara, directa y sin rodeos.`,
  explicativo: `Tu nombre es ${NOMBRE_IA}. Eres un tutor y explicador experto. Responde de forma didáctica, detallada, estructurando la información paso a paso y usando ejemplos sencillos.`,
  creativo: `Tu nombre es ${NOMBRE_IA}. Eres un compañero creativo e imaginativo. Usa un tono expresivo, fluido y original para ayudar a redactar, idear proyectos o crear contenido.`
};

async function obtenerChatSesion(sessionId, modo = 'asistente') {
  const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;
  const keySesion = `${sessionId}_${modo}`;

  if (!conversaciones.has(keySesion)) {
    const model = genAI.getGenerativeModel({ 
      model: MODELO_PRINCIPAL,
      systemInstruction: promptSistema
    });

    const chat = model.startChat({ history: [] });
    conversaciones.set(keySesion, chat);
  }
  return conversaciones.get(keySesion);
}

// INTERFAZ WEB
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${NOMBRE_IA} Copilot</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; justify-content: space-between; }
        header { background: #1e293b; padding: 12px 16px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        header h1 { color: #38bdf8; font-size: 18px; }
        .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        select { background: #0f172a; color: #38bdf8; border: 1px solid #38bdf8; border-radius: 6px; padding: 6px 10px; font-size: 13px; outline: none; }
        .btn-header { background: transparent; border: 1px solid #38bdf8; color: #38bdf8; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .btn-header.active { background: #0284c7; color: white; border-color: #0284c7; }
        .chat-box { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        .msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; word-break: break-word; position: relative; }
        .user { background: #0284c7; align-self: flex-end; }
        .yarvis { background: #334155; align-self: flex-start; border-left: 3px solid #38bdf8; padding-right: 32px; }
        .btn-speak { position: absolute; top: 8px; right: 8px; background: transparent; border: none; color: #38bdf8; cursor: pointer; font-size: 14px; opacity: 0.7; }
        .msg img { max-width: 100%; border-radius: 8px; margin-bottom: 8px; display: block; }
        .preview-area { padding: 8px 15px; background: #0f172a; display: none; align-items: center; gap: 10px; border-top: 1px solid #334155; }
        .preview-area img { height: 50px; border-radius: 6px; border: 1px solid #38bdf8; }
        .preview-area button { background: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
        .input-area { padding: 12px; background: #1e293b; display: flex; gap: 8px; border-top: 1px solid #334155; align-items: center; }
        input[type="text"] { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; outline: none; }
        .btn-action { width: 40px; height: 40px; border-radius: 8px; border: 1px solid #38bdf8; background: transparent; color: #38bdf8; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .btn-action.recording { background: #ef4444; color: white; border-color: #ef4444; }
        .btn-send { padding: 10px 16px; border-radius: 8px; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; cursor: pointer; }
        input[type="file"] { display: none; }
      </style>
    </head>
    <body>
      <header>
        <h1>🤖 ${NOMBRE_IA}</h1>
        <div class="controls">
          <label style="font-size: 12px; color: #94a3b8;">Modo:</label>
          <select id="modoSelect">
            <option value="asistente">⚡ Asistente (Directo)</option>
            <option value="explicativo">📚 Explicativo (Detallado)</option>
            <option value="creativo">🎨 Creativo (Redacción/Ideas)</option>
          </select>
          <select id="voiceSelect" title="Elegir voz">
            <option value="">Cargando voces...</option>
          </select>
          <button id="btnAutoTTS" class="btn-header" onclick="toggleAutoTTS()">🔊 Voz: OFF</button>
        </div>
      </header>
      
      <div class="chat-box" id="chat">
        <div class="msg yarvis">
          <span>¡Hola! Soy ${NOMBRE_IA}. Sistema listo para ayudarte.</span>
          <button class="btn-speak" onclick="leerTexto(this.previousElementSibling.innerText)">🔊</button>
        </div>
      </div>

      <div class="preview-area" id="previewArea">
        <img id="imgPreview" src="" alt="Vista previa">
        <span style="font-size: 12px; color: #94a3b8;">Imagen cargada</span>
        <button onclick="quitarImagen()">✕</button>
      </div>

      <div class="input-area">
        <button class="btn-action" title="Adjuntar foto" onclick="document.getElementById('fileInput').click()">+</button>
        <button class="btn-action" id="btnMic" title="Dictar por voz" onclick="toggleMic()">🎙️</button>
        <input type="file" id="fileInput" accept="image/*" onchange="seleccionarImagen(event)">
        <input type="text" id="mensaje" placeholder="Escribe tu mensaje..." onkeypress="if(event.key==='Enter') enviar()">
        <button class="btn-send" onclick="enviar()">Enviar</button>
      </div>

      <script>
        let imagenBase64 = null;
        let imagenMimeType = null;
        let reconociendo = false;
        let recognition = null;
        let vozAutomatica = false;
        let listaVoces = [];

        function cargarVoces() {
          if (!('speechSynthesis' in window)) return;
          listaVoces = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('es'));
          const select = document.getElementById('voiceSelect');
          select.innerHTML = '';

          if (listaVoces.length === 0) {
            select.innerHTML = '<option value="">Voz predeterminada</option>';
            return;
          }

          listaVoces.forEach((voz, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = voz.name + ' (' + voz.lang + ')';
            select.appendChild(option);
          });
        }

        if ('speechSynthesis' in window) {
          window.speechSynthesis.onvoiceschanged = cargarVoces;
          cargarVoces();
        }

        function leerTexto(texto) {
          if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(texto);
            utterance.lang = 'es-ES';
            const select = document.getElementById('voiceSelect');
            if (select.value !== "" && listaVoces[select.value]) {
              utterance.voice = listaVoces[select.value];
            }
            window.speechSynthesis.speak(utterance);
          }
        }

        function toggleAutoTTS() {
          vozAutomatica = !vozAutomatica;
          const btn = document.getElementById('btnAutoTTS');
          if (vozAutomatica) {
            btn.classList.add('active');
            btn.innerText = '🔊 Voz: ON';
          } else {
            btn.classList.remove('active');
            btn.innerText = '🔊 Voz: OFF';
            window.speechSynthesis.cancel();
          }
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
          recognition = new SpeechRecognition();
          recognition.lang = 'es-ES';
          recognition.continuous = false;
          recognition.interimResults = true;

          recognition.onresult = function(event) {
            let textoTranscribiendo = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              textoTranscribiendo += event.results[i][0].transcript;
            }
            document.getElementById('mensaje').value = textoTranscribiendo;
          };

          recognition.onerror = function() { detenerMic(); };
          recognition.onend = function() { detenerMic(); };
        } else {
          document.getElementById('btnMic').style.display = 'none';
        }

        function toggleMic() {
          if (!recognition) return;
          if (reconociendo) {
            recognition.stop();
            detenerMic();
          } else {
            try {
              recognition.start();
              reconociendo = true;
              document.getElementById('btnMic').classList.add('recording');
            } catch(e) {}
          }
        }

        function detenerMic() {
          reconociendo = false;
          document.getElementById('btnMic').classList.remove('recording');
        }

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
          if (reconociendo && recognition) recognition.stop();

          const input = document.getElementById('mensaje');
          const modo = document.getElementById('modoSelect').value;
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
            mensaje: texto || "¿Qué ves en esta foto?",
            sessionId: 'web_session',
            modo: modo,
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
            
            const msgDiv = document.createElement('div');
            msgDiv.className = 'msg yarvis';
            
            const spanTexto = document.createElement('span');
            spanTexto.innerText = respuesta;
            
            const btnHablar = document.createElement('button');
            btnHablar.className = 'btn-speak';
            btnHablar.innerText = '🔊';
            btnHablar.onclick = function() { leerTexto(respuesta); };
            
            msgDiv.appendChild(spanTexto);
            msgDiv.appendChild(btnHablar);
            chat.appendChild(msgDiv);
            
            chat.scrollTop = chat.scrollHeight;

            if (vozAutomatica) {
              leerTexto(respuesta);
            }
          } catch(e) {
            chat.innerHTML += '<div class="msg yarvis">Error de conexión con el servidor.</div>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// PROCESAMIENTO DIRECTO DE CONSULTAS
async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType) {
  try {
    const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;

    if (imagen && mimeType) {
      const model = genAI.getGenerativeModel({ 
        model: MODELO_PRINCIPAL,
        systemInstruction: promptSistema
      });

      const partImagen = {
        inlineData: { data: imagen, mimeType: mimeType }
      };

      const result = await model.generateContent([mensaje || "¿Qué observas en esta foto?", partImagen]);
      const response = await result.response;
      return response.text();
    } else {
      const chat = await obtenerChatSesion(sessionId, modo);
      const result = await chat.sendMessage(mensaje);
      const response = await result.response;
      return response.text();
    }
  } catch (error) {
    console.error("Error en procesarRespuestaIA:", error.message);

    if (error.message.includes('history') || error.message.includes('ChatSession')) {
      conversaciones.delete(`${sessionId}_${modo}`);
      const model = genAI.getGenerativeModel({ model: MODELO_PRINCIPAL });
      const result = await model.generateContent(mensaje);
      const response = await result.response;
      return response.text();
    }

    throw new Error(error.message);
  }
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
