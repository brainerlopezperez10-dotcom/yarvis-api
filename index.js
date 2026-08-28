require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const NOMBRE_IA = 'Yarvis';

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

const PORT =
  process.env.PORT || 3000;

const ALLOWED_ORIGINS =
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error(
    '❌ Falta GROQ_API_KEY en las variables de entorno.'
  );

  process.exit(1);
}

if (!TAVILY_API_KEY) {
  console.warn(
    '⚠️ Falta TAVILY_API_KEY. La búsqueda web no funcionará.'
  );
}

const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });

// ============================================================
// MODELOS
// ============================================================

const MODELO_TEXTO =
  'openai/gpt-oss-20b';

const MODELO_VISION =
  'qwen/qwen3.6-27b';

const MODELO_STT =
  'whisper-large-v3-turbo';

const MODELO_TTS =
  'playai-tts';

const VOZ_TTS =
  'Aaliyah-PlayAI';

// ============================================================
// MODOS
// ============================================================

const PROMPTS_MODO = {

  asistente: `
Tu nombre es Yarvis.

Eres un asistente de inteligencia artificial
rápido, inteligente, útil y amigable.

Responde en español salvo que el usuario
pida otro idioma.

Sé claro y directo.

Puedes ayudar con tecnología, teléfonos,
aplicaciones, juegos, programación,
matemáticas, explicaciones, ideas,
escritura y planificación.

No inventes información.
`,

  explicativo: `
Tu nombre es Yarvis.

Eres un tutor y profesor experto.

Explica las cosas paso a paso.

Utiliza ejemplos sencillos.

Si el usuario es principiante,
explica primero lo básico y después
lo avanzado.

Responde en español salvo que te pidan
otro idioma.
`,

  creativo: `
Tu nombre es Yarvis.

Eres un asistente creativo.

Ayudas a crear historias, nombres,
diseños, ideas, proyectos, guiones,
publicaciones y conceptos para
aplicaciones o videojuegos.

Sé original.
`,

  programador: `
Tu nombre es Yarvis.

Eres un programador experto.

Puedes ayudar con JavaScript,
Node.js, HTML, CSS, Python,
APIs, Express, bases de datos,
GitHub, Render y aplicaciones web.

Cuando escribas código:

1. Explica brevemente qué hace.
2. Entrega código completo cuando sea necesario.
3. Indica dónde debe colocarse.
4. Evita código innecesariamente complicado.

Si el usuario proporciona código con errores,
identifica el problema y proporciona
la corrección.
`,

  investigador: `
Tu nombre es Yarvis.

Eres un investigador.

Analiza cuidadosamente las preguntas.

Distingue hechos de opiniones.

Cuando tengas acceso a Internet,
utiliza información actual y fiable.

Resume primero la respuesta principal
y después proporciona los detalles importantes.
`,

  busqueda: `
Tu nombre es Yarvis.

Tienes acceso a Internet mediante Tavily.

Utiliza la búsqueda cuando la pregunta
necesite información actualizada.

Esto incluye:

- Noticias
- Clima
- Precios
- Deportes
- Tecnología reciente
- Eventos
- Horarios
- Productos
- Aplicaciones
- Información de lugares
- Cualquier información que pueda cambiar

Utiliza los resultados proporcionados
por la herramienta.

No inventes información.

Cuando utilices Internet,
incluye las fuentes al final de la respuesta.
`
};

const MODOS_VALIDOS =
  Object.keys(PROMPTS_MODO);

// ============================================================
// LÍMITES
// ============================================================

const MAX_HISTORIAL =
  30;

const TTL_SESION =
  1000 * 60 * 60 * 6;

const MAX_IMAGEN_BYTES =
  8 * 1024 * 1024;

const MAX_AUDIO_BYTES =
  15 * 1024 * 1024;

const MAX_ARCHIVO_BYTES =
  10 * 1024 * 1024;

// ============================================================
// EXPRESS
// ============================================================

const app =
  express();

// Render funciona detrás de un proxy.
app.set(
  'trust proxy',
  1
);

app.use(
  express.json({
    limit: '25mb'
  })
);

app.use(
  cors(
    ALLOWED_ORIGINS.length
      ? {
          origin:
            ALLOWED_ORIGINS
        }
      : {}
  )
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

// ============================================================
// BÚSQUEDA WEB CON TAVILY
// ============================================================

async function buscarEnInternet(
  pregunta
) {

  if (!TAVILY_API_KEY) {

    throw new Error(
      'TAVILY_API_KEY no está configurada en Render.'
    );

  }

  const respuesta =
    await fetch(
      'https://api.tavily.com/search',
      {

        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            api_key:
              TAVILY_API_KEY,

            query:
              pregunta,

            search_depth:
              'advanced',

            topic:
              'general',

            max_results:
              5,

            include_answer:
              true,

            include_raw_content:
              false

          })

      }
    );

  if (!respuesta.ok) {

    const detalle =
      await respuesta.text();

    console.error(
      '❌ Error Tavily:',
      respuesta.status,
      detalle
    );

    throw new Error(
      'Tavily no pudo realizar la búsqueda.'
    );

  }

  return await respuesta.json();
}

// ============================================================
// RATE LIMIT
// ============================================================

const limitador =
  rateLimit({

    windowMs:
      15 * 60 * 1000,

    max:
      100,

    standardHeaders:
      true,

    legacyHeaders:
      false,

    message: {
      error:
        'Demasiadas solicitudes. Intenta de nuevo más tarde.'
    }

  });

// ============================================================
// SESIONES
// ============================================================

const sesiones =
  new Map();

function obtenerSesion(
  sessionId,
  modo
) {

  const key =
    `${sessionId}_${modo}`;

  if (!sesiones.has(key)) {

    sesiones.set(
      key,
      {

        mensajes: [

          {
            role:
              'system',

            content:
              PROMPTS_MODO[modo] ||
              PROMPTS_MODO.asistente
          }

        ],

        ultimaActividad:
          Date.now()

      }
    );

  }

  const sesion =
    sesiones.get(key);

  sesion.ultimaActividad =
    Date.now();

  return sesion;
}

function recortarHistorial(
  sesion
) {

  const system =
    sesion.mensajes[0];

  const resto =
    sesion.mensajes.slice(1);

  if (
    resto.length >
    MAX_HISTORIAL
  ) {

    sesion.mensajes = [

      system,

      ...resto.slice(
        -MAX_HISTORIAL
      )

    ];

  }
}

// ============================================================
// LIMPIEZA DE SESIONES
// ============================================================

setInterval(
  () => {

    const ahora =
      Date.now();

    for (
      const [
        key,
        sesion
      ] of sesiones.entries()
    ) {

      if (
        ahora -
        sesion.ultimaActividad >
        TTL_SESION
      ) {

        sesiones.delete(
          key
        );

      }

    }

  },
  15 * 60 * 1000
);

// ============================================================
// CARPETA DE DATOS
// ============================================================

const DATA_DIR =
  path.join(
    __dirname,
    'data'
  );

if (
  !fs.existsSync(
    DATA_DIR
  )
) {

  fs.mkdirSync(
    DATA_DIR,
    {
      recursive:
        true
    }
  );

}

const MEMORY_FILE =
  path.join(
    DATA_DIR,
    'memory.json'
  );

const CHATS_FILE =
  path.join(
    DATA_DIR,
    'chats.json'
  );

function cargarJSON(
  archivo,
  valorInicial
) {

  try {

    if (
      !fs.existsSync(
        archivo
      )
    ) {

      fs.writeFileSync(

        archivo,

        JSON.stringify(
          valorInicial,
          null,
          2
        )

      );

      return valorInicial;

    }

    return JSON.parse(

      fs.readFileSync(
        archivo,
        'utf8'
      )

    );

  }

  catch (error) {

    console.error(
      '❌ Error leyendo datos:',
      error.message
    );

    return valorInicial;

  }

}

function guardarJSON(
  archivo,
  datos
) {

  fs.writeFileSync(

    archivo,

    JSON.stringify(
      datos,
      null,
      2
    )

  );

}

let memoria =
  cargarJSON(
    MEMORY_FILE,
    {}
  );

let conversaciones =
  cargarJSON(
    CHATS_FILE,
    {}
  );

// ============================================================
// MEMORIA
// ============================================================

function obtenerMemorias(
  userId
) {

  const id =
    String(
      userId ||
      'default'
    );

  if (
    !memoria[id]
  ) {

    memoria[id] =
      [];

  }

  return memoria[id];
}

function contextoMemoria(
  userId
) {

  const lista =
    obtenerMemorias(
      userId
    );

  if (
    !lista.length
  ) {

    return '';

  }

  return `

MEMORIA DEL USUARIO:

${lista
  .slice(-20)
  .map(
    item =>
      '- ' + item.text
  )
  .join('\n')}

Utiliza estos datos solamente
cuando sean relevantes.
`;

}

// ============================================================
// ENDPOINT DE MEMORIA
// ============================================================

app.get(
  '/memory',
  limitador,
  (req, res) => {

    const userId =
      String(
        req.query.userId ||
        'default'
      );

    res.json({

      memories:
        obtenerMemorias(
          userId
        )

    });

  }
);

app.post(
  '/memory/add',
  limitador,
  (req, res) => {

    const {
      userId =
        'default',
      text
    } = req.body;

    if (
      !text ||
      typeof text !==
        'string'
    ) {

      return res
        .status(400)
        .json({
          error:
            'Falta el texto.'
        });

    }

    const lista =
      obtenerMemorias(
        userId
      );

    lista.push({

      id:
        crypto.randomUUID(),

      text:
        text.trim(),

      fecha:
        new Date().toISOString()

    });

    if (
      lista.length >
      100
    ) {

      lista.splice(
        0,
        lista.length - 100
      );

    }

    guardarJSON(
      MEMORY_FILE,
      memoria
    );

    res.json({
      ok:
        true
    });

  }
);

// ============================================================
// CONVERSACIONES
// ============================================================

app.get(
  '/conversations',
  limitador,
  (req, res) => {

    const userId =
      String(
        req.query.userId ||
        'default'
      );

    res.json({

      conversations:
        conversaciones[userId] ||
        []

    });

  }
);

function guardarConversacion(
  userId,
  sessionId,
  titulo
) {

  const idUsuario =
    String(
      userId ||
      'default'
    );

  if (
    !conversaciones[idUsuario]
  ) {

    conversaciones[idUsuario] =
      [];

  }

  let conversacion =
    conversaciones[idUsuario]
      .find(
        item =>
          item.id ===
          sessionId
      );

  if (
    !conversacion
  ) {

    conversacion = {

      id:
        sessionId,

      title:
        titulo ||
        'Nueva conversación',

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()

    };

    conversaciones[idUsuario]
      .push(
        conversacion
      );

  }

  else {

    conversacion.updatedAt =
      new Date().toISOString();

  }

  guardarJSON(
    CHATS_FILE,
    conversaciones
  );
}

// ============================================================
// FIN DE LA PARTE 1
// =========================================================

// ============================================================
// PARTE 2 — MEMORIA Y SESIONES
// ============================================================

const sesiones = new Map();

function obtenerSesion(sessionId, modo) {
  const key = `${sessionId}_${modo}`;

  if (!sesiones.has(key)) {
    sesiones.set(key, {
      mensajes: [
        {
          role: 'system',
          content:
            PROMPTS_MODO[modo] ||
            PROMPTS_MODO.asistente
        }
      ],
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
    sesion.mensajes = [
      system,
      ...resto.slice(-MAX_HISTORIAL)
    ];
  }
}


// ============================================================
// LIMPIEZA AUTOMÁTICA DE SESIONES
// ============================================================

setInterval(() => {
  const ahora = Date.now();

  for (const [key, sesion] of sesiones.entries()) {
    if (
      ahora - sesion.ultimaActividad >
      TTL_SESION
    ) {
      sesiones.delete(key);
    }
  }
}, 15 * 60 * 1000);


// ============================================================
// CARPETA DE DATOS
// ============================================================

const DATA_DIR = path.join(
  __dirname,
  'data'
);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

const MEMORY_FILE = path.join(
  DATA_DIR,
  'memory.json'
);

const CHATS_FILE = path.join(
  DATA_DIR,
  'chats.json'
);


// ============================================================
// FUNCIONES JSON
// ============================================================

function cargarJSON(
  archivo,
  valorInicial
) {
  try {

    if (!fs.existsSync(archivo)) {

      fs.writeFileSync(
        archivo,
        JSON.stringify(
          valorInicial,
          null,
          2
        )
      );

      return valorInicial;
    }

    return JSON.parse(
      fs.readFileSync(
        archivo,
        'utf8'
      )
    );

  } catch (error) {

    console.error(
      'Error leyendo datos:',
      error.message
    );

    return valorInicial;
  }
}


function guardarJSON(
  archivo,
  datos
) {
  try {

    fs.writeFileSync(
      archivo,
      JSON.stringify(
        datos,
        null,
        2
      )
    );

  } catch (error) {

    console.error(
      'Error guardando datos:',
      error.message
    );

  }
}


// ============================================================
// CARGAR MEMORIA
// ============================================================

let memoria = cargarJSON(
  MEMORY_FILE,
  {}
);

let conversaciones = cargarJSON(
  CHATS_FILE,
  {}
);


// ============================================================
// MEMORIA DE USUARIO
// ============================================================

function obtenerMemorias(userId) {

  const id = String(
    userId || 'default'
  );

  if (!memoria[id]) {
    memoria[id] = [];
  }

  return memoria[id];
}


function contextoMemoria(userId) {

  const lista =
    obtenerMemorias(userId);

  if (!lista.length) {
    return '';
  }

  return `

MEMORIA DEL USUARIO:

${lista
  .slice(-20)
  .map(
    item => `- ${item.text}`
  )
  .join('\n')}

Utiliza estos datos solamente
cuando sean relevantes.
`;
}


// ============================================================
// ENDPOINT — VER MEMORIA
// ============================================================

app.get(
  '/memory',
  limitador,
  (req, res) => {

    const userId = String(
      req.query.userId ||
      'default'
    );

    res.json({
      memories:
        obtenerMemorias(userId)
    });

  }
);


// ============================================================
// ENDPOINT — AGREGAR MEMORIA
// ============================================================

app.post(
  '/memory/add',
  limitador,
  (req, res) => {

    const {
      userId = 'default',
      text
    } = req.body;

    if (
      !text ||
      typeof text !== 'string'
    ) {

      return res
        .status(400)
        .json({
          error:
            'Falta el texto.'
        });

    }

    const lista =
      obtenerMemorias(userId);

    lista.push({

      id:
        crypto.randomUUID(),

      text:
        text.trim(),

      fecha:
        new Date().toISOString()

    });

    // Máximo 100 recuerdos
    if (lista.length > 100) {

      lista.splice(
        0,
        lista.length - 100
      );

    }

    guardarJSON(
      MEMORY_FILE,
      memoria
    );

    res.json({
      ok: true,
      mensaje:
        'Memoria guardada correctamente.'
    });

  }
);


// ============================================================
// ENDPOINT — BORRAR UNA MEMORIA
// ============================================================

app.delete(
  '/memory/:id',
  limitador,
  (req, res) => {

    const userId = String(
      req.query.userId ||
      'default'
    );

    const id =
      req.params.id;

    const lista =
      obtenerMemorias(userId);

    const nuevaLista =
      lista.filter(
        item =>
          item.id !== id
      );

    memoria[userId] =
      nuevaLista;

    guardarJSON(
      MEMORY_FILE,
      memoria
    );

    res.json({
      ok: true
    });

  }
);


// ============================================================
// FIN DE LA PARTE 2
// ==========================================================

