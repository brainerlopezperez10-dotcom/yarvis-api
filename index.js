const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use(cors());

// Verificación de API Key
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);
const NOMBRE_IA = "Yarvis";

app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está activo.` });
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

    // Usamos el modelo estable gemini-2.5-flash
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente y amable. Responde al usuario: "${mensaje}"`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.json({
      ia: NOMBRE_IA,
      respuesta: response.text()
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
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} en puerto ${PORT}`));
