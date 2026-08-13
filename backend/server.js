require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");

const { generateAIResponse } = require("./services/groqService");
const { db } = require("./firebaseAdmin");

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

const corsOptions = {
  origin: [
    "https://gavemoneytips.blogspot.com",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin"
  ],
  credentials: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin === "https://gavemoneytips.blogspot.com" ||
    origin === "http://localhost:3000"
  ) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, Origin"
    );
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

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

    aiReply = aiReply.replace(/\*\*/g, "");
    aiReply = aiReply.replace(/\*/g, "");
    aiReply = aiReply.replace(/##/g, "");
    aiReply = aiReply.replace(/#/g, "");
    aiReply = aiReply.replaceAll("`", "");

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

app.post("/upload-profile", upload.single("file"), async (req, res) => {
  try {
    const uploadedFile = req.file || req.files?.file;
    if (!uploadedFile) {
      return res.status(400).json({
        error: "No profile photo uploaded"
      });
    }

    const validTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp"
    ];

    if (!validTypes.includes(uploadedFile.mimetype)) {
      return res.status(400).json({
        error: "Only JPG, JPEG, PNG, and WEBP files are allowed for profile photos"
      });
    }

    const result = await imagekit.upload({
      file: uploadedFile.buffer,
      fileName: uploadedFile.originalname,
      folder: "gavemoneytips/profile-photos"
    });

    const photoUrl = result.url;

    const userId =
      typeof req.body.userId === "string"
        ? req.body.userId.trim()
        : "";

    if (userId) {
      await db.collection("users").doc(userId).set(
        {
          photoUrl: photoUrl
        },
        {
          merge: true
        }
      );
    }

    res.json({
      success: true,
      url: photoUrl,
      photoUrl: photoUrl,
      savedToFirestore: Boolean(userId)
    });

  } catch (error) {
    console.error("PROFILE PHOTO ERROR:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/upload-resume", upload.any(), async (req, res) => {
  try {
    const uploadedFile = req.file || (req.files && req.files[0]);
    if (!uploadedFile) {
      return res.status(400).json({
        error: "No resume uploaded"
      });
    }

    const result = await imagekit.upload({
      file: uploadedFile.buffer,
      fileName: uploadedFile.originalname,
      folder: "gavemoneytips/resumes"
    });

    const resumeURL = result.url;

    const userId =
      typeof req.body.userId === "string"
        ? req.body.userId.trim()
        : "";

    if (userId) {
      await db.collection("users").doc(userId).set(
        {
          resumeURL: resumeURL
        },
        {
          merge: true
        }
      );
    }

    res.json({
      success: true,
      url: resumeURL,
      resumeURL: resumeURL,
      savedToFirestore: Boolean(userId)
    });

  } catch (error) {
      console.error("RESUME UPLOAD ERROR:", error);

      res.status(500).json({
        error: error.message
      });
  }
});

app.post("/upload-cover-letter", upload.any(), async (req, res) => {
  try {
    const uploadedFile = req.file || (req.files && req.files[0]);
    if (!uploadedFile) {
      return res.status(400).json({
        error: "No cover letter uploaded"
      });
    }

    const result = await imagekit.upload({
      file: uploadedFile.buffer,
      fileName: uploadedFile.originalname,
      folder: "gavemoneytips/cover-letters"
    });

    const coverLetterURL = result.url;

    const userId =
      typeof req.body.userId === "string"
        ? req.body.userId.trim()
        : "";

    if (userId) {
      await db.collection("users").doc(userId).set(
        {
          coverLetterURL: coverLetterURL
        },
        {
          merge: true
        }
      );
    }

    res.json({
      success: true,
      url: coverLetterURL,
      coverLetterURL: coverLetterURL,
      savedToFirestore: Boolean(userId)
    });

  } catch (error) {
    console.error("COVER LETTER ERROR:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/upload-certificate", upload.any(), async (req, res) => {
  try {
    const uploadedFile = req.file || (req.files && req.files[0]);
    if (!uploadedFile) {
      return res.status(400).json({
        error: "No certificate PDF uploaded"
      });
    }

    const result = await imagekit.upload({
      file: uploadedFile.buffer,
      fileName: uploadedFile.originalname,
      folder: "gavemoneytips/certificates"
    });

    const certificateUrl = result.url;

    const userId =
      typeof req.body.userId === "string"
        ? req.body.userId.trim()
        : "";

    if (userId) {
      await db.collection("users").doc(userId).set(
        {
          certificateUrls: {
            [Date.now().toString()]: certificateUrl
          }
        },
        {
          merge: true
        }
      );
    }

    res.json({
      success: true,
      url: certificateUrl,
      savedToFirestore: Boolean(userId)
    });

  } catch (error) {
    console.error("CERTIFICATE IMAGEKIT/FIRESTORE ERROR:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Gave Money Tips AI running on port ${PORT}`);
});