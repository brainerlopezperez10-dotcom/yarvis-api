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

// Variable global para guardar el modelo detectado
let modeloDetectado = null;
const conversaciones = new Map();

const PROMPTS_MODO = {
  asistente: `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual altamente eficiente. Responde de forma muy concisa, clara, directa y sin rodeos.`,
  explicativo: `Tu nombre es ${NOMBRE_IA}. Eres un tutor y explicador experto. Responde de forma didáctica, detallada, estructurando la información paso a paso y usando ejemplos sencillos.`,
  creativo: `Tu nombre es ${NOMBRE_IA}. Eres un compañero creativo e imaginativo. Usa un tono expresivo, fluido y original para ayudar a redactar, idear proyectos o crear contenido.`
};

// MODELOS DE RESPALDO GRATUITOS (Solo variantes Flash / LITE, excluye PRO)
const MODELOS_GRATUITOS_PREDETERMINADOS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

// Función para obtener un modelo Flash activo de la API
async function obtenerModeloDisponible() {
  if (modeloDetectado) return modeloDetectado;

  try {
    // Si el SDK soporta listar modelos, buscamos dinámicamente
    if (typeof genAI.listModels === 'function') {
      const respuesta = await genAI.listModels();
      const modelos = respuesta.models || [];
      
      // Filtramos solo modelos que soporten generación y que NO sean PRO
      const modeloFlash = modelos.find(m => 
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('flash') &&
        !m.name.includes('pro')
      );

      if (modeloFlash) {
        // Limpiamos el prefijo 'models/' si la API lo devuelve
        modeloDetectado = modeloFlash.name.replace('models/', '');
        console.log(`[IA] Modelo detectado dinámicamente: ${modeloDetectado}`);
        return modeloDetectado;
      }
    }
  } catch (err) {
    console.log('[IA] No se pudo listar los modelos dinámicamente, probando lista de respaldo gratuita...');
  }

  // Si no se pudo listar, asignamos por defecto el primer modelo de respaldo
  modeloDetectado = MODELOS_GRATUITOS_PREDETERMINADOS[0];
  console.log(`[IA] Usando modelo de respaldo: ${modeloDetectado}`);
  return modeloDetectado;
}

async function obtenerChatSesion(sessionId, modo = 'asistente') {
  const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;
  const keySesion = `${sessionId}_${modo}`;
  const nombreModelo = await obtenerModeloDisponible();

  if (!conversaciones.has(keySesion)) {
    const model = genAI.getGenerativeModel({ 
      model: nombreModelo,
      systemInstruction: promptSistema
    });

    const chat = model.startChat({ history: [] });
    conversaciones.set(keySesion, chat);
  }
  return conversaciones.get(keySesion);
}

// PROCESAMIENTO CON REINTENTO AUTOMÁTICO EN OTRO MODELO GRATUITO
async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType) {
  let nombreModelo = await obtenerModeloDisponible();
  const promptSistema = PROMPTS_MODO[modo] || PROMPTS_MODO.asistente;

  // Lista de modelos a probar en orden por si el principal falla
  const modelosAProbar = [
    nombreModelo,
    ...MODELOS_GRATUITOS_PREDETERMINADOS.filter(m => m !== nombreModelo)
  ];

  let ultimoError = null;

  for (const mod of modelosAProbar) {
    try {
      if (imagen && mimeType) {
        const model = genAI.getGenerativeModel({ 
          model: mod,
          systemInstruction: promptSistema
        });

        const partImagen = { inlineData: { data: imagen, mimeType: mimeType } };
        const result = await model.generateContent([mensaje || "¿Qué observas en esta foto?", partImagen]);
        const response = await result.response;
        
        modeloDetectado = mod; // Guardamos el modelo que sí funcionó
        return response.text();
      } else {
        const chat = await obtenerChatSesion(sessionId, modo);
        const result = await chat.sendMessage(mensaje);
        const response = await result.response;

        modeloDetectado = mod;
        return response.text();
      }
    } catch (error) {
      console.error(`[IA] Falló el modelo ${mod}: ${error.message}`);
      ultimoError = error;
      
      // Si falla, borramos la sesión guardada y reiniciamos el selector para el siguiente intento
      conversaciones.delete(`${sessionId}_${modo}`);
      modeloDetectado = null;
    }
  }

  throw new Error(`Ningún modelo gratuito disponible respondió correctamente. Último error: ${ultimoError?.message}`);
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
      modeloDetectado = null;
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
