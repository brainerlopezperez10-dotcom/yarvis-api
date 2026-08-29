require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');
const os = require('os');

const app = express();

// ============================================================
// CONFIGURACIÓN
// ============================================================

const NOMBRE_IA = 'Yarvis';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error('Falta GROQ_API_KEY');
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ============================================================
// MODELOS
// ============================================================

const MODELO_TEXTO = 'openai/gpt-oss-20b';
const MODELO_VISION = 'qwen/qwen3.6-27b';
const MODELO_BUSQUEDA = 'groq/compound';
const MODELO_STT = 'whisper-large-v3-turbo';
const MODELO_TTS = 'canopylabs/orpheus-v1-english';
const VOZ_TTS = 'Tara';

// ============================================================
// AGENTES ESPECIALIZADOS
// ============================================================

const AGENTES = {
  yarvis: {
    nombre: 'Yarvis',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Yarvis. Eres el asistente principal, rápido, inteligente, útil y amigable. Responde en español salvo que el usuario pida otro idioma. Sé claro, directo y útil. No inventes información.'
  },
  atlas: {
    nombre: 'Atlas',
    modelo: MODELO_BUSQUEDA,
    prompt: 'Tu nombre es Atlas. Eres un investigador experto. Analizas cuidadosamente las preguntas, distingues hechos de opiniones y usas información actualizada cuando está disponible. Resume primero la respuesta principal y después los detalles importantes. Siempre menciona las fuentes cuando uses búsqueda.'
  },
  code: {
    nombre: 'Code',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Code. Eres un programador experto. Puedes ayudar con JavaScript, Node.js, HTML, CSS, Python, APIs, Express, bases de datos, GitHub y Render. Cuando escribas código: 1. Explica brevemente qué hace. 2. Entrega código completo cuando sea necesario. 3. Indica dónde colocarlo. 4. Evita complicaciones innecesarias.'
  },
  nova: {
    nombre: 'Nova',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Nova. Eres un asistente creativo. Ayudas a crear historias, nombres, diseños, ideas, proyectos, guiones, publicaciones, conceptos y textos persuasivos. Sé original, inspirador y práctico.'
  },
  lumen: {
    nombre: 'Lumen',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Lumen. Eres un tutor experto. Explicas cualquier tema paso a paso, con ejemplos sencillos y claros. Responde en español salvo que el usuario pida otro idioma. Tu objetivo es que la persona realmente entienda.'
  }
};

// ============================================================
// DETECCIÓN DE AGENTE
// ============================================================

function detectarAgente(mensaje) {
  if (!mensaje || typeof mensaje !== 'string') return 'yarvis';

  const texto = mensaje.toLowerCase().trim();

  if (texto.startsWith('/atlas') || texto.startsWith('/investigar')) return 'atlas';
  if (texto.startsWith('/code') || texto.startsWith('/programar')) return 'code';
  if (texto.startsWith('/nova') || texto.startsWith('/crear') || texto.startsWith('/idea')) return 'nova';
  if (texto.startsWith('/lumen') || texto.startsWith('/explicar')) return 'lumen';
  if (texto.startsWith('/yarvis')) return 'yarvis';

  const reglas = [
    { agente: 'atlas', palabras: ['busca', 'investiga', 'información actual', 'noticias', 'precio de', 'qué pasó', 'últimas', 'hoy', 'ahora', 'fuente', 'datos reales'] },
    { agente: 'code', palabras: ['código', 'programa', 'javascript', 'node', 'express', 'python', 'html', 'css', 'error', 'bug', 'función', 'endpoint', 'api', 'github', 'render'] },
    { agente: 'nova', palabras: ['idea', 'nombre para', 'historia', 'guión', 'copy', 'creativo', 'slogan', 'diseño', 'concepto', 'inventa'] },
    { agente: 'lumen', palabras: ['explica', 'cómo funciona', 'qué es', 'enséñame', 'diferencia entre', 'paso a paso', 'tutorial'] }
  ];

  for (const regla of reglas) {
    if (regla.palabras.some(function(p) { return texto.includes(p); })) {
      return regla.agente;
    }
  }

  return 'yarvis';
}

function limpiarComando(mensaje) {
  if (!mensaje) return mensaje;
  return mensaje.replace(/^\/(atlas|code|nova|lumen|yarvis|investigar|programar|crear|idea|explicar)\s*/i, '').trim();
}

// ============================================================
// LÍMITES
// ============================================================

const MAX_HISTORIAL = 30;
const TTL_SESION = 1000 * 60 * 60 * 6;
const MAX_IMAGEN_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// ============================================================
// EXPRESS
// ============================================================

app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(cors(ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS } : {}));
app.use(express.static(path.join(__dirname, 'public')));

const limitador = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' }
});

// ============================================================
// SESIONES
// ============================================================

const sesiones = new Map();

function obtenerSesion(sessionId, modo) {
  const key = sessionId + '_' + modo;

  if (!sesiones.has(key)) {
    const agente = AGENTES[modo] || AGENTES.yarvis;
    sesiones.set(key, {
      mensajes: [{
        role: 'system',
        content: agente.prompt
      }],
      ultimaActividad: Date.now()
    });
  }

  const sesion = sesiones.get(key);
  sesion.ultimaActividad = Date.now();
  return sesion;
}

function recortarHistorial(sesion) {
  const system = sesion.mensajes[0];
  const resto = sesion.mensajes.slice(1);

  if (resto.length > MAX_HISTORIAL) {
    sesion.mensajes = [system].concat(resto.slice(-MAX_HISTORIAL));
  }
}

setInterval(function() {
  const ahora = Date.now();
  for (const [key, sesion] of sesiones.entries()) {
    if (ahora - sesion.ultimaActividad > TTL_SESION) {
      sesiones.delete(key);
    }
  }
}, 15 * 60 * 1000);

// ============================================================
// ALMACENAMIENTO
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

function cargarJSON(archivo, valorInicial) {
  try {
    if (!fs.existsSync(archivo)) {
      fs.writeFileSync(archivo, JSON.stringify(valorInicial, null, 2));
      return valorInicial;
    }
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (error) {
    console.error('Error leyendo datos:', error.message);
    return valorInicial;
  }
}

function guardarJSON(archivo, datos) {
  try {
    fs.writeFileSync(archivo, JSON.stringify(datos, null, 2));
  } catch (error) {
    console.error('Error guardando datos:', error.message);
  }
}

let memoria = cargarJSON(MEMORY_FILE, {});
let conversaciones = cargarJSON(CHATS_FILE, {});

// ============================================================
// MEMORIA
// ============================================================

function obtenerMemorias(userId) {
  const id = String(userId || 'default');
  if (!memoria[id]) memoria[id] = [];
  return memoria[id];
}

function contextoMemoria(userId) {
  const lista = obtenerMemorias(userId);
  if (!lista.length) return '';

  var texto = '\nMEMORIA DEL USUARIO:\n';
  lista.slice(-20).forEach(function(item) {
    texto += '- ' + item.text + '\n';
  });
  texto += '\nUtiliza estos datos solamente cuando sean relevantes.\n';
  return texto;
}

// ============================================================
// ENDPOINTS DE MEMORIA
// ============================================================

app.get('/memory', limitador, function(req, res) {
  const userId = String(req.query.userId || 'default');
  res.json({ memories: obtenerMemorias(userId) });
});

app.post('/memory/add', limitador, function(req, res) {
  const userId = req.body.userId || 'default';
  const text = req.body.text;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Falta el texto.' });
  }

  const lista = obtenerMemorias(userId);
  lista.push({
    id: crypto.randomUUID(),
    text: text.trim(),
    fecha: new Date().toISOString()
  });

  if (lista.length > 100) {
    lista.splice(0, lista.length - 100);
  }

  guardarJSON(MEMORY_FILE, memoria);
  res.json({ ok: true, mensaje: 'Memoria guardada correctamente.' });
});

app.delete('/memory/:id', limitador, function(req, res) {
  const userId = String(req.query.userId || 'default');
  const id = req.params.id;
  const lista = obtenerMemorias(userId);

  memoria[userId] = lista.filter(function(item) {
    return item.id !== id;
  });
  guardarJSON(MEMORY_FILE, memoria);

  res.json({ ok: true });
});

// ============================================================
// CONVERSACIONES
// ============================================================

app.get('/conversations', limitador, function(req, res) {
  const userId = String(req.query.userId || 'default');
  res.json({ conversations: conversaciones[userId] || [] });
});

function guardarConversacion(userId, sessionId, titulo) {
  const idUsuario = String(userId || 'default');
  if (!conversaciones[idUsuario]) conversaciones[idUsuario] = [];

  var conversacion = conversaciones[idUsuario].find(function(item) {
    return item.id === sessionId;
  });

  if (!conversacion) {
    conversacion = {
      id: sessionId,
      title: titulo || 'Nueva conversación',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    conversaciones[idUsuario].push(conversacion);
  } else {
    conversacion.updatedAt = new Date().toISOString();
  }

  guardarJSON(CHATS_FILE, conversaciones);
}

// ============================================================
// BÚSQUEDA WEB
// ============================================================

async function buscarEnInternet(pregunta) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY no está configurada.');
  }

  const respuesta = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: pregunta,
      search_depth: 'advanced',
      topic: 'general',
      max_results: 5,
      include_answer: true,
      include_raw_content: false
    })
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    console.error('Error Tavily:', respuesta.status, detalle);
    throw new Error('Tavily no pudo realizar la búsqueda.');
  }

  return await respuesta.json();
}

function formatearResultadosBusqueda(datos) {
  if (!datos || !Array.isArray(datos.results)) return '';

  var texto = '';
  datos.results.slice(0, 5).forEach(function(resultado, indice) {
    texto += '\nFUENTE ' + (indice + 1) + ':\n';
    texto += 'Título: ' + (resultado.title || 'Sin título') + '\n';
    texto += 'URL: ' + (resultado.url || '') + '\n';
    texto += 'Contenido:\n' + (resultado.content || '') + '\n';
  });
  return texto;
}

// ============================================================
// NÚCLEO DE LA IA
// ============================================================

async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType, userId) {
  modo = modo || 'asistente';
  userId = userId || 'default';

  const agenteId = detectarAgente(mensaje);
  const agente = AGENTES[agenteId] || AGENTES.yarvis;
  const mensajeLimpio = limpiarComando(mensaje);
  const sesion = obtenerSesion(sessionId, agenteId);

  try {
    // IMAGEN
    if (imagen && mimeType) {
      const bytes = Buffer.byteLength(imagen, 'base64');
      if (bytes > MAX_IMAGEN_BYTES) {
        throw new Error('La imagen supera el límite de 8MB.');
      }

      const memoriaTexto = contextoMemoria(userId);

      const mensajes = [
        {
          role: 'system',
          content: agente.prompt + memoriaTexto
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: mensajeLimpio || '¿Qué observas en esta imagen?' },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + imagen } }
          ]
        }
      ];

      const completion = await groq.chat.completions.create({
        model: MODELO_VISION,
        messages: mensajes,
        temperature: 0.7,
        max_tokens: 2048
      });

      return completion.choices && completion.choices[0] && completion.choices[0].message
        ? completion.choices[0].message.content
        : 'No pude analizar la imagen.';
    }

    // TEXTO
    if (!mensajeLimpio || typeof mensajeLimpio !== 'string') {
      throw new Error('El mensaje está vacío.');
    }

    const memoriaTexto = contextoMemoria(userId);

    if (sesion.mensajes[0]) {
      sesion.mensajes[0].content = agente.prompt + memoriaTexto;
    }

    var contextoBusqueda = '';
    if (agenteId === 'atlas') {
      try {
        const datos = await buscarEnInternet(mensajeLimpio);
        contextoBusqueda = formatearResultadosBusqueda(datos);
      } catch (error) {
        console.error('Error en búsqueda:', error.message);
      }
    }

    var mensajeParaIA = mensajeLimpio;

    if (contextoBusqueda) {
      mensajeParaIA += '\n\nINFORMACIÓN OBTENIDA DE INTERNET:\n' + contextoBusqueda + '\n\nUtiliza esta información para responder. No inventes datos que no aparezcan aquí.';
    }

    sesion.mensajes.push({ role: 'user', content: mensajeParaIA });
    recortarHistorial(sesion);

    const completion = await groq.chat.completions.create({
      model: agente.modelo,
      messages: sesion.mensajes,
      temperature: 0.7,
      max_tokens: 2048
    });

    const respuesta = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : 'No pude generar una respuesta.';

    sesion.mensajes.push({ role: 'assistant', content: respuesta });
    recortarHistorial(sesion);

    guardarConversacion(userId, sessionId, mensajeLimpio.substring(0, 60));

    // Respuesta limpia (sin template strings)
    return agente.nombre + ':\n\n' + respuesta;

  } catch (error) {
    console.error('Error de Yarvis:', error);
    throw new Error(error.message || 'Ocurrió un error al generar la respuesta.');
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.post('/chat', limitador, async function(req, res) {
  try {
    const mensaje = req.body.mensaje;
    const sessionId = req.body.sessionId || 'web_session';
    const modo = req.body.modo || 'asistente';
    const imagen = req.body.imagen;
    const mimeType = req.body.mimeType;
    const userId = req.body.userId || 'default';

    if (!mensaje && !imagen) {
      return res.status(400).json({ error: 'Envía un mensaje o una imagen.' });
    }

    if (typeof sessionId !== 'string' || sessionId.length > 100) {
      return res.status(400).json({ error: 'sessionId inválido.' });
    }

    if (imagen && !mimeType) {
      return res.status(400).json({ error: 'Falta mimeType para la imagen.' });
    }

    const respuesta = await procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType, userId);

    res.json({
      ia: NOMBRE_IA,
      respuesta: respuesta
    });

  } catch (error) {
    console.error('Error en /chat:', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor.' });
  }
});

app.delete('/conversations/:sessionId', limitador, function(req, res) {
  const userId = String(req.query.userId || 'default');
  const sessionId = req.params.sessionId;

  if (conversaciones[userId]) {
    conversaciones[userId] = conversaciones[userId].filter(function(item) {
      return item.id !== sessionId;
    });
    guardarJSON(CHATS_FILE, conversaciones);
  }

  for (const key of sesiones.keys()) {
    if (key.startsWith(sessionId + '_')) {
      sesiones.delete(key);
    }
  }

  res.json({ ok: true });
});

app.post('/reset', limitador, function(req, res) {
  const sessionId = req.body.sessionId || 'web_session';
  const modo = req.body.modo || 'asistente';
  const key = sessionId + '_' + modo;
  sesiones.delete(key);

  res.json({ ok: true, mensaje: 'Conversación reiniciada correctamente.' });
});

// ============================================================
// AUDIO
// ============================================================

app.post('/transcribe', limitador, async function(req, res) {
  try {
    const audio = req.body.audio;
    const mimeType = req.body.mimeType || 'audio/webm';

    if (!audio) {
      return res.status(400).json({ error: 'Falta el audio.' });
    }

    const bytes = Buffer.byteLength(audio, 'base64');
    if (bytes > MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'El audio supera el límite de 15MB.' });
    }

    var extension = 'webm';
    if (mimeType.includes('mp4')) extension = 'mp4';
    else if (mimeType.includes('ogg')) extension = 'ogg';
    else if (mimeType.includes('wav')) extension = 'wav';

    const archivo = path.join(os.tmpdir(), 'yarvis-' + crypto.randomUUID() + '.' + extension);
    fs.writeFileSync(archivo, Buffer.from(audio, 'base64'));

    const transcripcion = await groq.audio.transcriptions.create({
      file: fs.createReadStream(archivo),
      model: MODELO_STT,
      language: 'es'
    });

    try { fs.unlinkSync(archivo); } catch (e) {}

    res.json({ texto: transcripcion.text || '' });

  } catch (error) {
    console.error('Error transcribiendo:', error);
    res.status(500).json({ error: 'No pude transcribir el audio.' });
  }
});

app.post('/tts', limitador, async function(req, res) {
  try {
    const texto = req.body.texto;

    if (!texto || typeof texto !== 'string') {
      return res.status(400).json({ error: 'Falta el texto.' });
    }

    const resultado = await groq.audio.speech.create({
      model: MODELO_TTS,
      voice: VOZ_TTS,
      input: texto.trim(),
      response_format: 'wav'
    });

    const buffer = Buffer.from(await resultado.arrayBuffer());
    res.set('Content-Type', 'audio/wav');
    res.send(buffer);

  } catch (error) {
    console.error('Error TTS:', error);
    res.status(500).json({ error: 'No pude generar el audio.' });
  }
});

// ============================================================
// HEALTH Y RUTAS
// ============================================================

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    ia: NOMBRE_IA,
    version: '1.2.1',
    agentes: Object.keys(AGENTES),
    groq: Boolean(GROQ_API_KEY),
    tavily: Boolean(TAVILY_API_KEY),
    timestamp: new Date().toISOString()
  });
});

app.get('/api', function(req, res) {
  res.json({
    nombre: NOMBRE_IA,
    estado: 'online',
    agentes: Object.keys(AGENTES),
    endpoints: ['/chat', '/memory', '/memory/add', '/conversations', '/reset', '/transcribe', '/tts', '/health']
  });
});

app.get('*', function(req, res) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ ia: NOMBRE_IA, mensaje: 'Yarvis está funcionand
