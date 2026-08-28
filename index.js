require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

const app = express();

/* =========================================================
   CONFIGURACIÓN
========================================================= */

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


/* =========================================================
   MODELOS
========================================================= */

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


/* =========================================================
   MODOS DE YARVIS
========================================================= */

const PROMPTS_MODO = {

  asistente: `
Tu nombre es Yarvis.

Eres un asistente de inteligencia artificial rápido,
útil, inteligente y amigable.

Responde en español salvo que el usuario pida otro idioma.

Sé claro y directo.

Puedes ayudar con:
- preguntas generales
- tecnología
- teléfonos
- aplicaciones
- juegos
- programación
- matemáticas
- explicaciones
- ideas
- escritura
- planificación

No inventes información.
`,

  explicativo: `
Tu nombre es Yarvis.

Eres un profesor y tutor experto.

Explica las cosas paso a paso.

Usa ejemplos sencillos.

Si el usuario parece principiante,
explica primero lo básico y después lo avanzado.

Responde en español salvo que te pidan otro idioma.
`,

  creativo: `
Tu nombre es Yarvis.

Eres un asistente creativo.

Ayudas a crear:
- historias
- nombres
- diseños
- ideas
- proyectos
- guiones
- publicaciones
- conceptos para aplicaciones
- ideas para videojuegos

Sé original y evita respuestas genéricas.
`,

  programador: `
Tu nombre es Yarvis.

Eres un programador experto.

Puedes ayudar con:
- JavaScript
- Node.js
- HTML
- CSS
- Python
- APIs
- Express
- bases de datos
- GitHub
- Render
- aplicaciones web
- debugging

Cuando escribas código:
1. explica brevemente qué hace
2. entrega código completo cuando sea necesario
3. indica dónde debe colocarse
4. evita código innecesariamente complicado

Si encuentras un error en el código del usuario,
identifica exactamente el problema y proporciona la corrección.
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

Tienes acceso a Internet mediante herramientas de búsqueda.

Utiliza Internet cuando la pregunta necesite
información actualizada.

Esto incluye:
- noticias
- clima
- precios
- deportes
- tecnología reciente
- eventos
- horarios
- información que pueda haber cambiado

No inventes resultados.

Cuando utilices información de Internet,
menciona brevemente las fuentes o sitios consultados.
`

};

const MODOS_VALIDOS =
  Object.keys(PROMPTS_MODO);


/* =========================================================
   LÍMITES
========================================================= */

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


/* =========================================================
   MEMORIA EN ARCHIVOS
========================================================= */

const DATA_DIR =
  path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
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
      'Error leyendo JSON:',
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


/* =========================================================
   SESIONES EN MEMORIA
========================================================= */

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
            role: 'system',
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


/* =========================================================
   LIMPIEZA DE SESIONES
========================================================= */

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

        sesiones.delete(key);

      }

    }

  },
  15 * 60 * 1000
);


/* =========================================================
   EXPRESS
========================================================= */

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


/* =========================================================
   RATE LIMIT
========================================================= */

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


/* =========================================================
   MEMORIA DEL USUARIO
========================================================= */

function obtenerMemorias(
  userId
) {

  if (!memoria[userId]) {
    memoria[userId] = [];
  }

  return memoria[userId];

}


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
        obtenerMemorias(userId)
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
        String(userId)
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


/* =========================================================
   CONVERSACIONES
========================================================= */

app.get(
  '/conversations',
  limitador,
  (req, res) => {

    const userId =
      String(
        req.query.userId ||
        'default'
      );

    const lista =
      conversaciones[userId] ||
      [];

    res.json({
      conversations:
        lista
    });

  }
);


function guardarConversacion(
  userId,
  sessionId,
  titulo
) {

  userId =
    String(userId);

  if (
    !conversaciones[userId]
  ) {

    conversaciones[userId] =
      [];

  }

  let existente =
    conversaciones[userId]
      .find(
        c =>
          c.id ===
          sessionId
      );

  if (!existente) {

    existente = {

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

    conversaciones[userId]
      .push(existente);

  } else {

    existente.updatedAt =
      new Date().toISOString();

  }

  guardarJSON(
    CHATS_FILE,
    conversaciones
  );

}


/* =========================================================
   LEER ARCHIVOS
========================================================= */

function limpiarTextoArchivo(
  texto
) {

  if (!texto)
    return '';

  return texto
    .replace(
      /\0/g,
      ''
    )
    .slice(
      0,
      100000
    );

}


app.post(
  '/file',
  limitador,
  async (req, res) => {

    try {

      const {
        file,
        name = 'archivo',
        mimeType = ''
      } = req.body;

      if (!file) {

        return res
          .status(400)
          .json({
            error:
              'No se recibió el archivo.'
          });

      }

      const bytes =
        Buffer.byteLength(
          file,
          'base64'
        );

      if (
        bytes >
        MAX_ARCHIVO_BYTES
      ) {

        return res
          .status(400)
          .json({
            error:
              'El archivo supera los 10 MB.'
          });

      }

      const buffer =
        Buffer.from(
          file,
          'base64'
        );

      const extension =
        path.extname(name)
          .toLowerCase();

      let texto = '';


      /* TEXTO */

      if (
        extension !==
          '.pdf'
      ) {

        texto =
          buffer.toString(
            'utf8'
          );

      }


      /*
       PDF:

       Para evitar que tu servidor falle
       si pdf-parse no está instalado,
       devolvemos una indicación.
      */

      else {

        texto =
          `
Archivo PDF recibido: ${name}

El PDF fue cargado correctamente.
Para habilitar extracción completa de texto
añade la dependencia pdf-parse al proyecto.
          `.trim();

      }


      texto =
        limpiarTextoArchivo(
          texto
        );


      res.json({

        ok: true,

        name,

        mimeType,

        text: texto

      });

    }

    catch(error) {

      console.error(
        'Error archivo:',
        error.message
      );

      res
        .status(500)
        .json({
          error:
            'No se pudo leer el archivo.'
        });

    }

  }
);


/* =========================================================
   CONSTRUIR MEMORIA PARA LA IA
========================================================= */

function contextoMemoria(
  userId
) {

  const lista =
    memoria[
      String(userId)
    ] || [];

  if (!lista.length)
    return '';

  return `

MEMORIA DEL USUARIO:

${lista
  .slice(-20)
  .map(
    m =>
      '- ' + m.text
  )
  .join('\n')}

Utiliza estos datos únicamente
cuando sean relevantes para la conversación.

`;

}


/* =========================================================
   PROCESAR IA
========================================================= */

async function procesarIA({

  mensaje,

  sessionId,

  userId,

  modo,

  imagen,

  mimeType,

  fileContext

}) {

  const modoFinal =
    MODOS_VALIDOS.includes(modo)
      ? modo
      : 'asistente';


  const sesion =
    obtenerSesion(
      sessionId,
      modoFinal
    );


  let modelo =
    MODELO_TEXTO;

  let messages;


  /* =====================================================
     IMAGEN
  ===================================================== */

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
        'La imagen supera los 8 MB.'
      );

    }


    modelo =
      MODELO_VISION;


    let texto =
      mensaje ||
      'Analiza esta imagen.';


    if (fileContext) {

      texto +=
        `\n\nContexto del archivo:\n${fileContext}`;

    }


    messages = [

      {
        role:
          'system',

        content:
          PROMPTS_MODO[
            modoFinal
          ] +
          contextoMemoria(
            userId
          )

      },

      {

        role:
          'user',

        content: [

          {
            type:
              'text',

            text
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

  }


  /* =====================================================
     TEXTO
  ===================================================== */

  else {

    let contenido =
      mensaje || '';


    if (fileContext) {

      contenido +=
        `\n\n--- ARCHIVO DEL USUARIO ---\n${fileContext}\n--- FIN DEL ARCHIVO ---`;

    }


    /*
      Si es búsqueda,
      usamos Compound.
    */

    if (
      modoFinal ===
      'busqueda'
    ) {

      modelo =
        MODELO_BUSQUEDA;

    }


    sesion.mensajes[0] = {

      role:
        'system',

      content:
        PROMPTS_MODO[
          modoFinal
        ] +
        contextoMemoria(
          userId
        )

    };


    sesion.mensajes.push({

      role:
        'user',

      content:
        contenido

    });


    recortarHistorial(
      sesion
    );


    messages =
      sesion.mensajes;

  }


  /* =====================================================
     GROQ
  ===================================================== */

  const completion =
    await groq.chat.completions.create({

      model:
        modelo,

      messages,

      temperature:
        0.7,

      max_tokens:
        2048

    });


  const respuesta =
    completion
      .choices?.[0]
      ?.message
      ?.content ||
    'No pude generar una respuesta.';


  /* GUARDAR HISTORIAL */

  if (!imagen) {

    sesion.mensajes.push({

      role:
        'assistant',

      content:
        respuesta

    });

    recortarHistorial(
      sesion
    );

  }


  /* GUARDAR CONVERSACIÓN */

  if (userId) {

    guardarConversacion(

      userId,

      sessionId,

      mensaje
        ? mensaje.slice(
            0,
            60
          )
        : 'Conversación'

    );

  }


  return respuesta;

}


/* =========================================================
   ENDPOINT CHAT
========================================================= */

app.post(
  '/chat',
  limitador,
  async (req, res) => {

    try {

      const {

        mensaje,

        sessionId =
          'default_session',

        userId =
          'default',

        modo =
          'asistente',

        imagen,

        mimeType,

        fileContext

      } = req.body;


      if (
        !mensaje &&
        !imagen &&
        !fileContext
      ) {

        return res
          .status(400)
          .json({
            error:
              'Envía un mensaje, imagen o archivo.'
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


      const respuesta =
        await procesarIA({

          mensaje,

          sessionId,

          userId,

          modo,

          imagen,

          mimeType,

          fileContext

        });


      res.json({

        ia:
          NOMBRE_IA,

        respuesta,

        modo:
          modo,

        sessionId

      });

    }

    catch(error) {

      console.error(
        '[CHAT ERROR]',
        error.message
      );

      res
        .status(500)
        .json({
          error:
            'Ocurrió un error al generar la respuesta.'
        });

    }

  }
);


/* =========================================================
   VOZ -> TEXTO
========================================================= */

app.post(
  '/transcribir',
  limitador,
  async (req, res) => {

    let temporal =
      null;

    try {

      const {

        audio,

        mimeType =
          'audio/webm'

      } = req.body;


      if (!audio) {

        return res
          .status(400)
          .json({
            error:
              'No se recibió audio.'
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
              'El audio supera los 15 MB.'
          });

      }


      let extension =
        'webm';


      if (
        mimeType.includes(
          'mp3'
        )
      )
        extension =
          'mp3';


      if (
        mimeType.includes(
          'wav'
        )
      )
        extension =
          'wav';


      temporal =
        path.join(

          os.tmpdir(),

          `yarvis_${crypto.randomUUID()}.${extension}`

        );


      fs.writeFileSync(

        temporal,

        Buffer.from(
          audio,
          'base64'
        )

      );


      const result =
        await groq.audio
          .transcriptions
          .create({

            file:
              fs.createReadStream(
                temporal
              ),

            model:
              MODELO_STT

          });


      res.json({

        texto:
          result.text || ''

      });

    }

    catch(error) {

      console.error(
        '[STT ERROR]',
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
        temporal &&
        fs.existsSync(
          temporal
        )
      ) {

        try {

          fs.unlinkSync(
            temporal
          );

        } catch {}

      }

    }

  }
);


/* =========================================================
   TEXTO -> VOZ
========================================================= */

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
        !texto.trim()
      ) {

        return res
          .status(400)
          .json({
            error:
              'Envía un texto.'
          });

      }


      if (
     
