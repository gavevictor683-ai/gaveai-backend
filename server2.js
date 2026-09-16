require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { generateAIResponse } = require("./backend/services/groqService");
const { transcribeAudio } = require("./backend/services/sttService");
const {
  getAudioUrl,
  normalizeLanguageCode
} = require("./backend/services/ttsService");

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

  if (plan === "pro") {
    return "pro";
  }

  if (plan === "premium") {
    return "premium";
  }

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
  if (!value) {
    return 0;
  }

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
  if (!value) {
    return null;
  }

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

  if (!plan) {
    return false;
  }

  const expiresAt =
    timestampToMillis(
      userData.subscriptionExpiresAt
    );

  if (!expiresAt) {
    return false;
  }

  return expiresAt > Date.now();
}

function getUserPlan(userData = {}) {
  const plan = normalizePlan(
    userData.subscriptionPlan ||
    userData.plan
  );

  if (!plan) {
    return null;
  }

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
      new Error(
        "CORS origin not allowed."
      )
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

app.use(
  cors(corsOptions)
);

app.options(
  /.*/,
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

      paymentSystem:
        "manual-bank-transfer",

      adminApprovalRequired:
        true,

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
        .verifyIdToken(
          idToken
        );

    if (
      !decodedToken?.uid
    ) {
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
    if (
      !isAdmin(
        req.userUid
      )
    ) {
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
   FIRESTORE USER HELPERS
========================================================= */

async function getUserDocument(
  userId
) {
  if (!userId) {
    return null;
  }

  const snapshot =
    await db
      .collection("users")
      .doc(userId)
      .get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data()
  };
}

async function getOrCreateUserDocument(
  userId
) {
  if (!userId) {
    throw new Error(
      "User ID is required."
    );
  }

  const ref =
    db
      .collection("users")
      .doc(userId);

  const snapshot =
    await ref.get();

  if (snapshot.exists) {
    return {
      ref,
      data: snapshot.data() || {}
    };
  }

  const now =
    admin.firestore.Timestamp.now();

  const initialData = {
    uid: userId,

    credits: 0,

    plan: null,

    subscriptionPlan: null,

    subscriptionExpiresAt: null,

    freeVideoUsed: false,

    freeVideoRemaining:
      FREE_VIDEO_COUNT,

    freeVideoAvailable: true,

    createdAt: now,

    updatedAt: now
  };

  await ref.set(
    initialData,
    {
      merge: true
    }
  );

  return {
    ref,
    data: initialData
  };
}

async function getUserCredits(
  userId
) {
  const userData =
    await getUserDocument(
      userId
    );

  if (!userData) {
    return 0;
  }

  return Math.max(
    0,
    safeNumber(
      userData.credits,
      0
    )
  );
}

async function uploadBufferToImageKit(
  buffer,
  fileName,
  folder
) {
  if (
    !buffer ||
    !Buffer.isBuffer(buffer)
  ) {
    throw new Error(
      "Upload buffer is required."
    );
  }

  if (!process.env.IMAGEKIT_PUBLIC_KEY ||
      !process.env.IMAGEKIT_PRIVATE_KEY ||
      !process.env.IMAGEKIT_URL_ENDPOINT) {
    throw new Error(
      "ImageKit is not configured."
    );
  }

  const result =
    await imagekit.upload({
      file: buffer,
      fileName,
      folder,
      useUniqueFileName: true
    });

  return {
    url: result.url,
    fileId: result.fileId || null,
    name: result.name || fileName,
    filePath:
      result.filePath || null
  };
}

/* =========================================================
   ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const userId =
        req.userUid;

      const userData =
        await getUserDocument(
          userId
        );

      if (!userData) {
        return res.json({
          success: true,

          user: {
            uid: userId,
            credits: 0,
            plan: null,
            subscriptionPlan: null,
            subscriptionExpiresAt: null,

            ...normalizeFreeVideoState({})
          }
        });
      }

      const freeState =
        normalizeFreeVideoState(
          userData
        );

      const activePlan =
        getUserPlan(
          userData
        );

      res.json({
        success: true,

        user: {
          ...userData,

          uid: userId,

          credits: Math.max(
            0,
            safeNumber(
              userData.credits,
              0
            )
          ),

          plan: activePlan,

          subscriptionPlan:
            activePlan,

          subscriptionExpiresAt:
            timestampToISO(
              userData.subscriptionExpiresAt
            ),

          freeVideoUsed:
            freeState.freeVideoUsed,

          freeVideoRemaining:
            freeState.freeVideoRemaining,

          freeVideoAvailable:
            freeState.freeVideoAvailable,

          isAdmin:
            isAdmin(userId)
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
   IMAGEKIT AUTHENTICATION
========================================================= */

app.get(
  "/api/imagekit-auth",
  requireAuthenticatedUser,
  (req, res) => {
    try {
      if (
        !process.env.IMAGEKIT_PRIVATE_KEY
      ) {
        return res.status(500).json({
          success: false,

          error:
            "ImageKit is not configured."
        });
      }

      const authenticationParameters =
        imagekit.getAuthenticationParameters();

      res.json({
        success: true,

        ...authenticationParameters
      });
    } catch (error) {
      console.error(
        "ImageKit auth error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to create ImageKit authentication parameters."
      });
    }
  }
);

/* =========================================================
   CHAT
========================================================= */

app.post(
  "/chat",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const userId =
        req.userUid;

      const message =
        String(
          req.body?.message ||
          req.body?.prompt ||
          ""
        ).trim();

      const imageUrl =
        req.body?.imageUrl ||
        null;

      if (!message) {
        return res.status(400).json({
          success: false,

          error:
            "Message is required."
        });
      }

      const conversation =
        Array.isArray(
          req.body?.conversation
        )
          ? req.body.conversation
          : [];

      const aiResult =
        await generateAIResponse(
          message,
          {
            userId,
            imageUrl,
            conversation
          }
        );

      const reply =
        typeof aiResult === "string"
          ? aiResult
          : aiResult?.reply ||
            aiResult?.response ||
            aiResult?.content ||
            aiResult?.message ||
            "";

      if (!reply) {
        throw new Error(
          "AI did not generate a response."
        );
      }

      res.json({
        success: true,

        reply,

        response: reply,

        message: reply
      });
    } catch (error) {
      console.error(
        "Chat error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "GaveAI could not generate a response. Please try again."
      });
    }
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
      const userId =
        req.userUid;

      const prompt =
        String(
          req.body?.prompt ||
          req.body?.description ||
          ""
        ).trim();

      if (!prompt) {
        return res.status(400).json({
          success: false,

          error:
            "Image prompt is required."
        });
      }

      const account =
        await getOrCreateUserDocument(
          userId
        );

      const userData =
        account.data || {};

      const isUserAdmin =
        isAdmin(userId);

      const credits =
        Math.max(
          0,
          safeNumber(
            userData.credits,
            0
          )
        );

      /*
       * Image generation is authenticated
       * through the Firebase ID token.
       *
       * Admin users are not charged.
       */

      const width =
        safeNumber(
          req.body?.width,
          1024
        );

      const height =
        safeNumber(
          req.body?.height,
          1024
        );

      const steps =
        safeNumber(
          req.body?.steps,
          4
        );

      const seed =
        safeNumber(
          req.body?.seed,
          Math.floor(
            Math.random() * 1000000000
          )
        );

      const accountId =
        process.env.CLOUDFLARE_ACCOUNT_ID;

      const apiToken =
        process.env.CLOUDFLARE_API_TOKEN;

      if (
        !accountId ||
        !apiToken
      ) {
        return res.status(500).json({
          success: false,

          error:
            "GaveAI image generation is not configured."
        });
      }

      const endpoint =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${GAVEAI_IMAGE_MODEL}`;

      const response =
        await axios.post(
          endpoint,
          {
            prompt,

            width,

            height,

            steps,

            seed
          },
          {
            headers: {
              Authorization:
                `Bearer ${apiToken}`,

              "Content-Type":
                "application/json"
            },

            responseType:
              "arraybuffer",

            timeout:
              120000
          }
        );

      const contentType =
        String(
          response.headers?.[
            "content-type"
          ] ||
          "image/png"
        );

      const imageBuffer =
        Buffer.from(
          response.data
        );

      if (
        !imageBuffer.length
      ) {
        throw new Error(
          "GaveAI image provider returned an empty image."
        );
      }

      let imageUrl = null;

      /*
       * Upload generated image to ImageKit
       * so the Blogger frontend receives a
       * persistent URL instead of a temporary
       * provider response.
       */

      try {
        const uploaded =
          await uploadBufferToImageKit(
            imageBuffer,

            `gaveai-image-${Date.now()}.png`,

            "/generated-images"
          );

        imageUrl =
          uploaded.url;
      } catch (uploadError) {
        console.error(
          "Generated image ImageKit upload error:",
          uploadError
        );

        /*
         * Fallback to a data URL so the
         * generated image is still returned.
         */

        imageUrl =
          `data:${contentType};base64,${imageBuffer.toString(
            "base64"
          )}`;
      }

      res.json({
        success: true,

        imageUrl,

        url: imageUrl,

        prompt,

        model:
          GAVEAI_IMAGE_MODEL,

        provider: "GaveAI",

        seed,

        width,

        height,

        credits:
          isUserAdmin
            ? credits
            : credits
      });
    } catch (error) {
      console.error(
        "Generate image error:",
        error?.response?.data ||
        error
      );

      let message =
        "GaveAI image generation failed. Please try again.";

      if (
        error?.response?.status === 401 ||
        error?.response?.status === 403
      ) {
        message =
          "GaveAI image generation authorization failed. Please try again.";
      }

      if (
        error?.response?.status === 404
      ) {
        message =
          "GaveAI image generation model is unavailable.";
      }

      res.status(
        error?.response?.status >= 400 &&
        error?.response?.status < 500
          ? error.response.status
          : 500
      ).json({
        success: false,

        error: message
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

      configured:
        !!(
          process.env.CLOUDFLARE_ACCOUNT_ID &&
          process.env.CLOUDFLARE_API_TOKEN
        ),

      model:
        GAVEAI_IMAGE_MODEL
    });
  }
);/* =========================================================
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
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },

          {
            merge: true
          }
        );

      res.json({
        success: true,
  }
);
      
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

          error:
            "File is required."
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

        folder
      });
    } catch (error) {
      console.error(
        "Generic media upload error:",
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
   RESUME UPLOAD
========================================================= */

app.post(
  "/upload-resume",
  requireAuthenticatedUser,
  upload.single("resume"),
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

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
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

        fileName:
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
   PAYMENT REQUEST HELPERS
========================================================= */

function normalizePaymentStatus(
  value
) {
  const status =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "pending",
      "approved",
      "rejected",
      "trash"
    ].includes(status)
  ) {
    return status;
  }

  return "pending";
}

function paymentStatusIsActive(
  status
) {
  return (
    status !== "trash"
  );
}

function paymentToClient(
  id,
  data = {}
) {
  const plan =
    normalizePlan(
      data.plan ||
      data.subscriptionPlan
    );

  const status =
    normalizePaymentStatus(
      data.status
    );

  return {
    id,

    uid:
      data.uid ||
      data.userId ||
      null,

    userId:
      data.userId ||
      data.uid ||
      null,

    email:
      data.email ||
      null,

    name:
      data.name ||
      data.displayName ||
      null,

    plan,

    price:
      safeNumber(
        data.amount ??
        data.price ??
        getPlanPrice(plan),
        0
      ),

    amount:
      safeNumber(
        data.amount ??
        data.price ??
        getPlanPrice(plan),
        0
      ),

    credits:
      safeNumber(
        data.credits ??
        getPlanCredits(plan),
        0
      ),

    durationDays:
      safeNumber(
        data.durationDays ??
        PLANS[plan]?.durationDays ??
        30,
        30
      ),

    status,

    reference:
      data.reference ||
      data.transactionId ||
      data.paymentReference ||
      null,

    receiptUrl:
      data.receiptUrl ||
      data.proofUrl ||
      data.imageUrl ||
      null,

    bankName:
      data.bankName ||
      BANK_INFO.bankName,

    accountHolder:
      data.accountHolder ||
      BANK_INFO.accountHolder,

    createdAt:
      timestampToISO(
        data.createdAt
      ),

    submittedAt:
      timestampToISO(
        data.submittedAt
      ),

    reviewedAt:
      timestampToISO(
        data.reviewedAt
      ),

    approvedAt:
      timestampToISO(
        data.approvedAt
      ),

    rejectedAt:
      timestampToISO(
        data.rejectedAt
      ),

    deleted:
      data.deleted === true
  };
}

/* =========================================================
   CREATE PAYMENT REQUEST
========================================================= */

app.post(
  "/api/payment-request",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const userId =
        req.userUid;

      const requestedPlan =
        normalizePlan(
          req.body?.plan
        );

      if (!requestedPlan) {
        return res.status(400).json({
          success: false,

          error:
            "A valid plan is required."
        });
      }

      const planInfo =
        PLANS[requestedPlan];

      const reference =
        String(
          req.body?.reference ||
          req.body?.transactionId ||
          ""
        ).trim();

      const receiptUrl =
        String(
          req.body?.receiptUrl ||
          req.body?.proofUrl ||
          ""
        ).trim();

      const now =
        admin.firestore.Timestamp.now();

      const paymentData = {
        uid: userId,

        userId,

        plan:
          requestedPlan,

        subscriptionPlan:
          requestedPlan,

        amount:
          planInfo.price,

        price:
          planInfo.price,

        credits:
          planInfo.credits,

        durationDays:
          planInfo.durationDays,

        status:
          "pending",

        reference:
          reference || null,

        transactionId:
          reference || null,

        receiptUrl:
          receiptUrl || null,

        deleted: false,

        createdAt:
          now,

        submittedAt:
          now,

        updatedAt:
          now
      };

      const paymentRef =
        await db
          .collection("paymentRequests")
          .add(
            paymentData
          );

      res.status(201).json({
        success: true,

        message:
          "Payment request submitted successfully.",

        payment:
          paymentToClient(
            paymentRef.id,
            paymentData
          )
      });
    } catch (error) {
      console.error(
        "Create payment request error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to submit payment request."
      });
    }
  }
);

/* =========================================================
   PAYMENT HISTORY
========================================================= */

app.get(
  "/api/payment-history",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const userId =
        req.userUid;

      const snapshot =
        await db
          .collection("paymentRequests")
          .where(
            "uid",
            "==",
            userId
          )
          .get();

      const payments =
        snapshot.docs
          .map((doc) =>
            paymentToClient(
              doc.id,
              doc.data()
            )
          )
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
);/* =========================================================
   ADMIN — PAYMENT REQUESTS
========================================================= */

app.get(
  "/api/admin/payment-requests",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const statusFilter =
        String(
          req.query?.status ||
          "all"
        )
          .trim()
          .toLowerCase();

      const snapshot =
        await db
          .collection("paymentRequests")
          .get();

      let payments =
        snapshot.docs.map(
          (doc) =>
            paymentToClient(
              doc.id,
              doc.data()
            )
        );

      if (
        statusFilter !== "all"
      ) {
        payments =
          payments.filter(
            (payment) =>
              payment.status ===
              statusFilter
          );
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

        payments,

        total:
          payments.length
      });
    } catch (error) {
      console.error(
        "Admin payment requests error:",
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
   ADMIN — ALL PAYMENTS
========================================================= */

app.get(
  "/api/admin/payments",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot =
        await db
          .collection("paymentRequests")
          .get();

      const payments =
        snapshot.docs
          .map(
            (doc) =>
              paymentToClient(
                doc.id,
                doc.data()
              )
          )
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

        payments,

        total:
          payments.length
      });
    } catch (error) {
      console.error(
        "Admin payments error:",
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
   ADMIN — APPROVE PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:paymentId/approve",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const paymentRef =
        db
          .collection("paymentRequests")
          .doc(paymentId);

      const result =
        await db.runTransaction(
          async (transaction) => {
            const paymentSnapshot =
              await transaction.get(
                paymentRef
              );

            if (
              !paymentSnapshot.exists
            ) {
              throw new Error(
                "PAYMENT_NOT_FOUND"
              );
            }

            const payment =
              paymentSnapshot.data() ||
              {};

            const currentStatus =
              normalizePaymentStatus(
                payment.status
              );

            if (
              currentStatus ===
              "approved"
            ) {
              return {
                alreadyApproved:
                  true,

                payment
              };
            }

            if (
              currentStatus ===
              "trash"
            ) {
              throw new Error(
                "PAYMENT_IN_TRASH"
              );
            }

            if (
              currentStatus ===
              "rejected"
            ) {
              throw new Error(
                "PAYMENT_ALREADY_REJECTED"
              );
            }

            const userId =
              payment.uid ||
              payment.userId;

            if (!userId) {
              throw new Error(
                "PAYMENT_USER_MISSING"
              );
            }

            const plan =
              normalizePlan(
                payment.plan ||
                payment.subscriptionPlan
              );

            if (!plan) {
              throw new Error(
                "PAYMENT_PLAN_INVALID"
              );
            }

            const planInfo =
              PLANS[plan];

            const userRef =
              db
                .collection("users")
                .doc(userId);

            const userSnapshot =
              await transaction.get(
                userRef
              );

            const userData =
              userSnapshot.exists
                ? userSnapshot.data() || {}
                : {};

            const existingCredits =
              Math.max(
                0,
                safeNumber(
                  userData.credits,
                  0
                )
              );

            const now =
              admin.firestore.Timestamp.now();

            const currentExpiry =
              timestampToMillis(
                userData.subscriptionExpiresAt
              );

            const baseDate =
              currentExpiry >
              Date.now()
                ? new Date(
                    currentExpiry
                  )
                : new Date();

            baseDate.setDate(
              baseDate.getDate() +
                planInfo.durationDays
            );

            const newExpiry =
              admin.firestore.Timestamp.fromDate(
                baseDate
              );

            const newCredits =
              existingCredits +
              planInfo.credits;

            transaction.set(
              userRef,
              {
                uid: userId,

                credits:
                  newCredits,

                plan,

                subscriptionPlan:
                  plan,

                subscriptionExpiresAt:
                  newExpiry,

                updatedAt:
                  now
              },
              {
                merge: true
              }
            );

            transaction.update(
              paymentRef,
              {
                status:
                  "approved",

                approvedAt:
                  now,

                reviewedAt:
                  now,

                reviewedBy:
                  req.userUid,

                updatedAt:
                  now,

                deleted: false
              }
            );

            return {
              alreadyApproved:
                false,

              payment: {
                ...payment,

                status:
                  "approved",

                creditsAdded:
                  planInfo.credits,

                totalCredits:
                  newCredits
              }
            };
          }
        );

      res.json({
        success: true,

        message:
          result.alreadyApproved
            ? "Payment was already approved."
            : "Payment approved successfully.",

        payment:
          paymentToClient(
            paymentId,
            result.payment
          )
      });
    } catch (error) {
      console.error(
        "Approve payment error:",
        error
      );

      const message =
        String(
          error?.message || ""
        );

      if (
        message ===
        "PAYMENT_NOT_FOUND"
      ) {
        return res.status(404).json({
          success: false,

          error:
            "Payment request not found."
        });
      }

      if (
        message ===
        "PAYMENT_IN_TRASH"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment is in trash and cannot be approved."
        });
      }

      if (
        message ===
        "PAYMENT_ALREADY_REJECTED"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "This payment has already been rejected."
        });
      }

      if (
        message ===
        "PAYMENT_USER_MISSING"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment user information is missing."
        });
      }

      if (
        message ===
        "PAYMENT_PLAN_INVALID"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment plan is invalid."
        });
      }

      res.status(500).json({
        success: false,

        error:
          "Unable to approve payment."
      });
    }
  }
);

/* =========================================================
   ADMIN — REJECT PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:paymentId/reject",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const paymentRef =
        db
          .collection("paymentRequests")
          .doc(paymentId);

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
        snapshot.data() || {};

      const status =
        normalizePaymentStatus(
          payment.status
        );

      if (
        status === "approved"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "An approved payment cannot be rejected."
        });
      }

      if (
        status === "trash"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment is already in trash."
        });
      }

      const now =
        admin.firestore.Timestamp.now();

      await paymentRef.update({
        status:
          "rejected",

        rejectedAt:
          now,

        reviewedAt:
          now,

        reviewedBy:
          req.userUid,

        updatedAt:
          now
      });

      res.json({
        success: true,

        message:
          "Payment rejected successfully."
      });
    } catch (error) {
      console.error(
        "Reject payment error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to reject payment."
      });
    }
  }
);

/* =========================================================
   ADMIN — MOVE PAYMENT TO TRASH
========================================================= */

app.post(
  "/api/admin/payment-requests/:paymentId/trash",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const paymentRef =
        db
          .collection("paymentRequests")
          .doc(paymentId);

      const snapshot =
        await paymentRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "Payment request not found."
        });
      }

      const now =
        admin.firestore.Timestamp.now();

      await paymentRef.update({
        status:
          "trash",

        deleted: true,

        deletedAt:
          now,

        deletedBy:
          req.userUid,

        updatedAt:
          now
      });

      res.json({
        success: true,

        message:
          "Payment moved to trash successfully."
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
   ADMIN — RESTORE PAYMENT
========================================================= */

app.post(
  "/api/admin/payment-requests/:paymentId/restore",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const paymentRef =
        db
          .collection("paymentRequests")
          .doc(paymentId);

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
        snapshot.data() || {};

      const currentStatus =
        normalizePaymentStatus(
          payment.status
        );

      const restoredStatus =
        payment.previousStatus &&
        [
          "pending",
          "approved",
          "rejected"
        ].includes(
          payment.previousStatus
        )
          ? payment.previousStatus
          : "pending";

      const now =
        admin.firestore.Timestamp.now();

      await paymentRef.update({
        status:
          currentStatus === "trash"
            ? restoredStatus
            : currentStatus,

        deleted: false,

        deletedAt:
          admin.firestore.FieldValue
            .delete(),

        deletedBy:
          admin.firestore.FieldValue
            .delete(),

        previousStatus:
          admin.firestore.FieldValue
            .delete(),

        updatedAt:
          now,

        restoredAt:
          now,

        restoredBy:
          req.userUid
      });

      res.json({
        success: true,

        message:
          "Payment restored successfully."
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
   ADMIN — PERMANENTLY DELETE PAYMENT
========================================================= */

app.delete(
  "/api/admin/payment-requests/:paymentId",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const paymentRef =
        db
          .collection("paymentRequests")
          .doc(paymentId);

      const snapshot =
        await paymentRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "Payment request not found."
        });
      }

      await paymentRef.delete();

      res.json({
        success: true,

        message:
          "Payment permanently deleted."
      });
    } catch (error) {
      console.error(
        "Delete payment error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to delete payment."
      });
    }
  }
);

/* =========================================================
   ADMIN — ADD CREDITS
========================================================= */

app.post(
  "/api/admin/users/:uid/add-credits",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUid =
        req.params.uid;

      const amount =
        safeNumber(
          req.body?.credits,
          0
        );

      if (
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Credits amount must be greater than zero."
        });
      }

      const userRef =
        db
          .collection("users")
          .doc(targetUid);

      const snapshot =
        await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User not found."
        });
      }

      const userData =
        snapshot.data() || {};

      const oldCredits =
        Math.max(
          0,
          safeNumber(
            userData.credits,
            0
          )
        );

      const newCredits =
        oldCredits +
        amount;

      await userRef.update({
        credits:
          newCredits,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      });

      res.json({
        success: true,

        message:
          "Credits added successfully.",

        uid:
          targetUid,

        previousCredits:
          oldCredits,

        addedCredits:
          amount,

        credits:
          newCredits
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
   ADMIN — REMOVE CREDITS
========================================================= */

app.post(
  "/api/admin/users/:uid/remove-credits",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUid =
        req.params.uid;

      const amount =
        safeNumber(
          req.body?.credits,
          0
        );

      if (
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Credits amount must be greater than zero."
        });
      }

      const userRef =
        db
          .collection("users")
          .doc(targetUid);

      const snapshot =
        await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User not found."
        });
      }

      const userData =
        snapshot.data() || {};

      const oldCredits =
        Math.max(
          0,
          safeNumber(
            userData.credits,
            0
          )
        );

      const newCredits =
        Math.max(
          0,
          oldCredits - amount
        );

      await userRef.update({
        credits:
          newCredits,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      });

      res.json({
        success: true,

        message:
          "Credits removed successfully.",

        uid:
          targetUid,

        previousCredits:
          oldCredits,

        removedCredits:
          amount,

        credits:
          newCredits
      });
    } catch (error) {
      console.error(
        "Admin remove credits error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to remove credits."
      });
    }
  }
);

/* =========================================================
   ADMIN — RESET FREE VIDEO
========================================================= */

app.post(
  "/api/admin/users/:uid/reset-free-video",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUid =
        req.params.uid;

      const userRef =
        db
          .collection("users")
          .doc(targetUid);

      const snapshot =
        await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User not found."
        });
      }

      await userRef.update({
        freeVideoUsed:
          false,

        freeVideoRemaining:
          FREE_VIDEO_COUNT,

        freeVideoAvailable:
          true,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      });

      res.json({
        success: true,

        message:
          "Lifetime free video has been reset."
      });
    } catch (error) {
      console.error(
        "Reset free video error:",
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
   ADMIN — ACTIVATE SUBSCRIPTION
========================================================= */

app.post(
  "/api/admin/users/:uid/activate-subscription",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUid =
        req.params.uid;

      const plan =
        normalizePlan(
          req.body?.plan
        );

      if (!plan) {
        return res.status(400).json({
          success: false,

          error:
            "A valid plan is required."
        });
      }

      const planInfo =
        PLANS[plan];

      const userRef =
        db
          .collection("users")
          .doc(targetUid);

      const snapshot =
        await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User not found."
        });
      }

      const userData =
        snapshot.data() || {};

      const oldCredits =
        Math.max(
          0,
          safeNumber(
            userData.credits,
            0
          )
        );

      const currentExpiry =
        timestampToMillis(
          userData.subscriptionExpiresAt
        );

      const baseDate =
        currentExpiry >
        Date.now()
          ? new Date(
              currentExpiry
            )
          : new Date();

      baseDate.setDate(
        baseDate.getDate() +
          planInfo.durationDays
      );

      const expiration =
        admin.firestore.Timestamp.fromDate(
          baseDate
        );

      const newCredits =
        oldCredits +
        planInfo.credits;

      await userRef.update({
        credits:
          newCredits,

        plan,

        subscriptionPlan:
          plan,

        subscriptionExpiresAt:
          expiration,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      });

      res.json({
        success: true,

        message:
          "Subscription activated successfully.",

        plan,

        credits:
          newCredits,

        subscriptionExpiresAt:
          expiration.toDate().toISOString()
      });
    } catch (error) {
      console.error(
        "Activate subscription error:",
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
   ADMIN — CANCEL SUBSCRIPTION
========================================================= */

app.post(
  "/api/admin/users/:uid/cancel-subscription",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUid =
        req.params.uid;

      const userRef =
        db
          .collection("users")
          .doc(targetUid);

      const snapshot =
        await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User not found."
        });
      }

      await userRef.update({
        plan: null,

        subscriptionPlan:
          null,

        subscriptionExpiresAt:
          null,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      });

      res.json({
        success: true,

        message:
          "Subscription cancelled successfully."
      });
    } catch (error) {
      console.error(
        "Cancel subscription error:",
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
  async (req, res) => {
    try {
      const adminUser =
        isAdmin(
          req.userUid
        );

      res.json({
        success: true,

        isAdmin:
          adminUser,

        uid:
          req.userUid
      });

    } catch (error) {
      console.error(
        "Admin status error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to check admin status."
      });
    }
  }
);

/* =========================================================
   STORYBOARD AUDIO HELPERS
========================================================= */

function normalizeStoryboardScenes(
  scenes
) {
  if (!Array.isArray(scenes)) {
    return [];
  }

  return scenes
    .map((scene, index) => {
      const current =
        scene || {};

      const duration =
        Number(current.duration) === 8
          ? 8
          : 5;

      return {
        id:
          current.id ||
          `scene-${index + 1}`,

        index,

        prompt:
          String(
            current.prompt ||
            ""
          ).trim(),

        duration,

        voice:
          String(
            current.voice ||
            ""
          ).trim(),

        dialogue:
          String(
            current.dialogue ||
            ""
          ).trim(),

        narration:
          String(
            current.narration ||
            ""
          ).trim(),

        music:
          String(
            current.music ||
            ""
          ).trim(),

        sfx:
          String(
            current.sfx ||
            ""
          ).trim(),

        ambience:
          String(
            current.ambience ||
            ""
          ).trim(),

        imageUrl:
          current.imageUrl ||
          current.image ||
          null,

        videoUrl:
          current.videoUrl ||
          current.video ||
          null,

        firstFrameImage:
          current.firstFrameImage ||
          null,

        continuityContext:
          String(
            current.continuityContext ||
            ""
          ).trim()
      };
    })
    .filter(
      (scene) =>
        scene.prompt ||
        scene.imageUrl ||
        scene.videoUrl ||
        scene.dialogue ||
        scene.narration ||
        scene.music ||
        scene.sfx ||
        scene.ambience
    );
}

/* =========================================================
   STORYBOARD CREDIT CALCULATION
========================================================= */

function calculateStoryboardCredits(
  scenes
) {
  const normalized =
    normalizeStoryboardScenes(
      scenes
    );

  return normalized.reduce(
    (total, scene) => {
      return (
        total +
        getVideoCreditCost(
          scene.duration
        )
      );
    },
    0
  );
}

/* =========================================================
   STORYBOARD CONTINUITY
========================================================= */

function buildStoryboardContinuity(
  scenes
) {
  const normalized =
    normalizeStoryboardScenes(
      scenes
    );

  let continuity = "";

  normalized.forEach(
    (scene, index) => {
      const sceneNumber =
        index + 1;

      const details = [
        `Scene ${sceneNumber}`,

        scene.prompt
          ? `Visual: ${scene.prompt}`
          : "",

        scene.voice
          ? `Voice: ${scene.voice}`
          : "",

        scene.dialogue
          ? `Dialogue: ${scene.dialogue}`
          : "",

        scene.narration
          ? `Narration: ${scene.narration}`
          : "",

        scene.music
          ? `Music: ${scene.music}`
          : "",

        scene.sfx
          ? `SFX: ${scene.sfx}`
          : "",

        scene.ambience
          ? `Ambience: ${scene.ambience}`
          : ""
      ]
        .filter(Boolean)
        .join("\n");

      continuity +=
        details +
        "\n\n";
    }
  );

  return continuity.trim();
}

/* =========================================================
   STORYBOARD AUDIO RENDERING
========================================================= */

async function renderStoryboardAudio(
  scenes,
  options = {}
) {
  const normalized =
    normalizeStoryboardScenes(
      scenes
    );

  if (!normalized.length) {
    return {
      scenes: [],
      audioFiles: [],
      cleanupFiles: []
    };
  }

  try {
    const rendered =
      await renderGaveAIAudioForScenes(
        normalized,
        {
          ...options
        }
      );

    return (
      rendered || {
        scenes: normalized,
        audioFiles: [],
        cleanupFiles: []
      }
    );
  } catch (error) {
    console.error(
      "Storyboard audio rendering error:",
      error
    );

    throw new Error(
      "GaveAI storyboard audio generation failed."
    );
  }
}

/* =========================================================
   VIDEO JOB HELPERS
========================================================= */

function getVideoJobCollection() {
  return db.collection(
    "videoJobs"
  );
}

function getVideoProductionCollection() {
  return db.collection(
    "videoProductions"
  );
}

function normalizeVideoStatus(
  value
) {
  const status =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "queued",
      "generating",
      "completed",
      "failed"
    ].includes(status)
  ) {
    return status;
  }

  return "queued";
}

function videoJobToClient(
  id,
  data = {}
) {
  return {
    id,

    userId:
      data.userId ||
      null,

    status:
      normalizeVideoStatus(
        data.status
      ),

    prompt:
      data.prompt ||
      "",

    duration:
      Number(
        data.duration
      ) === 8
        ? 8
        : 5,

    credits:
      safeNumber(
        data.credits,
        0
      ),

    provider:
      "GaveAI",

    videoUrl:
      data.videoUrl ||
      data.url ||
      null,

    thumbnailUrl:
      data.thumbnailUrl ||
      null,

    error:
      data.error ||
      null,

    createdAt:
      timestampToISO(
        data.createdAt
      ),

    startedAt:
      timestampToISO(
        data.startedAt
      ),

    completedAt:
      timestampToISO(
        data.completedAt
      ),

    failedAt:
      timestampToISO(
        data.failedAt
      )
  };
}

/* =========================================================
   VIDEO CREDIT / FREE VIDEO STATE
========================================================= */

async function reserveVideoCredits(
  userId,
  duration
) {
  const cost =
    getVideoCreditCost(
      duration
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

      const userData =
        snapshot.exists
          ? snapshot.data() || {}
          : {};

      const adminUser =
        isAdmin(userId);

      const freeState =
        normalizeFreeVideoState(
          userData
        );

      const credits =
        Math.max(
          0,
          safeNumber(
            userData.credits,
            0
          )
        );

      if (adminUser) {
        return {
          chargedCredits: 0,

          usedFreeVideo: false,

          remainingCredits:
            credits,

          freeVideoRemaining:
            freeState.freeVideoRemaining,

          isAdmin: true
        };
      }

      if (
        freeState.freeVideoAvailable
      ) {
        transaction.set(
          userRef,
          {
            freeVideoUsed:
              true,

            freeVideoRemaining:
              0,

            freeVideoAvailable:
              false,

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );

        return {
          chargedCredits: 0,

          usedFreeVideo: true,

          remainingCredits:
            credits,

          freeVideoRemaining: 0,

          isAdmin: false
        };
      }

      if (
        credits < cost
      ) {
        throw new Error(
          "INSUFFICIENT_CREDITS"
        );
      }

      const remainingCredits =
        credits - cost;

      transaction.set(
        userRef,
        {
          credits:
            remainingCredits,

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

      return {
        chargedCredits:
          cost,

        usedFreeVideo: false,

        remainingCredits,

        freeVideoRemaining:
          freeState.freeVideoRemaining,

        isAdmin: false
      };
    }
  );
}

/* =========================================================
   REFUND VIDEO CREDITS
========================================================= */

async function refundVideoCredits(
  userId,
  amount,
  usedFreeVideo
) {
  if (
    isAdmin(userId)
  ) {
    return;
  }

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

      const userData =
        snapshot.exists
          ? snapshot.data() || {}
          : {};

      const currentCredits =
        Math.max(
          0,
          safeNumber(
            userData.credits,
            0
          )
        );

      const updateData = {
        credits:
          currentCredits +
          Math.max(
            0,
            safeNumber(
              amount,
              0
            )
          ),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      };

      if (usedFreeVideo) {
        updateData.freeVideoUsed =
          false;

        updateData.freeVideoRemaining =
          FREE_VIDEO_COUNT;

        updateData.freeVideoAvailable =
          true;
      }

      transaction.set(
        userRef,
        updateData,
        {
          merge: true
        }
      );
    }
  );
}

/* =========================================================
   VIDEO QUEUE
========================================================= */

function canAcceptVideoJob() {
  return (
    queuedVideoGenerations <
    MAX_VIDEO_QUEUE
  );
}

function incrementVideoQueue() {
  queuedVideoGenerations += 1;
}

function decrementVideoQueue() {
  queuedVideoGenerations =
    Math.max(
      0,
      queuedVideoGenerations - 1
    );
}

function startVideoGenerationSlot() {
  activeVideoGenerations += 1;
}

function finishVideoGenerationSlot() {
  activeVideoGenerations =
    Math.max(
      0,
      activeVideoGenerations - 1
    );
}

/* =========================================================
   GAVEAI VIDEO PROVIDER CALL
========================================================= */

async function generateVideoWithProvider(
  options
) {
  try {
    const result =
      await generateWithGaveAIVideoProvider(
        options
      );

    if (!result) {
      throw new Error(
        "VIDEO_PROVIDER_EMPTY_RESULT"
      );
    }

    return result;
  } catch (error) {
    console.error(
      "GaveAI video provider error:",
      error
    );

    throw error;
  }
}

/* =========================================================
   VIDEO JOB PROCESSOR
========================================================= */

async function processVideoJob(
  jobId
) {
  const jobRef =
    getVideoJobCollection()
      .doc(jobId);

  let jobData = null;

  try {
    const snapshot =
      await jobRef.get();

    if (!snapshot.exists) {
      return;
    }

    jobData =
      snapshot.data() || {};

    const userId =
      jobData.userId;

    const duration =
      Number(
        jobData.duration
      ) === 8
        ? 8
        : 5;

    const chargedCredits =
      safeNumber(
        jobData.chargedCredits,
        0
      );

    const usedFreeVideo =
      jobData.usedFreeVideo ===
      true;

    await jobRef.set(
      {
        status:
          "generating",

        startedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      },
      {
        merge: true
      }
    );

    startVideoGenerationSlot();

    const providerResult =
      await generateVideoWithProvider(
        {
          prompt:
            jobData.prompt,

          width:
            safeNumber(
              jobData.width,
              832
            ),

          height:
            safeNumber(
              jobData.height,
              480
            ),

          duration,

          seed:
            safeNumber(
              jobData.seed,
              -1
            ),

          firstFrameImage:
            jobData.firstFrameImage ||
            null,

          userId,

          jobId,

          providerName:
            "GAVEAIproduction"
        }
      );

    const videoUrl =
      providerResult?.videoUrl ||
      providerResult?.url ||
      providerResult?.outputUrl ||
      providerResult?.output?.url ||
      null;

    if (!videoUrl) {
      throw new Error(
        "VIDEO_PROVIDER_EMPTY_RESULT"
      );
    }

    await jobRef.set(
      {
        status:
          "completed",

        provider:
          "GaveAI",

        videoUrl,

        completedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      },
      {
        merge: true
      }
    );

    await getVideoProductionCollection()
      .doc(jobId)
      .set(
        {
          ...jobData,

          status:
            "completed",

          provider:
            "GaveAI",

          videoUrl,

          completedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

  } catch (error) {
    console.error(
      "VIDEO JOB FAILED:",
      jobId,
      error
    );

    if (
      jobData
    ) {
      try {
        await refundVideoCredits(
          jobData.userId,
          jobData.chargedCredits,
          jobData.usedFreeVideo ===
            true
        );
      } catch (refundError) {
        console.error(
          "VIDEO CREDIT REFUND ERROR:",
          refundError
        );
      }
    }

    try {
      await jobRef.set(
        {
          status:
            "failed",

          error:
            genericVideoError(
              error
            ),

          failedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

      await getVideoProductionCollection()
        .doc(jobId)
        .set(
          {
            ...(jobData || {}),

            status:
              "failed",

            error:
              genericVideoError(
                error
              ),

            failedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
    } catch (saveError) {
      console.error(
        "VIDEO FAILURE SAVE ERROR:",
        saveError
      );
    }
  } finally {
    finishVideoGenerationSlot();
  }
}

/* =========================================================
   VIDEO QUEUE WORKER
========================================================= */

async function processQueuedVideoJobs() {
  if (
    activeVideoGenerations >=
    MAX_CONCURRENT_VIDEOS
  ) {
    return;
  }

  try {
    const snapshot =
      await getVideoJobCollection()
        .where(
          "status",
          "==",
          "queued"
        )
        .limit(
          Math.max(
            1,
            MAX_CONCURRENT_VIDEOS -
              activeVideoGenerations
          )
        )
        .get();

    if (
      snapshot.empty
    ) {
      return;
    }

    for (
      const doc of snapshot.docs
    ) {
      if (
        activeVideoGenerations >=
        MAX_CONCURRENT_VIDEOS
      ) {
        break;
      }

      const claimed =
        await db.runTransaction(
          async (transaction) => {
            const ref =
              getVideoJobCollection()
                .doc(doc.id);

            const current =
              await transaction.get(
                ref
              );

            if (
              !current.exists
            ) {
              return false;
            }

            const data =
              current.data() ||
              {};

            if (
              normalizeVideoStatus(
                data.status
              ) !== "queued"
            ) {
              return false;
            }

            transaction.set(
              ref,
              {
                status:
                  "generating",

                claimedAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp(),

                updatedAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp()
              },
              {
                merge: true
              }
            );

            return true;
          }
        );

      if (claimed) {
        processVideoJob(
          doc.id
        ).catch(
          (error) => {
            console.error(
              "Unhandled video worker error:",
              error
            );
          }
        );
      }
    }
  } catch (error) {
    console.error(
      "Video queue worker error:",
      error
    );
  }
}

setInterval(
  processQueuedVideoJobs,
  2000
);

/* =========================================================
   GENERATE VIDEO
========================================================= */

app.post(
  "/generate-video",
  requireAuthenticatedUser,
  async (req, res) => {
    let reservation = null;

    try {
      if (
        !canAcceptVideoJob()
      ) {
        return res.status(429).json({
          success: false,

          error:
            "GaveAI video generation queue is full. Please try again shortly."
        });
      }

      const userId =
        req.userUid;

      const prompt =
        String(
          req.body?.prompt ||
          ""
        ).trim();

      if (!prompt) {
        return res.status(400).json({
          success: false,

          error:
            "Video prompt is required."
        });
      }

      const duration =
        Number(
          req.body?.duration
        ) === 8
          ? 8
          : 5;

      const creditsRequired =
        getVideoCreditCost(
          duration
        );

      reservation =
        await reserveVideoCredits(
          userId,
          duration
        );

      incrementVideoQueue();

      const now =
        admin.firestore.Timestamp.now();

      const jobRef =
        getVideoJobCollection()
          .doc();

      const jobData = {
        userId,

        prompt,

        width:
          safeNumber(
            req.body?.width,
            832
          ),

        height:
          safeNumber(
            req.body?.height,
            480
          ),

        duration,

        seed:
          safeNumber(
            req.body?.seed,
            -1
          ),

        firstFrameImage:
          req.body?.firstFrameImage ||
          null,

        credits:
          creditsRequired,

        chargedCredits:
          reservation.chargedCredits,

        usedFreeVideo:
          reservation.usedFreeVideo,

        provider:
          "GaveAI",

        providerName:
          "GAVEAIproduction",

        status:
          "queued",

        createdAt:
          now,

        updatedAt:
          now
      };

      await jobRef.set(
        jobData
      );

      res.status(202).json({
        success: true,

        queued: true,

        jobId:
          jobRef.id,

        videoJobId:
          jobRef.id,

        status:
          "queued",

        provider:
          "GaveAI",

        message:
          "Your GaveAI video is being generated.",

        credits:
          reservation.remainingCredits,

        chargedCredits:
          reservation.chargedCredits,

        usedFreeVideo:
          reservation.usedFreeVideo,

        freeVideoRemaining:
          reservation.freeVideoRemaining
      });

    } catch (error) {
      console.error(
        "Generate video request error:",
        error
      );

      if (
        reservation
      ) {
        try {
          await refundVideoCredits(
            req.userUid,
            reservation.chargedCredits,
            reservation.usedFreeVideo
          );
        } catch (refundError) {
          console.error(
            "Generate video reservation refund error:",
            refundError
          );
        }
      }

      res.status(
        String(
          error?.message || ""
        ) ===
        "INSUFFICIENT_CREDITS"
          ? 402
          : 500
      ).json({
        success: false,

        error:
          genericVideoError(
            error
          )
      });
    }
  }
);/* =========================================================
   VIDEO JOB STATUS
========================================================= */

app.get(
  "/api/video-productions/:id",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const productionId =
        req.params.id;

      const jobRef =
        getVideoJobCollection()
          .doc(productionId);

      const snapshot =
        await jobRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,

          error:
            "Video production not found."
        });
      }

      const data =
        snapshot.data() || {};

      if (
        data.userId !==
          req.userUid &&
        !isAdmin(req.userUid)
      ) {
        return res.status(403).json({
          success: false,

          error:
            "You do not have access to this video production."
        });
      }

      res.json({
        success: true,

        production:
          videoJobToClient(
            snapshot.id,
            data
          )
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
   VIDEO JOBS FOR CURRENT USER
========================================================= */

app.get(
  "/api/video-productions",
  requireAuthenticatedUser,
  async (req, res) => {
    try {
      const userId =
        req.userUid;

      const snapshot =
        await getVideoJobCollection()
          .where(
            "userId",
            "==",
            userId
          )
          .limit(100)
          .get();

      const productions =
        snapshot.docs
          .map((doc) =>
            videoJobToClient(
              doc.id,
              doc.data()
            )
          )
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

        productions
      });
    } catch (error) {
      console.error(
        "User video productions error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to load your video productions."
      });
    }
  }
);

/* =========================================================
   ADMIN — VIDEO PRODUCTIONS
========================================================= */

app.get(
  "/api/admin/video-productions",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const statusFilter =
        String(
          req.query?.status ||
          "all"
        )
          .trim()
          .toLowerCase();

      const snapshot =
        await getVideoProductionCollection()
          .limit(500)
          .get();

      let productions =
        snapshot.docs.map(
          (doc) =>
            videoJobToClient(
              doc.id,
              doc.data()
            )
        );

      if (
        statusFilter !==
        "all"
      ) {
        productions =
          productions.filter(
            (item) =>
              item.status ===
              statusFilter
          );
      }

      productions.sort(
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

        productions,

        total:
          productions.length
      });
    } catch (error) {
      console.error(
        "Admin video productions error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to load video productions."
      });
    }
  }
);

/* =========================================================
   STORYBOARD — CREATE VIDEO JOB
========================================================= */

app.post(
  "/api/storyboard/generate",
  requireAuthenticatedUser,
  async (req, res) => {
    let reservation = null;

    let createdJobId = null;

    try {
      if (
        !canAcceptVideoJob()
      ) {
        return res.status(429).json({
          success: false,

          error:
            "GaveAI video generation queue is full. Please try again shortly."
        });
      }

      const userId =
        req.userUid;

      const storyOverview =
        String(
          req.body?.storyOverview ||
          req.body?.story ||
          ""
        ).trim();

      const mainCharacter =
        String(
          req.body?.mainCharacter ||
          ""
        ).trim();

      const supportingCharacters =
        String(
          req.body?.supportingCharacters ||
          ""
        ).trim();

      const visualStyle =
        String(
          req.body?.visualStyle ||
          ""
        ).trim();

      const environment =
        String(
          req.body?.environment ||
          ""
        ).trim();

      const cameraStyle =
        String(
          req.body?.cameraStyle ||
          ""
        ).trim();

      const globalAudioDirection =
        String(
          req.body?.globalAudioDirection ||
          ""
        ).trim();

      const scenes =
        normalizeStoryboardScenes(
          req.body?.scenes
        );

      if (
        !scenes.length
      ) {
        return res.status(400).json({
          success: false,

          error:
            "At least one storyboard scene is required."
        });
      }

      const totalCredits =
        calculateStoryboardCredits(
          scenes
        );

      const totalDuration =
        scenes.reduce(
          (total, scene) =>
            total +
            scene.duration,
          0
        );

      /*
       * Reserve the total storyboard
       * credits atomically.
       *
       * The lifetime free video applies
       * only when the storyboard contains
       * exactly one scene.
       */

      if (
        scenes.length === 1
      ) {
        reservation =
          await reserveVideoCredits(
            userId,
            scenes[0].duration
          );
      } else {
        const userRef =
          db
            .collection("users")
            .doc(userId);

        reservation =
          await db.runTransaction(
            async (transaction) => {
              const snapshot =
                await transaction.get(
                  userRef
                );

              const userData =
                snapshot.exists
                  ? snapshot.data() || {}
                  : {};

              const adminUser =
                isAdmin(userId);

              const credits =
                Math.max(
                  0,
                  safeNumber(
                    userData.credits,
                    0
                  )
                );

              if (adminUser) {
                return {
                  chargedCredits: 0,

                  usedFreeVideo: false,

                  remainingCredits:
                    credits,

                  freeVideoRemaining:
                    normalizeFreeVideoState(
                      userData
                    )
                      .freeVideoRemaining,

                  isAdmin: true
                };
              }

              if (
                credits <
                totalCredits
              ) {
                throw new Error(
                  "INSUFFICIENT_CREDITS"
                );
              }

              const remainingCredits =
                credits -
                totalCredits;

              transaction.set(
                userRef,
                {
                  credits:
                    remainingCredits,

                  updatedAt:
                    admin.firestore
                      .FieldValue
                      .serverTimestamp()
                },
                {
                  merge: true
                }
              );

              return {
                chargedCredits:
                  totalCredits,

                usedFreeVideo:
                  false,

                remainingCredits,

                freeVideoRemaining:
                  normalizeFreeVideoState(
                    userData
                  )
                    .freeVideoRemaining,

                isAdmin: false
              };
            }
          );
      }

      incrementVideoQueue();

      const now =
        admin.firestore.Timestamp.now();

      const storyboardId =
        `storyboard-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;

      const productionRef =
        getVideoProductionCollection()
          .doc(storyboardId);

      const productionData = {
        userId,

        type:
          "storyboard",

        storyboardId,

        storyOverview,

        mainCharacter,

        supportingCharacters,

        visualStyle,

        environment,

        cameraStyle,

        globalAudioDirection,

        scenes,

        totalScenes:
          scenes.length,

        totalDuration,

        totalCredits,

        chargedCredits:
          reservation.chargedCredits,

        usedFreeVideo:
          reservation.usedFreeVideo,

        provider:
          "GaveAI",

        status:
          "queued",

        createdAt:
          now,

        updatedAt:
          now
      };

      await productionRef.set(
        productionData
      );

      const jobRef =
        getVideoJobCollection()
          .doc(
            storyboardId
          );

      await jobRef.set({
        ...productionData,

        prompt:
          storyOverview ||
          scenes
            .map(
              (scene) =>
                scene.prompt
            )
            .filter(Boolean)
            .join("\n"),

        duration:
          totalDuration,

        credits:
          totalCredits,

        storyboard:
          true,

        status:
          "queued",

        audioRequested:
          scenes.some(
            (scene) =>
              scene.voice ||
              scene.dialogue ||
              scene.narration ||
              scene.music ||
              scene.sfx ||
              scene.ambience
          )
      });

      createdJobId =
        storyboardId;

      res.status(202).json({
        success: true,

        queued: true,

        storyboardId,

        jobId:
          storyboardId,

        videoJobId:
          storyboardId,

        status:
          "queued",

        provider:
          "GaveAI",

        totalScenes:
          scenes.length,

        totalDuration,

        totalCredits,

        chargedCredits:
          reservation.chargedCredits,

        usedFreeVideo:
          reservation.usedFreeVideo,

        credits:
          reservation.remainingCredits,

        freeVideoRemaining:
          reservation.freeVideoRemaining,

        continuity:
          buildStoryboardContinuity(
            scenes
          )
      });

      /*
       * Start storyboard processing
       * separately from the HTTP response.
       */
      processStoryboardJob(
        storyboardId
      ).catch(
        (error) => {
          console.error(
            "Storyboard worker error:",
            error
          );
        }
      );

    } catch (error) {
      console.error(
        "Storyboard generate error:",
        error
      );

      if (
        reservation
      ) {
        try {
          await refundVideoCredits(
            req.userUid,

            reservation.chargedCredits,

            reservation.usedFreeVideo
          );
        } catch (refundError) {
          console.error(
            "Storyboard refund error:",
            refundError
          );
        }
      }

      if (
        createdJobId
      ) {
        try {
          await getVideoJobCollection()
            .doc(createdJobId)
            .set(
              {
                status:
                  "failed",

                error:
                  genericVideoError(
                    error
                  ),

                updatedAt:
                  admin.firestore
                    .FieldValue
                    .serverTimestamp()
              },
              {
                merge: true
              }
            );
        } catch (saveError) {
          console.error(
            "Storyboard failure save error:",
            saveError
          );
        }
      }

      res.status(
        String(
          error?.message || ""
        ) ===
        "INSUFFICIENT_CREDITS"
          ? 402
          : 500
      ).json({
        success: false,

        error:
          genericVideoError(
            error
          )
      });
    }
  }
);

/* =========================================================
   STORYBOARD JOB PROCESSOR
========================================================= */

async function processStoryboardJob(
  storyboardId
) {
  const jobRef =
    getVideoJobCollection()
      .doc(
        storyboardId
      );

  let jobData = null;

  let audioResult = null;

  let cleanupPaths = [];

  try {
    const snapshot =
      await jobRef.get();

    if (!snapshot.exists) {
      decrementVideoQueue();

      return;
    }

    jobData =
      snapshot.data() || {};

    await jobRef.set(
      {
        status:
          "generating",

        startedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      },
      {
        merge: true
      }
    );

    await getVideoProductionCollection()
      .doc(storyboardId)
      .set(
        {
          status:
            "generating",

          startedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

    const scenes =
      normalizeStoryboardScenes(
        jobData.scenes
      );

    if (!scenes.length) {
      throw new Error(
        "STORYBOARD_SCENES_EMPTY"
      );
    }

    /*
     * Render requested scene audio on
     * the backend. This keeps dialogue,
     * narration, music, SFX and ambience
     * available for the final audiovisual
     * rendering instead of relying on the
     * browser.
     */

    const audioRequested =
      scenes.some(
        (scene) =>
          scene.voice ||
          scene.dialogue ||
          scene.narration ||
          scene.music ||
          scene.sfx ||
          scene.ambience
      );

    if (audioRequested) {
      audioResult =
        await renderStoryboardAudio(
          scenes,
          {
            userId:
              jobData.userId,

            storyboardId,

            storyOverview:
              jobData.storyOverview,

            globalAudioDirection:
              jobData.globalAudioDirection,

            mainCharacter:
              jobData.mainCharacter,

            visualStyle:
              jobData.visualStyle
          }
        );

      cleanupPaths =
        Array.isArray(
          audioResult?.cleanupFiles
        )
          ? audioResult.cleanupFiles
          : [];
    }

    /*
     * Generate each scene while preserving
     * the previous scene's continuity.
     */

    const generatedScenes = [];

    let previousSceneContext = "";

    for (
      let index = 0;
      index < scenes.length;
      index++
    ) {
      const scene =
        scenes[index];

      const continuity =
        [
          jobData.storyOverview
            ? `Story: ${jobData.storyOverview}`
            : "",

          jobData.mainCharacter
            ? `Main character: ${jobData.mainCharacter}`
            : "",

          jobData.supportingCharacters
            ? `Supporting characters: ${jobData.supportingCharacters}`
            : "",

          jobData.visualStyle
            ? `Visual style: ${jobData.visualStyle}`
            : "",

          jobData.environment
            ? `Environment: ${jobData.environment}`
            : "",

          jobData.cameraStyle
            ? `Camera style: ${jobData.cameraStyle}`
            : "",

          previousSceneContext
            ? `Previous scene continuity:\n${previousSceneContext}`
            : "",

          scene.continuityContext
            ? `Scene continuity:\n${scene.continuityContext}`
            : ""
        ]
          .filter(Boolean)
          .join("\n\n");

      const scenePrompt =
        [
          scene.prompt,

          continuity
            ? `Maintain this continuity:\n${continuity}`
            : ""
        ]
          .filter(Boolean)
          .join("\n\n");

      const sceneResult =
        await generateVideoWithProvider(
          {
            prompt:
              scenePrompt,

            width:
              safeNumber(
                jobData.width,
                832
              ),

            height:
              safeNumber(
                jobData.height,
                480
              ),

            duration:
              scene.duration,

            seed:
              safeNumber(
                jobData.seed,
                -1
              ),

            firstFrameImage:
              scene.firstFrameImage ||
              scene.imageUrl ||
              null,

            userId:
              jobData.userId,

            jobId:
              storyboardId,

            sceneId:
              scene.id,

            sceneIndex:
              index,

            providerName:
              "GAVEAIproduction"
          }
        );

      const sceneVideoUrl =
        sceneResult?.videoUrl ||
        sceneResult?.url ||
        sceneResult?.outputUrl ||
        sceneResult?.output?.url ||
        null;

      if (!sceneVideoUrl) {
        throw new Error(
          "STORYBOARD_SCENE_VIDEO_EMPTY"
        );
      }

      generatedScenes.push({
        ...scene,

        sceneIndex:
          index,

        videoUrl:
          sceneVideoUrl,

        audio:
          audioResult?.scenes?.[
            index
          ] || null
      });

      previousSceneContext =
        [
          scene.prompt,
          scene.dialogue,
          scene.narration
        ]
          .filter(Boolean)
          .join(" ");
    }

    /*
     * The provider-generated scene URLs
     * are preserved. The audio renderer's
     * output is attached to each scene so
     * the final render layer can mux it.
     */

    await jobRef.set(
      {
        scenes:
          generatedScenes,

        audio:
          audioResult || null,

        audioRequested,

        continuity:
          buildStoryboardContinuity(
            generatedScenes
          ),

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      },
      {
        merge: true
      }
    );

    await getVideoProductionCollection()
      .doc(storyboardId)
      .set(
        {
          scenes:
            generatedScenes,

          audio:
            audioResult || null,

          audioRequested,

          continuity:
            buildStoryboardContinuity(
              generatedScenes
            ),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

    /*
     * If the audio service exposes a
     * rendered final video, use it.
     * Otherwise preserve all generated
     * scene videos/audio metadata for the
     * frontend and downstream renderer.
     */

    const finalVideoUrl =
      audioResult?.finalVideoUrl ||
      audioResult?.videoUrl ||
      null;

    const completedData = {
      status:
        "completed",

      provider:
        "GaveAI",

      scenes:
        generatedScenes,

      audio:
        audioResult || null,

      audioRequested,

      finalVideoUrl,

      videoUrl:
        finalVideoUrl ||
        generatedScenes[0]?.videoUrl ||
        null,

      completedAt:
        admin.firestore
          .FieldValue
          .serverTimestamp(),

      updatedAt:
        admin.firestore
          .FieldValue
          .serverTimestamp()
    };

    await jobRef.set(
      completedData,
      {
        merge: true
      }
    );

    await getVideoProductionCollection()
      .doc(storyboardId)
      .set(
        completedData,
        {
          merge: true
        }
      );

  } catch (error) {
    console.error(
      "Storyboard job failed:",
      storyboardId,
      error
    );

    if (
      jobData
    ) {
      try {
        await refundVideoCredits(
          jobData.userId,

          jobData.chargedCredits,

          jobData.usedFreeVideo ===
            true
        );
      } catch (refundError) {
        console.error(
          "Storyboard credit refund failed:",
          refundError
        );
      }
    }

    const errorMessage =
      genericVideoError(
        error
      );

    try {
      await jobRef.set(
        {
          status:
            "failed",

          error:
            errorMessage,

          failedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

      await getVideoProductionCollection()
        .doc(storyboardId)
        .set(
          {
            status:
              "failed",

            error:
              errorMessage,

            failedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
    } catch (saveError) {
      console.error(
        "Storyboard failed-state save error:",
        saveError
      );
    }
  } finally {
    if (
      cleanupPaths.length
    ) {
      try {
        await cleanupAudioFiles(
          cleanupPaths
        );
      } catch (cleanupError) {
        console.error(
          "Storyboard audio cleanup error:",
          cleanupError
        );
      }
    }

    decrementVideoQueue();
  }
}        message:
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
            "Valid plan is required."
        });
      }

      const planData =
        PLANS[plan];

      const userRef =
        db
          .collection("users")
          .doc(
            req.params.uid
          );

      const snapshot =
        await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "User not found."
        });
      }

      const user =
        snapshot.data() || {};

      const currentCredits =
        Math.max(
          0,
          safeNumber(
            user.credits,
            0
          )
        );

      const currentExpiry =
        timestampToMillis(
          user.subscriptionExpiresAt
        );

      const baseDate =
        currentExpiry > Date.now()
          ? new Date(
              currentExpiry
            )
          : new Date();

      baseDate.setDate(
        baseDate.getDate() +
          planData.durationDays
      );

      const expiration =
        admin.firestore.Timestamp.fromDate(
          baseDate
        );

      await userRef.set(
        {
          credits:
            currentCredits +
            planData.credits,

          plan,

          subscriptionPlan:
            plan,

          subscriptionExpiresAt:
            expiration,

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
          "Subscription activated.",

        plan,

        credits:
          currentCredits +
          planData.credits,

        subscriptionExpiresAt:
          expiration
            .toDate()
            .toISOString()
      });
    } catch (error) {
      console.error(
        "Admin activate subscription error:",
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
      const ref =
        db
          .collection("users")
          .doc(
            req.params.uid
          );

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error:
            "User not found."
        });
      }

      await ref.set(
        {
          plan:
            null,

          subscriptionPlan:
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
   ADMIN OVERVIEW
========================================================= */

app.get(
  "/api/admin/overview",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const filter =
        String(
          req.query?.filter ||
          "all"
        )
          .trim()
          .toLowerCase();

      const validFilters = [
        "all",
        "admin",
        "pro",
        "premium",
        "active",
        "free"
      ];

      const normalizedFilter =
        validFilters.includes(
          filter
        )
          ? filter
          : "all";

      const [
        usersSnapshot,
        paymentsSnapshot,
        productionsSnapshot
      ] =
        await Promise.all([
          db
            .collection("users")
            .get(),

          db
            .collection(
              "paymentRequests"
            )
            .get(),

          db
            .collection(
              "videoProductions"
            )
            .get()
        ]);

      const allUsers =
        usersSnapshot.docs.map(
          (doc) => ({
            uid:
              doc.id,

            ...doc.data()
          })
        );

      const allPayments =
        paymentsSnapshot.docs.map(
          (doc) => ({
            id:
              doc.id,

            ...doc.data()
          })
        );

      const allProductions =
        productionsSnapshot.docs.map(
          (doc) => ({
            id:
              doc.id,

            ...doc.data()
          })
        );

      let users =
        [...allUsers];

      if (
        normalizedFilter ===
        "admin"
      ) {
        users =
          users.filter(
            (user) =>
              isAdmin(
                user.uid
              )
          );
      }

      if (
        normalizedFilter ===
        "pro"
      ) {
        users =
          users.filter(
            (user) =>
              normalizePlan(
                user.subscriptionPlan ||
                user.plan
              ) === "pro"
          );
      }

      if (
        normalizedFilter ===
        "premium"
      ) {
        users =
          users.filter(
            (user) =>
              normalizePlan(
                user.subscriptionPlan ||
                user.plan
              ) === "premium"
          );
      }

      if (
        normalizedFilter ===
        "active"
      ) {
        users =
          users.filter(
            (user) =>
              isSubscriptionActive(
                user
              )
          );
      }

      if (
        normalizedFilter ===
        "free"
      ) {
        users =
          users.filter(
            (user) =>
              !isSubscriptionActive(
                user
              )
          );
      }

      users.sort(
        (a, b) =>
          timestampToMillis(
            b.createdAt
          ) -
          timestampToMillis(
            a.createdAt
          )
      );

      const activePayments =
        allPayments.filter(
          (payment) =>
            payment.deleted !==
            true
        );

      const pendingPayments =
        activePayments.filter(
          (payment) =>
            normalizePaymentStatus(
              payment.status
            ) === "pending"
        );

      const approvedPayments =
        activePayments.filter(
          (payment) =>
            normalizePaymentStatus(
              payment.status
            ) === "approved"
        );

      const rejectedPayments =
        activePayments.filter(
          (payment) =>
            normalizePaymentStatus(
              payment.status
            ) === "rejected"
        );

      const trashPayments =
        allPayments.filter(
          (payment) =>
            payment.deleted ===
            true
        );

      const approvedRevenue =
        approvedPayments.reduce(
          (total, payment) =>
            total +
            safeNumber(
              payment.amount ??
              payment.price,
              0
            ),
          0
        );

      const pendingRevenue =
        pendingPayments.reduce(
          (total, payment) =>
            total +
            safeNumber(
              payment.amount ??
              payment.price,
              0
            ),
          0
        );

      const totalCredits =
        allUsers.reduce(
          (total, user) =>
            total +
            Math.max(
              0,
              safeNumber(
                user.credits,
                0
              )
            ),
          0
        );

      const proUsers =
        allUsers.filter(
          (user) =>
            normalizePlan(
              user.subscriptionPlan ||
              user.plan
            ) === "pro"
        ).length;

      const premiumUsers =
        allUsers.filter(
          (user) =>
            normalizePlan(
              user.subscriptionPlan ||
              user.plan
            ) === "premium"
        ).length;

      const activeSubscriptions =
        allUsers.filter(
          (user) =>
            isSubscriptionActive(
              user
            )
        ).length;

      const adminUsers =
        allUsers.filter(
          (user) =>
            isAdmin(
              user.uid
            )
        ).length;

      const freeVideosUsed =
        allUsers.filter(
          (user) =>
            user.freeVideoUsed ===
            true
        ).length;

      const queuedVideos =
        allProductions.filter(
          (production) =>
            normalizeVideoStatus(
              production.status
            ) === "queued"
        ).length;

      const generatingVideos =
        allProductions.filter(
          (production) =>
            normalizeVideoStatus(
              production.status
            ) === "generating"
        ).length;

      const completedVideos =
        allProductions.filter(
          (production) =>
            normalizeVideoStatus(
              production.status
            ) === "completed"
        ).length;

      const failedVideos =
        allProductions.filter(
          (production) =>
            normalizeVideoStatus(
              production.status
            ) === "failed"
        ).length;

      const totalVideoScenes =
        allProductions.reduce(
          (total, production) =>
            total +
            safeNumber(
              production.sceneCount,
              Array.isArray(
                production.scenes
              )
                ? production.scenes.length
                : 0
            ),
          0
        );

      const totalCreditsUsedForVideos =
        allProductions.reduce(
          (total, production) =>
            total +
            safeNumber(
              production.creditsUsed,
              0
            ),
          0
        );

      res.json({
        success: true,

        filter:
          normalizedFilter,

        overview: {
          totalUsers:
            allUsers.length,

          adminUsers,

          activeSubscriptions,

          proUsers,

          premiumUsers,

          totalCredits,

          totalPayments:
            allPayments.length,

          pendingPayments:
            pendingPayments.length,

          approvedPayments:
            approvedPayments.length,

          rejectedPayments:
            rejectedPayments.length,

          trashPayments:
            trashPayments.length,

          approvedRevenue,

          pendingRevenue,

          totalVideoProductions:
            allProductions.length,

          totalVideoScenes,

          totalCreditsUsedForVideos,

          freeVideosUsed,

          queuedVideos,

          generatingVideos,

          completedVideos,

          failedVideos
        },

        payments:
          activePayments
            .map(
              (payment) =>
                paymentToClient(
                  payment.id,
                  payment
                )
            )
            .sort(
              (a, b) =>
                timestampToMillis(
                  b.createdAt
                ) -
                timestampToMillis(
                  a.createdAt
                )
            )
            .slice(
              0,
              100
            ),

        users:
          users
            .map(
              (user) => ({
                uid:
                  user.uid,

                email:
                  user.email ||
                  null,

                displayName:
                  user.displayName ||
                  user.name ||
                  null,

                credits:
                  Math.max(
                    0,
                    safeNumber(
                      user.credits,
                      0
                    )
                  ),

                plan:
                  getUserPlan(
                    user
                  ),

                subscriptionPlan:
                  getUserPlan(
                    user
                  ),

                subscriptionExpiresAt:
                  timestampToISO(
                    user.subscriptionExpiresAt
                  ),

                freeVideoUsed:
                  user.freeVideoUsed ===
                  true,

                freeVideoRemaining:
                  normalizeFreeVideoState(
                    user
                  )
                    .freeVideoRemaining,

                isAdmin:
                  isAdmin(
                    user.uid
                  ),

                createdAt:
                  timestampToISO(
                    user.createdAt
                  )
              })
            ),

        videoProductions:
          allProductions
            .sort(
              (a, b) =>
                timestampToMillis(
                  b.createdAt
                ) -
                timestampToMillis(
                  a.createdAt
                )
            )
            .slice(
              0,
              100
            )
            .map(
              (production) => ({
                id:
                  production.id,

                userId:
                  production.userId ||
                  null,

                status:
                  normalizeVideoStatus(
                    production.status
                  ),

                provider:
                  "GaveAI",

                sceneCount:
                  safeNumber(
                    production.sceneCount,
                    Array.isArray(
                      production.scenes
                    )
                      ? production
                          .scenes
                          .length
                      : 0
                  ),

                creditsUsed:
                  safeNumber(
                    production.creditsUsed,
                    0
                  ),

                videoUrl:
                  production.videoUrl ||
                  null,

                createdAt:
                  timestampToISO(
                    production.createdAt
                  ),

                completedAt:
                  timestampToISO(
                    production.completedAt
                  )
              })
            )
      });
    } catch (error) {
      console.error(
        "Admin overview error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to load admin overview."
      });
    }
  }
);

/* =========================================================
   ADMIN USERS
========================================================= */

app.get(
  "/api/admin/users",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const filter =
        String(
          req.query?.filter ||
          "all"
        )
          .trim()
          .toLowerCase();

      const validFilters = [
        "all",
        "admin",
        "pro",
        "premium",
        "active",
        "free"
      ];

      const normalizedFilter =
        validFilters.includes(
          filter
        )
          ? filter
          : "all";

      const snapshot =
        await db
          .collection("users")
          .get();

      let users =
        snapshot.docs.map(
          (doc) => {
            const data =
              doc.data() || {};

            return {
              uid:
                doc.id,

              email:
                data.email ||
                null,

              displayName:
                data.displayName ||
                data.name ||
                null,

              photoURL:
                data.photoURL ||
                data.profilePhotoUrl ||
                null,

              credits:
                Math.max(
                  0,
                  safeNumber(
                    data.credits,
                    0
                  )
                ),

              plan:
                getUserPlan(
                  data
                ),

              subscriptionPlan:
                getUserPlan(
                  data
                ),

              subscriptionExpiresAt:
                timestampToISO(
                  data.subscriptionExpiresAt
                ),

              freeVideoUsed:
                data.freeVideoUsed ===
                true,

              freeVideoRemaining:
                normalizeFreeVideoState(
                  data
                )
                  .freeVideoRemaining,

              freeVideoAvailable:
                normalizeFreeVideoState(
                  data
                )
                  .freeVideoAvailable,

              isAdmin:
                isAdmin(
                  doc.id
                ),

              createdAt:
                timestampToISO(
                  data.createdAt
                ),

              updatedAt:
                timestampToISO(
                  data.updatedAt
                )
            };
          }
        );

      if (
        normalizedFilter ===
        "admin"
      ) {
        users =
          users.filter(
            (user) =>
              user.isAdmin
          );
      }

      if (
        normalizedFilter ===
        "pro"
      ) {
        users =
          users.filter(
            (user) =>
              user.plan ===
              "pro"
          );
      }

      if (
        normalizedFilter ===
        "premium"
      ) {
        users =
          users.filter(
            (user) =>
              user.plan ===
              "premium"
          );
      }

      if (
        normalizedFilter ===
        "active"
      ) {
        users =
          users.filter(
            (user) =>
              !!user.plan
          );
      }

      if (
        normalizedFilter ===
        "free"
      ) {
        users =
          users.filter(
            (user) =>
              !user.plan
          );
      }

      users.sort(
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

        filter:
          normalizedFilter,

        total:
          users.length,

        users
      });
    } catch (error) {
      console.error(
        "Admin users error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "Unable to load admin users."
      });
    }
  }
);

/* =========================================================
   VOICE MESSAGE
========================================================= */

app.post(
  "/api/voice/message",
  requireAuthenticatedUser,
  upload.single("audio"),
  async (req, res) => {
    try {
      const userId =
        req.userUid;

      const imageUrl =
        req.body?.imageUrl ||
        null;

      if (!req.file) {
        return res.status(400).json({
          success: false,

          error:
            "Audio file is required."
        });
      }

      const audioBuffer =
        req.file.buffer;

      if (
        !audioBuffer ||
        !audioBuffer.length
      ) {
        throw new Error(
          "Audio buffer is empty."
        );
      }

      /*
       * SPEECH → TEXT
       */

      const sttResult =
        await transcribeAudio(
          audioBuffer,

          req.file.mimetype,

          "voice-input.webm"
        );

      const transcript =
        String(
          sttResult?.transcript ||
          ""
        ).trim();

      const detectedLanguage =
        sttResult?.language ||
        "en";

      if (!transcript) {
        return res.status(400).json({
          success: false,

          error:
            "No speech was detected."
        });
      }

      /*
       * TEXT → AI
       */

      const aiResult =
        await generateAIResponse(
          transcript,
          {
            userId,

            imageUrl,

            conversation: [],

            language: detectedLanguage,

            detectedLanguage
          }
        );

      const reply =
        typeof aiResult ===
        "string"
          ? aiResult
          : aiResult?.reply ||
            aiResult?.response ||
            aiResult?.content ||
            aiResult?.message ||
            "";

      if (!reply) {
        throw new Error(
          "AI did not generate a response."
        );
      }

      /*
       * AI TEXT → BACKEND TTS
       *
       * No browser-only fallback.
       * If backend TTS fails, the endpoint
       * returns a clear error instead of
       * pretending voice generation succeeded.
       */

      let audioUrl =
        null;

      try {
        const normalizedLanguage =
          normalizeLanguageCode(
            detectedLanguage
          );

        audioUrl =
          await getAudioUrl(
            reply,

            normalizedLanguage
          );
      } catch (ttsError) {
        console.error(
          "GaveAI backend TTS generation failed:",
          ttsError
        );

        return res.status(502).json({
          success: false,

          stage:
            "tts",

          language:
            detectedLanguage,

          error:
            "GaveAI voice audio could not be generated. Please try again."
        });
      }

      if (!audioUrl) {
        return res.status(502).json({
          success: false,

          stage:
            "tts",

          language:
            detectedLanguage,

          error:
            "GaveAI voice audio could not be generated. Please try again."
        });
      }

      const userData =
        await getUserDocument(
          userId
        );

      const freeState =
        normalizeFreeVideoState(
          userData || {}
        );

      res.json({
        success: true,

        transcript,

        reply,

        response:
          reply,

        audioUrl,

        audio:
          audioUrl,

        language:
          detectedLanguage,

        detectedLanguage,

        freeVideoRemaining:
          freeState.freeVideoRemaining,

        freeVideoAvailable:
          freeState.freeVideoAvailable
      });
    } catch (error) {
      console.error(
        "Voice message error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          "GaveAI voice processing failed. Please try again."
      });
    }
  }
);/* =========================================================
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
      "ADMIN OVERVIEW: ENABLED"
    );

    console.log(
      "GET /api/admin/overview?filter=all"
    );

    console.log(
      "ADMIN USERS LIST: ENABLED"
    );

    console.log(
      "GET /api/admin/users?filter=all"
    );

    console.log(
      "VOICE PIPELINE: STT -> AI -> BACKEND TTS"
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


