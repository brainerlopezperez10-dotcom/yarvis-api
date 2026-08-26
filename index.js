const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(cors());

// Inicializa Google Gen AI con tu API Key almacenada en variables de entorno
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const NOMBRE_IA = "Yarvis";

app.get('/', (req, res) => {
  res.json({ estado: `${NOMBRE_IA} está en línea y conectado al cerebro de IA.` });
});

app.post('/chat', async (req, res) => {
  try {
    const { mensaje } = req.body;
    
    if (!mensaje) {
      return res.status(400).json({ error: "Por favor envía un mensaje." });
    }

    // Le damos a la IA la orden de actuar siempre como Yarvis
    const promptConfigurado = `Tu nombre es ${NOMBRE_IA}. Eres un asistente virtual inteligente, servicial y amable. Responde al siguiente mensaje del usuario: "${mensaje}"`;

    // Llamada al modelo inteligente
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: promptConfigurado,
    });

    res.json({
      ia: NOMBRE_IA,
      respuesta: response.text
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al comunicarse con la IA." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ${NOMBRE_IA} corriendo en puerto ${PORT}`));
