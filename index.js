require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

const app = express();

// ============================================================
// CONFIGURACIÓN
// ============================================================

const NOMBRE_IA = 'Yarvis';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS =
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error('Falta GROQ_API_KEY en Render.');
  process.exit(1);
}

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ============================================================
// MODELOS
// ============================================================

const MODELO_TEXTO = 'openai/gpt-oss-20b';
const MODELO_VISION = 'qwen/qwen3.6-27b';
const MODELO_BUSQUEDA = 'groq/compound';
const MODELO_STT = 'whisper-large-v3-turbo';
const MODELO_TTS = 'playai-tts';
const VOZ_TTS = 'Aaliyah-PlayAI';

// ============================================================
// PROMPTS
// ============================================================

const PROMPTS_MODO = {

  asistente: `
Tu nombre es Yarvis.

Eres un asistente de inteligencia artificial
rápido, inteligente, útil y amigable.

Responde en español salvo que el usuario
pida otro idioma.

Sé claro, directo y útil.

No inventes información.
`,

  explicativo: `
Tu nombre es Yarvis.

Eres un tutor experto.

Explica paso a paso y utiliza ejemplos
sencillos.

Responde en español salvo que el usuario
pida otro idioma.
`,

  creativo: `
Tu nombre es Yarvis.

Eres un asistente creativo.

Ayudas a crear historias, nombres,
diseños, ideas, proyectos, guiones,
publicaciones y conceptos.

Sé original.
`,

  programador: `
Tu nombre es Yarvis.

Eres un programador experto.

Puedes ayudar con JavaScript, Node.js,
HTML, CSS, Python, APIs, Express,
bases de datos, GitHub y Render.

Cuando escribas código:

1. Explica brevemente qué hace.
2. Entrega código completo cuando sea necesario.
3. Indica dónde colocarlo.
4. Evita complicaciones innecesarias.
`,

  investigador: `
Tu nombre es Yarvis.

Eres un investigador.

Analiza cuidadosamente las preguntas.

Distingue hechos de opiniones.

Resume primero la respuesta principal
y después los detalles importantes.
`,

  busqueda: `
Tu nombre es Yarvis.

Tienes acceso a Internet mediante Tavily.

Utiliza la búsqueda cuando la pregunta
necesite información actualizada.

No inventes información.

Utiliza los resultados proporcionados
por la búsqueda y menciona las fuentes.
`
};

const MODOS_VALIDOS = Object.keys(PROMPTS_MODO);

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

// Render funciona detrás de un proxy.
app.set('trust proxy', 1);

app.use(express.json({
  limit: '25mb'
}));

app.use(cors(
  ALLOWED_ORIGINS.length
    ? { origin: ALLOWED_ORIGINS }
    : {}
));

app.use(express.static(
  path.join(__dirname, 'public')
));

// ============================================================
// RATE LIMIT
// ============================================================

const limitador = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiadas solicitudes. Intenta más tarde.'
  }
});

// ============================================================
// SESIONES
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
// LIMPIEZA DE SESIONES
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

function cargarJSON(archivo, valorInicial) {

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

function guardarJSON(archivo, datos) {

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

let memoria = cargarJSON(
  MEMORY_FILE,
  {}
);

let conversaciones = cargarJSON(
  CHATS_FILE,
  {}
);

// ============================================================
// MEMORIA
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
  .map(item => `- ${item.text}`)
  .join('\n')}

Utiliza estos datos solamente
cuando sean relevantes.
`;
  }
// ============================================================
// MEMORIA — ENDPOINTS
// ============================================================

app.get(
  '/memory',
  limitador,
  (req, res) => {

    const userId = String(
      req.query.userId || 'default'
    );

    res.json({
      memories: obtenerMemorias(userId)
    });

  }
);


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
          error: 'Falta el texto.'
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


app.delete(
  '/memory/:id',
  limitador,
  (req, res) => {

    const userId = String(
      req.query.userId || 'default'
    );

    const id =
      req.params.id;

    const lista =
      obtenerMemorias(userId);

    memoria[userId] =
      lista.filter(
        item => item.id !== id
      );

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
// CONVERSACIONES
// ============================================================

app.get(
  '/conversations',
  limitador,
  (req, res) => {

    const userId = String(
      req.query.userId || 'default'
    );

    res.json({

      conversations:
        conversaciones[userId] || []

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
      userId || 'default'
    );

  if (!conversaciones[idUsuario]) {

    conversaciones[idUsuario] = [];

  }

  let conversacion =
    conversaciones[idUsuario].find(
      item => item.id === sessionId
    );

  if (!conversacion) {

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

    conversaciones[idUsuario].push(
      conversacion
    );

  } else {

    conversacion.updatedAt =
      new Date().toISOString();

  }

  guardarJSON(
    CHATS_FILE,
    conversaciones
  );

}


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

        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({

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
      'Error Tavily:',
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
// FORMATEAR RESULTADOS DE TAVILY
// ============================================================

function formatearResultadosBusqueda(
  datos
) {

  if (
    !datos ||
    !Array.isArray(datos.results)
  ) {

    return '';

  }

  return datos.results
    .slice(0, 5)
    .map(
      (resultado, indice) => {

        return `
FUENTE ${indice + 1}:
Título: ${resultado.title || 'Sin título'}
URL: ${resultado.url || ''}
Contenido:
${resultado.content || ''}
`;

      }
    )
    .join('\n');

}


// ============================================================
// PROCESAR RESPUESTA DE YARVIS
// ============================================================

async function procesarRespuestaIA(
  mensaje,
  sessionId,
  modo = 'asistente',
  imagen = null,
  mimeType = null,
  userId = 'default'
) {

  const modoFinal =
    MODOS_VALIDOS.includes(modo)
      ? modo
      : 'asistente';

  const sesion =
    obtenerSesion(
      sessionId,
      modoFinal
    );

  try {

    // ========================================================
    // IMAGEN
    // ========================================================

    if (
      imagen &&
      mimeType
    ) {

      const bytes =
        Buffer.byteLength(
          imagen,
          'base64'
        );

      if (
        bytes >
        MAX_IMAGEN_BYTES
      ) {

        throw new Error(
          'La imagen supera el límite de 8MB.'
        );

      }

      const memoriaTexto =
        contextoMemoria(
          userId
        );

      const mensajes = [

        {

          role:
            'system',

          content:
            (
              PROMPTS_MODO[
                modoFinal
              ] ||
              PROMPTS_MODO.asistente
            ) +
            memoriaTexto

        },

        {

          role:
            'user',

          content: [

            {

              type:
                'text',

              text:
                mensaje ||
                '¿Qué observas en esta imagen?'

            },

            {

              type:
                'image_url',

              image_url: {

                url:
                  `data:${mimeType};base64,${imagen}`

              }

            }

          ]

        }

      ];

      const completion =
        await groq.chat.completions.create({

          model:
            MODELO_VISION,

          messages:
            mensajes,

          temperature:
            0.7,

          max_tokens:
            2048

        });

      return (
        completion
          .choices?.[0]
          ?.message?.content ||
        'No pude analizar la imagen.'
      );

    }


    // ========================================================
    // MENSAJE DE TEXTO
    // ========================================================

    if (
      !mensaje ||
      typeof mensaje !== 'string'
    ) {

      throw new Error(
        'El mensaje está vacío.'
      );

    }

    const memoriaTexto =
      contextoMemoria(
        userId
      );


    // Actualizar instrucciones del sistema

    if (sesion.mensajes[0]) {

      sesion.mensajes[0].content =
        (
          PROMPTS_MODO[
            modoFinal
          ] ||
          PROMPTS_MODO.asistente
        ) +
        memoriaTexto;

    }


    // ========================================================
    // BÚSQUEDA WEB
    // ========================================================

    let contextoBusqueda = '';

    if (
      modoFinal === 'busqueda'
    ) {

      try {

        const datos =
          await buscarEnInternet(
            mensaje
          );

        contextoBusqueda =
          formatearResultadosBusqueda(
            datos
          );

      } catch (error) {

        console.error(
          'Error en búsqueda:',
          error.message
        );

        contextoBusqueda = '';

      }

    }


    let mensajeParaIA =
      mensaje.trim();


    if (contextoBusqueda) {

      mensajeParaIA += `

INFORMACIÓN OBTENIDA DE INTERNET:

${contextoBusqueda}

Utiliza esta información para responder.
No inventes datos que no aparezcan en
la información obtenida.
`;

    }


    // ========================================================
    // AGREGAR MENSAJE
    // ========================================================

    sesion.mensajes.push({

      role:
        'user',

      content:
        mensajeParaIA

    });


    recortarHistorial(
      sesion
    );


    // ========================================================
    // ELEGIR MODELO
    // ========================================================

    const modelo =
      modoFinal === 'busqueda'
        ? MODELO_BUSQUEDA
        : MODELO_TEXTO;


    const completion =
      await groq.chat.completions.create({

        model:
          modelo,

        messages:
          sesion.mensajes,

        temperature:
          0.7,

        max_tokens:
          2048

      });


    const respuesta =
      completion
        .choices?.[0]
        ?.message?.content ||
      'No pude generar una respuesta.';


    // ========================================================
    // GUARDAR RESPUESTA
    // ========================================================

    sesion.mensajes.push({

      role:
        'assistant',

      content:
        respuesta

    });


    recortarHistorial(
      sesion
    );


    guardarConversacion(

      userId,

      sessionId,

      mensaje.substring(
        0,
        60
      )

    );


    return respuesta;

  } catch (error) {

    console.error(
      '❌ Error de Yarvis:',
      error
    );

    throw new Error(
      'Ocurrió un error al generar la respuesta.'
    );

  }

}


// ============================================================
// FIN DE LA PARTE 2
// ============================================================
// ============================================================
// PARTE 3 — ENDPOINTS PRINCIPALES Y ARRANQUE
// ============================================================


// ============================================================
// CHAT
// ============================================================

app.post(
  '/chat',
  limitador,
  async (req, res) => {

    try {

      const {
        mensaje,
        sessionId = 'web_session',
        modo = 'asistente',
        imagen,
        mimeType,
        userId = 'default'
      } = req.body;


      if (!mensaje && !imagen) {

        return res
          .status(400)
          .json({
            error:
              'Envía un mensaje o una imagen.'
          });

      }


      if (
        typeof sessionId !== 'string' ||
        sessionId.length > 100
      ) {

        return res
          .status(400)
          .json({
            error:
              'sessionId inválido.'
          });

      }


      if (imagen && !mimeType) {

        return res
          .status(400)
          .json({
            error:
              'Falta mimeType para la imagen.'
          });

      }


      const respuesta =
        await procesarRespuestaIA(
          mensaje,
          sessionId,
          modo,
          imagen,
          mimeType,
          userId
        );


      res.json({

        ia:
          NOMBRE_IA,

        respuesta

      });

    } catch (error) {

      console.error(
        '❌ Error en /chat:',
        error
      );

      res
        .status(500)
        .json({

          error:
            error.message ||
            'Error interno del servidor.'

        });

    }

  }
);


// ============================================================
// BORRAR CONVERSACIÓN
// ============================================================

app.delete(
  '/conversations/:sessionId',
  limitador,
  (req, res) => {

    const userId =
      String(
        req.query.userId ||
        'default'
      );

    const sessionId =
      req.params.sessionId;


    if (
      conversaciones[userId]
    ) {

      conversaciones[userId] =
        conversaciones[userId].filter(
          item =>
            item.id !== sessionId
        );


      guardarJSON(
        CHATS_FILE,
        conversaciones
      );

    }


    // Eliminar sesión de memoria

    for (
      const key of sesiones.keys()
    ) {

      if (
        key.startsWith(
          `${sessionId}_`
        )
      ) {

        sesiones.delete(key);

      }

    }


    res.json({
      ok: true
    });

  }
);


// ============================================================
// REINICIAR CONVERSACIÓN
// ============================================================

app.post(
  '/reset',
  limitador,
  (req, res) => {

    const {
      sessionId = 'web_session',
      modo = 'asistente'
    } = req.body;


    const key =
      `${sessionId}_${modo}`;


    sesiones.delete(
      key
    );


    res.json({

      ok:
        true,

      mensaje:
        'Conversación reiniciada correctamente.'

    });

  }
);


// ============================================================
// TRANSCRIPCIÓN DE AUDIO
// ============================================================

app.post(
  '/transcribe',
  limitador,
  async (req, res) => {

    try {

      const {
        audio,
        mimeType = 'audio/webm'
      } = req.body;


      if (!audio) {

        return res
          .status(400)
          .json({
            error:
              'Falta el audio.'
          });

      }


      const bytes =
        Buffer.byteLength(
          audio,
          'base64'
        );


      if (
        bytes >
        MAX_AUDIO_BYTES
      ) {

        return res
          .status(400)
          .json({
            error:
              'El audio supera el límite de 15MB.'
          });

      }


      const extension =
        mimeType.includes('mp4')
          ? 'mp4'
          : mimeType.includes('ogg')
          ? 'ogg'
          : mimeType.includes('wav')
          ? 'wav'
          : 'webm';


      const archivo =
        path.join(
          require('os').tmpdir(),
          `yarvis-${crypto.randomUUID()}.${extension}`
        );


      fs.writeFileSync(
        archivo,
        Buffer.from(
          audio,
          'base64'
        )
      );


      const transcripcion =
        await groq.audio.transcriptions.create({

          file:
            fs.createReadStream(
              archivo
            ),

          model:
            MODELO_STT,

          language:
            'es'

        });


      try {
        fs.unlinkSync(
          archivo
        );
      } catch (_) {}


      res.json({

        texto:
          transcripcion.text || ''

      });

    } catch (error) {

      console.error(
        '❌ Error transcribiendo:',
        error
      );


      res
        .status(500)
        .json({

          error:
            'No pude transcribir el audio.'

        });

    }

  }
);


// ============================================================
// TEXTO A VOZ
// ============================================================

app.post(
  '/tts',
  limitador,
  async (req, res) => {

    try {

      const {
        texto
      } = req.body;


      if (
        !texto ||
        typeof texto !== 'string'
      ) {

        return res
          .status(400)
          .json({

            error:
              'Falta el texto.'

          });

      }


      const resultado =
        await groq.audio.speech.create({

          model:
            MODELO_TTS,

          voice:
            VOZ_TTS,

          input:
            texto.trim(),

          response_format:
            'wav'

        });


      const buffer =
        Buffer.from(
          await resultado.arrayBuffer()
        );


      res.set(
        'Content-Type',
        'audio/wav'
      );


      res.send(
        buffer
      );

    } catch (error) {

      console.error(
        '❌ Error TTS:',
        error
      );


      res
        .status(500)
        .json({

          error:
            'No pude generar el audio.'

        });

    }

  }
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.json({

      status:
        'ok',

      ia:
        NOMBRE_IA,

      version:
        '1.0.0',

      groq:
        Boolean(
          GROQ_API_KEY
        ),

      tavily:
        Boolean(
          TAVILY_API_KEY
        ),

      timestamp:
        new Date().toISOString()

    });

  }
);


// ============================================================
// INFORMACIÓN DE YARVIS
// ============================================================

app.get(
  '/api',
  (req, res) => {

    res.json({

      nombre:
        NOMBRE_IA,

      estado:
        'online',

      endpoints: [

        '/chat',

        '/memory',

        '/memory/add',

        '/conversations',

        '/reset',

        '/transcribe',

        '/tts',

        '/health'

      ]

    });

  }
);


// ============================================================
// RUTA PRINCIPAL
// ============================================================

app.get(
  '*',
  (req, res) => {

    const indexPath =
      path.join(
        __dirname,
        'public',
        'index.html'
      );


    if (
      fs.existsSync(indexPath)
    ) {

      res.sendFile(
        indexPath
      );

    } else {

      res.json({

        ia:
          NOMBRE_IA,

        mensaje:
          'Yarvis está funcionando correctamente.'

      });

    }

  }
);


// ============================================================
// MANEJO DE ERRORES
// ============================================================

app.use(
  (err, req, res, next) => {

    console.error(
      '❌ Error del servidor:',
      err
    );


    if (
      res.headersSent
    ) {

      return next(err);

    }


    res
      .status(500)
      .json({

        error:
          'Error interno del servidor.'

      });

  }
);


// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `🤖 ${NOMBRE_IA} está funcionando en el puerto ${PORT}`
    );

    console.log(
      `🌐 Servidor iniciado correctamente`
    );

    console.log(
      `🔎 Tavily: ${
        TAVILY_API_KEY
          ? 'ACTIVO'
          : 'NO CONFIGURADO'
      }`
    );

  }
);
