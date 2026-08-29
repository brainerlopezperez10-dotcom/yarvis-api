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

const TONOS = {
  normal: '',
  formal: ' Responde de forma formal, profesional y respetuosa.',
  casual: ' Responde de forma casual, cercana y relajada.',
  tecnico: ' Responde de forma tecnica, precisa y detallada.',
  breve: ' Responde de forma muy breve y directa.'
};

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
  if (texto.indexOf('codigo') !== -1 || texto.indexOf('programa') !== -1 || texto.indexOf('javascript') !== -1 || texto.indexOf('express') !== -1 || texto.indexOf('endpoint') !== -1 || texto.indexOf(' api') !== -1) return 'code';
  if (texto.indexOf('idea') !== -1 || texto.indexOf('nombre para') !== -1 || texto.indexOf('historia') !== -1 || texto.indexOf('creativo') !== -1) return 'nova';
  if (texto.indexOf('explica') !== -1 || texto.indexOf('que es') !== -1 || texto.indexOf('como funciona') !== -1 || texto.indexOf('ensename') !== -1) return 'lumen';

  return 'yarvis';
}

function limpiarComando(mensaje) {
  if (!mensaje) return mensaje;
  return mensaje
    .replace(/^\/(atlas|code|nova|lumen|yarvis|investigar|programar|crear|idea|explicar|resumen|formal|casual|tecnico|breve)\s*/i, '')
    .trim();
}

function detectarTono(mensaje) {
  if (!mensaje) return 'normal';
  var t = mensaje.toLowerCase();
  if (t.indexOf('/formal') === 0 || t.indexOf('modo formal') !== -1) return 'formal';
  if (t.indexOf('/casual') === 0 || t.indexOf('modo casual') !== -1) return 'casual';
  if (t.indexOf('/tecnico') === 0 || t.indexOf('modo tecnico') !== -1) return 'tecnico';
  if (t.indexOf('/breve') === 0 || t.indexOf('modo breve') !== -1) return 'breve';
  return 'normal';
}

function esResumen(mensaje) {
  if (!mensaje) return false;
  var t = mensaje.toLowerCase().trim();
  return t === '/resumen' || t.indexOf('/resumen') === 0 || t === 'resume la conversacion' || t === 'resume esto';
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
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta mas tarde.' }
});

const sesiones = new Map();
const tonosUsuario = new Map();

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
    if (ahora - sesion.ultimaActividad > TTL_SESION) sesiones.delete(key);
  });
}, 15 * 60 * 1000);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');

function cargarJSON(archivo, valorInicial) {
  try {
    if (!fs.existsSync(archivo)) {
      fs.writeFileSync(archivo, JSON.stringify(valorInicial, null, 2));
      return valorInicial;
    }
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (e) {
    return valorInicial;
  }
}

function guardarJSON(archivo, datos) {
  try {
    fs.writeFileSync(archivo, JSON.stringify(datos, null, 2));
  } catch (e) {
    console.error('Error guardando:', e.message);
  }
}

var memoria = cargarJSON(MEMORY_FILE, {});
var conversaciones = cargarJSON(CHATS_FILE, {});
var notas = cargarJSON(NOTES_FILE, {});

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
  texto += '\nUtiliza estos datos solo cuando sean relevantes.\n';
  return texto;
}

app.get('/memory', limitador, function(req, res) {
  res.json({ memories: obtenerMemorias(req.query.userId || 'default') });
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
  if (lista.length > 100) lista.splice(0, lista.length - 100);
  guardarJSON(MEMORY_FILE, memoria);
  res.json({ ok: true });
});

app.delete('/memory/:id', limitador, function(req, res) {
  var userId = String(req.query.userId || 'default');
  memoria[userId] = obtenerMemorias(userId).filter(function(item) {
    return item.id !== req.params.id;
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
  var conv = null;
  for (var i = 0; i < conversaciones[idUsuario].length; i++) {
    if (conversaciones[idUsuario][i].id === sessionId) {
      conv = conversaciones[idUsuario][i];
      break;
    }
  }
  if (!conv) {
    conv = {
      id: sessionId,
      title: (titulo || 'Nueva conversacion').substring(0, 60),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    conversaciones[idUsuario].unshift(conv);
    if (conversaciones[idUsuario].length > 50) {
      conversaciones[idUsuario] = conversaciones[idUsuario].slice(0, 50);
    }
  } else {
    conv.updatedAt = new Date().toISOString();
  }
  guardarJSON(CHATS_FILE, conversaciones);
}

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
    if (key.indexOf(sessionId + '_') === 0) sesiones.delete(key);
  });
  res.json({ ok: true });
});

app.post('/notes/add', limitador, function(req, res) {
  var userId = req.body.userId || 'default';
  var text = req.body.text;
  if (!text) return res.status(400).json({ error: 'Falta texto' });
  if (!notas[userId]) notas[userId] = [];
  notas[userId].push({
    id: crypto.randomUUID(),
    text: String(text).trim(),
    fecha: new Date().toISOString()
  });
  guardarJSON(NOTES_FILE, notas);
  res.json({ ok: true });
});

app.get('/notes', limitador, function(req, res) {
  var userId = String(req.query.userId || 'default');
  res.json({ notes: notas[userId] || [] });
});

async function buscarEnInternet(pregunta) {
  if (!TAVILY_API_KEY) throw new Error('TAVILY_API_KEY no esta configurada.');

  var queryLimpio = String(pregunta || '').trim().slice(0, 380);

  var respuesta = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: queryLimpio,
      search_depth: 'basic',
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
  if (!datos || !Array.isArray(datos.results)) return { texto: '', fuentes: [] };
  var texto = '';
  var fuentes = [];
  var resultados = datos.results.slice(0, 5);
  for (var i = 0; i < resultados.length; i++) {
    var r = resultados[i];
    var contenidoCorto = (r.content || '').slice(0, 600);
    texto += '\nFUENTE ' + (i + 1) + ':\n';
    texto += 'Titulo: ' + (r.title || 'Sin titulo') + '\n';
    texto += 'URL: ' + (r.url || '') + '\n';
    texto += 'Contenido:\n' + contenidoCorto + '\n';
    fuentes.push({
      titulo: r.title || 'Sin titulo',
      url: r.url || '',
      snippet: contenidoCorto.substring(0, 180)
    });
  }
  return { texto: texto, fuentes: fuentes };
}
