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

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const PORT = process.env.PORT || 3000;

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


const groq = new Groq({
  apiKey: GROQ_API_KEY
});


// ============================================================
// MODELOS
// ============================================================

const MODELO_TEXTO =
  'openai/gpt-oss-20b';

const MODELO_VISION =
  'qwen/qwen3.6-27b';

const MODELO_BUSQUEDA =
  'groq/compound';

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

Tienes acceso a Internet mediante herramientas
de búsqueda.

Utiliza Internet cuando la pregunta necesite
información actualizada.

Esto incluye noticias, clima, precios,
deportes, tecnología reciente, eventos,
horarios y cualquier información que pueda
haber cambiado.

No inventes resultados.

Cuando utilices información de Internet,
menciona brevemente las fuentes consultadas.
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

const app = express();

// Render funciona detrás de un proxy.
// Esto permite que express-rate-limit
// identifique correctamente la IP del usuario.
app.set('trust proxy', 1);


app.use(
  express.json({
    limit: '25mb'
  })
);


app.use(
  cors(
    ALLOWED_ORIGINS.length
      ? {
          origin: ALLOWED_ORIGINS
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
      recursive: true
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
// PARTE 2 — CEREBRO DE YARVIS
// ============================================================


// ────────────────────────────────────────────────────────────
// PROCESAR RESPUESTA DE LA IA
// ────────────────────────────────────────────────────────────

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
    // VISIÓN
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


      const promptSistema =
        PROMPTS_MODO[
          modoFinal
        ];


      const memoriaTexto =
        contextoMemoria(
          userId
        );


      const mensajes =
        [

          {

            role:
              'system',

            content:
              promptSistema +
              memoriaTexto

          },

          {

            role:
              'user',

            content:
              [

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

                  image_url:
                    {

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
    // TEXTO
    // ========================================================

    if (
      !mensaje ||
      typeof mensaje !==
        'string'
    ) {

      throw new Error(
        'El mensaje está vacío.'
      );

    }


    const memoriaTexto =
      contextoMemoria(
        userId
      );


    // Añadimos memoria al system prompt
    if (
      sesion.mensajes[0]
    ) {

      sesion.mensajes[0]
        .content =
          (
            PROMPTS_MODO[
              modoFinal
            ] ||
            PROMPTS_MODO.asistente
          ) +
          memoriaTexto;

    }


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
    // MODELO NORMAL / BÚSQUEDA
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


    sesion.mensajes.push({

      role:
        'assistant',

      content:
        respuesta

    });


    recortarHistorial(
      sesion
    );


    // Guardar información básica
    // de la conversación
    guardarConversacion(
      userId,
      sessionId,
      mensaje.substring(
        0,
        60
      )
    );


    return respuesta;

  }

  catch (
    error
  ) {

    console.error(
      '❌ Error de Yarvis:',
      error.message
    );


    throw new Error(
      'Ocurrió un error al generar la respuesta. Intenta de nuevo.'
    );

  }

}


// ────────────────────────────────────────────────────────────
// ENDPOINT PRINCIPAL /CHAT
// ────────────────────────────────────────────────────────────

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

    }

    catch (
      error
    ) {

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


// ────────────────────────────────────────────────────────────
// BORRAR CONVERSACIÓN
// ────────────────────────────────────────────────────────────

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


    // También eliminamos la sesión
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
      ok: true
    });

  }
);


// ────────────────────────────────────────────────────────────
// REINICIAR MEMORIA DE UNA SESIÓN
// ────────────────────────────────────────────────────────────

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


// ────────────────────────────────────────────────────────────
// HEALTH CHECK
// ────────────────────────────────────────────────────────────

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

      version:
        '2.0.0',

      sesionesActivas:
        sesiones.size,

      memoria:
        true,

      vision:
        true,

      voz:
        true,

      timestamp:
        new Date().toISOString()

    });

  }
);


// ────────────────────────────────────────────────────────────
// VOZ → TEXTO
// ────────────────────────────────────────────────────────────

app.post(
  '/transcribir',
  limitador,
  async (
    req,
    res
  ) => {

    let rutaTemporal =
      null;


    try {

      const {

        audio,

        mimeType =
          'audio/webm'

      } = req.body;


      if (
        !audio
      ) {

        return res
          .status(400)
          .json({

            error:
              'Envía el audio en base64.'

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


      let extension =
        'webm';


      if (
        mimeType.includes(
          'mp3'
        )
      ) {

        extension =
          'mp3';

      }

      else if (
        mimeType.includes(
          'wav'
        )
      ) {

        extension =
          'wav';

      }

      else if (
        mimeType.includes(
          'mp4'
        )
      ) {

        extension =
          'mp4';

      }


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


      const resultado =
        await groq.audio.transcriptions.create({

          file:
            fs.createReadStream(
              rutaTemporal
            ),

          model:
            MODELO_STT

        });


      res.json({

        texto:
          resultado.text ||
          ''

      });

    }

    catch (
      error
    ) {

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

        catch {}

      }

    }

  }
);


// ============================================================
// FIN DE LA PARTE 2
// ============================================================
// ============================================================
// PARTE 3 — VOZ, ARCHIVOS Y ARRANQUE DE YARVIS
// ============================================================


// ────────────────────────────────────────────────────────────
// TEXTO → VOZ
// ────────────────────────────────────────────────────────────

app.post(
  '/hablar',
  limitador,
  async (req, res) => {

    try {

      const {
        texto,
        voice
      } = req.body;


      if (
        !texto ||
        typeof texto !== 'string' ||
        !texto.trim()
      ) {

        return res
          .status(400)
          .json({
            error: 'Envía un texto.'
          });

      }


      if (
        texto.length > 2000
      ) {

        return res
          .status(400)
          .json({
            error:
              'El texto es demasiado largo (máximo 2000 caracteres).'
          });

      }


      const voz =
        typeof voice === 'string' &&
        voice.trim()
          ? voice.trim()
          : VOZ_TTS;


      const respuestaGroq =
        await fetch(
          'https://api.groq.com/openai/v1/audio/speech',
          {

            method: 'POST',

            headers: {
              Authorization:
                `Bearer ${GROQ_API_KEY}`,

              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({

              model:
                MODELO_TTS,

              input:
                texto.trim(),

              voice:
                voz,

              response_format:
                'mp3'

            })

          }
        );


      if (
        !respuestaGroq.ok
      ) {

        const detalle =
          await respuestaGroq.text();


        console.error(
          '❌ Error Groq TTS:',
          respuestaGroq.status,
          detalle
        );


        return res
          .status(500)
          .json({
            error:
              'Groq no pudo generar la voz.'
          });

      }


      const arrayBuffer =
        await respuestaGroq.arrayBuffer();


      const audioBase64 =
        Buffer
          .from(arrayBuffer)
          .toString('base64');


      res.json({

        audio:
          audioBase64,

        mimeType:
          'audio/mpeg',

        voice:
          voz

      });

    }

    catch (error) {

      console.error(
        '❌ Error en /hablar:',
        error.message
      );


      res
        .status(500)
        .json({

          error:
            'No se pudo generar el audio.'

        });

    }

  }
);


// ────────────────────────────────────────────────────────────
// INFORMACIÓN DEL SERVIDOR
// ────────────────────────────────────────────────────────────

app.get(
  '/info',
  (req, res) => {

    res.json({

      ia:
        NOMBRE_IA,

      version:
        '2.0.0',

      modelos: {

        texto:
          MODELO_TEXTO,

        vision:
          MODELO_VISION,

        busqueda:
          MODELO_BUSQUEDA,

        vozTexto:
          MODELO_STT,

        textoVoz:
          MODELO_TTS

      },

      funciones: [

        'chat',

        'memoria',

        'vision',

        'busqueda',

        'voz',

        'texto-a-voz',

        'voz-a-texto',

        'historial',

        'conversaciones'

      ]

    });

  }
);


// ────────────────────────────────────────────────────────────
// PÁGINA PRINCIPAL
// ────────────────────────────────────────────────────────────

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );

  }
);


// ────────────────────────────────────────────────────────────
// MANEJO DE RUTAS NO ENCONTRADAS
// ────────────────────────────────────────────────────────────

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        error:
          'Ruta no encontrada.',

        ia:
          NOMBRE_IA

      });

  }
);


// ────────────────────────────────────────────────────────────
// MANEJO GLOBAL DE ERRORES
// ────────────────────────────────────────────────────────────

app.use(
  (error, req, res, next) => {

    console.error(
      '❌ Error global:',
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
      .status(500)
      .json({

        error:
          'Error interno del servidor.'

      });

  }
);


// ============================================================
// ARRANQUE DEL SERVIDOR
// ============================================================

const server =
  app.listen(
    PORT,
    '0.0.0.0',
    () => {

      console.log(
        `🚀 ${NOMBRE_IA} iniciado correctamente.`
      );

      console.log(
        `🌐 Puerto: ${PORT}`
      );

      console.log(
        `🧠 Modelo: ${MODELO_TEXTO}`
      );

      console.log(
        `👁️ Visión: activada`
      );

      console.log(
        `🎤 Voz: activada`
      );

      console.log(
        `💾 Memoria: activada`
      );

    }
  );


// ============================================================
// CIERRE ORDENADO
// ============================================================

function cerrarServidor(
  señal
) {

  console.log(
    `📴 Recibida señal ${señal}. Cerrando servidor...`
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


  setTimeout(
    () => {

      process.exit(
        1
      );

    },
    10000
  );

}


process.on(
  'SIGTERM',
  () => cerrarServidor('SIGTERM')
);


process.on(
  'SIGINT',
  () => cerrarServidor('SIGINT')
);


// ============================================================
// FIN DE SERVER.JS
// ============================================================
