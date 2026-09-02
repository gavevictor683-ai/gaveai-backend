require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");

const { generateAIResponse } = require("./services/groqService");

const {
  generateWithGaveAIVideoProvider
} = require("./services/gaveaiVideoProviderService");

const { db } = require("./firebaseAdmin");

const {
  requireAuth,
  requireAdmin
} = require("./middleware/authMiddleware");

const {
  checkAndDeductCredits,
  refundCredits,
  getVideoCreditCost,
  normalizeVideoDuration
} = require("./services/creditService");

/*
========================================================
EXPRESS APP
========================================================
*/

const app = express();

/*
========================================================
GAVEAI CREDIT SYSTEM
========================================================

FREE
--------------------------------------------------------
- 1 free video ONLY for lifetime of account
- No daily credits
- No daily reset
- No paid credits

PRO
--------------------------------------------------------
- $9.99 USD
- 1,000 credits
- 30 days
- 5 sec = 15 credits
- 8 sec = 24 credits

PREMIUM
--------------------------------------------------------
- $19.99 USD
- 1,500 credits
- 30 days
- 5 sec = 15 credits
- 8 sec = 24 credits

ADMIN
--------------------------------------------------------
- Unlimited video generation
- No credit deduction

IMPORTANT
--------------------------------------------------------
Credits field:

users/{userId}.credits

NOT:

creditBalance
========================================================
*/

/*
========================================================
CONFIGURATION
========================================================
*/

const PORT = Number(process.env.PORT) || 3000;

const MAX_VIDEO_PROMPTS = 20;

const MAX_UPLOAD_SIZE =
  50 * 1024 * 1024;

const GAVEAI_PROVIDER_NAME =
  "GAVEAIproduction";

/*
========================================================
PLANS
========================================================
*/

const PLAN_CONFIG = {
  pro: {
    price: 9.99,
    credits: 1000,
    creditLimit: 1000,
    durationDays: 30
  },

  premium: {
    price: 19.99,
    credits: 1500,
    creditLimit: 1500,
    durationDays: 30
  }
};

/*
========================================================
SOGEBANK PAYMENT INFORMATION
========================================================
*/

const GAVEAI_BANK_INFO = {
  bankName: "SOGEBANK",
  accountHolder: "Gave Victor",
  accountNumber: "2611111879",
  swiftBic: "SOGHHTPP",
  currency: "USD"
};

/*
========================================================
FILE UPLOAD
========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_UPLOAD_SIZE
  }
});

/*
========================================================
IMAGEKIT
========================================================
*/

const imagekit = new ImageKit({
  publicKey:
    process.env.IMAGEKIT_PUBLIC_KEY,

  privateKey:
    process.env.IMAGEKIT_PRIVATE_KEY,

  urlEndpoint:
    process.env.IMAGEKIT_URL_ENDPOINT
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

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error("CORS origin not allowed")
    );
  },

  methods: [
    "GET",
    "POST",
    "OPTIONS"
  ],

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

/*
========================================================
MANUAL CORS FALLBACK
========================================================
*/

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin &&
    allowedOrigins.includes(origin)
  ) {
    res.header(
      "Access-Control-Allow-Origin",
      origin
    );

    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

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

/*
========================================================
BODY PARSING
========================================================
*/

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

/*
========================================================
HELPER:
TIMESTAMP -> ISO
========================================================
*/

function timestampToISO(value) {
  if (!value) {
    return null;
  }

  let ms = 0;

  try {
    if (
      typeof value.toDate ===
      "function"
    ) {
      ms = value.toDate().getTime();
    } else if (
      value.seconds !== undefined
    ) {
      ms =
        Number(value.seconds) *
        1000;
    } else {
      const parsed =
        new Date(value).getTime();

      if (!Number.isNaN(parsed)) {
        ms = parsed;
      }
    }
  } catch (error) {
    return null;
  }

  return ms
    ? new Date(ms).toISOString()
    : null;
}

/*
========================================================
HELPER:
TIMESTAMP -> MILLISECONDS
========================================================
*/

function timestampToMs(value) {
  if (!value) {
    return null;
  }

  try {
    if (
      typeof value.toDate ===
      "function"
    ) {
      return value.toDate().getTime();
    }

    if (
      value.seconds !== undefined
    ) {
      return (
        Number(value.seconds) *
        1000
      );
    }

    const parsed =
      new Date(value).getTime();

    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  } catch (error) {
    return null;
  }

  return null;
}

/*
========================================================
HELPER:
FREE VIDEO STATE

ONE LIFETIME FREE VIDEO
========================================================
*/

function normalizeFreeVideoState(
  userData = {}
) {
  const hasRemaining =
    userData.freeVideoRemaining !==
      undefined &&
    userData.freeVideoRemaining !==
      null;

  const hasAvailable =
    userData.freeVideoAvailable !==
      undefined &&
    userData.freeVideoAvailable !==
      null;

  const hasUsed =
    userData.freeVideoUsed !==
      undefined &&
    userData.freeVideoUsed !==
      null;

  let remaining = hasRemaining
    ? Number(
        userData.freeVideoRemaining
      )
    : null;

  if (
    remaining === null ||
    !Number.isFinite(remaining) ||
    remaining < 0
  ) {
    remaining = null;
  }

  let available = null;

  if (hasAvailable) {
    available =
      userData.freeVideoAvailable ===
      true;
  }

  if (
    available === null &&
    remaining !== null
  ) {
    available =
      remaining > 0;
  }

  if (
    available === null &&
    hasUsed
  ) {
    available =
      userData.freeVideoUsed !== true;
  }

  /*
  Legacy users with no free-video
  fields get one lifetime free video.
  */
  if (available === null) {
    available = true;
  }

  if (remaining === null) {
    remaining = available ? 1 : 0;
  }

  if (!available) {
    remaining = 0;
  }

  return {
    freeVideoAvailable:
      available,

    freeVideoRemaining:
      remaining,

    freeVideoUsed:
      !available
  };
}

/*
========================================================
HELPER:
NORMALIZE PLAN
========================================================
*/

function normalizePlan(value) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}

/*
========================================================
HELPER:
GET EFFECTIVE SUBSCRIPTION
========================================================
*/

function getEffectiveSubscription(
  userData = {}
) {
  const storedPlan =
    normalizePlan(
      userData.subscriptionPlan ||
        userData.plan ||
        "free"
    );

  const expiresAtMs =
    timestampToMs(
      userData.subscriptionExpiresAt
    );

  const isPaidPlan =
    storedPlan === "pro" ||
    storedPlan === "premium";

  const isActive =
    isPaidPlan &&
    expiresAtMs !== null &&
    expiresAtMs > Date.now();

  return {
    storedPlan,
    effectivePlan: isActive
      ? storedPlan
      : "free",

    isActive,

    expiresAtMs
  };
}

/*
========================================================
HELPER:
GET PLAN CREDIT LIMIT
========================================================
*/

function getPlanCreditLimit(plan) {
  const normalizedPlan =
    normalizePlan(plan);

  if (
    normalizedPlan === "pro"
  ) {
    return 1000;
  }

  if (
    normalizedPlan === "premium"
  ) {
    return 1500;
  }

  return 0;
}

/*
========================================================
HEALTH CHECK
========================================================
*/

app.get("/", (req, res) => {
  res.json({
    success: true,

    message:
      "Gave Money Tips AI Backend is running 🚀",

    status: "online",

    provider:
      GAVEAI_PROVIDER_NAME
  });
});

/*
========================================================
ACCOUNT API
========================================================

GET /api/account

Returns the authenticated user's
current account information.

========================================================
*/

app.get(
  "/api/account",
  requireAuth,
  async (req, res) => {
    try {
      const userId =
        req.user.uid;

      const userRef =
        db.collection("users")
          .doc(userId);

      const userSnap =
        await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User account not found."
        });
      }

      const data =
        userSnap.data() || {};

      const subscription =
        getEffectiveSubscription(
          data
        );

      const freeVideoState =
        normalizeFreeVideoState(
          data
        );

      const credits = Math.max(
        Number(data.credits) || 0,
        0
      );

      const effectivePlan =
        subscription.effectivePlan;

      const creditLimit =
        getPlanCreditLimit(
          effectivePlan
        );

      return res.json({
        success: true,

        account: {
          id: userId,

          email:
            data.email ||
            req.user.email ||
            "",

          fullName:
            data.fullName ||
            data.name ||
            "",

          photoUrl:
            data.photoUrl ||
            data.photoURL ||
            "",

          plan:
            effectivePlan,

          subscriptionPlan:
            effectivePlan,

          subscriptionStatus:
            subscription.isActive
              ? "active"
              : "inactive",

          credits,

          creditLimit,

          freeVideoAvailable:
            freeVideoState.freeVideoAvailable,

          freeVideoRemaining:
            freeVideoState.freeVideoRemaining,

          freeVideoUsed:
            freeVideoState.freeVideoUsed,

          subscriptionStartedAtISO:
            timestampToISO(
              data.subscriptionStartedAt
            ),

          subscriptionExpiresAtISO:
            timestampToISO(
              data.subscriptionExpiresAt
            ),

          lastPaymentAmount:
            data.lastPaymentAmount ||
            null,

          lastPaymentRequestId:
            data.lastPaymentRequestId ||
            null,

          lastPaymentDateISO:
            timestampToISO(
              data.lastPaymentAt
            )
        }
      });
    } catch (error) {
      console.error(
        "ACCOUNT API ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Failed to load account."
      });
    }
  }
);

/*
========================================================
PAYMENT INFORMATION API
========================================================

Useful for account page.

GET /api/payment-info
========================================================
*/

app.get(
  "/api/payment-info",
  requireAuth,
  async (req, res) => {
    return res.json({
      success: true,

      bank: {
        bankName:
          GAVEAI_BANK_INFO.bankName,

        accountHolder:
          GAVEAI_BANK_INFO.accountHolder,

        accountNumber:
          GAVEAI_BANK_INFO.accountNumber,

        swiftBic:
          GAVEAI_BANK_INFO.swiftBic,

        currency:
          GAVEAI_BANK_INFO.currency
      },

      plans: {
        pro: {
          price:
            PLAN_CONFIG.pro.price,

          credits:
            PLAN_CONFIG.pro.credits,

          durationDays:
            PLAN_CONFIG.pro.durationDays
        },

        premium: {
          price:
            PLAN_CONFIG.premium.price,

          credits:
            PLAN_CONFIG.premium.credits,

          durationDays:
            PLAN_CONFIG.premium.durationDays
        }
      }
    });
  }
);

/*
========================================================
CREATE PAYMENT REQUEST
========================================================

POST /api/payment-requests

Authenticated users submit their
manual SOGEBANK payment.

========================================================
*/

app.post(
  "/api/payment-requests",
  requireAuth,
  async (req, res) => {
    try {
      const userId =
        req.user.uid;

      const {
        plan,
        amount,
        currency,
        bankName,
        accountHolderFullName,
        transactionDate,
        transactionTime,
        description,
        proofImageUrl
      } = req.body || {};

      const normalizedPlan =
        normalizePlan(plan);

      if (
        !PLAN_CONFIG[
          normalizedPlan
        ]
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Invalid subscription plan. Choose Pro or Premium."
        });
      }

      const planConfig =
        PLAN_CONFIG[
          normalizedPlan
        ];

      const submittedAmount =
        Number(amount);

      if (
        !Number.isFinite(
          submittedAmount
        )
      ) {
        return res.status(400).json({
          success: false,

          error:
            "A valid payment amount is required."
        });
      }

      if (
        Math.abs(
          submittedAmount -
            planConfig.price
        ) > 0.01
      ) {
        return res.status(400).json({
          success: false,

          error:
            `The amount for ${normalizedPlan} must be $${planConfig.price.toFixed(2)} USD.`
        });
      }

      const normalizedCurrency =
        String(
          currency || ""
        )
          .trim()
          .toUpperCase();

      if (
        normalizedCurrency !==
        "USD"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "GaveAI payments must be made in USD."
        });
      }

      if (
        String(bankName || "")
          .trim()
          .toUpperCase() !==
        "SOGEBANK"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment must be made to the configured SOGEBANK account."
        });
      }

      if (
        !String(
          accountHolderFullName || ""
        ).trim()
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Account holder full name is required."
        });
      }

      if (
        !String(
          transactionDate || ""
        ).trim()
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Transaction date is required."
        });
      }

      if (
        !String(
          transactionTime || ""
        ).trim()
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Transaction time is required."
        });
      }

      if (
        !String(
          proofImageUrl || ""
        ).trim()
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment proof image is required."
        });
      }

      const userRef =
        db.collection("users")
          .doc(userId);

      const userSnap =
        await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,

          error:
            "User account not found."
        });
      }

      const userData =
        userSnap.data() || {};

      const userEmail =
        userData.email ||
        req.user.email ||
        "";

      const userName =
        userData.fullName ||
        userData.name ||
        "";

      /*
      ----------------------------------------------------
      PREVENT MULTIPLE PENDING REQUESTS
      ----------------------------------------------------
      */

      const pendingSnap =
        await db
          .collection(
            "paymentRequests"
          )
          .where(
            "userId",
            "==",
            userId
          )
          .get();

      let existingPending =
        false;

      pendingSnap.forEach(
        (doc) => {
          const payment =
            doc.data() || {};

          if (
            String(
              payment.status || ""
            )
              .trim()
              .toLowerCase() ===
            "pending"
          ) {
            existingPending =
              true;
          }
        }
      );

      if (existingPending) {
        return res.status(409).json({
          success: false,

          error:
            "You already have a pending payment request. Please wait for admin approval."
        });
      }

      const now =
        new Date();

      const paymentRef =
        await db
          .collection(
            "paymentRequests"
          )
          .add({
            userId,

            userEmail,

            userName,

            plan:
              normalizedPlan,

            amount:
              planConfig.price,

            currency:
              "USD",

            bankName:
              "SOGEBANK",

            accountHolderFullName:
              String(
                accountHolderFullName
              ).trim(),

            transactionDate:
              String(
                transactionDate
              ).trim(),

            transactionTime:
              String(
                transactionTime
              ).trim(),

            description:
              String(
                description || ""
              ).trim(),

            proofImageUrl:
              String(
                proofImageUrl
              ).trim(),

            status:
              "pending",

            createdAt:
              now,

            updatedAt:
              now
          });

      console.log(
        "PAYMENT REQUEST CREATED:",
        paymentRef.id
      );

      return res.status(201).json({
        success: true,

        message:
          "Payment request submitted successfully. Please wait for admin approval.",

        paymentId:
          paymentRef.id,

        status:
          "pending"
      });
    } catch (error) {
      console.error(
        "PAYMENT REQUEST ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Failed to submit payment request."
      });
    }
  }
);

/*
========================================================
UPLOAD PAYMENT PROOF
========================================================

POST /upload-payment-proof

The account page can upload a payment
screenshot/proof here before submitting
/api/payment-requests.

========================================================
*/

app.post(
  "/upload-payment-proof",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const uploadedFile =
        req.file ||
        req.files?.file;

      if (!uploadedFile) {
        return res.status(400).json({
          success: false,

          error:
            "No payment proof file uploaded."
        });
      }

      const validTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp"
      ];

      if (
        !validTypes.includes(
          uploadedFile.mimetype
        )
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment proof must be a JPG, JPEG, PNG, or WEBP image."
        });
      }

      const result =
        await imagekit.upload({
          file:
            uploadedFile.buffer,

          fileName:
            uploadedFile.originalname,

          folder:
            "gavemoneytips/payment-proofs"
        });

      if (
        !result ||
        !result.url
      ) {
        throw new Error(
          "ImageKit did not return a payment proof URL."
        );
      }

      return res.json({
        success: true,

        url:
          result.url,

        proofImageUrl:
          result.url
      });
    } catch (error) {
      console.error(
        "PAYMENT PROOF UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Payment proof upload failed."
      });
    }
  }
);

/*
========================================================
CHAT
========================================================
*/

app.post(
  "/chat",
  async (req, res) => {
    try {
      const userMessage =
        typeof req.body?.message ===
        "string"
          ? req.body.message.trim()
          : "";

      if (!userMessage) {
        return res.status(400).json({
          success: false,

          error:
            "Message is required."
        });
      }

      let aiReply = "";

      let webSearchUsed =
        false;

      let webSources = [];

      const result =
        await generateAIResponse(
          userMessage
        );

      if (
        typeof result ===
        "string"
      ) {
        aiReply =
          result;
      } else {
        aiReply =
          result?.reply ||
          result?.message ||
          "";

        webSearchUsed =
          Boolean(
            result?.webSearchUsed
          );

        webSources =
          Array.isArray(
            result?.sources
          )
            ? result.sources
            : [];
      }

      if (
        typeof aiReply !==
        "string"
      ) {
        aiReply =
          String(
            aiReply ?? ""
          );
      }

      /*
      ----------------------------------------------------
      CLEAN AI RESPONSE
      ----------------------------------------------------
      */

      aiReply = aiReply
        .replace(/\*\*\*/g, "")
        .replace(/\*\*/g, "")
        .replace(/##/g, "")
        .replace(/#/g, "")
        .replace(/```/g, "");

      /*
      ----------------------------------------------------
      HAITIAN CREOLE CORRECTIONS
      ----------------------------------------------------
      */

      const corrections = {
        "resime": "rezime",
        "ekperyans": "eksperyans",
        "metÃƒÂ¨": "mete",
        "MetÃƒÂ¨": "Mete",
        "organize": "òganize",
        "Organize": "Òganize",
        "kli": "klè",
        "Exanp": "Egzanp",
        "exanp": "egzanp",
        "aspect": "aspè",
        "marche": "mache",
        "Pwoprye": "Premyèman",
        "pwoprye": "premyèman",
        "Voici": "Men",
        "voici": "men",
        "katogori": "kategori",
        "produkto": "pwodwi",
        "prodiktivite": "pwodiktivite",
        "biro": "biwo",
        "let": "lèt",
        "tak": "tach",
        "ekzamp": "egzanp",
        "konple": "konplè",
        "karvyÃƒÂ¨": "karyè",
        "rasamble": "rasanble",
        "Rasamble": "Rasanble",
        "objatif": "objektif",
        "objatif ou": "objektif ou",
        "vÃƒÂ¨fye": "verifye",
        "VÃƒÂ¨fye": "Verifye",
        "vÃƒÂ¨ifye": "verifye",
        "VÃƒÂ¨ifye": "Verifye",
        "ekspÃƒÂ¨yans": "eksperyans",
        "komense": "kòmanse",
        "fe": "fè",
        "rekrute": "rekritè",
        "aktyÃƒÂ¨l aktivite": "aktivite",
        "aktyÃƒÂ¨l konpetans": "konpetans",
        "aktyÃƒÂ¨l travay": "travay",
        "fonksyÃƒÂ²nÃƒÂ¨l": "fonksyonèl",
        "konvenab": "ki pi bon",
        "edite": "modifye",
        "pwodikte": "pwodiktivite"
      };

      for (
        const [wrong, correct]
        of Object.entries(
          corrections
        )
      ) {
        aiReply =
          aiReply.replaceAll(
            wrong,
            correct
          );
      }

      /*
      ----------------------------------------------------
      SAFE WEB SOURCES
      ----------------------------------------------------
      */

      const safeSources =
        Array.isArray(
          webSources
        )
          ? webSources
          : [];

      return res.json({
        success: true,

        reply:
          aiReply,

        webSearchUsed,

        sources:
          safeSources.map(
            (source) => ({
              title:
                source?.title ||
                "",

              url:
                source?.url ||
                "",

              provider:
                source?.provider ||
                "",

              official:
                Boolean(
                  source?.official
                )
            })
          )
      });
    } catch (error) {
      console.error(
        "GROQ ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "AI request failed."
      });
    }
  }
);

/*
========================================================
UPLOAD GENERATED VIDEO TO IMAGEKIT
========================================================
*/

async function uploadGeneratedVideoToImageKit(
  filePath,
  productionId
) {
  if (!filePath) {
    throw new Error(
      "Generated video file path is missing."
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(
      "Generated video file does not exist."
    );
  }

  const fileBuffer =
    fs.readFileSync(
      filePath
    );

  if (
    !fileBuffer ||
    fileBuffer.length === 0
  ) {
    throw new Error(
      "Generated video file is empty."
    );
  }

  const fileName =
    `gaveai-production-${productionId || Date.now()}.mp4`;

  console.log(
    "========================================"
  );

  console.log(
    "IMAGEKIT VIDEO UPLOAD STARTED"
  );

  console.log(
    "FILE:",
    filePath
  );

  console.log(
    "FILE SIZE:",
    fileBuffer.length
  );

  console.log(
    "========================================"
  );

  const result =
    await imagekit.upload({
      file:
        fileBuffer,

      fileName,

      folder:
        "gavemoneytips/generated-videos"
    });

  if (
    !result ||
    !result.url
  ) {
    throw new Error(
      "ImageKit did not return a public video URL."
    );
  }

  console.log(
    "========================================"
  );

  console.log(
    "IMAGEKIT VIDEO UPLOAD SUCCESS"
  );

  console.log(
    "PUBLIC VIDEO URL:",
    result.url
  );

  console.log(
    "========================================"
  );

  return {
    url:
      result.url,

    fileId:
      result.fileId || null,

    filePath:
      result.filePath || null,

    name:
      result.name ||
      fileName
  };
}

/*
========================================================
DELETE LOCAL VIDEO FILE
========================================================
*/

function deleteLocalVideoFile(
  filePath
) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(
        filePath
      );

      console.log(
        "LOCAL VIDEO DELETED:",
        filePath
      );
    }
  } catch (error) {
    console.warn(
      "VIDEO DELETE WARNING:",
      error?.message ||
        error
    );
  }
}

/*
========================================================
DELETE ALL GENERATED CLIPS
========================================================
*/

function cleanupGeneratedClips(
  clips
) {
  if (
    !Array.isArray(clips)
  ) {
    return;
  }

  for (
    const clip of clips
  ) {
    if (
      clip?.videoFile
    ) {
      deleteLocalVideoFile(
        clip.videoFile
      );
    }
  }
}

/*
========================================================
CALCULATE TOTAL VIDEO CREDIT COST
========================================================

5 seconds = 15 credits
8 seconds = 24 credits
========================================================
*/

function calculateProductionCreditCost(
  prompts,
  duration
) {
  const normalizedDuration =
    normalizeVideoDuration(
      duration
    );

  const costPerClip =
    getVideoCreditCost(
      normalizedDuration
    );

  const clipCount =
    Array.isArray(prompts)
      ? prompts.length
      : 0;

  if (
    clipCount <= 0
  ) {
    return 0;
  }

  return (
    costPerClip *
    clipCount
  );
}

/*
========================================================
GAVEAI VIDEO PRODUCTION
========================================================
*/

async function generateGaveAIVideoProduction(
  prompts,
  options = {}
) {
  if (
    !Array.isArray(prompts) ||
    prompts.length === 0
  ) {
    throw new Error(
      "At least one video prompt is required."
    );
  }

  const clips = [];

  let firstGeneratedVideo =
    null;

  const productionId =
    `gaveai-${Date.now()}`;

  const normalizedDuration =
    normalizeVideoDuration(
      options.duration
    );

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO PRODUCTION STARTED"
  );

  console.log(
    "PROVIDER:",
    GAVEAI_PROVIDER_NAME
  );

  console.log(
    "PRODUCTION ID:",
    productionId
  );

  console.log(
    "TOTAL CLIPS:",
    prompts.length
  );

  console.log(
    "DURATION:",
    normalizedDuration
  );

  console.log(
    "COST PER CLIP:",
    getVideoCreditCost(
      normalizedDuration
    )
  );

  console.log(
    "TOTAL CREDIT COST:",
    calculateProductionCreditCost(
      prompts,
      normalizedDuration
    )
  );

  console.log(
    "========================================"
  );

  try {
    for (
      let i = 0;
      i < prompts.length;
      i++
    ) {
      const currentPrompt =
        prompts[i];

      console.log(
        "========================================"
      );

      console.log(
        "GAVEAI CLIP GENERATION"
      );

      console.log(
        "CLIP:",
        `${i + 1}/${prompts.length}`
      );

      console.log(
        "PROMPT:",
        currentPrompt
      );

      console.log(
        "DURATION:",
        normalizedDuration
      );

      console.log(
        "========================================"
      );

      const clipFirstFrame =
        i === 0
          ? options.firstFrameImage
          : undefined;

      const result =
        await generateWithGaveAIVideoProvider({
          prompt:
            currentPrompt,

          firstFrameImage:
            clipFirstFrame,

          subjectReference:
            options.subjectReference,

          width:
            options.width || 832,

          height:
            options.height || 480,

          duration:
            normalizedDuration,

          seed:
            options.seed,

          negativePrompt:
            options.negativePrompt,

          resolution:
            options.resolution
        });

      if (
        !result ||
        !result.success ||
        !result.videoFile
      ) {
        throw new Error(
          `GAVEAIproduction video clip ${i + 1} failed.`
        );
      }

      if (
        !firstGeneratedVideo
      ) {
        firstGeneratedVideo =
          result;
      }

      clips.push({
        index:
          i + 1,

        prompt:
          currentPrompt,

        videoFile:
          result.videoFile,

        videoUrl:
          result.videoUrl ||
          null,

        outputUrl:
          result.outputUrl ||
          null,

        provider:
          GAVEAI_PROVIDER_NAME,

        model:
          result.model ||
          null,

        predictionId:
          result.predictionId ||
          null,

        duration:
          result.duration ||
          normalizedDuration,

        width:
          result.width ||
          options.width ||
          832,

        height:
          result.height ||
          options.height ||
          480
      });

      console.log(
        "GAVEAI CLIP COMPLETED:",
        `${i + 1}/${prompts.length}`
      );
    }

    console.log(
      "========================================"
    );

    console.log(
      "GAVEAI VIDEO PRODUCTION SUCCESS"
    );

    console.log(
      "PROVIDER:",
      GAVEAI_PROVIDER_NAME
    );

    console.log(
      "PRODUCTION ID:",
      productionId
    );

    console.log(
      "CLIPS GENERATED:",
      clips.length
    );

    console.log(
      "========================================"
    );

    return {
      success:
        true,

      provider:
        GAVEAI_PROVIDER_NAME,

      model:
        firstGeneratedVideo?.model ||
        null,

      productionId,

      clips,

      videoFile:
        firstGeneratedVideo?.videoFile ||
        null
    };
  } catch (error) {
    console.error(
      "GAVEAI VIDEO PRODUCTION ERROR:",
      error
    );

    cleanupGeneratedClips(
      clips
    );

    throw error;
  }
}

/*
========================================================
GENERATE VIDEO
========================================================
*/

app.post(
  "/generate-video",
  async (req, res) => {
    let userId = "";

    let creditResult =
      null;

    let genResult =
      null;

    let creditsRefunded =
      false;

    try {
      /*
      ==================================================
      USER ID
      ==================================================
      */

      userId =
        typeof req.body?.userId ===
        "string"
          ? req.body.userId.trim()
          : "";

      /*
      ==================================================
      SINGLE PROMPT
      ==================================================
      */

      let prompt =
        typeof req.body?.prompt ===
        "string"
          ? req.body.prompt.trim()
          : "";

      /*
      ==================================================
      SUPPORT MESSAGE
      ==================================================
      */

      if (
        !prompt &&
        typeof req.body?.message ===
          "string"
      ) {
        prompt =
          req.body.message
            .replace(
              /^\/?generate-video\s*/i,
              ""
            )
            .trim();
      }

      /*
      ==================================================
      MULTIPLE PROMPTS
      ==================================================
      */

      let prompts = [];

      if (
        Array.isArray(
          req.body?.prompts
        ) &&
        req.body.prompts.length > 0
      ) {
        prompts =
          req.body.prompts
            .filter(
              (item) =>
                typeof item ===
                  "string" &&
                item.trim()
            )
            .map(
              (item) =>
                item.trim()
            );
      }

      /*
      ==================================================
      IF NO PROMPTS ARRAY
      ==================================================
      */

      if (
        prompts.length === 0 &&
        prompt
      ) {
        prompts = [
          prompt
        ];
      }

      /*
      ==================================================
      VALIDATION
      ==================================================
      */

      if (
        prompts.length === 0
      ) {
        return res.status(400).json({
          success: false,

          error:
            "At least one video prompt is required."
        });
      }

      if (
        prompts.length >
        MAX_VIDEO_PROMPTS
      ) {
        return res.status(400).json({
          success: false,

          error:
            `A maximum of ${MAX_VIDEO_PROMPTS} video clips can be generated in one production.`
        });
      }

      /*
      ==================================================
      FIRST FRAME
      ==================================================
      */

      const firstFrameImage =
        typeof req.body?.firstFrameImage ===
        "string"
          ? req.body.firstFrameImage.trim()
          : undefined;

      /*
      ==================================================
      SUBJECT REFERENCE
      ==================================================
      */

      const subjectReference =
        typeof req.body?.subjectReference ===
        "string"
          ? req.body.subjectReference.trim()
          : undefined;

      /*
      ==================================================
      VIDEO OPTIONS
      ==================================================
      */

      let duration;

      try {
        duration =
          normalizeVideoDuration(
            req.body?.duration
          );
      } catch (
        durationError
      ) {
        return res.status(400).json({
          success: false,

          error:
            durationError?.message ||
            "Only 5-second and 8-second videos are supported."
        });
      }

      const width =
        Number(
          req.body?.width
        ) || 832;

      const height =
        Number(
          req.body?.height
        ) || 480;

      const seed =
        req.body?.seed;

      const negativePrompt =
        typeof req.body?.negativePrompt ===
        "string"
          ? req.body.negativePrompt.trim()
          : undefined;

      const resolution =
        typeof req.body?.resolution ===
        "string"
          ? req.body.resolution.trim()
          : undefined;

      /*
      ==================================================
      CREDIT COST
      ==================================================
      */

      const creditCost =
        calculateProductionCreditCost(
          prompts,
          duration
        );

      const costPerClip =
        getVideoCreditCost(
          duration
        );

      /*
      ==================================================
      ADMIN / OWNER
      ==================================================
      */

      const adminUserId =
        process.env.ADMIN_USER_ID
          ? process.env.ADMIN_USER_ID.trim()
          : "";

      const ownerUser =
        Boolean(
          userId &&
          adminUserId &&
          userId ===
            adminUserId
        );

      /*
      ==================================================
      LOG REQUEST
      ==================================================
      */

      console.log(
        "========================================"
      );

      console.log(
        "GENERATE VIDEO REQUEST"
      );

      console.log(
        "PROVIDER:",
        GAVEAI_PROVIDER_NAME
      );

      console.log(
        "USER ID:",
        userId ||
          "anonymous"
      );

      console.log(
        "OWNER / ADMIN:",
        ownerUser
      );

      console.log(
        "TOTAL PROMPTS:",
        prompts.length
      );

      console.log(
        "FIRST FRAME:",
        Boolean(
          firstFrameImage
        )
      );

      console.log(
        "SUBJECT REFERENCE:",
        Boolean(
          subjectReference
        )
      );

      console.log(
        "WIDTH:",
        width
      );

      console.log(
        "HEIGHT:",
        height
      );

      console.log(
        "DURATION:",
        duration
      );

      console.log(
        "COST PER CLIP:",
        costPerClip
      );

      console.log(
        "TOTAL CREDIT COST:",
        creditCost
      );

      console.log(
        "========================================"
      );

      /*
      ==================================================
      OWNER / ADMIN
      ==================================================
      */

      if (ownerUser) {
        console.log(
          "VIDEO GENERATION: OWNER/ADMIN - UNLIMITED"
        );

        genResult =
          await generateGaveAIVideoProduction(
            prompts,
            {
              firstFrameImage,

              subjectReference,

              width,

              height,

              duration,

              seed,

              negativePrompt,

              resolution
            }
          );

        if (
          !genResult ||
          !genResult.success
        ) {
          return res.status(500).json({
            success: false,

            error:
              "Video production failed.",

            productionId:
              genResult?.productionId ||
              null
          });
        }

        let uploadedVideo;

        try {
          uploadedVideo =
            await uploadGeneratedVideoToImageKit(
              genResult.videoFile,
              genResult.productionId
            );
        } catch (
          uploadError
        ) {
          console.error(
            "IMAGEKIT GENERATED VIDEO UPLOAD ERROR:",
            uploadError
          );

          cleanupGeneratedClips(
            genResult.clips
          );

          return res.status(500).json({
            success: false,

            error:
              "Video was generated, but uploading the final video failed.",

            details:
              uploadError?.message ||
              "ImageKit upload failed."
          });
        }

        cleanupGeneratedClips(
          genResult.clips
        );

        return res.json({
          success:
            true,

          reply:
            "Video generated successfully!",

          generatedMedia: {
            type:
              "video",

            url:
              uploadedVideo.url,

            downloadUrl:
              uploadedVideo.url,

            productionId:
              genResult.productionId,

            clips:
              genResult.clips,

            provider:
              GAVEAI_PROVIDER_NAME,

            model:
              genResult.model
          },

          creditsDeducted:
            0,

          newCredits:
            null,

          unlimited:
            true,

          isAdmin:
            true
        });
      }

      /*
      ==================================================
      REGULAR USER
      ==================================================
      */

      if (!userId) {
        return res.status(401).json({
          success: false,

          error:
            "User ID is required to generate a video."
        });
      }

      /*
      ==================================================
      CHECK + DEDUCT CREDITS
      ==================================================
      */

      try {
        creditResult =
          await checkAndDeductCredits(
            userId,
            creditCost
          );

        console.log(
          "VIDEO CREDIT CHECK SUCCESS"
        );

        console.log(
          "CREDIT SOURCE:",
          creditResult?.creditSource
        );

        console.log(
          "PLAN:",
          creditResult?.plan ||
            "free"
        );

        console.log(
          "CREDITS DEDUCTED:",
          creditResult?.creditsDeducted ||
            0
        );

        console.log(
          "PREVIOUS CREDITS:",
          creditResult?.previousCredits
        );

        console.log(
          "NEW CREDITS:",
          creditResult?.newCredits
        );
      } catch (
        creditError
      ) {
        console.error(
          "VIDEO CREDIT ERROR:",
          creditError
        );

        if (
          creditError?.message ===
          "FREE_VIDEO_ALREADY_USED"
        ) {
          return res.status(402).json({
            success: false,

            error:
              "FREE_VIDEO_ALREADY_USED",

            message:
              "Your lifetime free video has already been used.",

            freeVideoAvailable:
              false
          });
        }

        if (
          creditError?.message ===
          "INSUFFICIENT_VIDEO_CREDITS"
        ) {
          return res.status(402).json({
            success: false,

            error:
              "INSUFFICIENT_VIDEO_CREDITS",

            message:
              "You do not have enough video credits.",

            requiredCredits:
              creditError.requiredCredits,

            currentCredits:
              creditError.currentCredits,

            plan:
              creditError.plan ||
              null
          });
        }

        if (
          creditError?.message ===
          "User account not found."
        ) {
          return res.status(404).json({
            success: false,

            error:
              "User account was not found."
          });
        }

        return res.status(500).json({
          success: false,

          error:
            "Unable to process video credits.",

          details:
            creditError?.message ||
            "Credit system error."
        });
      }

      /*
      ==================================================
      GENERATE VIDEO
      ==================================================
      */

      try {
        genResult =
          await generateGaveAIVideoProduction(
            prompts,
            {
              firstFrameImage,

              subjectReference,

              width,

              height,

              duration,

              seed,

              negativePrompt,

              resolution
            }
          );
      } catch (
        generationError
      ) {
        console.error(
          "GAVEAI VIDEO GENERATION ERROR:",
          generationError
        );

        if (
          userId &&
          creditResult &&
          !creditsRefunded
        ) {
          try {
            const refundAmount =
              creditResult?.creditSource ===
              "subscription"
                ? creditResult?.creditsDeducted ||
                  0
                : 0;

            if (
              refundAmount > 0
            ) {
              const refundResult =
                await refundCredits(
                  userId,
                  refundAmount
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            } else if (
              creditResult?.creditSource ===
              "free_video"
            ) {
              const refundResult =
                await refundCredits(
                  userId,
                  0
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            }
          } catch (
            refundError
          ) {
            console.error(
              "VIDEO CREDIT REFUND ERROR:",
              refundError
            );
          }
        }

        return res.status(500).json({
          success: false,

          error:
            generationError?.message ||
            "Video production failed.",

          creditsRefunded
        });
      }

      /*
      ==================================================
      GENERATION FAILED
      ==================================================
      */

      if (
        !genResult ||
        !genResult.success
      ) {
        if (
          userId &&
          creditResult &&
          !creditsRefunded
        ) {
          try {
            const refundAmount =
              creditResult?.creditSource ===
              "subscription"
                ? creditResult?.creditsDeducted ||
                  0
                : 0;

            if (
              refundAmount > 0
            ) {
              const refundResult =
                await refundCredits(
                  userId,
                  refundAmount
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            } else if (
              creditResult?.creditSource ===
              "free_video"
            ) {
              const refundResult =
                await refundCredits(
                  userId,
                  0
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            }
          } catch (
            refundError
          ) {
            console.error(
              "GENERATION FAILURE REFUND ERROR:",
              refundError
            );
          }
        }

        cleanupGeneratedClips(
          genResult?.clips
        );

        return res.status(500).json({
          success: false,

          error:
            genResult?.message ||
            "Video production failed.",

          productionId:
            genResult?.productionId ||
            null,

          failedClip:
            genResult?.failedClip ||
            null,

          creditsRefunded
        });
      }

      /*
      ==================================================
      IMAGEKIT UPLOAD
      ==================================================
      */

      let uploadedVideo;

      try {
        uploadedVideo =
          await uploadGeneratedVideoToImageKit(
            genResult.videoFile,
            genResult.productionId
          );
      } catch (
        uploadError
      ) {
        console.error(
          "IMAGEKIT GENERATED VIDEO UPLOAD ERROR:",
          uploadError
        );

        if (
          userId &&
          creditResult &&
          !creditsRefunded
        ) {
          try {
            const refundAmount =
              creditResult?.creditSource ===
              "subscription"
                ? creditResult?.creditsDeducted ||
                  0
                : 0;

            if (
              refundAmount > 0
            ) {
              const refundResult =
                await refundCredits(
                  userId,
                  refundAmount
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            } else if (
              creditResult?.creditSource ===
              "free_video"
            ) {
              const refundResult =
                await refundCredits(
                  userId,
                  0
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            }
          } catch (
            refundError
          ) {
            console.error(
              "IMAGEKIT REFUND ERROR:",
              refundError
            );
          }
        }

        cleanupGeneratedClips(
          genResult.clips
        );

        return res.status(500).json({
          success: false,

          error:
            "Video was generated, but uploading the final video failed.",

          details:
            uploadError?.message ||
            "ImageKit upload failed.",

          creditsRefunded
        });
      }

      /*
      ==================================================
      DELETE LOCAL VIDEO FILES
      ==================================================
      */

      cleanupGeneratedClips(
        genResult.clips
      );

      /*
      ==================================================
      FINAL RESPONSE
      ==================================================
      */

      return res.json({
        success:
          true,

        reply:
          "Video generated successfully!",

        generatedMedia: {
          type:
            "video",

          url:
            uploadedVideo.url,

          downloadUrl:
            uploadedVideo.url,

          productionId:
            genResult.productionId,

          clips:
            genResult.clips,

          provider:
            GAVEAI_PROVIDER_NAME,

          model:
            genResult.model
        },

        creditsDeducted:
          creditResult?.creditsDeducted ||
          0,

        newCredits:
          creditResult?.newCredits ??
          null,

        creditSource:
          creditResult?.creditSource ||
          null,

        plan:
          creditResult?.plan ||
          "free",

        freeVideoUsed:
          creditResult?.freeVideoUsed ??
          false
      });
    } catch (error) {
      console.error(
        "GENERATE VIDEO ERROR:",
        error
      );

      if (
        userId &&
        creditResult &&
        !creditsRefunded
      ) {
        try {
          const refundAmount =
            creditResult?.creditSource ===
            "subscription"
              ? creditResult?.creditsDeducted ||
                0
              : 0;

          if (
            refundAmount > 0
          ) {
            const refundResult =
              await refundCredits(
                userId,
                refundAmount
              );

            creditsRefunded =
              Boolean(
                refundResult?.success
              );
          } else if (
            creditResult?.creditSource ===
            "free_video"
          ) {
            const refundResult =
              await refundCredits(
                userId,
                0
              );

            creditsRefunded =
              Boolean(
                refundResult?.success
              );
          }
        } catch (
          refundError
        ) {
          console.error(
            "SAFETY REFUND ERROR:",
            refundError
          );
        }
      }

      cleanupGeneratedClips(
        genResult?.clips
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Video generation failed.",

        creditsRefunded
      });
    }
  }
);

/*
========================================================
UPLOAD PROFILE PHOTO
========================================================
*/

app.post(
  "/upload-profile",
  upload.single("file"),
  async (req, res) => {
    try {
      const uploadedFile =
        req.file ||
        req.files?.file;

      if (!uploadedFile) {
        return res.status(400).json({
          success: false,

          error:
            "No profile photo uploaded."
        });
      }

      const validTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp"
      ];

      if (
        !validTypes.includes(
          uploadedFile.mimetype
        )
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Only JPG, JPEG, PNG, and WEBP files are allowed for profile photos."
        });
      }

      const result =
        await imagekit.upload({
          file:
            uploadedFile.buffer,

          fileName:
            uploadedFile.originalname,

          folder:
            "gavemoneytips/profile-photos"
        });

      const photoUrl =
        result.url;

      const userId =
        typeof req.body.userId ===
        "string"
          ? req.body.userId.trim()
          : "";

      if (userId) {
        await db
          .collection("users")
          .doc(userId)
          .set(
            {
              photoUrl
            },
            {
              merge: true
            }
          );
      }

      return res.json({
        success:
          true,

        url:
          photoUrl,

        photoUrl,

        savedToFirestore:
          Boolean(userId)
      });
    } catch (error) {
      console.error(
        "PROFILE PHOTO ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Profile photo upload failed."
      });
    }
  }
);

/*
========================================================
UPLOAD RESUME
========================================================
*/

app.post(
  "/upload-resume",
  upload.any(),
  async (req, res) => {
    try {
      const uploadedFile =
        req.file ||
        (
          req.files &&
          req.files[0]
        );

      if (!uploadedFile) {
        return res.status(400).json({
          success: false,

          error:
            "No resume uploaded."
        });
      }

      const result =
        await imagekit.upload({
          file:
            uploadedFile.buffer,

          fileName:
            uploadedFile.originalname,

          folder:
            "gavemoneytips/resumes"
        });

      const resumeURL =
        result.url;

      const userId =
        typeof req.body.userId ===
        "string"
          ? req.body.userId.trim()
          : "";

      if (userId) {
        await db
          .collection("users")
          .doc(userId)
          .set(
            {
              resumeURL
            },
            {
              merge: true
            }
          );
      }

      return res.json({
        success:
          true,

        url:
          resumeURL,

        resumeURL,

        savedToFirestore:
          Boolean(userId)
      });
    } catch (error) {
      console.error(
        "RESUME UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Resume upload failed."
      });
    }
  }
);

/*
========================================================
UPLOAD COVER LETTER
========================================================
*/

app.post(
  "/upload-cover-letter",
  upload.any(),
  async (req, res) => {
    try {
      const uploadedFile =
        req.file ||
        (
          req.files &&
          req.files[0]
        );

      if (!uploadedFile) {
        return res.status(400).json({
          success: false,

          error:
            "No cover letter uploaded."
        });
      }

      const result =
        await imagekit.upload({
          file:
            uploadedFile.buffer,

          fileName:
            uploadedFile.originalname,

          folder:
            "gavemoneytips/cover-letters"
        });

      const coverLetterURL =
        result.url;

      const userId =
        typeof req.body.userId ===
        "string"
          ? req.body.userId.trim()
          : "";

      if (userId) {
        await db
          .collection("users")
          .doc(userId)
          .set(
            {
              coverLetterURL
            },
            {
              merge: true
            }
          );
      }

      return res.json({
        success:
          true,

        url:
          coverLetterURL,

        coverLetterURL,

        savedToFirestore:
          Boolean(userId)
      });
    } catch (error) {
      console.error(
        "COVER LETTER ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Cover letter upload failed."
      });
    }
  }
);

/*
========================================================
UPLOAD CERTIFICATE
========================================================
*/

app.post(
  "/upload-certificate",
  upload.any(),
  async (req, res) => {
    try {
      const uploadedFile =
        req.file ||
        (
          req.files &&
          req.files[0]
        );

      if (!uploadedFile) {
        return res.status(400).json({
          success: false,

          error:
            "No certificate PDF uploaded."
        });
      }

      const result =
        await imagekit.upload({
          file:
            uploadedFile.buffer,

          fileName:
            uploadedFile.originalname,

          folder:
            "gavemoneytips/certificates"
        });

      const certificateUrl =
        result.url;

      const userId =
        typeof req.body.userId ===
        "string"
          ? req.body.userId.trim()
          : "";

      if (userId) {
        await db
          .collection("users")
          .doc(userId)
          .set(
            {
              certificateUrls: {
                [Date.now().toString()]:
                  certificateUrl
              }
            },
            {
              merge: true
            }
          );
      }

      return res.json({
        success:
          true,

        url:
          certificateUrl,

        savedToFirestore:
          Boolean(userId)
      });
    } catch (error) {
      console.error(
        "CERTIFICATE IMAGEKIT/FIRESTORE ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Certificate upload failed."
      });
    }
  }
);

/*
========================================================
ADMIN OVERVIEW API
========================================================
*/

app.get(
  "/api/admin/overview",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const [
        usersSnap,
        paymentsSnap
      ] = await Promise.all([
        db
          .collection("users")
          .get(),

        db
          .collection(
            "paymentRequests"
          )
          .get()
      ]);

      const totalUsers =
        usersSnap.size;

      let activePro = 0;
      let activePremium = 0;
      let expiredSubs = 0;

      let pendingPayments = 0;
      let approvedPayments = 0;
      let rejectedPayments = 0;

      let totalRevenue = 0;

      const now =
        Date.now();

      usersSnap.forEach(
        (doc) => {
          const user =
            doc.data() || {};

          const plan =
            normalizePlan(
              user.subscriptionPlan ||
                user.plan ||
                "free"
            );

          const expiresAt =
            timestampToMs(
              user.subscriptionExpiresAt
            );

          const isPaidPlan =
            plan === "pro" ||
            plan === "premium";

          if (
            isPaidPlan &&
            expiresAt &&
            expiresAt <= now
          ) {
            expiredSubs++;
          } else if (
            plan === "pro"
          ) {
            activePro++;
          } else if (
            plan === "premium"
          ) {
            activePremium++;
          }
        }
      );

      paymentsSnap.forEach(
        (doc) => {
          const payment =
            doc.data() || {};

          const status =
            String(
              payment.status ||
                "pending"
            )
              .trim()
              .toLowerCase();

          if (
            status === "pending"
          ) {
            pendingPayments++;
          }

          if (
            status === "approved"
          ) {
            approvedPayments++;

            const amount =
              Number(
                payment.amount ||
                  0
              );

            if (
              !Number.isNaN(
                amount
              )
            ) {
              totalRevenue +=
                amount;
            }
          }

          if (
            status === "rejected"
          ) {
            rejectedPayments++;
          }
        }
      );

      return res.json({
        success:
          true,

        totalUsers,

        activePro,

        activePremium,

        expiredSubs,

        pendingPayments,

        approvedPayments,

        rejectedPayments,

        totalRevenue:
          Number(
            totalRevenue.toFixed(
              2
            )
          )
      });
    } catch (error) {
      console.error(
        "ADMIN OVERVIEW ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          "Failed to load admin overview."
      });
    }
  }
);

/*
========================================================
ADMIN PAYMENTS API
========================================================
*/

app.get(
  "/api/admin/payments",
  requireAuth,
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

      const validFilters = [
        "all",
        "pending",
        "approved",
        "rejected"
      ];

      if (
        !validFilters.includes(
          filter
        )
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Invalid payment filter."
        });
      }

      let snap;

      if (
        filter === "all"
      ) {
        snap =
          await db
            .collection(
              "paymentRequests"
            )
            .get();
      } else {
        snap =
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
      }

      const payments = [];

      snap.forEach(
        (doc) => {
          const data =
            doc.data() || {};

          payments.push({
            id:
              doc.id,

            ...data,

            createdAtISO:
              timestampToISO(
                data.createdAt
              ),

            updatedAtISO:
              timestampToISO(
                data.updatedAt
              ),

            approvedAtISO:
              timestampToISO(
                data.approvedAt
              ),

            rejectedAtISO:
              timestampToISO(
                data.rejectedAt
              )
          });
        }
      );

      payments.sort(
        (a, b) => {
          const aTime =
            timestampToMs(
              a.createdAt
            ) || 0;

          const bTime =
            timestampToMs(
              b.createdAt
            ) || 0;

          return (
            bTime -
            aTime
          );
        }
      );

      return res.json({
        success:
          true,

        payments
      });
    } catch (error) {
      console.error(
        "ADMIN PAYMENTS ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          "Failed to load admin payments."
      });
    }
  }
);

/*
========================================================
ADMIN APPROVE PAYMENT
========================================================

IMPORTANT CREDIT RULE:

ACTIVE PAID SUBSCRIPTION:
    existing credits + new plan credits

EXPIRED/FREE:
    new plan credits only

NO ROLLOVER AFTER EXPIRATION
========================================================
*/

app.post(
  "/api/admin/payment-requests/:id/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        String(
          req.params.id ||
            ""
        ).trim();

      if (!paymentId) {
        return res.status(400).json({
          success: false,

          error:
            "Payment request ID is required."
        });
      }

      const adminUserId =
        req.user.uid;

      const paymentRef =
        db
          .collection(
            "paymentRequests"
          )
          .doc(paymentId);

      const paymentSnap =
        await paymentRef.get();

      if (
        !paymentSnap.exists
      ) {
        return res.status(404).json({
          success: false,

          error:
            "Payment request not found."
        });
      }

      const payment =
        paymentSnap.data() || {};

      const paymentStatus =
        String(
          payment.status ||
            "pending"
        )
          .trim()
          .toLowerCase();

      if (
        paymentStatus !==
        "pending"
      ) {
        return res.status(409).json({
          success: false,

          error:
            `This payment request has already been ${paymentStatus}.`
        });
      }

      const normalizedPlan =
        normalizePlan(
          payment.plan
        );

      if (
        !PLAN_CONFIG[
          normalizedPlan
        ]
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Invalid payment plan."
        });
      }

      const planConfig =
        PLAN_CONFIG[
          normalizedPlan
        ];

      const paymentAmount =
        Number(
          payment.amount
        );

      if (
        !Number.isFinite(
          paymentAmount
        ) ||
        Math.abs(
          paymentAmount -
            planConfig.price
        ) > 0.01
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Payment amount does not match the selected plan."
        });
      }

      const paymentCurrency =
        String(
          payment.currency ||
            ""
        )
          .trim()
          .toUpperCase();

      if (
        paymentCurrency !==
        "USD"
      ) {
        return res.status(400).json({
          success: false,

          error:
            "Only USD payments can be approved."
        });
      }

      const userId =
        String(
          payment.userId ||
            ""
        ).trim();

      if (!userId) {
        return res.status(400).json({
          success: false,

          error:
            "Payment request has no user ID."
        });
      }

      /*
      ----------------------------------------------------
      DUPLICATE APPROVED PAYMENT PROTECTION
      ----------------------------------------------------
      */

      const approvedSnap =
        await db
          .collection(
            "paymentRequests"
          )
          .where(
            "status",
            "==",
            "approved"
          )
          .get();

      let duplicateApproved =
        false;

      approvedSnap.forEach(
        (doc) => {
          if (
            doc.id ===
            paymentId
          ) {
            return;
          }

          const approvedPayment =
            doc.data() || {};

          if (
            String(
              approvedPayment.userId ||
                ""
            ).trim() ===
              userId &&
            String(
              approvedPayment.plan ||
                ""
            )
              .trim()
              .toLowerCase() ===
              normalizedPlan &&
            String(
              approvedPayment.transactionDate ||
                ""
            ).trim() ===
              String(
                payment.transactionDate ||
                  ""
              ).trim() &&
            String(
              approvedPayment.transactionTime ||
                ""
            ).trim() ===
              String(
                payment.transactionTime ||
                  ""
              ).trim()
          ) {
            duplicateApproved =
              true;
          }
        }
      );

      if (
        duplicateApproved
      ) {
        return res.status(409).json({
          success: false,

          error:
            "A matching payment has already been approved."
        });
      }

      const userRef =
        db
          .collection("users")
          .doc(userId);

      const userSnap =
        await userRef.get();

      if (
        !userSnap.exists
      ) {
        return res.status(404).json({
          success: false,

          error:
            "User account associated with this payment was not found."
        });
      }

      const userData =
        userSnap.data() || {};

      /*
      ====================================================
      DETERMINE WHETHER OLD SUBSCRIPTION IS STILL ACTIVE
      ====================================================
      */

      const existingPlan =
        normalizePlan(
          userData.subscriptionPlan ||
            userData.plan ||
            "free"
        );

      const existingExpiresAtMs =
        timestampToMs(
          userData.subscriptionExpiresAt
        );

      const existingPaidPlan =
        existingPlan === "pro" ||
        existingPlan === "premium";

      const existingSubscriptionActive =
        existingPaidPlan &&
        existingExpiresAtMs !==
          null &&
        existingExpiresAtMs >
          Date.now();

      /*
      ====================================================
      CREDIT BALANCE
      ====================================================

      If current paid plan is active:

          current credits + new credits

      If current plan expired/free:

          new plan allocation only
      ====================================================
      */

      const currentCredits =
        Number(
          userData.credits
        );

      const safeCurrentCredits =
        Number.isFinite(
          currentCredits
        ) &&
        currentCredits > 0
          ? currentCredits
          : 0;

      const newCreditBalance =
        existingSubscriptionActive
          ? safeCurrentCredits +
            planConfig.credits
          : planConfig.credits;

      /*
      ====================================================
      NEW SUBSCRIPTION EXPIRATION
      ====================================================
      */

      const now =
        new Date();

      const expiresAt =
        new Date(
          now.getTime() +
            planConfig.durationDays *
              24 *
              60 *
              60 *
              1000
        );

      /*
      ====================================================
      FREE VIDEO STATE
      ====================================================
      */

      const freeVideoState =
        normalizeFreeVideoState(
          userData
        );

      /*
      ====================================================
      FIRESTORE TRANSACTION
      ====================================================
      */

      await db.runTransaction(
        async (
          transaction
        ) => {
          transaction.set(
            userRef,
            {
              plan:
                normalizedPlan,

              subscriptionPlan:
                normalizedPlan,

              subscriptionStatus:
                "active",

              subscriptionStartedAt:
                now,

              subscriptionExpiresAt:
                expiresAt,

              credits:
                newCreditBalance,

              creditLimit:
                planConfig.creditLimit,

              lastPaymentAmount:
                planConfig.price,

              lastPaymentRequestId:
                paymentId,

              lastPaymentAt:
                now,

              freeVideoAvailable:
                freeVideoState.freeVideoAvailable,

              freeVideoRemaining:
                freeVideoState.freeVideoRemaining,

              freeVideoUsed:
                freeVideoState.freeVideoUsed,

              updatedAt:
                now
            },
            {
              merge:
                true
            }
          );

          transaction.set(
            paymentRef,
            {
              status:
                "approved",

              approvedAt:
                now,

              approvedBy:
                adminUserId,

              updatedAt:
                now
            },
            {
              merge:
                true
            }
          );
        }
      );

      console.log(
        "========================================"
      );

      console.log(
        "PAYMENT APPROVED"
      );

      console.log(
        "PAYMENT ID:",
        paymentId
      );

      console.log(
        "USER ID:",
        userId
      );

      console.log(
        "PLAN:",
        normalizedPlan
      );

      console.log(
        "OLD PLAN ACTIVE:",
        existingSubscriptionActive
      );

      console.log(
        "OLD CREDITS:",
        safeCurrentCredits
      );

      console.log(
        "PLAN CREDITS:",
        planConfig.credits
      );

      console.log(
        "NEW CREDIT BALANCE:",
        newCreditBalance
      );

      console.log(
        "EXPIRES:",
        expiresAt.toISOString()
      );

      console.log(
        "========================================"
      );

      return res.json({
        success:
          true,

        message:
          "Payment approved and subscription activated successfully.",

        paymentId,

        userId,

        plan:
          normalizedPlan,

        credits:
          newCreditBalance,

        creditsAdded:
          planConfig.credits,

        creditLimit:
          planConfig.creditLimit,

        subscriptionStatus:
          "active",

        subscriptionStartedAtISO:
          now.toISOString(),

        subscriptionExpiresAtISO:
          expiresAt.toISOString(),

        existingSubscriptionWasActive:
          existingSubscriptionActive
      });
    } catch (error) {
      console.error(
        "ADMIN APPROVE PAYMENT ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Failed to approve payment."
      });
    }
  }
);

/*
========================================================
ADMIN REJECT PAYMENT
========================================================
*/

app.post(
  "/api/admin/payment-requests/:id/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        String(
          req.params.id ||
            ""
        ).trim();

      const reason =
        String(
          req.body?.reason ||
            ""
        ).trim();

      if (!paymentId) {
        return res.status(400).json({
          success: false,

          error:
            "Payment request ID is required."
        });
      }

      if (!reason) {
        return res.status(400).json({
          success: false,

          error:
            "A rejection reason is required."
        });
      }

      const paymentRef =
        db
          .collection(
            "paymentRequests"
          )
          .doc(paymentId);

      const paymentSnap =
        await paymentRef.get();

      if (
        !paymentSnap.exists
      ) {
        return res.status(404).json({
          success: false,

          error:
            "Payment request not found."
        });
      }

      const payment =
        paymentSnap.data() || {};

      const status =
        String(
          payment.status ||
            "pending"
        )
          .trim()
          .toLowerCase();

      if (
        status !==
        "pending"
      ) {
        return res.status(409).json({
          success: false,

          error:
            `This payment request has already been ${status}.`
        });
      }

      const now =
        new Date();

      await paymentRef.set(
        {
          status:
            "rejected",

          rejectedAt:
            now,

          rejectedBy:
            req.user.uid,

          rejectionReason:
            reason,

          updatedAt:
            now
        },
        {
          merge:
            true
        }
      );

      console.log(
        "PAYMENT REJECTED:",
        paymentId
      );

      return res.json({
        success:
          true,

        message:
          "Payment request rejected successfully.",

        paymentId,

        status:
          "rejected",

        rejectionReason:
          reason
      });
    } catch (error) {
      console.error(
        "ADMIN REJECT PAYMENT ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Failed to reject payment request."
      });
    }
  }
);

/*
========================================================
ADMIN USERS API
========================================================
*/

app.get(
  "/api/admin/users",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const usersSnap =
        await db
          .collection("users")
          .get();

      const users = [];

      usersSnap.forEach(
        (doc) => {
          const data =
            doc.data() || {};

          const subscription =
            getEffectiveSubscription(
              data
            );

          const freeVideoState =
            normalizeFreeVideoState(
              data
            );

          const effectivePlan =
            subscription.effectivePlan;

          users.push({
            id:
              doc.id,

            email:
              data.email ||
              "",

            fullName:
              data.fullName ||
              data.name ||
              "",

            photoUrl:
              data.photoUrl ||
              data.photoURL ||
              "",

            plan:
              effectivePlan,

            subscriptionPlan:
              effectivePlan,

            subscriptionStatus:
              subscription.isActive
                ? "active"
                : "inactive",

            credits:
              Math.max(
                Number(
                  data.credits
                ) || 0,
                0
              ),

            creditLimit:
              getPlanCreditLimit(
                effectivePlan
              ),

            freeVideoAvailable:
              freeVideoState.freeVideoAvailable,

            freeVideoRemaining:
              freeVideoState.freeVideoRemaining,

            freeVideoUsed:
              freeVideoState.freeVideoUsed,

            subscriptionStartedAtISO:
              timestampToISO(
                data.subscriptionStartedAt
              ),

            subscriptionExpiresAtISO:
              timestampToISO(
                data.subscriptionExpiresAt
              ),

            lastPaymentAmount:
              data.lastPaymentAmount ||
              null,

            lastPaymentDate:
              data.lastPaymentAt ||
              null,

            lastPaymentDateISO:
              timestampToISO(
                data.lastPaymentAt
              ),

            lastPaymentRequestId:
              data.lastPaymentRequestId ||
              null
          });
        }
      );

      return res.json({
        success:
          true,

        users
      });
    } catch (error) {
      console.error(
        "ADMIN USERS ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          "Failed to load admin users."
      });
    }
  }
);

/*
========================================================
ROUTE CONFIRMATION
========================================================
*/

console.log(
  "========================================"
);

console.log(
  "GAVEAI BACKEND ROUTES"
);

console.log(
  "========================================"
);

console.log(
  "ACCOUNT: GET /api/account"
);

console.log(
  "PAYMENT INFO: GET /api/payment-info"
);

console.log(
  "PAYMENT: POST /api/payment-requests"
);

console.log(
  "PAYMENT PROOF: POST /upload-payment-proof"
);

console.log(
  "ADMIN PAYMENTS: GET /api/admin/payments"
);

console.log(
  "ADMIN APPROVE: POST /api/admin/payment-requests/:id/approve"
);

console.log(
  "ADMIN REJECT: POST /api/admin/payment-requests/:id/reject"
);

console.log(
  "ADMIN USERS: GET /api/admin/users"
);

console.log(
  "ADMIN OVERVIEW: GET /api/admin/overview"
);

console.log(
  "VIDEO: POST /generate-video"
);

console.log(
  "CHAT: POST /chat"
);

console.log(
  "========================================"
);

console.log(
  "VIDEO PROVIDER:",
  GAVEAI_PROVIDER_NAME
);

console.log(
  "VIDEO SERVICE: gaveaiVideoProviderService.js"
);

console.log(
  "CREDIT SERVICE: creditService.js"
);

console.log(
  "CREDIT FIELD: users/{userId}.credits"
);

console.log(
  "FREE VIDEO: 1 lifetime only"
);

console.log(
  "PRO: $9.99 / 1,000 credits / 30 days"
);

console.log(
  "PREMIUM: $19.99 / 1,500 credits / 30 days"
);

console.log(
  "5-SECOND VIDEO: 15 CREDITS"
);

console.log(
  "8-SECOND VIDEO: 24 CREDITS"
);

console.log(
  "PAYMENT BANK: SOGEBANK"
);

console.log(
  "PAYMENT CURRENCY: USD"
);

console.log(
  "NO DAILY CREDITS"
);

console.log(
  "NO CREDIT ROLLOVER AFTER EXPIRATION"
);

console.log(
  "NO AUTOMATIC MONTHLY RECHARGE"
);

console.log(
  "========================================"
);

/*
========================================================
START SERVER
========================================================
*/

app.listen(
  PORT,
  () => {
    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );

    console.log(
      "Owner/Admin video mode: UNLIMITED"
    );

    console.log(
      "Video provider:",
      GAVEAI_PROVIDER_NAME
    );

    console.log(
      "Credit service: ENABLED"
    );

    console.log(
      "Free video: 1 lifetime"
    );

    console.log(
      "Pro: 1,000 credits / 30 days"
    );

    console.log(
      "Premium: 1,500 credits / 30 days"
    );

    console.log(
      "5 seconds: 15 credits"
    );

    console.log(
      "8 seconds: 24 credits"
    );

    console.log(
      "No daily credits"
    );

    console.log(
      "No daily free-video reset"
    );

    console.log(
      "No credit rollover after expiration"
    );

    console.log(
      "No automatic monthly recharge"
    );

    console.log(
      "ImageKit: ENABLED"
    );

    console.log(
      "Firestore: ENABLED"
    );

    console.log(
      `Maximum video clips per production: ${MAX_VIDEO_PROMPTS}`
    );
  }
);