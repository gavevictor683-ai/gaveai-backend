require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");

const { generateAIResponse } = require("./services/groqService");

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

app.use(
  cors({
    origin: [
      "https://gavemoneytips.blogspot.com",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(
  express.json({
    limit: "10mb"
  })
);

app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running 🚀");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    const conversation = Array.isArray(req.body.conversation)
      ? req.body.conversation
      : [];

    const knowledge =
      typeof req.body.knowledge === "string"
        ? req.body.knowledge
        : "";

    let aiReply = await generateAIResponse(userMessage, {
      conversation,
      knowledge
    });

    // Remove markdown formatting
    aiReply = aiReply.replace(/\*\*/g, "");
    aiReply = aiReply.replace(/\*/g, "");
    aiReply = aiReply.replace(/##/g, "");
    aiReply = aiReply.replace(/#/g, "");
    aiReply = aiReply.replace(/`/g, "");

    // Haitian Creole corrections
    const corrections = {
      "gwope lajan": "fè lajan",
      "gwope": "fè",

      "dizayn grafik": "konsepsyon grafik",
      "dizayn": "konsepsyon",

      "kòn": "kontni",

      "Travis": "travay",
      "travis": "travay",

      "djob": "travay",

      "sertifikat": "sètifika",
      "sertifikat yo": "sètifika yo",

      "kompetans": "konpetans",

      "konnisans": "konesans",

      "platafòm": "platfòm",

      "avant ou kapab": "anvan ou kapab",

      "eksipple": "egzanp",
      "ekzanp": "egzanp",

      "travay online": "travay sou entènèt",

      "lajan online": "lajan sou entènèt",

      "diyital": "dijital",

      "kurs": "kou",
      "kour": "kou",

      "pwodui": "pwodwi",

      "sosyèl": "sosyal",

      "objeftif": "objektif",

      "determine": "detèmine",

      "resime": "rezime",

      "ekperyans": "eksperyans",

      "metè": "mete",
      "Metè": "Mete",

      "organize": "òganize",
      "Organize": "Òganize",

      "kli": "klè",

      "Exanp": "Egzanp",
      "exanp": "egzanp",

      "aspect": "aspè",

      "marche": "mache",

      "Pwoprye": "Premyèman",
      "pwoprye": "premyèman",

      "ankò nou": "eksperyans nou",

      "Voici": "Men",
      "voici": "men",

      "Met": "Mete",
      "met": "mete",

      "katogori": "kategori",

      "produkto": "pwodwi",

      "prodiktivite": "pwodiktivite",

      "biro": "biwo",

      "let": "lèt",

      "tak": "tach",

      "ekzamp": "egzanp",

      "ekzamp la": "egzanp lan",

      "konple": "konplè",

      "Remen nou": "Sonje",

      "karvyè": "karyè",

      "rasamble": "rasanble",
      "Rasamble": "Rasanble",

      "objatif": "objektif",
      "objatif ou": "objektif ou",

      "vèfye": "verifye",
      "Vèfye": "Verifye",

      "vèifye": "verifye",
      "Vèifye": "Verifye",

      "ekspèyans": "eksperyans",

      "koordinè": "enfòmasyon kontak",

      "komense": "kòmanse",

      "fe": "fè",

      "kwè nan": "mete",

      "louvri": "valab",

      "fòmate": "fòmate",

      "rekrute": "rekritè",

      "aktyèl aktivite": "aktivite",

      "aktyèl konpetans": "konpetans",

      "aktyèl travay": "travay",

      "fonksyònèl": "fonksyonèl",

      "konvenab": "ki pi bon",

      "edite": "modifye",

      "pwodikte": "pwodiktivite"
    };

    Object.keys(corrections).forEach((word) => {
      aiReply = aiReply.replaceAll(word, corrections[word]);
    });

    res.json({
      reply: aiReply
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