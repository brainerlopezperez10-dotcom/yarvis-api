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

const NOMBRE_IA = 'Yarvis';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(function(x) { return x.trim(); })
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error('Falta GROQ_API_KEY');
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

const MODELO_TEXTO = 'openai/gpt-oss-20b';
const MODELO_VISION = 'qwen/qwen3.6-27b';
const MODELO_BUSQUEDA = 'groq/compound';
const MODELO_STT = 'whisper-large-v3-turbo';
const MODELO_TTS = 'canopylabs/orpheus-v1-english';
const VOZ_TTS = 'Tara';

const AGENTES = {
  yarvis: {
    nombre: 'Yarvis',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Yarvis. Eres el asistente principal, rapido, inteligente, util y amigable. Responde en espanol salvo que el usuario pida otro idioma. Se claro, directo y util. No inventes informacion.'
  },
  atlas: {
    nombre: 'Atlas',
    modelo: MODELO_BUSQUEDA,
    prompt: 'Tu nombre es Atlas. Eres un investigador experto. Analizas cuidadosamente las preguntas, distingues hechos de opiniones y usas informacion actualizada cuando esta disponible. Resume primero la respuesta principal y despues los detalles importantes. Siempre menciona las fuentes cuando uses busqueda.'
  },
  code: {
    nombre: 'Code',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Code. Eres un programador experto. Puedes ayudar con JavaScript, Node.js, HTML, CSS, Python, APIs, Express, bases de datos, GitHub y Render. Cuando escribas codigo: 1. Explica brevemente que hace. 2. Entrega codigo completo cuando sea necesario. 3. Indica donde colocarlo. 4. Evita complicaciones innecesarias.'
  },
  nova: {
    nombre: 'Nova',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Nova. Eres un asistente creativo. Ayudas a crear historias, nombres, disenos, ideas, proyectos, guiones, publicaciones, conceptos y textos persuasivos. Se original, inspirador y practico.'
  },
  lumen: {
    nombre: 'Lumen',
    modelo: MODELO_TEXTO,
    prompt: 'Tu nombre es Lumen. Eres un tutor experto. Explicas cualquier tema paso a paso, con ejemplos sencillos y claros. Responde en espanol salvo que el usuario pida otro idioma. Tu objetivo es que la persona realmente entienda.'
  }
};

function detectarAgente(mensaje) {
  if (!mensaje || typeof mensaje !== 'string') return 'yarvis';

  var texto = mensaje.toLowerCase().trim();

  if (texto.indexOf('/atlas') === 0 || texto.indexOf('/investigar') === 0) return 'atlas';
  if (texto.indexOf('/code') === 0 || texto.indexOf('/programar') === 0) return 'code';
  if (texto.indexOf('/nova') === 0 || texto.indexOf('/crear') === 0 || texto.indexOf('/idea') === 0) return 'nova';
  if (texto.indexOf('/lumen') === 0 || texto.indexOf('/explicar') === 0) return 'lumen';
  if (texto.indexOf('/yarvis') === 0) return 'yarvis';

  if (texto.indexOf('busca') !== -1 || texto.indexOf('investiga') !== -1 || texto.indexOf('noticias') !== -1 || texto.indexOf('precio de') !== -1) return 'atlas';
  if (texto.indexOf('codigo') !== -1 || texto.indexOf('programa') !== -1 || texto.indexOf('javascript') !== -1 || texto.indexOf('express') !== -1 || texto.indexOf('endpoint') !== -1 || texto.indexOf('api') !== -1) return 'code';
  if (texto.indexOf('idea') !== -1 || texto.indexOf('nombre para') !== -1 || texto.indexOf('historia') !== -1 || texto.indexOf('creativo') !== -1) return 'nova';
  if (texto.indexOf('explica') !== -1 || texto.indexOf('que es') !== -1 || texto.indexOf('como funciona') !== -1 || texto.indexOf('ensename') !== -1) return 'lumen';

  return 'yarvis';
}

function limpiarComando(mensaje) {
  if (!mensaje) return mensaje;
  return mensaje.replace(/^\/(atlas|code|nova|lumen|yarvis|investigar|programar|crear|idea|explicar)\s*/i, '').trim();
}

const MAX_HISTORIAL = 30;
const TTL_SESION = 1000 * 60 * 60 * 6;
const MAX_IMAGEN_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(cors(ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS } : {}));
app.use(express.static(path.join(__dirname, 'public')));

const limitador = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta mas tarde.' }
});

const sesiones = new Map();

function obtenerSesion(sessionId, modo) {
  var key = sessionId + '_' + modo;

  if (!sesiones.has(key)) {
    var agente = AGENTES[modo] || AGENTES.yarvis;
    sesiones.set(key, {
      mensajes: [{ role: 'system', content: agente.prompt }],
      ultimaActividad: Date.now()
    });
  }

  var sesion = sesiones.get(key);
  sesion.ultimaActividad = Date.now();
  return sesion;
}

function recortarHistorial(sesion) {
  var system = sesion.mensajes[0];
  var resto = sesion.mensajes.slice(1);

  if (resto.length > MAX_HISTORIAL) {
    sesion.mensajes = [system].concat(resto.slice(-MAX_HISTORIAL));
  }
}

setInterval(function() {
  var ahora = Date.now();
  sesiones.forEach(function(sesion, key) {
    if (ahora - sesion.ultimaActividad > TTL_SESION) {
      sesiones.delete(key);
    }
  });
}, 15 * 60 * 1000);

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

var memoria = cargarJSON(MEMORY_FILE, {});
var conversaciones = cargarJSON(CHATS_FILE, {});

function obtenerMemorias(userId) {
  var id = String(userId || 'default');
  if (!memoria[id]) memoria[id] = [];
  return memoria[id];
}

function contextoMemoria(userId) {
  var lista = obtenerMemorias(userId);
  if (!lista.length) return '';

  var texto = '\nMEMORIA DEL USUARIO:\n';
  lista.slice(-20).forEach(function(item) {
    texto += '- ' + item.text + '\n';
  });
  texto += '\nUtiliza estos datos solamente cuando sean relevantes.\n';
  return texto;
}

app.get('/memory', limitador, function(req, res) {
  var userId = String(req.query.userId || 'default');
  res.json({ memories: obtenerMemorias(userId) });
});

app.post('/memory/add', limitador, function(req, res) {
  var userId = req.body.userId || 'default';
  var text = req.body.text;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Falta el texto.' });
  }

  var lista = obtenerMemorias(userId);
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
  var userId = String(req.query.userId || 'default');
  var id = req.params.id;
  var lista = obtenerMemorias(userId);

  memoria[userId] = lista.filter(function(item) {
    return item.id !== id;
  });
  guardarJSON(MEMORY_FILE, memoria);
  res.json({ ok: true });
});

app.get('/conversations', limitador, function(req, res) {
  var userId = String(req.query.userId || 'default');
  res.json({ conversations: conversaciones[userId] || [] });
});

function guardarConversacion(userId, sessionId, titulo) {
  var idUsuario = String(userId || 'default');
  if (!conversaciones[idUsuario]) conversaciones[idUsuario] = [];

  var conversacion = null;
  for (var i = 0; i < conversaciones[idUsuario].length; i++) {
    if (conversaciones[idUsuario][i].id === sessionId) {
      conversacion = conversaciones[idUsuario][i];
      break;
    }
  }

  if (!conversacion) {
    conversacion = {
      id: sessionId,
      title: titulo || 'Nueva conversacion',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    conversaciones[idUsuario].push(conversacion);
  } else {
    conversacion.updatedAt = new Date().toISOString();
  }

  guardarJSON(CHATS_FILE, conversaciones);
}

async function buscarEnInternet(pregunta) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY no esta configurada.');
  }

  var respuesta = await fetch('https://api.tavily.com/search', {
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
    var detalle = await respuesta.text();
    console.error('Error Tavily:', respuesta.status, detalle);
    throw new Error('Tavily no pudo realizar la busqueda.');
  }

  return await respuesta.json();
}

function formatearResultadosBusqueda(datos) {
  if (!datos || !Array.isArray(datos.results)) return '';

  var texto = '';
  var resultados = datos.results.slice(0, 5);
  for (var i = 0; i < resultados.length; i++) {
    var r = resultados[i];
    texto += '\nFUENTE ' + (i + 1) + ':\n';
    texto += 'Titulo: ' + (r.title || 'Sin titulo') + '\n';
    texto += 'URL: ' + (r.url || '') + '\n';
    texto += 'Contenido:\n' + (r.content || '') + '\n';
  }
  return texto;
}

async function procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType, userId) {
  modo = modo || 'asistente';
  userId = userId || 'default';

  var agenteId = detectarAgente(mensaje);
  var agente = AGENTES[agenteId] || AGENTES.yarvis;
  var mensajeLimpio = limpiarComando(mensaje);
  var sesion = obtenerSesion(sessionId, agenteId);

  try {
    if (imagen && mimeType) {
      var bytes = Buffer.byteLength(imagen, 'base64');
      if (bytes > MAX_IMAGEN_BYTES) {
        throw new Error('La imagen supera el limite de 8MB.');
      }

      var memoriaTexto = contextoMemoria(userId);

      var mensajesImg = [
        {
          role: 'system',
          content: agente.prompt + memoriaTexto
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: mensajeLimpio || 'Que observas en esta imagen?' },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + imagen } }
          ]
        }
      ];

      var completionImg = await groq.chat.completions.create({
        model: MODELO_VISION,
        messages: mensajesImg,
        temperature: 0.7,
        max_tokens: 2048
      });

      if (completionImg.choices && completionImg.choices[0] && completionImg.choices[0].message) {
        return completionImg.choices[0].message.content;
      }
      return 'No pude analizar la imagen.';
    }

    if (!mensajeLimpio || typeof mensajeLimpio !== 'string') {
      throw new Error('El mensaje esta vacio.');
    }

    var memoriaTexto2 = contextoMemoria(userId);

    if (sesion.mensajes[0]) {
      sesion.mensajes[0].content = agente.prompt + memoriaTexto2;
    }

    var contextoBusqueda = '';
    if (agenteId === 'atlas') {
      try {
        var datos = await buscarEnInternet(mensajeLimpio);
        contextoBusqueda = formatearResultadosBusqueda(datos);
      } catch (error) {
        console.error('Error en busqueda:', error.message);
      }
    }

    var mensajeParaIA = mensajeLimpio;

    if (contextoBusqueda) {
      mensajeParaIA += '\n\nINFORMACION OBTENIDA DE INTERNET:\n' + contextoBusqueda + '\n\nUtiliza esta informacion para responder. No inventes datos que no aparezcan aqui.';
    }

    sesion.mensajes.push({ role: 'user', content: mensajeParaIA });
    recortarHistorial(sesion);

    var completion = await groq.chat.completions.create({
      model: agente.modelo,
      messages: sesion.mensajes,
      temperature: 0.7,
      max_tokens: 2048
    });

    var respuesta = 'No pude generar una respuesta.';
    if (completion.choices && completion.choices[0] && completion.choices[0].message) {
      respuesta = completion.choices[0].message.content;
    }

    sesion.mensajes.push({ role: 'assistant', content: respuesta });
    recortarHistorial(sesion);

    guardarConversacion(userId, sessionId, mensajeLimpio.substring(0, 60));

    return agente.nombre + ':\n\n' + respuesta;

  } catch (error) {
    console.error('Error de Yarvis:', error);
    throw new Error(error.message || 'Ocurrio un error al generar la respuesta.');
  }
}

app.post('/chat', limitador, async function(req, res) {
  try {
    var mensaje = req.body.mensaje;
    var sessionId = req.body.sessionId || 'web_session';
    var modo = req.body.modo || 'asistente';
    var imagen = req.body.imagen;
    var mimeType = req.body.mimeType;
    var userId = req.body.userId || 'default';

    if (!mensaje && !imagen) {
      return res.status(400).json({ error: 'Envia un mensaje o una imagen.' });
    }

    if (typeof sessionId !== 'string' || sessionId.length > 100) {
      return res.status(400).json({ error: 'sessionId invalido.' });
    }

    if (imagen && !mimeType) {
      return res.status(400).json({ error: 'Falta mimeType para la imagen.' });
    }

    var respuesta = await procesarRespuestaIA(mensaje, sessionId, modo, imagen, mimeType, userId);

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
  var userId = String(req.query.userId || 'default');
  var sessionId = req.params.sessionId;

  if (conversaciones[userId]) {
    conversaciones[userId] = conversaciones[userId].filter(function(item) {
      return item.id !== sessionId;
    });
    guardarJSON(CHATS_FILE, conversaciones);
  }

  sesiones.forEach(function(sesion, key) {
    if (key.indexOf(sessionId + '_') === 0) {
      sesiones.delete(key);
    }
  });

  res.json({ ok: true });
});

app.post('/reset', limitador, function(req, res) {
  var sessionId = req.body.sessionId || 'web_session';
  var modo = req.body.modo || 'asistente';
  var key = sessionId + '_' + modo;
  sesiones.delete(key);

  res.json({ ok: true, mensaje: 'Conversacion reiniciada correctamente.' });
});

app.post('/transcribe', limitador, async function(req, res) {
  try {
    var audio = req.body.audio;
    var mimeType = req.body.mimeType || 'audio/webm';

    if (!audio) {
      return res.status(400).json({ error: 'Falta el audio.' });
    }

    var bytes = Buffer.byteLength(audio, 'base64');
    if (bytes > MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'El audio supera el limite de 15MB.' });
    }

    var extension = 'webm';
    if (mimeType.indexOf('mp4') !== -1) extension = 'mp4';
    else if (mimeType.indexOf('ogg') !== -1) extension = 'ogg';
    else if (mimeType.indexOf('wav') !== -1) extension = 'wav';

    var archivo = path.join(os.tmpdir(), 'yarvis-' + crypto.randomUUID() + '.' + extension);
    fs.writeFileSync(archivo, Buffer.from(audio, 'base64'));

    var transcripcion = await groq.audio.transcriptions.create({
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
    var texto = req.body.texto;

    if (!texto || typeof texto !== 'string') {
      return res.status(400).json({ error: 'Falta el texto.' });
    }

    var resultado = await groq.audio.speech.create({
      model: MODELO_TTS,
      voice: VOZ_TTS,
      input: texto.trim(),
      response_format: 'wav'
    });

    var buffer = Buffer.from(await resultado.arrayBuffer());
    res.set('Content-Type', 'audio/wav');
    res.send(buffer);

  } catch (error) {
    console.error('Error TTS:', error);
    res.status(500).json({ error: 'No pude generar el audio.' });
  }
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    ia: NOMBRE_IA,
    version: '1.2.2',
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
  var indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ ia: NOMBRE_IA, mensaje: 'Yarvis esta funcionando correctamente.' });
  }
});

app.use(function(err, req, res, next) {
  console.error('Error del servidor:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, '0.0.0.0', function() {
  console.log(NOMBRE_IA + ' esta funcionando en el puerto ' + PORT);
  console.log('Tavily: ' + (TAVILY_API_KEY ? 'ACTIVO' : 'NO CONFIGURADO'));
  console.log('Agentes: ' + Object.keys(AGENTES).join(', '));
});
