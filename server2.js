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

const GAVEAI_IMAGE_MODEL =
  process.env.GAVEAI_IMAGE_MODEL ||
  "@cf/black-forest-labs/flux-1-schnell";

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

function normalizePlan(value) {
  const plan = String(value || "")
    .trim()
    .toLowerCase();

  if (plan === "pro") return "pro";
  if (plan === "premium") return "premium";

  return null;
}

function getPlanCredits(plan) {
  const normalized = normalizePlan(plan);

  return normalized
    ? PLANS[normalized].credits
    : 0;
}

function getPlanPrice(plan) {
  const normalized = normalizePlan(plan);

  return normalized
    ? PLANS[normalized].price
    : 0;
}

function getVideoCreditCost(duration) {
  return Number(duration) === 8
    ? VIDEO_CREDITS[8]
    : VIDEO_CREDITS[5];
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function timestampToMillis(value) {
  if (!value) return 0;

  if (typeof value === "number") {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (
    value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value._seconds === "number"
  ) {
    return (
      value._seconds * 1000 +
      Math.floor(
        (value._nanoseconds || 0) / 1000000
      )
    );
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function timestampToISO(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate().toISOString();
  }

  if (
    value &&
    typeof value._seconds === "number"
  ) {
    return new Date(
      value._seconds * 1000 +
        Math.floor(
          (value._nanoseconds || 0) / 1000000
        )
    ).toISOString();
  }

  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : null;
}

function calculateExpirationDate() {
  const date = new Date();

  date.setDate(
    date.getDate() + 30
  );

  return date;
}

function isSubscriptionActive(userData = {}) {
  const plan = normalizePlan(
    userData.subscriptionPlan ||
      userData.plan
  );

  if (!plan) return false;

  const expiresAt =
    timestampToMillis(
      userData.subscriptionExpiresAt
    );

  if (!expiresAt) return false;

  return expiresAt > Date.now();
}

function getUserPlan(userData = {}) {
  const plan = normalizePlan(
    userData.subscriptionPlan ||
      userData.plan
  );

  if (!plan) return null;

  if (!isSubscriptionActive(userData)) {
    return null;
  }

  return plan;
}

function isAdmin(userId) {
  return (
    String(userId || "").trim() ===
    String(ADMIN_USER_ID || "").trim()
  );
}

function normalizeFreeVideoState(
  userData = {}
) {
  const used =
    userData.freeVideoUsed === true ||
    Number(
      userData.freeVideoRemaining ?? 1
    ) <= 0 ||
    userData.freeVideoAvailable === false;

  return {
    freeVideoUsed: used,
    freeVideoRemaining: used
      ? 0
      : FREE_VIDEO_COUNT,
    freeVideoAvailable: !used
  };
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

function ensureDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true
    });
  }

  return directory;
}

function genericVideoError(error) {
  const message = String(
    error?.message || ""
  ).toLowerCase();

  if (
    message.includes("insufficient_credits") ||
    message.includes("insufficient credits") ||
    message.includes("not enough credits")
  ) {
    return (
      "You don't have credits. Choose a plan to generate video."
    );
  }

  if (
    message.includes("paid_plan_required") ||
    message.includes("paid plan required")
  ) {
    return (
      "You don't have credits. Choose a plan to generate video."
    );
  }

  if (
    message.includes("subscription_expired") ||
    message.includes("subscription expired")
  ) {
    return (
      "Your subscription has expired. Choose a plan to generate video."
    );
  }

  if (
    message.includes("free_video_already_used") ||
    message.includes("free video already used")
  ) {
    return (
      "Your 1 lifetime free video has already been used. Choose a plan to generate another video."
    );
  }

  if (
    message.includes("video_duration_invalid")
  ) {
    return (
      "Video duration must be 5 or 8 seconds."
    );
  }

  if (
    message.includes("video_queue_full")
  ) {
    return (
      "GaveAI video generation queue is full. Please try again shortly."
    );
  }

  return (
    "GaveAI video generation failed. Please try again."
  );
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
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    console.warn(
      "Blocked CORS origin:",
      origin
    );

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

  credentials: true
};

app.use(cors(corsOptions));

app.options(
  "*",
  cors(corsOptions)
);

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.send(
    "Gave Money Tips AI Backend is running 🚀"
  );
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
      message:
        "Gave Money Tips AI Backend is running 🚀",
      provider: "GaveAI",

      firebaseConfigured:
        !!db,

      imageGenerationConfigured:
        !!(
          process.env.CLOUDFLARE_ACCOUNT_ID &&
          process.env.CLOUDFLARE_API_TOKEN
        ),

      imageProvider: "GaveAI",

      imageModel:
        GAVEAI_IMAGE_MODEL,

      imageKitConfigured:
        !!(
          process.env.IMAGEKIT_PUBLIC_KEY &&
          process.env.IMAGEKIT_PRIVATE_KEY &&
          process.env.IMAGEKIT_URL_ENDPOINT
        ),

      audioConfigured: true,

      activeVideoGenerations,
      queuedVideoGenerations,

      maxConcurrentVideos:
        MAX_CONCURRENT_VIDEOS,

      maxVideoQueue:
        MAX_VIDEO_QUEUE
    });
  }
);

/* =========================================================
   PLANS
========================================================= */

app.get(
  "/api/plans",
  (req, res) => {
    res.json({
      success: true,

      free: {
        price: 0,
        lifetimeVideos: 1,
        credits: 0
      },

      pro: {
        ...PLANS.pro
      },

      premium: {
        ...PLANS.premium
      },

      videoCredits: {
        5: VIDEO_CREDITS[5],
        8: VIDEO_CREDITS[8]
      },

      noDailyCredits: true,
      noRollover: true,
      topUpAddsNew30DayEntitlement: true
    });
  }
);

/* =========================================================
   PAYMENT BANK INFO
========================================================= */

app.get(
  "/api/payment-bank-info",
  requireAuthenticatedUser,
  (req, res) => {
    res.json({
      success: true,
      bank: BANK_INFO
    });
  }
);

/* =========================================================
   PAYMENT SYSTEM STATUS
========================================================= */

app.get(
  "/api/payment-status",
  requireAuthenticatedUser,
  (req, res) => {
    res.json({
      success: true,
      paymentSystem: "manual-bank-transfer",
      adminApprovalRequired: true,
      bank: BANK_INFO,
      plans: PLANS
    });
  }
);

/* =========================================================
   VIDEO PROVIDER STATUS
========================================================= */

app.get(
  "/api/video-provider-status",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const providerStatus =
        await getVideoProviderStatus();

      res.json({
        success: true,
        provider: "GaveAI",
        status: providerStatus
      });
    } catch (error) {
      console.error(
        "Video provider status error:",
        error
      );

      res.json({
        success: true,
        provider: "GaveAI",
        status: "available"
      });
    }
  }
);

/* =========================================================
   FIREBASE AUTH
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
        .verifyIdToken(idToken);

    if (!decodedToken?.uid) {
      return res.status(401).json({
        success: false,
        error:
          "Invalid authentication token."
      });
    }

    req.userUid =
      decodedToken.uid;

    req.userToken =
      decodedToken;

    next();
  } catch (error) {
    console.error(
      "Firebase authentication error:",
      error
    );

    return res.status(401).json({
      success: false,
      error:
        "User authentication is required."
    });
  }
}

/* =========================================================
   ADMIN AUTH
========================================================= */

async function requireAdmin(
  req,
  res,
  next
) {
  try {
    if (!isAdmin(req.userUid)) {
      return res.status(403).json({
        success: false,
        error:
          "Administrator access required."
      });
    }

    next();
  } catch (error) {
    console.error(
      "Admin authorization error:",
      error
    );

    return res.status(403).json({
      success: false,
      error:
        "Administrator access required."
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
          : Array.isArray(conversation) &&
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
          error: "Message is required."
        });
      }

      /*
       * IMPORTANT:
       * groqService.generateAIResponse()
       * expects a STRING user message.
       * The previous version incorrectly sent
       * the whole messages array.
       */

      const lastUserMessage =
        [...inputMessages]
          .reverse()
          .find((item) => {
            if (
              typeof item ===
              "string"
            ) {
              return true;
            }

            return (
              item &&
              (
                item.role ===
                  "user" ||
                !item.role
              )
            );
          });

      let userMessage = "";

      if (
        typeof lastUserMessage ===
        "string"
      ) {
        userMessage =
          lastUserMessage;
      } else {
        userMessage =
          lastUserMessage?.content ||
          lastUserMessage?.message ||
          lastUserMessage?.text ||
          "";
      }

      userMessage = String(
        userMessage || ""
      ).trim();

      if (!userMessage) {
        return res.status(400).json({
          success: false,
          error: "Message is required."
        });
      }

      const result =
        await generateAIResponse(
          userMessage,
          {
            userId: req.userUid,
            imageUrl,
            context,
            conversation:
              inputMessages
          }
        );

      /*
       * IMPORTANT:
       * groqService returns:
       * { reply, ... }
       *
       * The old server incorrectly searched
       * for result.response first.
       */

      const reply =
        typeof result === "string"
          ? result
          : result?.reply ||
            result?.response ||
            result?.content ||
            result?.message ||
            "";

      res.json({
        success: true,
        response: reply,
        reply,
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
   IMAGEKIT UPLOAD HELPER
========================================================= */

async function uploadBufferToImageKit(
  buffer,
  originalName,
  folder,
  mimeType
) {
  if (
    !buffer ||
    !buffer.length
  ) {
    throw new Error(
      "File buffer is empty."
    );
  }

  const extension =
    mimeType?.includes("png")
      ? "png"
      : mimeType?.includes("webp")
      ? "webp"
      : mimeType?.includes("gif")
      ? "gif"
      : mimeType?.includes("mp4")
      ? "mp4"
      : mimeType?.includes("pdf")
      ? "pdf"
      : path
          .extname(
            originalName ||
              ""
          )
          .replace(".", "") ||
        "bin";

  const baseName =
    path
      .basename(
        originalName ||
          "file",
        path.extname(
          originalName ||
            ""
        )
      )
      .replace(
        /[^a-zA-Z0-9-_]/g,
        "-"
      )
      .slice(0, 80) ||
    "file";

  return await imagekit.upload({
    file: buffer,

    fileName:
      `${baseName}-${Date.now()}.${extension}`,

    folder,

    useUniqueFileName: true,

    tags: [
      "gave-money-tips",
      "gaveai"
    ]
  });
}

/* =========================================================
   GENERATED IMAGE
========================================================= */

async function generateGaveAIImage(
  prompt
) {
  const accountId =
    process.env
      .CLOUDFLARE_ACCOUNT_ID;

  const apiToken =
    process.env
      .CLOUDFLARE_API_TOKEN;

  if (
    !accountId ||
    !apiToken
  ) {
    throw new Error(
      "IMAGE_PROVIDER_NOT_CONFIGURED"
    );
  }

  const cleanPrompt =
    String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error(
      "IMAGE_PROMPT_REQUIRED"
    );
  }

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${GAVEAI_IMAGE_MODEL}`;

  try {
    const response =
      await axios.post(
        endpoint,
        {
          prompt: cleanPrompt,
          steps: 4
        },
        {
          headers: {
            Authorization:
              `Bearer ${apiToken}`,
            "Content-Type":
              "application/json"
          },

          timeout: 120000,

          responseType:
            "arraybuffer",

          validateStatus:
            () => true
        }
      );

    const contentType =
      String(
        response.headers?.[
          "content-type"
        ] || ""
      ).toLowerCase();

    const rawBuffer =
      Buffer.isBuffer(
        response.data
      )
        ? response.data
        : Buffer.from(
            response.data || ""
          );

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      let errorText = "";

      try {
        errorText =
          rawBuffer.toString(
            "utf8"
          );
      } catch (e) {
        errorText = "";
      }

      console.error(
        "Cloudflare image provider HTTP error:",
        response.status,
        errorText
      );

      throw new Error(
        "IMAGE_PROVIDER_FAILED"
      );
    }

    /*
     * Cloudflare may directly return an image.
     */

    if (
      contentType.startsWith(
        "image/"
      )
    ) {
      if (
        !rawBuffer.length
      ) {
        throw new Error(
          "IMAGE_PROVIDER_EMPTY_RESULT"
        );
      }

      return {
        buffer: rawBuffer,
        mimeType:
          contentType.startsWith(
            "image/"
          )
            ? contentType
            : "image/jpeg"
      };
    }

    /*
     * Otherwise parse JSON.
     */

    let data = {};

    try {
      data = JSON.parse(
        rawBuffer.toString(
          "utf8"
        )
      );
    } catch (parseError) {
      console.error(
        "Cloudflare image JSON parse error:",
        parseError
      );

      throw new Error(
        "IMAGE_PROVIDER_EMPTY_RESULT"
      );
    }

    let base64Image =
      data?.result?.image ||
      data?.result?.image_base64 ||
      data?.result?.base64 ||
      data?.image ||
      data?.image_base64 ||
      null;

    if (
      typeof base64Image !==
        "string" ||
      !base64Image.trim()
    ) {
      throw new Error(
        "IMAGE_PROVIDER_EMPTY_RESULT"
      );
    }

    base64Image =
      base64Image
        .replace(
          /^data:image\/[a-zA-Z0-9.+-]+;base64,/i,
          ""
        )
        .trim();

    const imageBuffer =
      Buffer.from(
        base64Image,
        "base64"
      );

    if (
      !imageBuffer.length
    ) {
      throw new Error(
        "IMAGE_PROVIDER_EMPTY_RESULT"
      );
    }

    return {
      buffer: imageBuffer,
      mimeType: "image/jpeg"
    };
  } catch (error) {
    if (
      error?.message?.startsWith(
        "IMAGE_PROVIDER_"
      )
    ) {
      throw error;
    }

    console.error(
      "Cloudflare image generation error:",
      error
    );

    throw new Error(
      "IMAGE_PROVIDER_FAILED"
    );
  }
}

/* =========================================================
   GENERATED IMAGE → IMAGEKIT
========================================================= */

async function uploadGeneratedImageToImageKit(
  buffer,
  userId,
  mimeType = "image/jpeg"
) {
  if (
    !buffer ||
    !buffer.length
  ) {
    throw new Error(
      "IMAGE_GENERATION_FAILED"
    );
  }

  const extension =
    mimeType.includes("png")
      ? "png"
      : mimeType.includes("webp")
      ? "webp"
      : "jpg";

  return await imagekit.upload({
    file: buffer,

    fileName:
      `gaveai-image-${userId}-${Date.now()}.${extension}`,

    folder:
      "gavemoneytips/generated-images",

    useUniqueFileName: true,

    tags: [
      "gave-money-tips",
      "gaveai",
      "generated-image",
      String(userId)
    ]
  });
}

/* =========================================================
   IMAGE GENERATION STATUS
========================================================= */

app.get(
  "/api/image-generation-status",
  requireAuthenticatedUser,
  (req, res) => {
    const configured =
      !!(
        process.env
          .CLOUDFLARE_ACCOUNT_ID &&
        process.env
          .CLOUDFLARE_API_TOKEN
      );

    res.json({
      success: true,
      provider: "GaveAI",
      configured,
      model:
        GAVEAI_IMAGE_MODEL,
      imageKitConfigured:
        !!(
          process.env
            .IMAGEKIT_PUBLIC_KEY &&
          process.env
            .IMAGEKIT_PRIVATE_KEY &&
          process.env
            .IMAGEKIT_URL_ENDPOINT
        )
    });
  }
);

/* =========================================================
   GENERATE IMAGE
========================================================= */

app.post(
  "/generate-image",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const prompt =
        req.body?.prompt ||
        req.body?.message ||
        req.body?.text;

      if (
        !String(prompt || "").trim()
      ) {
        return res.status(400).json({
          success: false,
          provider: "GaveAI",
          error:
            "Image prompt is required."
        });
      }

      const generated =
        await generateGaveAIImage(
          prompt
        );

      const uploaded =
        await uploadGeneratedImageToImageKit(
          generated.buffer,
          req.userUid,
          generated.mimeType
        );

      res.json({
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
          uploaded.fileId,
        fileName:
          uploaded.name,

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
        "GENERATE IMAGE INTERNAL ERROR:",
        error
      );

      let status = 500;

      let friendlyError =
        "GaveAI image generation failed. Please try again.";

      const message =
        String(
          error?.message || ""
        );

      if (
        message ===
        "IMAGE_PROVIDER_NOT_CONFIGURED"
      ) {
        friendlyError =
          "GaveAI image generation is not configured.";
      } else if (
        message ===
        "IMAGE_PROMPT_REQUIRED"
      ) {
        status = 400;

        friendlyError =
          "Image prompt is required.";
      } else if (
        message ===
        "IMAGE_PROVIDER_EMPTY_RESULT"
      ) {
        friendlyError =
          "GaveAI image generation returned no image.";
      } else if (
        message.startsWith(
          "IMAGE_PROVIDER_FAILED"
        )
      ) {
        friendlyError =
          "GaveAI image generation failed. Please try again.";
      }

      res.status(status).json({
        success: false,
        provider: "GaveAI",
        error:
          friendlyError
      });
    }
  }
);

/* =========================================================
   PROFILE PHOTO
========================================================= */

app.post(
  "/upload-profile-photo",
  requireAuthenticatedUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "Profile photo is required."
        });
      }

      const result =
        await uploadBufferToImageKit(
          req.file.buffer,
          req.file.originalname ||
            "profile-photo",
          "gavemoneytips/profile-photos",
          req.file.mimetype
        );

      await db
        .collection("users")
        .doc(req.userUid)
        .set(
          {
            profilePhotoUrl:
              result.url,
            profilePhotoFileId:
              result.fileId,

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          {
            merge: true
          }
        );

      res.json({
        success: true,
        url:
          result.url,
        fileId:
          result.fileId,
        fileName:
          result.name
      });
    } catch (error) {
      console.error(
        "Profile photo upload error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Profile photo upload failed."
      });
    }
  }
);

/* =========================================================
   CERTIFICATE
========================================================= */

app.post(
  "/upload-certificate",
  requireAuthenticatedUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "Certificate file is required."
        });
      }

      const result =
        await uploadBufferToImageKit(
          req.file.buffer,
          req.file.originalname ||
            "certificate",
          "certificates",
          req.file.mimetype
        );

      res.json({
        success: true,
        url:
          result.url,
        fileId:
          result.fileId,
        fileName:
          result.name
      });
    } catch (error) {
      console.error(
        "Certificate upload error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Certificate upload failed."
      });
    }
  }
);

/* =========================================================
   GENERIC MEDIA
========================================================= */

app.post(
  "/upload-media",
  requireAuthenticatedUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "File is required."
        });
      }

      const requestedFolder =
        String(
          req.body?.folder || ""
        ).trim();

      const folder =
        requestedFolder ||
        "gavemoneytips/chat-media";

      const result =
        await uploadBufferToImageKit(
          req.file.buffer,
          req.file.originalname ||
            "media",
          folder,
          req.file.mimetype
        );

      res.json({
        success: true,
        url:
          result.url,
        fileId:
          result.fileId,
        fileName:
          result.name,
        mimeType:
          req.file.mimetype
      });
    } catch (error) {
      console.error(
        "Media upload error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Media upload failed."
      });
    }
  }
);

/* =========================================================
   GENERATED VIDEO → IMAGEKIT
========================================================= */

async function uploadGeneratedVideoToImageKit(
  filePath,
  userId
) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    throw new Error(
      "Generated video file was not found."
    );
  }

  const fileBuffer =
    fs.readFileSync(
      filePath
    );

  return await imagekit.upload({
    file:
      fileBuffer,

    fileName:
      `gaveai-${userId}-${Date.now()}.mp4`,

    folder:
      "gavemoneytips/generated-videos",

    useUniqueFileName:
      true,

    tags: [
      "gave-money-tips",
      "gaveai",
      "generated-video",
      String(userId)
    ]
  });
}

/* =========================================================
   ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const snapshot =
        await db
          .collection("users")
          .doc(req.userUid)
          .get();

      const data =
        snapshot.exists
          ? snapshot.data()
          : {};

      const freeState =
        normalizeFreeVideoState(
          data
        );

      const plan =
        getUserPlan(data);

      const expiresAt =
        timestampToISO(
          data.subscriptionExpiresAt
        );

      const active =
        isSubscriptionActive(
          data
        );

      const credits =
        Math.max(
          0,
          safeNumber(
            data.credits,
            0
          )
        );

      res.json({
        success: true,

        userId:
          req.userUid,

        account: {
          ...data,

          userId:
            req.userUid,

          credits,

          creditBalance:
            credits,

          plan,

          subscriptionPlan:
            plan,

          subscriptionExpiresAt:
            expiresAt,

          subscriptionActive:
            active,

          freeVideoUsed:
            freeState.freeVideoUsed,

          freeVideoRemaining:
            freeState.freeVideoRemaining,

          freeVideoAvailable:
            freeState.freeVideoAvailable,

          isAdmin:
            isAdmin(
              req.userUid
            )
        }
      });
    } catch (error) {
      console.error(
        "Account error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load account."
      });
    }
  }
);

/* =========================================================
   RESUME
========================================================= */

app.post(
  "/upload-resume",
  requireAuthenticatedUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "Resume file is required."
        });
      }

      const result =
        await uploadBufferToImageKit(
          req.file.buffer,
          req.file.originalname ||
            "resume",
          "resumes",
          req.file.mimetype
        );

      await db
        .collection("users")
        .doc(req.userUid)
        .set(
          {
            resumeUrl:
              result.url,

            resumeFileId:
              result.fileId,

            resumeFileName:
              result.name,

            resumeUpdatedAt:
              admin.firestore.FieldValue.serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          {
            merge: true
          }
        );

      res.json({
        success: true,

        url:
          result.url,

        resumeUrl:
          result.url,

        fileId:
          result.fileId,

        resumeFileId:
          result.fileId,

        fileName:
          result.name,

        resumeFileName:
          result.name
      });
    } catch (error) {
      console.error(
        "Resume upload error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Resume upload failed."
      });
    }
  }
);

/* =========================================================
   PAYMENT REQUEST CREATE
========================================================= */

app.post(
  "/api/payment-requests",
  requireAuthenticatedUser,
  upload.single("proof"),
  async (req, res) => {
    try {
      const plan =
        normalizePlan(
          req.body?.plan
        );

      if (!plan) {
        return res.status(400).json({
          success: false,
          error:
            "Valid Pro or Premium plan is required."
        });
      }

      const amount =
        safeNumber(
          req.body?.amount,
          getPlanPrice(plan)
        );

      if (
        !amount ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid payment amount is required."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "Payment proof is required."
        });
      }

      const proof =
        await uploadBufferToImageKit(
          req.file.buffer,
          req.file.originalname ||
            "payment-proof",
          "gavemoneytips/payment-proofs",
          req.file.mimetype
        );

      const paymentData = {
        userId:
          req.userUid,

        plan,

        amount,

        bankName:
          req.body?.bankName ||
          BANK_INFO.bankName,

        accountHolderName:
          req.body?.accountHolderName ||
          BANK_INFO.accountHolder,

        transactionDate:
          req.body?.transactionDate ||
          null,

        transactionTime:
          req.body?.transactionTime ||
          null,

        proofUrl:
          proof.url,

        proofFileId:
          proof.fileId,

        proofFileName:
          proof.name,

        status:
          "pending",

        deleted:
          false,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      };

      const doc =
        await db
          .collection("paymentRequests")
          .add(
            paymentData
          );

      res.json({
        success: true,
        id: doc.id,
        message:
          "Payment request submitted successfully."
      });
    } catch (error) {
      console.error(
        "Payment request creation error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Payment request could not be submitted."
      });
    }
  }
);

/* =========================================================
   USER PAYMENT HISTORY
========================================================= */

app.get(
  "/api/payment-requests",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      let snapshot;

      try {
        snapshot =
          await db
            .collection(
              "paymentRequests"
            )
            .where(
              "userId",
              "==",
              req.userUid
            )
            .orderBy(
              "createdAt",
              "desc"
            )
            .get();
      } catch (indexError) {
        snapshot =
          await db
            .collection(
              "paymentRequests"
            )
            .where(
              "userId",
              "==",
              req.userUid
            )
            .get();
      }

      const payments =
        snapshot.docs
          .map((doc) => {
            const data =
              doc.data();

            return {
              id: doc.id,

              ...data,

              createdAt:
                timestampToISO(
                  data.createdAt
                ),

              updatedAt:
                timestampToISO(
                  data.updatedAt
                ),

              approvedAt:
                timestampToISO(
                  data.approvedAt
                ),

              rejectedAt:
                timestampToISO(
                  data.rejectedAt
                )
            };
          })
          .sort(
            (a, b) =>
              timestampToMillis(
                b.createdAt
              ) -
              timestampToMillis(
                a.createdAt
              )
          );

      res.json({
        success: true,
        payments
      });
    } catch (error) {
      console.error(
        "Payment history error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load payment history."
      });
    }
  }
);

/* =========================================================
   ACTIVATE SUBSCRIPTION
========================================================= */

async function activateSubscriptionForUser(
  userId,
  plan
) {
  const normalizedPlan =
    normalizePlan(plan);

  if (!normalizedPlan) {
    throw new Error(
      "Invalid subscription plan."
    );
  }

  const planCredits =
    getPlanCredits(
      normalizedPlan
    );

  const userRef =
    db
      .collection("users")
      .doc(userId);

  return await db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      const currentData =
        snapshot.exists
          ? snapshot.data()
          : {};

      const currentlyActive =
        isSubscriptionActive(
          currentData
        );

      const currentCredits =
        Math.max(
          0,
          safeNumber(
            currentData.credits,
            0
          )
        );

      const newCredits =
        currentlyActive
          ? currentCredits +
            planCredits
          : planCredits;

      const expiresAt =
        calculateExpirationDate();

      transaction.set(
        userRef,
        {
          subscriptionPlan:
            normalizedPlan,

          plan:
            normalizedPlan,

          credits:
            newCredits,

          subscriptionExpiresAt:
            admin.firestore.Timestamp.fromDate(
              expiresAt
            ),

          subscriptionActivatedAt:
            admin.firestore.FieldValue.serverTimestamp(),

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        },
        {
          merge: true
        }
      );

      return {
        plan:
          normalizedPlan,

        credits:
          newCredits,

        creditsAdded:
          planCredits,

        subscriptionExpiresAt:
          expiresAt.toISOString()
      };
    }
  );
}

/* =========================================================
   ADMIN PAYMENT REQUESTS
========================================================= */

app.get(
  "/api/admin/payment-requests",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const filter =
        String(
          req.query.filter ||
            "all"
        )
          .trim()
          .toLowerCase();

      let snapshot;

      try {
        if (
          filter ===
          "trash"
        ) {
          snapshot =
            await db
              .collection(
                "paymentRequests"
              )
              .where(
                "deleted",
                "==",
                true
              )
              .get();
        } else if (
          [
            "pending",
            "approved",
            "rejected"
          ].includes(filter)
        ) {
          snapshot =
            await db
              .collection(
                "paymentRequests"
              )
              .where(
                "status",
                "==",
                filter
              )
              .get();
        } else {
          snapshot =
            await db
              .collection(
                "paymentRequests"
              )
              .where(
                "deleted",
                "!=",
                true
              )
              .get();
        }
      } catch (queryError) {
        snapshot =
          await db
            .collection(
              "paymentRequests"
            )
            .get();
      }

      let payments =
        snapshot.docs.map(
          (doc) => {
            const data =
              doc.data();

            return {
              id: doc.id,

              ...data,

              createdAt:
                timestampToISO(
                  data.createdAt
                ),

              updatedAt:
                timestampToISO(
                  data.updatedAt
                ),

              approvedAt:
                timestampToISO(
                  data.approvedAt
                ),

              rejectedAt:
                timestampToISO(
                  data.rejectedAt
                ),

              deletedAt:
                timestampToISO(
                  data.deletedAt
                ),

              restoredAt:
                timestampToISO(
                  data.restoredAt
                )
            };
          }
        );

      if (
        filter ===
        "trash"
      ) {
        payments =
          payments.filter(
            (payment) =>
              payment.deleted ===
              true
          );
      } else {
        payments =
          payments.filter(
            (payment) =>
              payment.deleted !==
              true
          );

        if (
          [
            "pending",
            "approved",
            "rejected"
          ].includes(filter)
        ) {
          payments =
            payments.filter(
              (payment) =>
                payment.status ===
                filter
            );
        }
      }

      payments.sort(
        (a, b) =>
          timestampToMillis(
            b.createdAt
          ) -
          timestampToMillis(
            a.createdAt
          )
      );

      res.json({
        success: true,
        filter,
        payments
      });
    } catch (error) {
      console.error(
        "Admin payment list error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load payment requests."
      });
    }
  }
);

/* =========================================================
   ADMIN PAYMENTS ALIAS
========================================================= */

app.get(
  "/api/admin/payments",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const filter =
        String(
          req.query.filter ||
            "all"
        );

      const snapshot =
        await db
          .collection(
            "paymentRequests"
          )
          .get();

      let payments =
        snapshot.docs.map(
          (doc) => {
            const data =
              doc.data();

            return {
              id: doc.id,

              ...data,

              createdAt:
                timestampToISO(
                  data.createdAt
                ),

              updatedAt:
                timestampToISO(
                  data.updatedAt
                ),

              approvedAt:
                timestampToISO(
                  data.approvedAt
                ),

              rejectedAt:
                timestampToISO(
                  data.rejectedAt
                ),

              deletedAt:
                timestampToISO(
                  data.deletedAt
                )
            };
          }
        );

      if (
        filter ===
        "trash"
      ) {
        payments =
          payments.filter(
            (item) =>
              item.deleted ===
              true
          );
      } else {
        payments =
          payments.filter(
            (item) =>
              item.deleted !==
              true
          );
      }

      res.json({
        success: true,
        filter,
        payments
      });
    } catch (error) {
      console.error(
        "Admin payments alias error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load payments."
      });
    }
  }
);

/* =========================================================
   ADMIN APPROVE PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:id/approve",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentRef =
        db
          .collection(
            "paymentRequests"
          )
          .doc(
            req.params.id
          );

      const snapshot =
        await paymentRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Payment request not found."
        });
      }

      const payment =
        snapshot.data();

      if (
        payment.deleted ===
        true
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Payment request is in trash."
        });
      }

      if (
        payment.status ===
        "approved"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Payment request is already approved."
        });
      }

      const plan =
        normalizePlan(
          payment.plan
        );

      if (!plan) {
        return res.status(400).json({
          success: false,
          error:
            "Payment request has an invalid plan."
        });
      }

      const subscription =
        await activateSubscriptionForUser(
          payment.userId,
          plan
        );

      await paymentRef.update({
        status:
          "approved",

        approvedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        approvedBy:
          req.userUid,

        subscriptionExpiresAt:
          admin.firestore.Timestamp.fromDate(
            new Date(
              subscription.subscriptionExpiresAt
            )
          ),

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        message:
          "Payment approved and subscription activated.",
        subscription
      });
    } catch (error) {
      console.error(
        "Approve payment error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Payment approval failed."
      });
    }
  }
);

/* =========================================================
   ADMIN REJECT PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:id/reject",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const ref =
        db
          .collection(
            "paymentRequests"
          )
          .doc(
            req.params.id
          );

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Payment request not found."
        });
      }

      const payment =
        snapshot.data();

      if (
        payment.deleted ===
        true
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Payment request is in trash."
        });
      }

      await ref.update({
        status:
          "rejected",

        rejectionReason:
          req.body?.reason ||
          "Payment rejected.",

        rejectedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        rejectedBy:
          req.userUid,

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        message:
          "Payment request rejected."
      });
    } catch (error) {
      console.error(
        "Reject payment error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Payment rejection failed."
      });
    }
  }
);

/* =========================================================
   ADMIN TRASH PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:id/trash",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const ref =
        db
          .collection(
            "paymentRequests"
          )
          .doc(
            req.params.id
          );

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Payment request not found."
        });
      }

      await ref.update({
        deleted:
          true,

        deletedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        deletedBy:
          req.userUid,

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        message:
          "Payment request moved to trash."
      });
    } catch (error) {
      console.error(
        "Trash payment error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to move payment to trash."
      });
    }
  }
);

/* =========================================================
   ADMIN RESTORE PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:id/restore",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const ref =
        db
          .collection(
            "paymentRequests"
          )
          .doc(
            req.params.id
          );

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Payment request not found."
        });
      }

      await ref.update({
        deleted:
          false,

        restoredAt:
          admin.firestore.FieldValue.serverTimestamp(),

        restoredBy:
          req.userUid,

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        message:
          "Payment request restored."
      });
    } catch (error) {
      console.error(
        "Restore payment error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to restore payment."
      });
    }
  }
);

/* =========================================================
   ADMIN BATCH RESTORE
========================================================= */

app.post(
  "/api/admin/payment-requests/batch-restore",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const ids =
        Array.isArray(
          req.body?.ids
        )
          ? req.body.ids.slice(
              0,
              100
            )
          : [];

      if (!ids.length) {
        return res.status(400).json({
          success: false,
          error:
            "Payment request IDs are required."
        });
      }

      const batch =
        db.batch();

      ids.forEach(
        (id) => {
          const ref =
            db
              .collection(
                "paymentRequests"
              )
              .doc(
                String(id)
              );

          batch.update(
            ref,
            {
              deleted:
                false,

              restoredAt:
                admin.firestore.FieldValue.serverTimestamp(),

              restoredBy:
                req.userUid,

              updatedAt:
                admin.firestore.FieldValue.serverTimestamp()
            }
          );
        }
      );

      await batch.commit();

      res.json({
        success: true,
        restored:
          ids.length
      });
    } catch (error) {
      console.error(
        "Batch restore error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to restore payment requests."
      });
    }
  }
);

/* =========================================================
   ADMIN PERMANENT DELETE
========================================================= */

app.delete(
  "/api/admin/payment-requests/:id",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const ref =
        db
          .collection(
            "paymentRequests"
          )
          .doc(
            req.params.id
          );

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Payment request not found."
        });
      }

      if (
        snapshot.data()
          .deleted !== true
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Only payment requests in trash can be permanently deleted."
        });
      }

      await ref.delete();

      res.json({
        success: true,
        message:
          "Payment request permanently deleted."
      });
    } catch (error) {
      console.error(
        "Permanent payment delete error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to permanently delete payment."
      });
    }
  }
);

/* =========================================================
   VIDEO QUEUE
========================================================= */

function enterVideoQueue() {
  /*
   * Maximum number of waiting jobs is independent
   * from the number currently generating.
   */

  if (
    queuedVideoGenerations >=
    MAX_VIDEO_QUEUE
  ) {
    const error =
      new Error(
        "VIDEO_QUEUE_FULL"
      );

    error.code =
      "VIDEO_QUEUE_FULL";

    throw error;
  }

  queuedVideoGenerations += 1;
}

function startVideoJob() {
  queuedVideoGenerations =
    Math.max(
      0,
      queuedVideoGenerations - 1
    );

  activeVideoGenerations += 1;
}

function finishVideoJob() {
  activeVideoGenerations =
    Math.max(
      0,
      activeVideoGenerations - 1
    );
}

/* =========================================================
   VIDEO PRODUCTION
========================================================= */

async function generateGaveAIVideoProduction(
  options = {}
) {
  const {
    scenes,
    storyOverview = "",
    mainCharacter = "",
    visualStyle = "",
    environment = "",
    cameraStyle = "",
    globalAudioDirection = "",
    userId
  } = options;

  let normalizedScenes =
    Array.isArray(scenes)
      ? scenes
      : [];

  if (
    !normalizedScenes.length
  ) {
    throw new Error(
      "At least one video scene is required."
    );
  }

  if (
    normalizedScenes.length >
    20
  ) {
    throw new Error(
      "A maximum of 20 scenes is allowed."
    );
  }

  const generatedClips = [];

  let audioResult = null;

  const continuity = [
    storyOverview
      ? `Story Overview: ${storyOverview}`
      : "",

    mainCharacter
      ? `Main Character: ${mainCharacter}`
      : "",

    visualStyle
      ? `Visual Style: ${visualStyle}`
      : "",

    environment
      ? `Environment: ${environment}`
      : "",

    cameraStyle
      ? `Camera Style: ${cameraStyle}`
      : "",

    globalAudioDirection
      ? `Global Audio Direction: ${globalAudioDirection}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");

  try {
    for (
      let index = 0;
      index <
      normalizedScenes.length;
      index++
    ) {
      const scene =
        normalizedScenes[index];

      const duration =
        Number(
          scene.duration
        ) === 8
          ? 8
          : 5;

      const promptParts = [
        continuity,

        `Scene ${index + 1} of ${normalizedScenes.length}:`,

        scene.prompt ||
          scene.description ||
          ""
      ].filter(Boolean);

      const prompt =
        promptParts.join(
          "\n\n"
        );

      const result =
        await generateWithGaveAIVideoProvider(
          {
            prompt,

            width:
              Number(
                scene.width
              ) ||
              Number(
                options.width
              ) ||
              832,

            height:
              Number(
                scene.height
              ) ||
              Number(
                options.height
              ) ||
              480,

            duration,

            seed:
              scene.seed ??
              options.seed ??
              -1,

            firstFrameImage:
              scene.firstFrameImage ||
              scene.image ||
              scene.imageUrl ||
              null,

            lastFrameImage:
              scene.lastFrameImage ||
              null,

            userId,

            sceneIndex:
              index
          }
        );

      const videoFile =
        result?.videoFile ||
        result?.filePath ||
        result?.path;

      if (!videoFile) {
        throw new Error(
          "GaveAI did not return a generated video file."
        );
      }

      generatedClips.push(
        videoFile
      );
    }

    /*
     * Render requested voice/dialogue/narration/music/
     * SFX/ambience and mux everything into final MP4.
     */

    audioResult =
      await renderGaveAIAudioForScenes(
        {
          clips:
            generatedClips,

          scenes:
            normalizedScenes,

          globalAudioDirection,

          userId
        }
      );

    const finalVideo =
      audioResult?.videoFile ||
      audioResult?.outputFile ||
      audioResult?.finalVideo;

    if (!finalVideo) {
      throw new Error(
        "GaveAI could not create the final video."
      );
    }

    return {
      videoFile:
        finalVideo,

      clips:
        generatedClips,

      audio:
        audioResult?.audio ||
        null,

      generatedAudioFiles:
        audioResult?.generatedAudioFiles ||
        [],

      sceneCount:
        normalizedScenes.length
    };
  } catch (error) {
    console.error(
      "GaveAI production error:",
      error
    );

    for (
      const clip of generatedClips
    ) {
      removeFile(clip);
    }

    if (
      audioResult?.generatedAudioFiles
    ) {
      try {
        cleanupAudioFiles(
          audioResult.generatedAudioFiles
        );
      } catch (
        cleanupError
      ) {
        console.error(
          "Audio cleanup error:",
          cleanupError.message
        );
      }
    }

    if (
      audioResult?.videoFile
    ) {
      removeFile(
        audioResult.videoFile
      );
    }

    throw error;
  }
}

/* =========================================================
   FREE VIDEO BILLING
========================================================= */

async function consumeFreeVideo(
  userId
) {
  const userRef =
    db
      .collection("users")
      .doc(userId);

  await db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      const data =
        snapshot.exists
          ? snapshot.data()
          : {};

      const state =
        normalizeFreeVideoState(
          data
        );

      if (
        !state.freeVideoAvailable
      ) {
        throw new Error(
          "FREE_VIDEO_ALREADY_USED"
        );
      }

      transaction.set(
        userRef,
        {
          freeVideoUsed:
            true,

          freeVideoRemaining:
            0,

          freeVideoAvailable:
            false,

          freeVideoUsedAt:
            admin.firestore.FieldValue.serverTimestamp(),

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        },
        {
          merge: true
        }
      );
    }
  );
}

async function restoreFreeVideo(
  userId
) {
  const userRef =
    db
      .collection("users")
      .doc(userId);

  await userRef.set(
    {
      freeVideoUsed:
        false,

      freeVideoRemaining:
        FREE_VIDEO_COUNT,

      freeVideoAvailable:
        true,

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    },
    {
      merge: true
    }
  );
}

/* =========================================================
   PAID CREDIT BILLING
========================================================= */

async function reservePaidCredits(
  userId,
  creditsRequired
) {
  const userRef =
    db
      .collection("users")
      .doc(userId);

  await db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      if (!snapshot.exists) {
        throw new Error(
          "PAID_PLAN_REQUIRED"
        );
      }

      const data =
        snapshot.data();

      if (
        !isSubscriptionActive(
          data
        )
      ) {
        throw new Error(
          "SUBSCRIPTION_EXPIRED"
        );
      }

      const credits =
        Math.max(
          0,
          safeNumber(
            data.credits,
            0
          )
        );

      if (
        credits <
        creditsRequired
      ) {
        throw new Error(
          "INSUFFICIENT_CREDITS"
        );
      }

      transaction.update(
        userRef,
        {
          credits:
            credits -
            creditsRequired,

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        }
      );
    }
  );
}

async function refundPaidCredits(
  userId,
  credits
) {
  if (
    !credits ||
    credits <= 0
  ) {
    return;
  }

  const userRef =
    db
      .collection("users")
      .doc(userId);

  await userRef.set(
    {
      credits:
        admin.firestore.FieldValue.increment(
          Number(credits)
        ),

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    },
    {
      merge: true
    }
  );
}

/* =========================================================
   GENERATE VIDEO
========================================================= */

app.post(
  "/generate-video",
  requireAuthenticatedUser,
  async (req, res) => {
    let billingType =
      null;

    let billingCredits =
      0;

    let billingConsumed =
      false;

    let billingFreeConsumed =
      false;

    let production =
      null;

    let uploadedVideo =
      null;

    let queueEntered =
      false;

    let queueStarted =
      false;

    try {
      const userId =
        req.userUid;

      const userSnapshot =
        await db
          .collection("users")
          .doc(userId)
          .get();

      const userData =
        userSnapshot.exists
          ? userSnapshot.data()
          : {};

      /*
       * IMPORTANT ADMIN CHECK.
       * Admin gets unlimited generation and
       * NEVER consumes credits/free video.
       */

      const adminUser =
        isAdmin(userId);

      console.log(
        "🎬 GaveAI video billing check:",
        {
          userId,
          adminUser,
          configuredAdminUserId:
            ADMIN_USER_ID,

          credits:
            safeNumber(
              userData.credits,
              0
            ),

          plan:
            userData.subscriptionPlan ||
            userData.plan ||
            null,

          subscriptionActive:
            isSubscriptionActive(
              userData
            ),

          freeVideo:
            normalizeFreeVideoState(
              userData
            )
        }
      );

      let scenes =
        Array.isArray(
          req.body?.scenes
        )
          ? req.body.scenes
          : [];

      /*
       * Legacy prompts format.
       */

      if (
        !scenes.length
      ) {
        const prompts =
          Array.isArray(
            req.body?.prompts
          )
            ? req.body.prompts
            : [];

        if (
          prompts.length
        ) {
          scenes =
            prompts.map(
              (prompt) => ({
                prompt,

                duration:
                  Number(
                    req.body?.duration
                  ) === 8
                    ? 8
                    : 5,

                width:
                  Number(
                    req.body?.width
                  ) ||
                  832,

                height:
                  Number(
                    req.body?.height
                  ) ||
                  480
              })
            );
        }
      }

      /*
       * Legacy single prompt.
       */

      if (
        !scenes.length
      ) {
        const fallbackPrompt =
          req.body?.prompt ||
          req.body?.message ||
          req.body?.text;

        if (
          fallbackPrompt
        ) {
          scenes = [
            {
              prompt:
                fallbackPrompt,

              duration:
                Number(
                  req.body?.duration
                ) === 8
                  ? 8
                  : 5,

              width:
                Number(
                  req.body?.width
                ) ||
                832,

              height:
                Number(
                  req.body?.height
                ) ||
                480,

              firstFrameImage:
                req.body
                  ?.firstFrameImage ||
                req.body
                  ?.imageUrl ||
                null
            }
          ];
        }
      }

      if (
        !scenes.length
      ) {
        return res.status(400).json({
          success: false,
          error:
            "At least one video scene is required."
        });
      }

      if (
        scenes.length >
        20
      ) {
        return res.status(400).json({
          success: false,
          error:
            "A maximum of 20 scenes is allowed."
        });
      }

      let totalCredits =
        0;

      scenes =
        scenes.map(
          (scene, index) => {
            const duration =
              Number(
                scene.duration
              ) === 8
                ? 8
                : 5;

            if (
              ![5, 8].includes(
                duration
              )
            ) {
              throw new Error(
                "VIDEO_DURATION_INVALID"
              );
            }

            totalCredits +=
              getVideoCreditCost(
                duration
              );

            return {
              ...scene,

              sceneIndex:
                index,

              duration
            };
          }
        );

      const plan =
        getUserPlan(
          userData
        );

      const freeState =
        normalizeFreeVideoState(
          userData
        );

      /*
       * BILLING
       *
       * ADMIN:
       * unlimited
       *
       * NEW FREE USER:
       * one lifetime free video
       *
       * FREE:
       * one scene only
       *
       * PAID:
       * consume credits
       */

      if (!adminUser) {
        if (
          !plan &&
          freeState.freeVideoAvailable
        ) {
          if (
            scenes.length >
            1
          ) {
            return res.status(400).json({
              success: false,
              error:
                "Your 1 lifetime free video is limited to one scene. Choose a plan to connect multiple scenes."
            });
          }

          billingType =
            "free";

          await consumeFreeVideo(
            userId
          );

          billingFreeConsumed =
            true;

          billingConsumed =
            true;
        } else {
          if (!plan) {
            throw new Error(
              "PAID_PLAN_REQUIRED"
            );
          }

          if (
            !isSubscriptionActive(
              userData
            )
          ) {
            throw new Error(
              "SUBSCRIPTION_EXPIRED"
            );
          }

          billingType =
            "paid";

          billingCredits =
            totalCredits;

          await reservePaidCredits(
            userId,
            totalCredits
          );

          billingConsumed =
            true;
        }
      } else {
        /*
         * ADMIN NEVER PAYS.
         */

        billingType =
          "admin";

        billingCredits =
          0;

        billingConsumed =
          false;

        billingFreeConsumed =
          false;
      }

      /*
       * ENTER QUEUE ONLY AFTER BILLING HAS
       * BEEN SUCCESSFULLY RESERVED.
       */

      enterVideoQueue();

      queueEntered =
        true;

      startVideoJob();

      queueStarted =
        true;

      try {
        production =
          await generateGaveAIVideoProduction(
            {
              scenes,

              storyOverview:
                req.body
                  ?.storyOverview ||
                "",

              mainCharacter:
                req.body
                  ?.mainCharacter ||
                "",

              visualStyle:
                req.body
                  ?.visualStyle ||
                "",

              environment:
                req.body
                  ?.environment ||
                "",

              cameraStyle:
                req.body
                  ?.cameraStyle ||
                "",

              globalAudioDirection:
                req.body
                  ?.globalAudioDirection ||
                "",

              userId,

              width:
                Number(
                  req.body?.width
                ) ||
                832,

              height:
                Number(
                  req.body?.height
                ) ||
                480,

              seed:
                req.body?.seed ??
                -1
            }
          );
      } finally {
        if (queueStarted) {
          finishVideoJob();
          queueStarted =
            false;
        }
      }

      uploadedVideo =
        await uploadGeneratedVideoToImageKit(
          production.videoFile,
          userId
        );

      const productionRecord = {
        userId,

        provider:
          "GaveAI",

        sceneCount:
          scenes.length,

        scenes:
          scenes.map(
            (scene) => ({
              prompt:
                scene.prompt ||
                "",

              duration:
                scene.duration,

              voice:
                scene.voice ||
                scene.voiceId ||
                null,

              voiceText:
                scene.voiceText ||
                scene.dialogue ||
                scene.narration ||
                null,

              voiceEmotion:
                scene.voiceEmotion ||
                null,

              voiceSpeed:
                scene.voiceSpeed ||
                null,

              musicPrompt:
                scene.musicPrompt ||
                scene.music ||
                null,

              musicVolume:
                scene.musicVolume ??
                null,

              sfxPrompt:
                scene.sfxPrompt ||
                scene.sfx ||
                null,

              sfxVolume:
                scene.sfxVolume ??
                null,

              ambiencePrompt:
                scene.ambiencePrompt ||
                scene.ambience ||
                null,

              ambienceVolume:
                scene.ambienceVolume ??
                null
            })
          ),

        storyOverview:
          req.body
            ?.storyOverview ||
          "",

        mainCharacter:
          req.body
            ?.mainCharacter ||
          "",

        visualStyle:
          req.body
            ?.visualStyle ||
          "",

        environment:
          req.body
            ?.environment ||
          "",

        cameraStyle:
          req.body
            ?.cameraStyle ||
          "",

        globalAudioDirection:
          req.body
            ?.globalAudioDirection ||
          "",

        billingType,

        creditsUsed:
          billingType ===
          "paid"
            ? totalCredits
            : 0,

        freeVideoUsed:
          billingType ===
          "free",

        videoUrl:
          uploadedVideo.url,

        videoFileId:
          uploadedVideo.fileId,

        audio:
          production.audio ||
          null,

        audioEmbedded:
          true,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      };

      const recordRef =
        await db
          .collection(
            "videoProductions"
          )
          .add(
            productionRecord
          );

      removeFile(
        production.videoFile
      );

      for (
        const clip of
          production.clips ||
          []
      ) {
        removeFile(clip);
      }

      if (
        production.generatedAudioFiles &&
        production
          .generatedAudioFiles
          .length
      ) {
        try {
          cleanupAudioFiles(
            production.generatedAudioFiles
          );
        } catch (error) {
          console.error(
            "Generated audio cleanup error:",
            error.message
          );
        }
      }

      res.json({
        success: true,

        id:
          recordRef.id,

        videoUrl:
          uploadedVideo.url,

        videoFileId:
          uploadedVideo.fileId,

        provider:
          "GaveAI",

        sceneCount:
          scenes.length,

        scenes:
          scenes.map(
            (scene) => ({
              duration:
                scene.duration,

              credits:
                getVideoCreditCost(
                  scene.duration
                )
            })
          ),

        totalCredits,

        creditsUsed:
          billingType ===
          "paid"
            ? totalCredits
            : 0,

        billingType,

        freeVideoUsed:
          billingType ===
          "free",

        audio:
          production.audio ||
          null,

        generatedMedia: {
          video:
            uploadedVideo.url,

          audioEmbedded:
            true
        }
      });
    } catch (error) {
      console.error(
        "GENERATE VIDEO INTERNAL ERROR:",
        error
      );

      /*
       * Refund paid credits only if they were
       * actually consumed.
       */

      if (
        billingConsumed &&
        billingType ===
          "paid" &&
        billingCredits >
          0
      ) {
        try {
          await refundPaidCredits(
            req.userUid,
            billingCredits
          );
        } catch (
          refundError
        ) {
          console.error(
            "Credit refund error:",
            refundError
          );
        }
      }

      /*
       * Restore free lifetime video if
       * generation failed after consumption.
       */

      if (
        billingConsumed &&
        billingType ===
          "free" &&
        billingFreeConsumed
      ) {
        try {
          await restoreFreeVideo(
            req.userUid
          );
        } catch (
          restoreError
        ) {
          console.error(
            "Free video restore error:",
            restoreError
          );
        }
      }

      /*
       * Safety queue cleanup.
       */

      if (
        queueStarted
      ) {
        finishVideoJob();
        queueStarted =
          false;
      }

      /*
       * If enterVideoQueue() succeeded but
       * startVideoJob() never happened.
       */

      if (
        queueEntered &&
        !queueStarted
      ) {
        /*
         * The normal path already moves the
         * job from queued → active.
         * Do not blindly decrement here because
         * the start path may already have done it.
         */
      }

      if (
        production?.videoFile
      ) {
        removeFile(
          production.videoFile
        );
      }

      for (
        const clip of
          production?.clips ||
          []
      ) {
        removeFile(clip);
      }

      if (
        production
          ?.generatedAudioFiles &&
        production
          .generatedAudioFiles
          .length
      ) {
        try {
          cleanupAudioFiles(
            production
              .generatedAudioFiles
          );
        } catch (
          cleanupError
        ) {
          console.error(
            "Generated audio cleanup error:",
            cleanupError.message
          );
        }
      }

      const friendlyError =
        genericVideoError(
          error
        );

      const lowerFriendly =
        friendlyError.toLowerCase();

      const status =
        lowerFriendly.includes(
          "credits"
        ) ||
        lowerFriendly.includes(
          "plan"
        ) ||
        lowerFriendly.includes(
          "expired"
        ) ||
        lowerFriendly.includes(
          "free video"
        ) ||
        lowerFriendly.includes(
          "queue"
        ) ||
        lowerFriendly.includes(
          "duration"
        )
          ? 400
          : 500;

      res.status(status).json({
        success: false,
        provider:
          "GaveAI",
        error:
          friendlyError
      });
    }
  }
);

/* =========================================================
   VIDEO PRODUCTION STATUS
========================================================= */

app.get(
  "/api/video-productions/:id",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const ref =
        db
          .collection(
            "videoProductions"
          )
          .doc(
            req.params.id
          );

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Video production not found."
        });
      }

      const data =
        snapshot.data();

      if (
        data.userId !==
          req.userUid &&
        !isAdmin(
          req.userUid
        )
      ) {
        return res.status(403).json({
          success: false,
          error:
            "You do not have access to this video."
        });
      }

      res.json({
        success: true,

        production: {
          id:
            snapshot.id,

          ...data,

          createdAt:
            timestampToISO(
              data.createdAt
            )
        }
      });
    } catch (error) {
      console.error(
        "Video production status error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load video production."
      });
    }
  }
);

/* =========================================================
   ADMIN USER LOOKUP
========================================================= */

app.get(
  "/api/admin/users/:uid",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot =
        await db
          .collection("users")
          .doc(
            req.params.uid
          )
          .get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "User not found."
        });
      }

      const data =
        snapshot.data();

      res.json({
        success: true,

        user: {
          uid:
            req.params.uid,

          ...data,

          subscriptionExpiresAt:
            timestampToISO(
              data.subscriptionExpiresAt
            )
        }
      });
    } catch (error) {
      console.error(
        "Admin user lookup error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load user."
      });
    }
  }
);

/* =========================================================
   ADMIN ADD CREDITS
========================================================= */

app.post(
  "/api/admin/users/:uid/add-credits",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        safeNumber(
          req.body?.credits
        );

      if (
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Credits must be greater than zero."
        });
      }

      await db
        .collection("users")
        .doc(
          req.params.uid
        )
        .set(
          {
            credits:
              admin.firestore.FieldValue.increment(
                amount
              ),

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          {
            merge: true
          }
        );

      res.json({
        success: true,
        creditsAdded:
          amount
      });
    } catch (error) {
      console.error(
        "Admin add credits error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to add credits."
      });
    }
  }
);

/* =========================================================
   ADMIN REMOVE CREDITS
========================================================= */

app.post(
  "/api/admin/users/:uid/remove-credits",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        safeNumber(
          req.body?.credits
        );

      if (
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Credits must be greater than zero."
        });
      }

      const ref =
        db
          .collection("users")
          .doc(
            req.params.uid
          );

      await db.runTransaction(
        async (transaction) => {
          const snapshot =
            await transaction.get(
              ref
            );

          if (!snapshot.exists) {
            throw new Error(
              "USER_NOT_FOUND"
            );
          }

          const current =
            Math.max(
              0,
              safeNumber(
                snapshot.data()
                  .credits,
                0
              )
            );

          transaction.update(
            ref,
            {
              credits:
                Math.max(
                  0,
                  current -
                    amount
                ),

              updatedAt:
                admin.firestore.FieldValue.serverTimestamp()
            }
          );
        }
      );

      res.json({
        success: true,
        creditsRemoved:
          amount
      });
    } catch (error) {
      console.error(
        "Admin remove credits error:",
        error
      );

      if (
        error.message ===
        "USER_NOT_FOUND"
      ) {
        return res.status(404).json({
          success: false,
          error:
            "User not found."
        });
      }

      res.status(500).json({
        success: false,
        error:
          "Unable to remove credits."
      });
    }
  }
);

/* =========================================================
   ADMIN RESET FREE VIDEO
========================================================= */

app.post(
  "/api/admin/users/:uid/reset-free-video",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      await restoreFreeVideo(
        req.params.uid
      );

      res.json({
        success: true,
        message:
          "Lifetime free video has been reset."
      });
    } catch (error) {
      console.error(
        "Admin reset free video error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to reset free video."
      });
    }
  }
);

/* =========================================================
   ADMIN ACTIVATE SUBSCRIPTION
========================================================= */

app.post(
  "/api/admin/users/:uid/activate-subscription",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const plan =
        normalizePlan(
          req.body?.plan
        );

      if (!plan) {
        return res.status(400).json({
          success: false,
          error:
            "Valid Pro or Premium plan is required."
        });
      }

      const result =
        await activateSubscriptionForUser(
          req.params.uid,
          plan
        );

      res.json({
        success: true,
        subscription:
          result
      });
    } catch (error) {
      console.error(
        "Admin subscription activation error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to activate subscription."
      });
    }
  }
);

/* =========================================================
   ADMIN CANCEL SUBSCRIPTION
========================================================= */

app.post(
  "/api/admin/users/:uid/cancel-subscription",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      await db
        .collection("users")
        .doc(
          req.params.uid
        )
        .set(
          {
            subscriptionPlan:
              null,

            plan:
              null,

            subscriptionExpiresAt:
              null,

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          {
            merge: true
          }
        );

      res.json({
        success: true,
        message:
          "Subscription cancelled."
      });
    } catch (error) {
      console.error(
        "Admin cancel subscription error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to cancel subscription."
      });
    }
  }
);

/* =========================================================
   ADMIN STATUS
========================================================= */

app.get(
  "/api/admin/status",
  requireAuthenticatedUser,
  requireAdmin,
  (req, res) => {
    res.json({
      success: true,

      admin:
        true,

      userId:
        req.userUid,

      configuredAdminUserId:
        ADMIN_USER_ID,

      videoProvider:
        "GaveAI",

      imageProvider:
        "GaveAI",

      imageModel:
        GAVEAI_IMAGE_MODEL,

      imageGenerationConfigured:
        !!(
          process.env
            .CLOUDFLARE_ACCOUNT_ID &&
          process.env
            .CLOUDFLARE_API_TOKEN
        ),

      imageKitConfigured:
        !!(
          process.env
            .IMAGEKIT_PUBLIC_KEY &&
          process.env
            .IMAGEKIT_PRIVATE_KEY &&
          process.env
            .IMAGEKIT_URL_ENDPOINT
        ),

      activeVideoGenerations,

      queuedVideoGenerations,

      maxConcurrentVideos:
        MAX_CONCURRENT_VIDEOS,

      maxVideoQueue:
        MAX_VIDEO_QUEUE
    });
  }
);

/* =========================================================
   404 HANDLER
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,

      error:
        "404 Not Found",

      path:
        req.originalUrl,

      method:
        req.method,

      message:
        `The requested route ${req.method} ${req.originalUrl} does not exist.`
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    if (
      error?.message ===
      "CORS origin not allowed."
    ) {
      return res.status(403).json({
        success: false,
        error:
          "Request origin is not allowed."
      });
    }

    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        success: false,
        error:
          "File is too large. Maximum size is 50 MB."
      });
    }

    res.status(500).json({
      success: false,
      error:
        "Gave Money Tips AI backend encountered an error."
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "============================================================"
    );

    console.log(
      "GAVEAI FINAL VIDEO + IMAGE + PAYMENT SYSTEM LOADED"
    );

    console.log(
      "VIDEO PROVIDER: GaveAI"
    );

    console.log(
      "IMAGE PROVIDER: GaveAI"
    );

    console.log(
      `IMAGE MODEL: ${GAVEAI_IMAGE_MODEL}`
    );

    console.log(
      `ADMIN USER ID: ${ADMIN_USER_ID}`
    );

    console.log(
      "FREE: 1 lifetime video"
    );

    console.log(
      "PRO: $9.99 / 1,000 credits / 30 days"
    );

    console.log(
      "PREMIUM: $19.99 / 1,500 credits / 30 days"
    );

    console.log(
      "5 seconds: 15 credits"
    );

    console.log(
      "8 seconds: 24 credits"
    );

    console.log(
      "NO DAILY CREDITS"
    );

    console.log(
      "NO 60 CREDITS/DAY"
    );

    console.log(
      "CREDITS DO NOT ROLLOVER AFTER EXPIRATION"
    );

    console.log(
      "TOP-UP: ADD PLAN CREDITS + NEW 30 DAYS"
    );

    console.log(
      "ADMIN VIDEO GENERATION: UNLIMITED"
    );

    console.log(
      "------------------------------------------------------------"
    );

    console.log(
      "IMAGE GENERATION: ENABLED"
    );

    console.log(
      "POST /generate-image"
    );

    console.log(
      "GET /api/image-generation-status"
    );

    console.log(
      "ACCOUNT API: ENABLED"
    );

    console.log(
      "GET /api/account"
    );

    console.log(
      "USER PAYMENT HISTORY: ENABLED"
    );

    console.log(
      "GET /api/payment-requests"
    );

    console.log(
      "RESUME UPLOAD: ENABLED"
    );

    console.log(
      "POST /upload-resume"
    );

    console.log(
      "PAYMENT BANK INFO: ENABLED"
    );

    console.log(
      "GET /api/payment-bank-info"
    );

    console.log(
      "PAYMENT SYSTEM STATUS: ENABLED"
    );

    console.log(
      "------------------------------------------------------------"
    );

    console.log(
      "PAYMENT TRASH SYSTEM: ENABLED"
    );

    console.log(
      "404 UNKNOWN ROUTES: ENABLED"
    );

    console.log(
      "GLOBAL ERROR HANDLER: ENABLED"
    );

    console.log(
      "POST /api/admin/payment-requests/:id/trash"
    );

    console.log(
      "POST /api/admin/payment-requests/:id/restore"
    );

    console.log(
      "POST /api/admin/payment-requests/batch-restore"
    );

    console.log(
      "GET /api/admin/payments?filter=trash"
    );

    console.log(
      "------------------------------------------------------------"
    );

    console.log(
      `Image generation configured: ${
        !!(
          process.env
            .CLOUDFLARE_ACCOUNT_ID &&
          process.env
            .CLOUDFLARE_API_TOKEN
        )
      }`
    );

    console.log(
      `ImageKit configured: ${
        !!(
          process.env
            .IMAGEKIT_PUBLIC_KEY &&
          process.env
            .IMAGEKIT_PRIVATE_KEY &&
          process.env
            .IMAGEKIT_URL_ENDPOINT
        )
      }`
    );

    console.log(
      "============================================================"
    );

    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );

    console.log(
      "Video Provider: GaveAI"
    );

    console.log(
      "Image Provider: GaveAI"
    );

    console.log(
      `Video Queue: ${MAX_CONCURRENT_VIDEOS} concurrent / ${MAX_VIDEO_QUEUE} queued`
    );
  }
);