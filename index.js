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

// ============================================================
// PARTE 3 — CEREBRO PRINCIPAL DE YARVIS
// CHAT + MEMORIA + BÚSQUEDA + IMÁGENES
// ============================================================


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
    // SI HAY IMAGEN
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
          role: 'system',

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
          role: 'user',

          content: [

            {
              type: 'text',

              text:
                mensaje ||
                '¿Qué observas en esta imagen?'
            },

            {
              type: 'image_url',

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


      const respuesta =
        completion
          .choices?.[0]
          ?.message?.content ||
        'No pude analizar la imagen.';


      return respuesta;

    }


    // ========================================================
    // VALIDAR MENSAJE
    // ========================================================

    if (
      !mensaje ||
      typeof mensaje !== 'string'
    ) {

      throw new Error(
        'El mensaje está vacío.'
      );

    }


    // ========================================================
    // MEMORIA
    // ========================================================

    const memoriaTexto =
      contextoMemoria(
        userId
      );


    if (
      sesion.mensajes[0]
    ) {

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
    // BÚSQUEDA TAVILY
    // ========================================================

    let contextoBusqueda = '';


    if (
      modoFinal === 'busqueda'
    ) {

      try {

        const resultados =
          await buscarEnInternet(
            mensaje
          );


        if (
          resultados.answer
        ) {

          contextoBusqueda += `

RESPUESTA DE INTERNET:

${resultados.answer}

`;

        }


        if (
          Array.isArray(
            resultados.results
          )
        ) {

          contextoBusqueda += `

RESULTADOS DE INTERNET:

`;

          resultados.results
            .slice(0, 5)
            .forEach(
              (resultado, index) => {

                contextoBusqueda += `

${index + 1}. ${resultado.title}

URL:
${resultado.url}

CONTENIDO:
${resultado.content}

`;

              }
            );

        }


      } catch (error) {

        console.error(
          '❌ Error en búsqueda:',
          error.message
        );

        contextoBusqueda = `

La búsqueda de Internet
no está disponible en este momento.

Responde utilizando únicamente
la información que ya conoces.
`;

      }

    }


    // ========================================================
    // AGREGAR PREGUNTA DEL USUARIO
    // ========================================================

    sesion.mensajes.push({

      role:
        'user',

      content:
        mensaje.trim()

    });


    recortarHistorial(
      sesion
    );


    // ========================================================
    // SI HAY RESULTADOS DE INTERNET,
    // SE LOS DAMOS A YARVIS
    // ========================================================

    if (
      contextoBusqueda
    ) {

      sesion.mensajes.push({

        role:
          'system',

        content:
          contextoBusqueda

      });

    }


    // ========================================================
    // ELEGIR MODELO
    // ========================================================

    const modelo =
      modoFinal === 'busqueda'
        ? MODELO_TEXTO
        : MODELO_TEXTO;


    // ========================================================
    // GENERAR RESPUESTA
    // ========================================================

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
    // GUARDAR RESPUESTA EN HISTORIAL
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


    // ========================================================
    // GUARDAR CONVERSACIÓN
    // ========================================================

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
      error.message
    );


    throw new Error(
      'Ocurrió un error al generar la respuesta. Intenta de nuevo.'
    );

  }

}


// ============================================================
// ENDPOINT PRINCIPAL /CHAT
// ============================================================

app.post(
  '/chat',
  limitador,
  async (
    req,
    res
  ) => {

    try {

      const {

        mensaje,

        sessionId =
          'web_session',

        modo =
          'asistente',

        imagen,

        mimeType,

        userId =
          'default'

      } = req.body;


      // ======================================================
      // VALIDAR MENSAJE
      // ======================================================

      if (
        !mensaje &&
        !imagen
      ) {

        return res
          .status(400)
          .json({

            error:
              'Envía un mensaje o una imagen.'

          });

      }


      // ======================================================
      // VALIDAR SESIÓN
      // ======================================================

      if (
        typeof sessionId !==
          'string' ||
        sessionId.length >
          100
      ) {

        return res
          .status(400)
          .json({

            error:
              'sessionId inválido.'

          });

      }


      // ======================================================
      // VALIDAR IMAGEN
      // ======================================================

      if (
        imagen &&
        !mimeType
      ) {

        return res
          .status(400)
          .json({

            error:
              'Falta mimeType para la imagen.'

          });

      }


      // ======================================================
      // PROCESAR
      // ======================================================

      const respuesta =
        await procesarRespuestaIA(

          mensaje,

          sessionId,

          modo,

          imagen,

          mimeType,

          userId

        );


      // ======================================================
      // RESPUESTA
      // ======================================================

      res.json({

        ia:
          NOMBRE_IA,

        respuesta

      });

    } catch (error) {

      console.error(
        '❌ Error en /chat:',
        error.message
      );


      res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);


// ============================================================
// FIN DE LA PARTE 3
// ============================================================

// ============================================================
// PARTE 4 — CONVERSACIONES Y CONTROL DE SESIONES
// ============================================================


// ============================================================
// LISTAR CONVERSACIONES
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


// ============================================================
// GUARDAR CONVERSACIÓN
// ============================================================

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


  // ----------------------------------------------------------
  // CREAR NUEVA CONVERSACIÓN
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // ACTUALIZAR CONVERSACIÓN
  // ----------------------------------------------------------

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
// BORRAR UNA CONVERSACIÓN
// ============================================================

app.delete(
  '/conversations/:sessionId',
  limitador,
  (
    req,
    res
  ) => {

    const userId =
      String(
        req.query.userId ||
        'default'
      );


    const sessionId =
      req.params.sessionId;


    // --------------------------------------------------------
    // BORRAR DEL ARCHIVO DE CONVERSACIONES
    // --------------------------------------------------------

    if (
      conversaciones[userId]
    ) {

      conversaciones[userId] =
        conversaciones[userId]
          .filter(
            item =>
              item.id !==
              sessionId
          );


      guardarJSON(
        CHATS_FILE,
        conversaciones
      );

    }


    // --------------------------------------------------------
    // BORRAR TAMBIÉN LA SESIÓN ACTIVA
    // --------------------------------------------------------

    for (
      const key of sesiones.keys()
    ) {

      if (
        key.startsWith(
          `${sessionId}_`
        )
      ) {

        sesiones.delete(
          key
        );

      }

    }


    res.json({

      ok:
        true,

      mensaje:
        'Conversación eliminada.'

    });

  }
);


// ============================================================
// REINICIAR CONVERSACIÓN ACTUAL
// ============================================================

app.post(
  '/reset',
  limitador,
  (
    req,
    res
  ) => {

    const {

      sessionId =
        'web_session',

      modo =
        'asistente'

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
// BORRAR TODAS LAS CONVERSACIONES DE UN USUARIO
// ============================================================

app.delete(
  '/conversations',
  limitador,
  (
    req,
    res
  ) => {

    const userId =
      String(
        req.query.userId ||
        'default'
      );


    // Borrar conversaciones guardadas

    delete conversaciones[userId];


    guardarJSON(
      CHATS_FILE,
      conversaciones
    );


    // Borrar sesiones activas

    for (
      const key of sesiones.keys()
    ) {

      if (
        key.startsWith(
          `${userId}_`
        )
      ) {

        sesiones.delete(
          key
        );

      }

    }


    res.json({

      ok:
        true,

      mensaje:
        'Todas las conversaciones fueron eliminadas.'

    });

  }
);


// ============================================================
// ESTADO DE YARVIS
// ============================================================

app.get(
  '/health',
  (
    req,
    res
  ) => {

    res.json({

      status:
        'ok',

      ia:
        NOMBRE_IA,

      sesionesActivas:
        sesiones.size,

      usuariosConMemoria:
        Object.keys(
          memoria
        ).length,

      usuariosConConversaciones:
        Object.keys(
          conversaciones
        ).length,

      funciones: [

        'chat',

        'memoria',

        'conversaciones',

        'imagenes',

        'busqueda-web',

        'voz',

        'modo-asistente',

        'modo-explicativo',

        'modo-creativo',

        'modo-programador',

        'modo-investigador'

      ]

    });

  }
);


// ============================================================
// FIN DE LA PARTE 4
// ============================================================

// ============================================================
// PARTE 5 — SISTEMA DE VOZ DE YARVIS
// AUDIO -> TEXTO
// TEXTO -> AUDIO
// ============================================================


// ============================================================
// TRANSCRIPCIÓN DE AUDIO
// ============================================================

app.post(
  '/transcribir',
  limitador,
  async (req, res) => {

    let rutaTemporal = null;

    try {

      const {
        audio,
        mimeType = 'audio/webm'
      } = req.body;


      // ------------------------------------------------------
      // COMPROBAR AUDIO
      // ------------------------------------------------------

      if (!audio) {

        return res
          .status(400)
          .json({
            error:
              'Envía el audio en base64.'
          });

      }


      // ------------------------------------------------------
      // COMPROBAR TAMAÑO
      // ------------------------------------------------------

      const bytesAprox =
        Buffer.byteLength(
          audio,
          'base64'
        );


      if (
        bytesAprox >
        MAX_AUDIO_BYTES
      ) {

        return res
          .status(400)
          .json({
            error:
              'El audio supera el límite de 15MB.'
          });

      }


      // ------------------------------------------------------
      // DETERMINAR EXTENSIÓN
      // ------------------------------------------------------

      let extension = 'webm';


      if (
        mimeType.includes('mp3')
      ) {

        extension = 'mp3';

      }

      else if (
        mimeType.includes('wav')
      ) {

        extension = 'wav';

      }

      else if (
        mimeType.includes('mp4')
      ) {

        extension = 'mp4';

      }


      // ------------------------------------------------------
      // CREAR ARCHIVO TEMPORAL
      // ------------------------------------------------------

      rutaTemporal =
        path.join(
          os.tmpdir(),
          `yarvis_${crypto.randomUUID()}.${extension}`
        );


      fs.writeFileSync(
        rutaTemporal,
        Buffer.from(
          audio,
          'base64'
        )
      );


      // ------------------------------------------------------
      // ENVIAR AUDIO A WHISPER
      // ------------------------------------------------------

      const transcripcion =
        await groq.audio.transcriptions.create({

          file:
            fs.createReadStream(
              rutaTemporal
            ),

          model:
            MODELO_STT

        });


      // ------------------------------------------------------
      // RESPONDER AL CLIENTE
      // ------------------------------------------------------

      res.json({

        texto:
          transcripcion.text ||
          ''

      });

    }

    catch (error) {

      console.error(
        '❌ Error STT:',
        error.message
      );


      res
        .status(500)
        .json({

          error:
            'No se pudo transcribir el audio.'

        });

    }

    finally {

      // ------------------------------------------------------
      // BORRAR ARCHIVO TEMPORAL
      // ------------------------------------------------------

      if (
        rutaTemporal &&
        fs.existsSync(
          rutaTemporal
        )
      ) {

        try {

          fs.unlinkSync(
            rutaTemporal
          );

        }

        catch (error) {

          console.error(
            'Error eliminando audio temporal:',
            error.message
          );

        }

      }

    }

  }
);


// ============================================================
// TEXTO -> VOZ
// ============================================================

app.post(
  '/hablar',
  limitador,
  async (req, res) => {

    try {

      const {
        texto,
        voice
      } = req.body;


      // ------------------------------------------------------
      // VALIDAR TEXTO
      // ------------------------------------------------------

      if (
        !texto ||
        typeof texto !== 'string' ||
        !texto.trim()
      ) {

        return res
          .status(400)
          .json({

            error:
              'Envía un texto.'

          });

      }


      // ------------------------------------------------------
      // LÍMITE DE TEXTO
      // ------------------------------------------------------

      if (
        texto.length >
        2000
      ) {

        return res
          .status(400)
          .json({

            error:
              'El texto es demasiado largo. Máximo 2000 caracteres.'

          });

      }


      // ------------------------------------------------------
      // VOCES PERMITIDAS
      // ------------------------------------------------------

      const VOCES_PERMITIDAS = [

        'Aaliyah-PlayAI',

        'Arista-PlayAI',

        'Atlas-PlayAI',

        'Briggs-PlayAI',

        'Calum-PlayAI',

        'Celeste-PlayAI',

        'Cheyenne-PlayAI',

        'Deedee-PlayAI',

        'Fritz-PlayAI',

        'Gail-PlayAI',

        'Indigo-PlayAI',

        'Mason-PlayAI',

        'Mitch-PlayAI',

        'Quinn-PlayAI',

        'Thunder-PlayAI'

      ];


      const vozElegida =
        VOCES_PERMITIDAS.includes(
          voice
        )
          ? voice
          : VOZ_TTS;


      // ------------------------------------------------------
      // SOLICITUD A GROQ
      // ------------------------------------------------------

      const respuestaGroq =
        await fetch(
          'https://api.groq.com/openai/v1/audio/speech',
          {

            method:
              'POST',

            headers: {

              Authorization:
                `Bearer ${GROQ_API_KEY}`,

              'Content-Type':
                'application/json'

            },

            body:
              JSON.stringify({

                model:
                  MODELO_TTS,

                input:
                  texto.trim(),

                voice:
                  vozElegida,

                response_format:
                  'mp3'

              })

          }
        );


      // ------------------------------------------------------
      // COMPROBAR RESPUESTA
      // ------------------------------------------------------

      if (
        !respuestaGroq.ok
      ) {

        const detalle =
          await respuestaGroq.text();


        console.error(
          '❌ Error Groq TTS:',
          detalle
        );


        throw new Error(
          'Groq no pudo generar el audio.'
        );

      }


      // ------------------------------------------------------
      // CONVERTIR AUDIO A BASE64
      // ------------------------------------------------------

      const arrayBuffer =
        await respuestaGroq.arrayBuffer();


      const audioBase64 =
        Buffer
          .from(arrayBuffer)
          .toString('base64');


      // ------------------------------------------------------
      // ENVIAR AUDIO
      // ------------------------------------------------------

      res.json({

        audio:
          audioBase64,

        mimeType:
          'audio/mpeg',

        voice:
          vozElegida

      });

    }

    catch (error) {

      console.error(
        '❌ Error TTS:',
        error.message
      );


      res
        .status(500)
        .json({

          error:
            'No se pudo generar la voz de Yarvis.'

        });

    }

  }
);


// ============================================================
// FIN DE LA PARTE 5
// ============================================================

// ============================================================
// PARTE 6 — ARRANQUE FINAL DE YARVIS
// ============================================================


// ============================================================
// INFORMACIÓN DEL SERVIDOR
// ============================================================

app.get(
  '/api',
  (req, res) => {

    res.json({

      ia: NOMBRE_IA,

      estado:
        'online',

      mensaje:
        'Yarvis está funcionando correctamente.',

      funciones: [

        'chat',

        'memoria',

        'conversaciones',

        'imagenes',

        'busqueda-web',

        'voz',

        'transcripcion',

        'modo-asistente',

        'modo-explicativo',

        'modo-creativo',

        'modo-programador',

        'modo-investigador'

      ]

    });

  }
);


// ============================================================
// RUTA 404 PARA API
// ============================================================

app.use(
  (req, res, next) => {

    // Si es una petición de API,
    // devolver JSON en lugar de HTML.

    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/chat') ||
      req.path.startsWith('/memory') ||
      req.path.startsWith('/conversations') ||
      req.path.startsWith('/transcribir') ||
      req.path.startsWith('/hablar') ||
      req.path.startsWith('/reset')
    ) {

      return res
        .status(404)
        .json({

          error:
            'Ruta no encontrada.'

        });

    }

    next();

  }
);


// ============================================================
// MANEJADOR GENERAL DE ERRORES
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      '❌ Error del servidor:',
      error.message
    );


    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }


    res
      .status(
        error.status || 500
      )
      .json({

        error:
          'Error interno del servidor.'

      });

  }
);


// ============================================================
// ARRANCAR SERVIDOR
// ============================================================

const server =
  app.listen(
    PORT,
    () => {

      console.log(
        '========================================'
      );

      console.log(
        `🤖 ${NOMBRE_IA} iniciado correctamente`
      );

      console.log(
        `🚀 Puerto: ${PORT}`
      );

      console.log(
        `🧠 Modelo: ${MODELO_TEXTO}`
      );

      console.log(
        '🔎 Búsqueda web: Tavily'
      );

      console.log(
        '👁️ Visión: activada'
      );

      console.log(
        '🎙️ Transcripción: activada'
      );

      console.log(
        '🔊 Voz: activada'
      );

      console.log(
        '💾 Memoria: activada'
      );

      console.log(
        '========================================'

      );

    }
  );


// ============================================================
// CIERRE SEGURO
// ============================================================

function cerrarServidor(
  señal
) {

  console.log(
    `📴 Recibida señal ${señal}. Cerrando Yarvis...`
  );


  server.close(
    () => {

      console.log(
        '✅ Servidor cerrado correctamente.'
      );

      process.exit(
        0
      );

    }
  );


  // Si tarda demasiado,
  // forzamos el cierre.

  setTimeout(
    () => {

      console.error(
        '⚠️ Cierre forzado del servidor.'
      );

      process.exit(
        1
      );

    },
    10000
  );

}


process.on(
  'SIGTERM',
  () => {

    cerrarServidor(
      'SIGTERM'
    );

  }
);


process.on(
  'SIGINT',
  () => {

    cerrarServidor(
      'SIGINT'
    );

  }
);


// ============================================================
// FIN DEL SERVER.JS
// ============================================================
