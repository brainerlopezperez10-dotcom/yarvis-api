const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use(cors());

// Conexión con tu API Key configurada en Render
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const NOMBRE_IA = "Yarvis";

app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está en línea y listo.` });
});

app.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: "Por favor envía un mensaje." });
    }

    // Inicializamos el modelo de Google Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, atento y servicial. Responde al usuario: "${mensaje}"`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.json({
      ia: NOMBRE_IA,
      respuesta: response.text()
    });

  } catch (error) {
    console.error("Error en Yarvis:", error);
    res.status(500).json({ error: "Ocurrió un error al procesar la respuesta." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} en puerto ${PORT}`));
