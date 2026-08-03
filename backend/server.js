require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const ImageKit = require("imagekit");
const multer = require("multer");

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.use(cors({
  origin: [
    "https://gavemoneytips.blogspot.com",
    "http://localhost:3000"
  ],
  methods: [
    "GET",
    "POST"
  ],
  allowedHeaders: [
    "Content-Type"
  ]
}));

app.use(express.json());


app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running 🚀");
});


app.post("/chat", async (req, res) => {

  try {

    const userMessage = req.body.message;


    const completion = await groq.chat.completions.create({

      model: "llama-3.3-70b-versatile",

      messages: [

        {
          role: "system",

          content: `
You are Gave Money Tips AI Assistant.

You are a multilingual professional AI assistant.

IMPORTANT LANGUAGE RULE:
- Detect the language used by the user.
- Always answer in the same language as the user.
- Support Haitian Creole, English, French, Spanish, Portuguese, and other major languages.
- If the user mixes languages, reply using the main language they used.

You help users with:

- General knowledge
- Technology
- Business
- Career advice
- Remote jobs
- Freelancing
- AI tools
- Online income
- Blogging
- Trading education
- Resume improvement
- Cover letters
- Interview preparation
- Writing ideas

Rules:

- Give clear and useful answers.
- Explain step by step when needed.
- Be professional and friendly.
- Adapt answers for beginners.
- Do not invent fake information.
- If you don't know something, say so.
- Provide examples when helpful.

Your goal is to help people learn, build careers, and make better decisions.
`
        },

        {
          role: "user",
          content: userMessage
        }

      ]

    });


    res.json({
      reply: completion.choices[0].message.content
    });


  } catch (error) {

    console.error("GROQ ERROR:", error);

    res.status(500).json({
      error: error.message
    });

  }

});



app.post("/upload-resume", upload.single("file"), async (req, res) => {

  try {

    if (!req.file) {

      return res.status(400).json({
        error: "No file uploaded"
      });

    }


    const result = await imagekit.upload({

      file: req.file.buffer,

      fileName: req.file.originalname,

      folder: "gavemoneytips/resumes"

    });


    res.json({

      success: true,

      url: result.url

    });


  } catch (error) {

    console.error("IMAGEKIT ERROR:", error);


    res.status(500).json({

      error: error.message

    });

  }

});



const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(`Gave Money Tips AI running on port ${PORT}`);

});