require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");

const { generateAIResponse } = require("./services/groqService");
const { generateWithGaveAIVideoProvider, getVideoProviderStatus } = require("./services/gaveaiVideoProviderService");
const { db } = require("./firebaseAdmin");

const app = express();

/*
========================================================
FILE UPLOAD
========================================================
*/
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/*
========================================================
IMAGEKIT
========================================================
*/
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

/*
========================================================
CORS
========================================================
*/
const allowedOrigins = [
  "https://gavemoneystips.blogspot.com",
  "https://gavemoneytips.blogspot.com",
  "http://localhost:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin"],
  credentials: false,
  optionsSuccessStatus: 204
}));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "10mb" }));

/*
========================================================
HEALTH CHECK
========================================================
*/
app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running 🚀");
});

/*
========================================================
CHAT
========================================================
*/
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const result = await generateAIResponse(userMessage);
    let aiReply = typeof result === "string" ? result : (result?.reply || result?.message || "");
    
    // Netwayaj repons
    aiReply = aiReply.split("*").join("").replace(/##/g, "").replace(/#/g, "").replace(/`/g, "");

    return res.json({
      reply: aiReply,
      webSearchUsed: Boolean(result?.webSearchUsed),
      sources: Array.isArray(result?.sources) ? result.sources.map(s => ({
        title: s?.title || "", url: s?.url || "", provider: s?.provider || "", official: Boolean(s?.official)
      })) : []
    });
  } catch (error) {
    console.error("GROQ ERROR:", error);
    return res.status(500).json({ error: error?.message || "AI request failed" });
  }
});

/*
========================================================
UPLOAD GENERATED VIDEO TO IMAGEKIT
========================================================
*/
async function uploadGeneratedVideoToImageKit(filePath, productionId) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Generated video file does not exist.");
  }

  const fileBuffer = fs.readFileSync(filePath);
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error("Generated video file is empty.");
  }

  const fileName = `gaveai-production-${productionId || Date.now()}.mp4`;
  console.log("========================================");
  console.log("IMAGEKIT VIDEO UPLOAD STARTED | FILE SIZE:", fileBuffer.length);
  console.log("========================================");

  const result = await imagekit.upload({
    file: fileBuffer,
    fileName: fileName,
    folder: "gavemoneytips/generated-videos"
  });

  if (!result || !result.url) {
    throw new Error("ImageKit did not return a public video URL.");
  }

  return { url: result.url, fileId: result.fileId || null, name: result.name || fileName };
}

function deleteLocalVideoFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("LOCAL VIDEO DELETED:", filePath);
    }
  } catch (error) {
    console.warn("VIDEO DELETE WARNING:", error?.message || error);
  }
}

function cleanupGeneratedClips(clips) {
  if (!Array.isArray(clips)) return;
  for (const clip of clips) {
    if (clip?.videoFile) deleteLocalVideoFile(clip.videoFile);
  }
}

/*
========================================================
GAVEAI VIDEO PRODUCTION
========================================================
*/
async function generateGaveAIVideoProduction(prompts, options = {}) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error("At least one video prompt is required.");
  }

  const clips = [];
  let firstGeneratedVideo = null;
  const productionId = `gaveai-${Date.now()}`;

  console.log("========================================");
  console.log("GAVEAI VIDEO PRODUCTION STARTED");
  console.log("PROVIDER: Hugging Face (Open Source)");
  console.log("PRODUCTION ID:", productionId);
  console.log("TOTAL CLIPS:", prompts.length);
  console.log("========================================");

  for (let i = 0; i < prompts.length; i++) {
    const currentPrompt = prompts[i];
    console.log(`GENERATING CLIP ${i + 1}/${prompts.length} | PROMPT: ${currentPrompt}`);

    const result = await generateWithGaveAIVideoProvider({
      prompt: currentPrompt,
      firstFrameImage: i === 0 ? options.firstFrameImage : undefined,
      width: options.width || 832,
      height: options.height || 480,
      duration: options.duration || 5,
      seed: options.seed,
      negativePrompt: options.negativePrompt,
      resolution: options.resolution
    });

    if (!result || !result.success || !result.videoFile) {
      throw new Error(`Video clip ${i + 1} failed.`);
    }

    if (!firstGeneratedVideo) firstGeneratedVideo = result;

    clips.push({
      index: i + 1,
      prompt: currentPrompt,
      videoFile: result.videoFile,
      videoUrl: result.videoUrl,
      provider: result.provider,
      model: result.model
    });
  }

  return {
    success: true,
    provider: firstGeneratedVideo?.provider || "Hugging Face",
    model: firstGeneratedVideo?.model || null,
    productionId,
    clips,
    videoFile: firstGeneratedVideo?.videoFile || null
  };
}

/*
========================================================
REFUND VIDEO CREDITS
========================================================
*/
async function refundVideoCredits(userId, creditCost) {
  if (!userId || !creditCost || creditCost <= 0) return;
  try {
    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      const userData = userSnap.data() || {};
      const currentCredits = Number(userData.credits ?? 0);
      await userRef.set({ credits: currentCredits + creditCost }, { merge: true });
      console.log("VIDEO CREDITS REFUNDED:", creditCost);
    }
  } catch (error) {
    console.error("CREDIT REFUND ERROR:", error);
  }
}

/*
========================================================
GENERATE VIDEO ROUTE
========================================================
*/
app.post("/generate-video", async (req, res) => {
  const VIDEO_CREDIT_COST = 15;
  let userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  let prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";

  if (!prompt && typeof req.body?.message === "string") {
    prompt = req.body.message.replace(/^\/generate-video\s*/i, "").trim();
  }

  let prompts = [];
  if (Array.isArray(req.body?.prompts) && req.body.prompts.length > 0) {
    prompts = req.body.prompts.filter(item => typeof item === "string" && item.trim()).map(item => item.trim());
  }
  if (prompts.length === 0 && prompt) prompts = [prompt];

  if (prompts.length === 0) {
    return res.status(400).json({ success: false, error: "At least one video prompt is required." });
  }
  if (prompts.length > 20) {
    return res.status(400).json({ success: false, error: "A maximum of 20 video clips can be generated." });
  }

  const firstFrameImage = typeof req.body?.firstFrameImage === "string" ? req.body.firstFrameImage.trim() : undefined;
  const width = Number(req.body?.width) || 832;
  const height = Number(req.body?.height) || 480;
  const duration = Number(req.body?.duration) || 5;

  const adminUserId = process.env.ADMIN_USER_ID ? process.env.ADMIN_USER_ID.trim() : "";
  const ownerUser = Boolean(userId && adminUserId && userId === adminUserId);

  console.log("========================================");
  console.log("GENERATE VIDEO REQUEST");
  console.log("PROVIDER: Hugging Face (Open Source)");
  console.log("USER ID:", userId || "anonymous");
  console.log("OWNER / ADMIN:", ownerUser);
  console.log("TOTAL PROMPTS:", prompts.length);
  console.log("========================================");

  let creditResult = null;
  let genResult = null;

  try {
    // 1. CREDIT CHECK (Skip if Admin)
    if (!ownerUser && userId) {
      try {
        const userRef = db.collection("users").doc(userId);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          return res.status(404).json({ success: false, error: "User account was not found." });
        }
        const userData = userSnap.data() || {};
        const currentCredits = Number(userData.credits ?? userData.dailyCredits ?? 0);

        if (currentCredits < VIDEO_CREDIT_COST) {
          return res.status(402).json({
            success: false, error: "Insufficient credits.",
            requiredCredits: VIDEO_CREDIT_COST, currentCredits: currentCredits
          });
        }

        const newCreditBalance = currentCredits - VIDEO_CREDIT_COST;
        await userRef.set({ credits: newCreditBalance }, { merge: true });
        creditResult = { creditsDeducted: VIDEO_CREDIT_COST, newCreditBalance, previousCreditBalance: currentCredits };
      } catch (creditError) {
        console.error("VIDEO CREDIT ERROR:", creditError);
        return res.status(500).json({ success: false, error: "Unable to process video credits." });
      }
    } else {
      creditResult = { creditsDeducted: 0, newCreditBalance: null };
    }

    // 2. GENERATE VIDEO
    try {
      genResult = await generateGaveAIVideoProduction(prompts, { firstFrameImage, width, height, duration });
    } catch (generationError) {
      console.error("OPEN SOURCE VIDEO GENERATION ERROR:", generationError);
      if (userId && creditResult && creditResult.creditsDeducted > 0) {
        await refundVideoCredits(userId, VIDEO_CREDIT_COST);
      }
      return res.status(500).json({ success: false, error: generationError?.message || "Video production failed." });
    }

    if (!genResult || !genResult.success) {
      if (userId && creditResult && creditResult.creditsDeducted > 0) {
        await refundVideoCredits(userId, VIDEO_CREDIT_COST);
      }
      cleanupGeneratedClips(genResult?.clips);
      return res.status(500).json({ success: false, error: genResult?.message || "Video production failed." });
    }

    // 3. UPLOAD TO IMAGEKIT
    let uploadedVideo;
    try {
      uploadedVideo = await uploadGeneratedVideoToImageKit(genResult.videoFile, genResult.productionId);
    } catch (uploadError) {
      console.error("IMAGEKIT GENERATED VIDEO UPLOAD ERROR:", uploadError);
      if (userId && creditResult && creditResult.creditsDeducted > 0) {
        await refundVideoCredits(userId, VIDEO_CREDIT_COST);
      }
      cleanupGeneratedClips(genResult.clips);
      return res.status(500).json({ success: false, error: "Video was generated, but uploading failed.", details: uploadError?.message });
    }

    // 4. CLEANUP LOCAL FILES
    cleanupGeneratedClips(genResult.clips);

    // 5. SUCCESS RESPONSE
    return res.json({
      success: true,
      reply: "Video generated successfully!",
      generatedMedia: {
        type: "video",
        url: uploadedVideo.url,
        downloadUrl: uploadedVideo.url,
        productionId: genResult.productionId,
        clips: genResult.clips,
        provider: genResult.provider,
        model: genResult.model
      },
      creditsDeducted: creditResult?.creditsDeducted || 0,
      newCreditBalance: creditResult?.newCreditBalance ?? null
    });

  } catch (error) {
    console.error("GENERATE VIDEO CRITICAL ERROR:", error);
    if (userId && creditResult && creditResult.creditsDeducted > 0) {
      await refundVideoCredits(userId, VIDEO_CREDIT_COST);
    }
    cleanupGeneratedClips(genResult?.clips);
    return res.status(500).json({ success: false, error: error?.message || "Video generation failed." });
  }
});

/*
========================================================
START SERVER
========================================================
*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Gave Money Tips AI running on port ${PORT}`);
  console.log(`Video Provider: Hugging Face (Open Source)`);
  console.log(`Owner/Admin video mode: UNLIMITED`);
  console.log(`========================================`);
});