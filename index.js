const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(cors());

// Se inicializa con la clave de entorno que pusiste en Render
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const NOMBRE_IA = "Yarvis";

app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está en línea y funcionando.` });
});

app.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: "Envía un mensaje." });
    }

    const prompt = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente y servicial. Responde al usuario: "${mensaje}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    res.json({
      ia: NOMBRE_IA,
      respuesta: response.text
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno al procesar tu consulta." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en el puerto ${PORT}`));
