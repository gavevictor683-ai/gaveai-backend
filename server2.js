require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { generateAIResponse } = require("./backend/services/groqService");

const {
  generateWithGaveAIVideoProvider,
  getVideoProviderStatus
} = require("./backend/services/gaveaiVideoProviderService");

const { db, admin } = require("./backend/firebaseAdmin");

const {
  renderGaveAIAudioForScenes,
  cleanupAudioFiles
} = require("./backend/services/videoAudioService");

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;

const ADMIN_USER_ID =
  process.env.ADMIN_USER_ID ||
  "8eGkRNjIqycQa4ZIVwX8r6LVm4u1";

const FREE_VIDEO_COUNT = 1;

const PLANS = {
  pro: {
    price: 9.99,
    credits: 1000,
    durationDays: 30
  },
  premium: {
    price: 19.99,
    credits: 1500,
    durationDays: 30
  }
};

const VIDEO_CREDITS = {
  5: 15,
  8: 24
};

const BANK_INFO = {
  bankName: "SOGEBANK",
  accountHolder: "Gave Victor",
  accountNumber: "2611111879",
  swift: "SOGHHTPP",
  currency: "USD"
};

const MAX_VIDEO_QUEUE = 10;
const MAX_CONCURRENT_VIDEOS = 2;

let activeVideoGenerations = 0;
let queuedVideoGenerations = 0;

/* =========================================================
   IMAGEKIT
========================================================= */

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

/* =========================================================
   GAVEAI IMAGE GENERATION
========================================================= */

const GAVEAI_IMAGE_MODEL =
  process.env.GAVEAI_IMAGE_MODEL ||
  "@cf/black-forest-labs/flux-1-schnell";

async function generateGaveAIImage(prompt) {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
  }

  if (
    !prompt ||
    typeof prompt !== "string" ||
    !prompt.trim()
  ) {
    throw new Error("IMAGE_PROMPT_REQUIRED");
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${process.env.CLOUDFLARE_ACCOUNT_ID}` +
    `/ai/run/${GAVEAI_IMAGE_MODEL}`;

  try {
    console.log("GAVEAI IMAGE GENERATION STARTED");

    const response = await axios.post(
      url,
      {
        prompt: prompt.trim(),
        steps: 4
      },
      {
        headers: {
          Authorization:
            `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 120000,
        responseType: "json"
      }
    );

    const data = response.data;

    if (!data?.success) {
      console.error("GAVEAI IMAGE PROVIDER ERROR:", data);

      const providerMessage =
        data?.errors?.[0]?.message ||
        "Image generation failed.";

      throw new Error(
        `IMAGE_PROVIDER_FAILED:${providerMessage}`
      );
    }

    const base64Image = data?.result?.image;

    if (!base64Image) {
      throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
    }

    return {
      base64: base64Image,
      mimeType: "image/jpeg",
      model: GAVEAI_IMAGE_MODEL
    };
  } catch (error) {
    if (
      error?.message?.startsWith("IMAGE_PROVIDER_") ||
      error?.message === "IMAGE_PROMPT_REQUIRED"
    ) {
      throw error;
    }

    console.error(
      "GAVEAI IMAGE GENERATION ERROR:",
      error?.message || error
    );

    throw new Error("IMAGE_GENERATION_FAILED");
  }
}

async function uploadGeneratedImageToImageKit(
  base64Image,
  userId
) {
  if (!base64Image) {
    throw new Error("Generated image data is missing.");
  }

  const buffer = Buffer.from(
    base64Image,
    "base64"
  );

  if (!buffer.length) {
    throw new Error("Generated image is empty.");
  }

  const result = await imagekit.upload({
    file: buffer,
    fileName:
      `gaveai-image-${userId}-${Date.now()}.jpg`,
    folder: "gavemoneytips/generated-images",
    useUniqueFileName: true,
    tags: [
      "gave-money-tips",
      "gaveai",
      "generated-image",
      String(userId)
    ]
  });

  if (!result?.url) {
    throw new Error(
      "ImageKit did not return a public image URL."
    );
  }

  return result;
}

/* =========================================================
   MULTER
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/* =========================================================
   HELPERS
========================================================= */

function normalizePlan(plan) {
  const value = String(plan || "").trim().toLowerCase();

  if (value === "pro") return "pro";
  if (value === "premium") return "premium";

  return null;
}

function getPlanCredits(plan) {
  const normalized = normalizePlan(plan);

  return normalized && PLANS[normalized]
    ? PLANS[normalized].credits
    : 0;
}

function getPlanPrice(plan) {
  const normalized = normalizePlan(plan);

  return normalized && PLANS[normalized]
    ? PLANS[normalized].price
    : 0;
}

function getVideoCreditCost(duration) {
  const value = Number(duration);

  if (value === 5) return VIDEO_CREDITS[5];
  if (value === 8) return VIDEO_CREDITS[8];

  throw new Error("VIDEO_DURATION_INVALID");
}

function timestampToMillis(value) {
  if (!value) return 0;

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  if (
    value.toMillis &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }

  if (value._seconds) {
    return (
      Number(value._seconds) * 1000 +
      Math.floor(
        Number(value._nanoseconds || 0) / 1000000
      )
    );
  }

  if (value.seconds) {
    return (
      Number(value.seconds) * 1000 +
      Math.floor(
        Number(value.nanoseconds || 0) / 1000000
      )
    );
  }

  return 0;
}

function timestampToISO(value) {
  const millis = timestampToMillis(value);

  if (!millis) return null;

  return new Date(millis).toISOString();
}

function normalizeFreeVideoState(userData = {}) {
  const used =
    userData.freeVideoUsed === true ||
    Number(userData.freeVideoRemaining || 1) <= 0 ||
    userData.freeVideoAvailable === false;

  return {
    freeVideoUsed: used,
    freeVideoRemaining: used ? 0 : 1,
    freeVideoAvailable: !used
  };
}

function isSubscriptionActive(userData = {}) {
  const expiresAt = timestampToMillis(
    userData.subscriptionExpiresAt
  );

  return (
    !!expiresAt &&
    expiresAt > Date.now() &&
    !!normalizePlan(
      userData.subscriptionPlan || userData.plan
    )
  );
}

function calculateExpirationDate() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date;
}

function getUserPlan(userData = {}) {
  return normalizePlan(
    userData.subscriptionPlan || userData.plan
  );
}

function isAdmin(uid) {
  return String(uid || "") === String(ADMIN_USER_ID);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number
    : fallback;
}

function ensureDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true
    });
  }
}

function removeFile(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(
      "File cleanup error:",
      error.message
    );
  }
}

function genericVideoError(error) {
  const message = String(
    error?.message || ""
  );

  if (
    message.includes("INSUFFICIENT_CREDITS") ||
    message
      .toLowerCase()
      .includes("insufficient credits")
  ) {
    return "You don’t have credits. Choose a plan to generate video.";
  }

  if (
    message.includes("PAID_PLAN_REQUIRED")
  ) {
    return "You need an active Pro or Premium plan to generate video.";
  }

  if (
    message.includes("SUBSCRIPTION_EXPIRED")
  ) {
    return "Your plan has expired. Choose a plan to continue generating videos.";
  }

  if (
    message.includes("FREE_VIDEO_ALREADY_USED")
  ) {
    return "Your 1 lifetime free video has already been used. Choose a plan to generate more videos.";
  }

  if (
    message.includes("VIDEO_DURATION_INVALID")
  ) {
    return "Video duration must be 5 or 8 seconds.";
  }

  if (
    message.includes("VIDEO_QUEUE_FULL")
  ) {
    return "GaveAI is currently busy. Please try again shortly.";
  }

  return "GaveAI video generation failed. Please try again.";
}

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://gavemoneystips.blogspot.com",
  "https://gavemoneytips.blogspot.com",
  "http://localhost:3000"
];

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error("CORS origin not allowed.")
    );
  },

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS"
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin"
  ],

  credentials: true,

  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.options(
  "/{*splat}",
  cors(corsOptions)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header(
      "Access-Control-Allow-Origin",
      origin
    );

    res.header(
      "Access-Control-Allow-Credentials",
      "true"
    );
  }

  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, Origin"
  );

  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );

  next();
});

/* =========================================================
   BODY PARSING
========================================================= */

app.use(
  express.json({
    limit: "50mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb"
  })
);

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Gave Money Tips AI Backend",
    message:
      "Gave Money Tips AI Backend is running 🚀",
    provider: "GaveAI",
    version: "final",
    timestamp:
      new Date().toISOString()
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "ok",
      service:
        "Gave Money Tips AI Backend",
      provider: "GaveAI",
      audioGeneration: true,
      imageKit: !!(
        process.env
          .IMAGEKIT_PUBLIC_KEY &&
        process.env
          .IMAGEKIT_PRIVATE_KEY &&
        process.env
          .IMAGEKIT_URL_ENDPOINT
      ),
      firebase: !!db,
      timestamp:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   VIDEO PROVIDER STATUS
========================================================= */

app.get(
  "/video-provider-status",
  async (req, res) => {
    try {
      const status =
        await getVideoProviderStatus();

      const safeStatus =
        status &&
        typeof status === "object"
          ? {
              configured:
                Boolean(
                  status.configured
                ),
              maxWaitMs:
                status.maxWaitMs
            }
          : {
              configured:
                Boolean(status)
            };

      res.json({
        success: true,
        provider: "GaveAI",
        status: safeStatus
      });
    } catch (error) {
      console.error(
        "Video provider status error:",
        error
      );

      res.json({
        success: false,
        provider: "GaveAI",
        status: "unavailable"
      });
    }
  }
);

/* =========================================================
   PAYMENT SYSTEM STATUS
========================================================= */

app.get(
  "/api/payment-system-status",
  (req, res) => {
    res.json({
      success: true,
      enabled: true,
      method:
        "manual bank transfer",
      plans: PLANS
    });
  }
);

app.get(
  "/api/payment-routes-status",
  (req, res) => {
    res.json({
      success: true,
      enabled: true,
      routes: [
        "/api/plans",
        "/api/payment-info",
        "/api/payment-bank-info",
        "/api/payment-requests",
        "/api/admin/payment-requests"
      ]
    });
  }
);

app.get(
  "/api/payment-bank-info",
  (req, res) => {
    res.json({
      success: true,
      bank: BANK_INFO
    });
  }
);

app.get(
  "/api/payment-info",
  (req, res) => {
    res.json({
      success: true,
      bank: BANK_INFO,
      plans: PLANS
    });
  }
);

app.get(
  "/api/plans",
  (req, res) => {
    res.json({
      success: true,
      plans: {
        pro: {
          name: "Pro",
          price:
            PLANS.pro.price,
          credits:
            PLANS.pro.credits,
          durationDays:
            PLANS.pro.durationDays
        },

        premium: {
          name: "Premium",
          price:
            PLANS.premium.price,
          credits:
            PLANS.premium.credits,
          durationDays:
            PLANS.premium.durationDays
        }
      },

      videoCredits:
        VIDEO_CREDITS,

      freeVideo: {
        lifetime: true,
        count: FREE_VIDEO_COUNT
      }
    });
  }
);

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function requireAuthenticatedUser(
  req,
  res,
  next
) {
  try {
    const authorization =
      req.headers.authorization || "";

    if (
      !authorization.startsWith(
        "Bearer "
      )
    ) {
      return res.status(401).json({
        success: false,
        error:
          "User authentication is required."
      });
    }

    const idToken =
      authorization
        .substring(7)
        .trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error:
          "User authentication is required."
      });
    }

    const decodedToken =
      await admin
        .auth()
        .verifyIdToken(
          idToken
        );

    req.userUid =
      decodedToken.uid;

    req.userToken =
      decodedToken;

    next();
  } catch (error) {
    console.error(
      "Authentication error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      error:
        "User authentication is required."
    });
  }
}

async function requireAdmin(
  req,
  res,
  next
) {
  try {
    if (!req.userUid) {
      return res.status(401).json({
        success: false,
        error:
          "User authentication is required."
      });
    }

    if (
      !isAdmin(req.userUid)
    ) {
      return res.status(403).json({
        success: false,
        error:
          "Administrator access is required."
      });
    }

    req.adminUid =
      req.userUid;

    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      error:
        "Administrator access is required."
    });
  }
}

/* =========================================================
   CHAT
========================================================= */

app.post(
  "/chat",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const {
        message,
        messages,
        conversation,
        imageUrl,
        context
      } = req.body || {};

      const inputMessages =
        Array.isArray(messages) &&
        messages.length
          ? messages
          : Array.isArray(
              conversation
            ) &&
            conversation.length
          ? conversation
          : message
          ? [
              {
                role: "user",
                content: message
              }
            ]
          : [];

      if (!inputMessages.length) {
        return res.status(400).json({
          success: false,
          error:
            "Message is required."
        });
      }

      const result =
        await generateAIResponse(
          inputMessages,
          {
            userId:
              req.userUid,
            imageUrl,
            context
          }
        );

      res.json({
        success: true,
        response:
          typeof result ===
          "string"
            ? result
            : result?.response ||
              result?.content ||
              result?.message ||
              result,

        data: result
      });
    } catch (error) {
      console.error(
        "Chat error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Gave Money Tips AI could not complete the request."
      });
    }
  }
);

/* =========================================================
   IMAGE GENERATION
========================================================= */

app.post(
  "/generate-image",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const prompt =
        req.body?.prompt ||
        req.body?.message ||
        req.body?.text ||
        "";

      if (
        !String(prompt).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Please provide a description for the image you want to generate."
        });
      }

      const generated =
        await generateGaveAIImage(
          prompt
        );

      const uploaded =
        await uploadGeneratedImageToImageKit(
          generated.base64,
          req.userUid
        );

      return res.json({
        success: true,
        provider: "GaveAI",
        type: "image",
        message:
          "Image generated successfully!",
        imageUrl:
          uploaded.url,
        url:
          uploaded.url,
        fileId:
          uploaded.fileId ||
          null,
        fileName:
          uploaded.name ||
          `gaveai-image-${Date.now()}.jpg`,

        generatedMedia: {
          type: "image",
          url:
            uploaded.url,
          provider:
            "GaveAI"
        }
      });
    } catch (error) {
      console.error(
        "GENERATE IMAGE ERROR:",
        error?.message ||
          error
      );

      if (
        error?.message ===
        "IMAGE_PROVIDER_NOT_CONFIGURED"
      ) {
        return res.status(503).json({
          success: false,
          provider: "GaveAI",
          error:
            "GaveAI image generation is not configured yet."
        });
      }

      if (
        error?.message ===
        "IMAGE_PROMPT_REQUIRED"
      ) {
        return res.status(400).json({
          success: false,
          provider: "GaveAI",
          error:
            "Please provide a description for the image you want to generate."
        });
      }

      if (
        error?.message ===
        "IMAGE_PROVIDER_EMPTY_RESULT"
      ) {
        return res.status(502).json({
          success: false,
          provider: "GaveAI",
          error:
            "GaveAI did not return an image. Please try again."
        });
      }

      return res.status(502).json({
        success: false,
        provider: "GaveAI",
        error:
          "GaveAI image generation failed. Please try again."
      });
    }
  }
);

/* =========================================================
   IMAGE GENERATION STATUS
========================================================= */

app.get(
  "/api/image-generation-status",
  requireAuthenticatedUser,
  (req, res) => {
    res.json({
      success: true,
      provider: "GaveAI",
      configured: Boolean(
        process.env
          .CLOUDFLARE_ACCOUNT_ID &&
        process.env
          .CLOUDFLARE_API_TOKEN
      )
    });
  }
);

/* =========================================================
   STORYBOARD MEDIA UPLOAD
========================================================= */

app.post(
  "/upload-storyboard-media",
  requireAuthenticatedUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "Storyboard media file is required."
        });
      }

      const isImage =
        req.file.mimetype?.startsWith(
          "image/"
        );

      const isVideo =
        req.file.mimetype?.startsWith(
          "video/"
        );

      if (!isImage && !isVideo) {
        return res.status(400).json({
          success: false,
          error:
            "Only image and video files are allowed."
        });
      }

      const folder = isVideo
        ? "gavemoneytips/storyboard-videos"
        : "gavemoneytips/storyboard-images";

      const result =
        await uploadBufferToImageKit(
          req.file.buffer,
          req.file.originalname ||
            "storyboard-media",
          folder,
          req.file.mimetype
        );

      return res.json({
        success: true,
        url: result.url,
        fileId:
          result.fileId,
        fileName:
          result.name,
        mimeType:
          req.file.mimetype,
        mediaType:
          isVideo
            ? "video"
            : "image"
      });
    } catch (error) {
      console.error(
        "STORYBOARD MEDIA UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Storyboard media upload failed."
      });
    }
  }
);

/* =========================================================
   MEDIA ANALYSIS
========================================================= */

app.post(
  "/api/analyze-media",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const {
        imageUrl,
        url,
        prompt,
        question,
        context
      } = req.body || {};

      const mediaUrl =
        imageUrl || url;

      if (!mediaUrl) {
        return res.status(400).json({
          success: false,
          error:
            "Media URL is required."
        });
      }

      const userPrompt =
        prompt ||
        question ||
        "Analyze this media and describe what you see.";

      const result =
        await generateAIResponse(
          [
            {
              role: "user",
              content: userPrompt
            }
          ],
          {
            userId:
              req.userUid,
            imageUrl:
              mediaUrl,
            context
          }
        );

      return res.json({
        success: true,
        provider: "GaveAI",
        response:
          typeof result ===
          "string"
            ? result
            : result?.response ||
              result?.content ||
              result?.message ||
              result
      });
    } catch (error) {
      console.error(
        "MEDIA ANALYSIS ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "GaveAI could not analyze this media."
      });
    }
  }
);