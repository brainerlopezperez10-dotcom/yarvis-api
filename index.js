const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use(cors());

// Conexión con tu API Key configurada en Render
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

// Lista de modelos a intentar en orden de preferencia
const MODELOS_DISPONIBLES = [
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-1.0-pro"
];

app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está activo y listo.` });
});

app.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: "Escribe un mensaje en el campo 'mensaje'." });
    }

    if (!apiKey) {
      return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Render." });
    }

    const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, atento y servicial. Responde al usuario: "${mensaje}"`;

    let respuestaTexto = null;
    let ultimoError = null;

    // Recorremos la lista de modelos hasta que uno funcione
    for (const nombreModelo of MODELOS_DISPONIBLES) {
      try {
        const model = genAI.getGenerativeModel({ model: nombreModelo });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        respuestaTexto = response.text();
        
        // Si funcionó, salimos del bucle
        if (respuestaTexto) break;
      } catch (err) {
        console.warn(`El modelo ${nombreModelo} no respondió, intentando con el siguiente...`);
        ultimoError = err;
      }
    }

    // Si ningún modelo respondió
    if (!respuestaTexto) {
      throw ultimoError || new Error("Ninguno de los modelos configurados pudo responder.");
    }

    res.json({
      ia: NOMBRE_IA,
      respuesta: respuestaTexto
    });

  } catch (error) {
    console.error("Error en Yarvis:", error);
    res.status(500).json({ 
      error: "Ocurrió un error en la comunicación con la IA.",
      detalle: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} iniciado en el puerto ${PORT}`));
