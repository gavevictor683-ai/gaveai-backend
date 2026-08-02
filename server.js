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

app.use(cors({
  origin: [
    "https://gavemoneytips.blogspot.com",
    "http://localhost:3000"
  ],
  methods: [
    "GET",
    "POST",
    "OPTIONS"
  ],
  allowedHeaders: [
    "Content-Type"
  ]
}));

app.use(express.json());


const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});


app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running 🚀");
});


app.post("/chat", async (req, res) => {

  try {

    const userMessage = req.body.message;


    const prompt = `
You are Gave Money Tips AI Assistant.

You are a helpful professional AI assistant.

You help with:

General knowledge.
Technology.
Business.
Career advice.
Remote jobs.
Freelancing.
AI tools.
Online income.
Writing ideas.

Rules:

Give clear answers.
Explain step by step when needed.
Be professional.
Do not invent fake information.
Do not guarantee results.

User question:

${userMessage}
`;


    const completion = await groq.chat.completions.create({

      messages: [
        {
          role: "system",
          content: "You are Gave Money Tips AI Assistant. Be helpful, professional, and clear."
        },
        {
          role: "user",
          content: prompt
        }
      ],

      model: "llama-3.3-70b-versatile"

    });


    const response = completion.choices[0].message.content;


    res.json({
      reply: response
    });


  } catch (error) {

    console.error(
      "GROQ ERROR:",
      error
    );


    res.status(500).json({
      error: error.message
    });

  }

});



app.post(
  "/upload-resume",
  upload.single("file"),
  async (req, res) => {

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

      console.error(
        "IMAGEKIT ERROR:",
        error
      );


      res.status(500).json({

        error: error.message

      });

    }

  }
);



const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(
    `Gave Money Tips AI Backend running on port ${PORT}`
  );

});
