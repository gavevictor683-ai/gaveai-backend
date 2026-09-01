require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");

const { generateAIResponse } = require("./services/groqService");

const {
  generateWithGaveAIVideoProvider,
  getVideoProviderStatus
} = require("./services/gaveaiVideoProviderService");

// IMPORTANT:
// firebaseAdmin.js must export BOTH db and admin.
const { db, admin } = require("./firebaseAdmin");

const app = express();

/*
========================================================
CONFIGURATION
========================================================
*/

const PORT = process.env.PORT || 3000;

const VIDEO_CREDIT_COST = 15;

const ADMIN_USER_ID =
  process.env.ADMIN_USER_ID ||
  "8eGkRNjIqycQa4ZIVwX8r6LVm4u1";

const PRO_PRICE = 9.99;
const PRO_CREDITS = 1200;

const PREMIUM_PRICE = 19.99;
const PREMIUM_CREDITS = 3000;

const SUBSCRIPTION_DAYS = 30;

/*
========================================================
FILE UPLOAD
========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
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

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("CORS origin not allowed")
      );
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin"
    ],
    credentials: false,
    optionsSuccessStatus: 204
  })
);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
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

app.use(
  express.json({
    limit: "10mb"
  })
);

/*
========================================================
HEALTH CHECK
========================================================
*/

app.get("/", (req, res) => {
  res.send(
    "Gave Money Tips AI Backend is running 🚀"
  );
});

/*
========================================================
VIDEO PROVIDER STATUS
========================================================
*/

app.get("/video-provider-status", async (req, res) => {
  try {
    const status = await getVideoProviderStatus();

    return res.json({
      success: true,
      provider: "Hugging Face",
      status
    });
  } catch (error) {
    console.error(
      "VIDEO PROVIDER STATUS ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Unable to get video provider status."
    });
  }
});

/*
========================================================
CHAT
========================================================
*/

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (
      !userMessage ||
      typeof userMessage !== "string"
    ) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    const result =
      await generateAIResponse(userMessage);

    let aiReply =
      typeof result === "string"
        ? result
        : (
            result?.reply ||
            result?.message ||
            ""
          );

    // Clean markdown formatting
    aiReply = aiReply
      .split("*")
      .join("")
      .replace(/##/g, "")
      .replace(/#/g, "")
      .replace(/`/g, "");

    return res.json({
      reply: aiReply,

      webSearchUsed: Boolean(
        result?.webSearchUsed
      ),

      sources: Array.isArray(result?.sources)
        ? result.sources.map((s) => ({
            title: s?.title || "",
            url: s?.url || "",
            provider: s?.provider || "",
            official: Boolean(
              s?.official
            )
          }))
        : []
    });
  } catch (error) {
    console.error(
      "GROQ ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "AI request failed"
    });
  }
});

/*
========================================================
UPLOAD GENERATED VIDEO TO IMAGEKIT
========================================================
*/

async function uploadGeneratedVideoToImageKit(
  filePath,
  productionId
) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    throw new Error(
      "Generated video file does not exist."
    );
  }

  const fileBuffer =
    fs.readFileSync(filePath);

  if (
    !fileBuffer ||
    fileBuffer.length === 0
  ) {
    throw new Error(
      "Generated video file is empty."
    );
  }

  const fileName =
    `gaveai-production-${
      productionId || Date.now()
    }.mp4`;

  console.log(
    "========================================"
  );

  console.log(
    "IMAGEKIT VIDEO UPLOAD STARTED"
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
      file: fileBuffer,
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

  return {
    url: result.url,
    fileId:
      result.fileId || null,
    name:
      result.name || fileName
  };
}

/*
========================================================
LOCAL FILE CLEANUP
========================================================
*/

function deleteLocalVideoFile(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);

      console.log(
        "LOCAL VIDEO DELETED:",
        filePath
      );
    }
  } catch (error) {
    console.warn(
      "VIDEO DELETE WARNING:",
      error?.message || error
    );
  }
}

function cleanupGeneratedClips(clips) {
  if (!Array.isArray(clips)) {
    return;
  }

  for (const clip of clips) {
    if (clip?.videoFile) {
      deleteLocalVideoFile(
        clip.videoFile
      );
    }
  }
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

  let firstGeneratedVideo = null;

  const productionId =
    `gaveai-${Date.now()}`;

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO PRODUCTION STARTED"
  );

  console.log(
    "PROVIDER: Hugging Face (Open Source)"
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
    "========================================"
  );

  for (
    let i = 0;
    i < prompts.length;
    i++
  ) {
    const currentPrompt =
      prompts[i];

    console.log(
      `GENERATING CLIP ${
        i + 1
      }/${prompts.length}`
    );

    console.log(
      "PROMPT:",
      currentPrompt
    );

    const result =
      await generateWithGaveAIVideoProvider({
        prompt: currentPrompt,

        firstFrameImage:
          i === 0
            ? options.firstFrameImage
            : undefined,

        width:
          options.width || 832,

        height:
          options.height || 480,

        duration:
          options.duration || 5,

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
        `Video clip ${
          i + 1
        } failed.`
      );
    }

    if (!firstGeneratedVideo) {
      firstGeneratedVideo = result;
    }

    clips.push({
      index: i + 1,

      prompt: currentPrompt,

      videoFile:
        result.videoFile,

      videoUrl:
        result.videoUrl || null,

      provider:
        result.provider || "Hugging Face",

      model:
        result.model || null
    });
  }

  /*
  IMPORTANT:
  If multiple clips are requested, the provider/service
  should eventually return a merged final videoFile.

  For one clip, the clip itself is the final video.
  For multiple clips, if the provider service returns
  finalVideoFile, we use it.
  Otherwise, we safely fall back to the first clip.
  */

  const finalVideoFile =
    firstGeneratedVideo?.finalVideoFile ||
    firstGeneratedVideo?.videoFile ||
    null;

  return {
    success: true,

    provider:
      firstGeneratedVideo?.provider ||
      "Hugging Face",

    model:
      firstGeneratedVideo?.model ||
      null,

    productionId,

    clips,

    videoFile:
      finalVideoFile
  };
}

/*
========================================================
FIRESTORE CREDIT REFUND
========================================================
*/

async function refundVideoCredits(
  userId,
  creditCost
) {
  if (
    !userId ||
    !creditCost ||
    creditCost <= 0
  ) {
    return;
  }

  try {
    const userRef =
      db.collection("users").doc(userId);

    await db.runTransaction(
      async (transaction) => {
        const userSnap =
          await transaction.get(
            userRef
          );

        if (!userSnap.exists) {
          throw new Error(
            "User account not found during credit refund."
          );
        }

        const userData =
          userSnap.data() || {};

        const currentCredits =
          Number(
            userData.credits ??
            userData.dailyCredits ??
            0
          );

        const newCredits =
          currentCredits + creditCost;

        transaction.set(
          userRef,
          {
            credits: newCredits,
            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );
      }
    );

    console.log(
      "VIDEO CREDITS REFUNDED:",
      creditCost
    );
  } catch (error) {
    console.error(
      "CREDIT REFUND ERROR:",
      error
    );
  }
}

/*
========================================================
ATOMIC VIDEO CREDIT DEDUCTION
========================================================
*/

async function deductVideoCredits(
  userId,
  creditCost
) {
  if (
    !userId ||
    !creditCost ||
    creditCost <= 0
  ) {
    return {
      creditsDeducted: 0,
      newCreditBalance: null,
      previousCreditBalance: null
    };
  }

  const userRef =
    db.collection("users").doc(userId);

  return await db.runTransaction(
    async (transaction) => {
      const userSnap =
        await transaction.get(
          userRef
        );

      if (!userSnap.exists) {
        const error =
          new Error(
            "USER_NOT_FOUND"
          );

        throw error;
      }

      const userData =
        userSnap.data() || {};

      const currentCredits =
        Number(
          userData.credits ??
          userData.dailyCredits ??
          0
        );

      if (
        !Number.isFinite(
          currentCredits
        )
      ) {
        const error =
          new Error(
            "INVALID_CREDIT_BALANCE"
          );

        throw error;
      }

      if (
        currentCredits <
        creditCost
      ) {
        const error =
          new Error(
            "INSUFFICIENT_CREDITS"
          );

        error.currentCredits =
          currentCredits;

        throw error;
      }

      const newCreditBalance =
        currentCredits -
        creditCost;

      transaction.set(
        userRef,
        {
          credits:
            newCreditBalance,

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
        creditsDeducted:
          creditCost,

        newCreditBalance,

        previousCreditBalance:
          currentCredits
      };
    }
  );
}

/*
========================================================
GENERATE VIDEO ROUTE
========================================================
*/

app.post(
  "/generate-video",
  async (req, res) => {
    let userId =
      typeof req.body?.userId ===
      "string"
        ? req.body.userId.trim()
        : "";

    let prompt =
      typeof req.body?.prompt ===
      "string"
        ? req.body.prompt.trim()
        : "";

    /*
    Support:
    {
      message: "/generate-video something"
    }
    */

    if (
      !prompt &&
      typeof req.body?.message ===
        "string"
    ) {
      prompt =
        req.body.message
          .replace(
            /^\/generate-video\s*/i,
            ""
          )
          .trim();
    }

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

    if (
      prompts.length === 0 &&
      prompt
    ) {
      prompts = [prompt];
    }

    if (
      prompts.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error:
          "At least one video prompt is required."
      });
    }

    /*
    Maximum 20 clips.
    */

    if (
      prompts.length > 20
    ) {
      return res.status(400).json({
        success: false,
        error:
          "A maximum of 20 video clips can be generated."
      });
    }

    /*
    IMPORTANT:
    Every clip costs 15 credits.
    */

    const totalCreditCost =
      prompts.length *
      VIDEO_CREDIT_COST;

    const firstFrameImage =
      typeof req.body
        ?.firstFrameImage ===
      "string"
        ? req.body.firstFrameImage.trim()
        : undefined;

    const width =
      Number(req.body?.width) ||
      832;

    const height =
      Number(req.body?.height) ||
      480;

    const duration =
      Number(req.body?.duration) ||
      5;

    const adminUserId =
      process.env.ADMIN_USER_ID
        ? process.env.ADMIN_USER_ID.trim()
        : ADMIN_USER_ID;

    const ownerUser =
      Boolean(
        userId &&
        adminUserId &&
        userId === adminUserId
      );

    console.log(
      "========================================"
    );

    console.log(
      "GENERATE VIDEO REQUEST"
    );

    console.log(
      "PROVIDER: Hugging Face (Open Source)"
    );

    console.log(
      "USER ID:",
      userId || "anonymous"
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
      "TOTAL CREDIT COST:",
      totalCreditCost
    );

    console.log(
      "========================================"
    );

    let creditResult = null;
    let genResult = null;

    try {
      /*
      ======================================================
      1. CREDIT CHECK + ATOMIC DEDUCTION
      ======================================================
      */

      if (
        !ownerUser &&
        userId
      ) {
        try {
          creditResult =
            await deductVideoCredits(
              userId,
              totalCreditCost
            );
        } catch (
          creditError
        ) {
          console.error(
            "VIDEO CREDIT ERROR:",
            creditError
          );

          if (
            creditError.message ===
            "USER_NOT_FOUND"
          ) {
            return res.status(404).json({
              success: false,
              error:
                "User account was not found."
            });
          }

          if (
            creditError.message ===
            "INSUFFICIENT_CREDITS"
          ) {
            return res.status(402).json({
              success: false,
              error:
                "Insufficient credits.",

              requiredCredits:
                totalCreditCost,

              currentCredits:
                creditError.currentCredits
            });
          }

          return res.status(500).json({
            success: false,
            error:
              "Unable to process video credits."
          });
        }
      } else {
        /*
        Admin has unlimited video credits.
        Anonymous users remain allowed according
        to the current backend behavior.
        */

        creditResult = {
          creditsDeducted: 0,
          newCreditBalance: null,
          previousCreditBalance: null
        };
      }

      /*
      ======================================================
      2. GENERATE VIDEO
      ======================================================
      */

      try {
        genResult =
          await generateGaveAIVideoProduction(
            prompts,
            {
              firstFrameImage,
              width,
              height,
              duration
            }
          );
      } catch (
        generationError
      ) {
        console.error(
          "OPEN SOURCE VIDEO GENERATION ERROR:",
          generationError
        );

        if (
          userId &&
          creditResult &&
          creditResult.creditsDeducted >
            0
        ) {
          await refundVideoCredits(
            userId,
            creditResult.creditsDeducted
          );
        }

        return res.status(500).json({
          success: false,
          error:
            generationError?.message ||
            "Video production failed."
        });
      }

      if (
        !genResult ||
        !genResult.success
      ) {
        if (
          userId &&
          creditResult &&
          creditResult.creditsDeducted >
            0
        ) {
          await refundVideoCredits(
            userId,
            creditResult.creditsDeducted
          );
        }

        cleanupGeneratedClips(
          genResult?.clips
        );

        return res.status(500).json({
          success: false,
          error:
            genResult?.message ||
            "Video production failed."
        });
      }

      /*
      ======================================================
      3. VERIFY FINAL VIDEO FILE
      ======================================================
      */

      if (
        !genResult.videoFile ||
        !fs.existsSync(
          genResult.videoFile
        )
      ) {
        console.error(
          "FINAL VIDEO FILE NOT FOUND:",
          genResult.videoFile
        );

        if (
          userId &&
          creditResult &&
          creditResult.creditsDeducted >
            0
        ) {
          await refundVideoCredits(
            userId,
            creditResult.creditsDeducted
          );
        }

        cleanupGeneratedClips(
          genResult.clips
        );

        return res.status(500).json({
          success: false,
          error:
            "Video was generated, but the final video file could not be found."
        });
      }

      /*
      ======================================================
      4. UPLOAD FINAL VIDEO TO IMAGEKIT
      ======================================================
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
          creditResult.creditsDeducted >
            0
        ) {
          await refundVideoCredits(
            userId,
            creditResult.creditsDeducted
          );
        }

        cleanupGeneratedClips(
          genResult.clips
        );

        /*
        If the final videoFile is different from
        individual clips, delete it too.
        */

        if (
          genResult.videoFile &&
          !genResult.clips.some(
            (clip) =>
              clip.videoFile ===
              genResult.videoFile
          )
        ) {
          deleteLocalVideoFile(
            genResult.videoFile
          );
        }

        return res.status(500).json({
          success: false,
          error:
            "Video was generated, but uploading failed.",
          details:
            uploadError?.message
        });
      }

      /*
      ======================================================
      5. CLEANUP LOCAL FILES
      ======================================================
      */

      cleanupGeneratedClips(
        genResult.clips
      );

      if (
        genResult.videoFile &&
        !genResult.clips.some(
          (clip) =>
            clip.videoFile ===
            genResult.videoFile
        )
      ) {
        deleteLocalVideoFile(
          genResult.videoFile
        );
      }

      /*
      ======================================================
      6. SUCCESS RESPONSE
      ======================================================
      */

      return res.json({
        success: true,

        reply:
          "Video generated successfully!",

        generatedMedia: {
          type: "video",

          url:
            uploadedVideo.url,

          downloadUrl:
            uploadedVideo.url,

          productionId:
            genResult.productionId,

          clips:
            genResult.clips,

          provider:
            genResult.provider,

          model:
            genResult.model
        },

        clipsGenerated:
          prompts.length,

        creditsPerClip:
          VIDEO_CREDIT_COST,

        creditsDeducted:
          creditResult?.creditsDeducted ||
          0,

        newCreditBalance:
          creditResult?.newCreditBalance ??
          null
      });
    } catch (error) {
      console.error(
        "GENERATE VIDEO CRITICAL ERROR:",
        error
      );

      if (
        userId &&
        creditResult &&
        creditResult.creditsDeducted >
          0
      ) {
        await refundVideoCredits(
          userId,
          creditResult.creditsDeducted
        );
      }

      cleanupGeneratedClips(
        genResult?.clips
      );

      if (
        genResult?.videoFile &&
        !genResult?.clips?.some(
          (clip) =>
            clip.videoFile ===
            genResult.videoFile
        )
      ) {
        deleteLocalVideoFile(
          genResult.videoFile
        );
      }

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Video generation failed."
      });
    }
  }
);

/*
========================================================
GAVEAI PAYMENT & ADMIN DASHBOARD
========================================================
*/

/*
========================================================
BANK TRANSFER INFORMATION
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
PAYMENT ROUTES HEALTH CHECK
========================================================
*/

app.get(
  "/api/payment-routes-status",
  (req, res) => {
    return res.status(200).json({
      success: true,

      message:
        "GaveAI payment/admin routes are loaded",

      service:
        "GaveAI Payment System",

      routes: {
        paymentSystemStatus:
          "GET /api/payment-system-status",

        paymentBankInfo:
          "GET /api/payment-bank-info",

        paymentRequests:
          "POST /api/payment-requests",

        adminOverview:
          "GET /api/admin/overview",

        adminPayments:
          "GET /api/admin/payments",

        adminUsers:
          "GET /api/admin/users",

        approvePayment:
          "POST /api/admin/payment-requests/:id/approve",

        rejectPayment:
          "POST /api/admin/payment-requests/:id/reject"
      },

      timestamp:
        new Date().toISOString()
    });
  }
);

/*
========================================================
ADMIN AUTHENTICATION
========================================================
*/

const requireAdmin =
  async (
    req,
    res,
    next
  ) => {
    try {
      const authHeader =
        req.headers.authorization;

      if (
        !authHeader ||
        !authHeader.startsWith(
          "Bearer "
        )
      ) {
        return res.status(401).json({
          success: false,
          error:
            "Unauthorized: No Firebase token provided"
        });
      }

      const token =
        authHeader
          .substring(
            "Bearer ".length
          )
          .trim();

      if (!token) {
        return res.status(401).json({
          success: false,
          error:
            "Unauthorized: Empty Firebase token"
        });
      }

      const decodedToken =
        await admin
          .auth()
          .verifyIdToken(
            token
          );

      if (
        !decodedToken ||
        decodedToken.uid !==
          ADMIN_USER_ID
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Forbidden: Admin access required"
        });
      }

      req.adminUid =
        decodedToken.uid;

      return next();
    } catch (error) {
      console.error(
        "Admin authentication error:",
        error
      );

      return res.status(401).json({
        success: false,
        error:
          "Invalid or expired Firebase token"
      });
    }
  };

/*
========================================================
NORMAL USER AUTHENTICATION
========================================================
*/

const requireAuthenticatedUser =
  async (
    req,
    res,
    next
  ) => {
    try {
      const authHeader =
        req.headers.authorization;

      if (
        !authHeader ||
        !authHeader.startsWith(
          "Bearer "
        )
      ) {
        return res.status(401).json({
          success: false,
          error:
            "Unauthorized: No Firebase token provided"
        });
      }

      const token =
        authHeader
          .substring(
            "Bearer ".length
          )
          .trim();

      if (!token) {
        return res.status(401).json({
          success: false,
          error:
            "Unauthorized"
        });
      }

      const decodedToken =
        await admin
          .auth()
          .verifyIdToken(
            token
          );

      req.authenticatedUser =
        decodedToken;

      req.userUid =
        decodedToken.uid;

      return next();
    } catch (error) {
      console.error(
        "User authentication error:",
        error
      );

      return res.status(401).json({
        success: false,
        error:
          "Invalid or expired Firebase token"
      });
    }
  };

/*
========================================================
PAYMENT SYSTEM STATUS
========================================================
*/

app.get(
  "/api/payment-system-status",
  (req, res) => {
    return res.json({
      success: true,

      paymentSystem:
        "online",

      bank:
        GAVEAI_BANK_INFO.bankName,

      currency:
        GAVEAI_BANK_INFO.currency,

      plans: {
        pro: {
          price:
            PRO_PRICE,

          credits:
            PRO_CREDITS,

          durationDays:
            SUBSCRIPTION_DAYS
        },

        premium: {
          price:
            PREMIUM_PRICE,

          credits:
            PREMIUM_CREDITS,

          durationDays:
            SUBSCRIPTION_DAYS
        }
      }
    });
  }
);

/*
========================================================
GET BANK TRANSFER INFORMATION
========================================================
*/

app.get(
  "/api/payment-bank-info",
  (req, res) => {
    return res.json({
      success: true,
      bank:
        GAVEAI_BANK_INFO
    });
  }
);

/*
========================================================
USER SUBMITS PAYMENT REQUEST
========================================================
*/

app.post(
  "/api/payment-requests",
  requireAuthenticatedUser,
  async (
    req,
    res
  ) => {
    try {
      const userId =
        req.userUid;

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

      /*
      ======================================================
      REQUIRED PLAN
      ======================================================
      */

      if (!plan) {
        return res.status(400).json({
          success: false,
          error:
            "Selected plan is required"
        });
      }

      const planLower =
        String(plan)
          .trim()
          .toLowerCase();

      if (
        planLower !== "pro" &&
        planLower !== "premium"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid plan. Select Pro or Premium."
        });
      }

      /*
      ======================================================
      AMOUNT
      ======================================================
      */

      if (
        amount === undefined ||
        amount === null ||
        amount === "" ||
        Number.isNaN(
          Number(amount)
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction amount is required"
        });
      }

      /*
      ======================================================
      USD ONLY
      ======================================================
      */

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
            "Payments must be made in USD."
        });
      }

      /*
      ======================================================
      BANK NAME
      ======================================================
      */

      if (
        !bankName ||
        !String(bankName).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Bank Name is required"
        });
      }

      /*
      ======================================================
      ACCOUNT HOLDER
      ======================================================
      */

      if (
        !accountHolderFullName ||
        !String(
          accountHolderFullName
        ).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Account Holder Full Name is required"
        });
      }

      /*
      ======================================================
      TRANSACTION DATE
      ======================================================
      */

      if (!transactionDate) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction Date is required"
        });
      }

      /*
      ======================================================
      TRANSACTION TIME
      ======================================================
      */

      if (!transactionTime) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction Time is required"
        });
      }

      /*
      ======================================================
      PAYMENT PROOF
      ======================================================
      */

      if (
        !proofImageUrl ||
        !String(
          proofImageUrl
        ).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Payment Proof / Screenshot is required"
        });
      }

      const numericAmount =
        Number(amount);

      /*
      ======================================================
      PLAN PRICE VALIDATION
      ======================================================
      */

      const expectedAmount =
        planLower === "pro"
          ? PRO_PRICE
          : PREMIUM_PRICE;

      if (
        Math.abs(
          numericAmount -
            expectedAmount
        ) > 0.01
      ) {
        return res.status(400).json({
          success: false,
          error:
            planLower === "pro"
              ? "Pro Plan requires a payment of $9.99 USD"
              : "Premium Plan requires a payment of $19.99 USD"
        });
      }

      /*
      ======================================================
      GET USER PROFILE
      ======================================================
      */

      const userRef =
        db.collection(
          "users"
        ).doc(userId);

      const userSnap =
        await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,
          error:
            "User profile not found"
        });
      }

      const userData =
        userSnap.data() || {};

      /*
      ======================================================
      CREATE PAYMENT REQUEST
      ======================================================
      */

      const paymentRequest = {
        userId,

        userEmail:
          userData.email ||
          req.authenticatedUser
            .email ||
          "",

        userFullName:
          userData.fullName ||
          userData.displayName ||
          "",

        plan:
          planLower,

        amount:
          numericAmount,

        currency:
          "USD",

        bankName:
          String(
            bankName
          ).trim(),

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
          description
            ? String(
                description
              ).trim()
            : "",

        proofImageUrl:
          String(
            proofImageUrl
          ).trim(),

        status:
          "pending",

        createdAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      };

      const paymentRef =
        await db
          .collection(
            "paymentRequests"
          )
          .add(
            paymentRequest
          );

      console.log(
        `Payment request created: ${paymentRef.id} | User: ${userId} | Plan: ${planLower}`
      );

      return res.status(201).json({
        success: true,

        message:
          "Payment request submitted successfully. Admin will verify the payment.",

        id:
          paymentRef.id
      });
    } catch (error) {
      console.error(
        "Create payment request error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to create payment request"
      });
    }
  }
);

/*
========================================================
ADMIN OVERVIEW
========================================================
*/

app.get(
  "/api/admin/overview",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const [
        usersSnap,
        paymentsSnap
      ] =
        await Promise.all([
          db.collection(
            "users"
          ).get(),

          db.collection(
            "paymentRequests"
          ).get()
        ]);

      let totalUsers = 0;
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
          totalUsers++;

          const user =
            doc.data() || {};

          const plan =
            String(
              user.subscriptionPlan ||
              user.plan ||
              "free"
            )
              .trim()
              .toLowerCase();

          let expiresAt =
            null;

          if (
            user.subscriptionExpiresAt
          ) {
            if (
              typeof user
                .subscriptionExpiresAt
                .toDate ===
              "function"
            ) {
              expiresAt =
                user
                  .subscriptionExpiresAt
                  .toDate()
                  .getTime();
            } else if (
              user
                .subscriptionExpiresAt
                .seconds
            ) {
              expiresAt =
                Number(
                  user
                    .subscriptionExpiresAt
                    .seconds
                ) * 1000;
            } else {
              const parsed =
                new Date(
                  user.subscriptionExpiresAt
                ).getTime();

              if (
                !Number.isNaN(
                  parsed
                )
              ) {
                expiresAt =
                  parsed;
              }
            }
          }

          if (
            (
              plan === "pro" ||
              plan === "premium"
            ) &&
            expiresAt &&
            expiresAt < now
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
            status ===
            "pending"
          ) {
            pendingPayments++;
          }

          if (
            status ===
            "approved"
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
            status ===
            "rejected"
          ) {
            rejectedPayments++;
          }
        }
      );

      return res.json({
        success: true,

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
        "Admin overview error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to load overview"
      });
    }
  }
);

/*
========================================================
ADMIN PAYMENT REQUESTS
========================================================
*/

app.get(
  "/api/admin/payments",
  requireAdmin,
  async (
    req,
    res
  ) => {
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
            "Invalid payment filter"
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

      const userIds =
        new Set();

      snap.forEach(
        (doc) => {
          const data =
            doc.data() || {};

          payments.push({
            id: doc.id,
            ...data
          });

          if (
            data.userId
          ) {
            userIds.add(
              data.userId
            );
          }
        }
      );

      /*
      ======================================================
      SORT NEWEST FIRST
      ======================================================
      */

      const getTime =
        (value) => {
          if (!value) {
            return 0;
          }

          if (
            typeof value.toDate ===
            "function"
          ) {
            return value
              .toDate()
              .getTime();
          }

          if (
            value.seconds
          ) {
            return (
              Number(
                value.seconds
              ) * 1000
            );
          }

          const parsed =
            new Date(
              value
            ).getTime();

          return Number.isNaN(
            parsed
          )
            ? 0
            : parsed;
        };

      payments.sort(
        (a, b) =>
          getTime(
            b.createdAt
          ) -
          getTime(
            a.createdAt
          )
      );

      /*
      ======================================================
      LOAD USER DATA
      ======================================================
      */

      const userDataMap =
        {};

      await Promise.all(
        Array.from(
          userIds
        ).map(
          async (
            uid
          ) => {
            try {
              const userSnap =
                await db
                  .collection(
                    "users"
                  )
                  .doc(uid)
                  .get();

              if (
                userSnap.exists
              ) {
                userDataMap[
                  uid
                ] = {
                  id:
                    userSnap.id,
                  ...userSnap.data()
                };
              }
            } catch (
              userError
            ) {
              console.error(
                `Could not load user ${uid}:`,
                userError
              );
            }
          }
        )
      );

      /*
      ======================================================
      ENRICH PAYMENT DATA
      ======================================================
      */

      const enrichedPayments =
        payments.map(
          (
            payment
          ) => {
            const userData =
              userDataMap[
                payment.userId
              ] || {};

            return {
              ...payment,

              userData,

              userFullName:
                payment.userFullName ||
                userData.fullName ||
                userData.displayName ||
                "",

              userEmail:
                payment.userEmail ||
                userData.email ||
                "",

              userProfilePhoto:
                userData.profilePhoto ||
                userData.photoURL ||
                userData.avatar ||
                ""
            };
          }
        );

      return res.json({
        success: true,

        payments:
          enrichedPayments,

        count:
          enrichedPayments.length
      });
    } catch (error) {
      console.error(
        "Admin payments error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to load payments"
      });
    }
  }
);

/*
========================================================
ADMIN USERS & SUBSCRIPTIONS
========================================================
*/

app.get(
  "/api/admin/users",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const [
        usersSnap,
        paymentsSnap
      ] =
        await Promise.all([
          db.collection(
            "users"
          ).get(),

          db.collection(
            "paymentRequests"
          ).get()
        ]);

      const userPaymentStats =
        {};

      paymentsSnap.forEach(
        (doc) => {
          const payment =
            doc.data() || {};

          const uid =
            payment.userId;

          if (!uid) {
            return;
          }

          if (
            !userPaymentStats[
              uid
            ]
          ) {
            userPaymentStats[
              uid
            ] = {
              approved: 0,
              total: 0,
              lastAmount: 0,
              lastDate: null,
              lastRequestId: ""
            };
          }

          userPaymentStats[
            uid
          ].total++;

          if (
            String(
              payment.status ||
              ""
            )
              .toLowerCase() ===
            "approved"
          ) {
            userPaymentStats[
              uid
            ].approved++;

            let paymentDate =
              null;

            if (
              payment.approvedAt &&
              typeof payment
                .approvedAt
                .toDate ===
                "function"
            ) {
              paymentDate =
                payment
                  .approvedAt
                  .toDate();
            } else if (
              payment.approvedAt
            ) {
              paymentDate =
                new Date(
                  payment.approvedAt
                );
            }

            if (
              paymentDate &&
              !Number.isNaN(
                paymentDate.getTime()
              )
            ) {
              const existing =
                userPaymentStats[
                  uid
                ].lastDate;

              if (
                !existing ||
                paymentDate >
                  existing
              ) {
                userPaymentStats[
                  uid
                ].lastDate =
                  paymentDate;

                userPaymentStats[
                  uid
                ].lastAmount =
                  Number(
                    payment.amount ||
                    0
                  );

                userPaymentStats[
                  uid
                ].lastRequestId =
                  doc.id;
              }
            }
          }
        }
      );

      const users = [];

      const now =
        Date.now();

      usersSnap.forEach(
        (doc) => {
          const data =
            doc.data() || {};

          const plan =
            String(
              data.subscriptionPlan ||
              data.plan ||
              "free"
            )
              .trim()
              .toLowerCase();

          let expiresAt =
            null;

          if (
            data.subscriptionExpiresAt
          ) {
            if (
              typeof data
                .subscriptionExpiresAt
                .toDate ===
              "function"
            ) {
              expiresAt =
                data
                  .subscriptionExpiresAt
                  .toDate()
                  .getTime();
            } else if (
              data
                .subscriptionExpiresAt
                .seconds
            ) {
              expiresAt =
                Number(
                  data
                    .subscriptionExpiresAt
                    .seconds
                ) * 1000;
            } else {
              const parsed =
                new Date(
                  data.subscriptionExpiresAt
                ).getTime();

              if (
                !Number.isNaN(
                  parsed
                )
              ) {
                expiresAt =
                  parsed;
              }
            }
          }

          let subscriptionStatus =
            "free";

          if (
            (
              plan === "pro" ||
              plan === "premium"
            ) &&
            expiresAt &&
            expiresAt < now
          ) {
            subscriptionStatus =
              "expired";
          } else if (
            plan === "pro" ||
            plan === "premium"
          ) {
            subscriptionStatus =
              "active";
          }

          const stats =
            userPaymentStats[
              doc.id
            ] || {
              approved: 0,
              total: 0,
              lastAmount: 0,
              lastDate: null,
              lastRequestId: ""
            };

          users.push({
            id: doc.id,

            ...data,

            subscriptionStatus,

            approvedPaymentsCount:
              stats.approved,

            totalPaymentRequests:
              stats.total,

            lastPaymentAmount:
              stats.lastAmount,

            lastPaymentDate:
              stats.lastDate,

            lastPaymentRequestId:
              stats.lastRequestId
          });
        }
      );

      users.sort(
        (a, b) => {
          const getUserTime =
            (value) => {
              if (!value) {
                return 0;
              }

              if (
                typeof value.toDate ===
                "function"
              ) {
                return value
                  .toDate()
                  .getTime();
              }

              if (
                value.seconds
              ) {
                return (
                  Number(
                    value.seconds
                  ) * 1000
                );
              }

              const parsed =
                new Date(
                  value
                ).getTime();

              return Number.isNaN(
                parsed
              )
                ? 0
                : parsed;
            };

          return (
            getUserTime(
              b.createdAt
            ) -
            getUserTime(
              a.createdAt
            )
          );
        }
      );

      return res.json({
        success: true,

        users,

        count:
          users.length
      });
    } catch (error) {
      console.error(
        "Admin users error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to load users"
      });
    }
  }
);

/*
========================================================
ADMIN APPROVE PAYMENT
========================================================
*/

app.post(
  "/api/admin/payment-requests/:id/approve",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const paymentId =
      req.params.id;

    const adminUid =
      req.adminUid;

    try {
      await db.runTransaction(
        async (
          transaction
        ) => {
          const paymentRef =
            db
              .collection(
                "paymentRequests"
              )
              .doc(
                paymentId
              );

          const paymentDoc =
            await transaction.get(
              paymentRef
            );

          if (
            !paymentDoc.exists
          ) {
            throw new Error(
              "PAYMENT_NOT_FOUND"
            );
          }

          const payment =
            paymentDoc.data() ||
            {};

          const currentStatus =
            String(
              payment.status ||
              "pending"
            ).toLowerCase();

          if (
            currentStatus ===
            "approved"
          ) {
            throw new Error(
              "ALREADY_APPROVED"
            );
          }

          if (
            currentStatus ===
            "rejected"
          ) {
            throw new Error(
              "ALREADY_REJECTED"
            );
          }

          if (
            currentStatus !==
            "pending"
          ) {
            throw new Error(
              "INVALID_PAYMENT_STATUS"
            );
          }

          /*
          ==================================================
          PLAN
          ==================================================
          */

          const plan =
            String(
              payment.plan ||
              ""
            )
              .trim()
              .toLowerCase();

          let credits = 0;
          let expectedAmount =
            0;

          if (
            plan === "pro"
          ) {
            credits =
              PRO_CREDITS;

            expectedAmount =
              PRO_PRICE;
          } else if (
            plan ===
            "premium"
          ) {
            credits =
              PREMIUM_CREDITS;

            expectedAmount =
              PREMIUM_PRICE;
          } else {
            throw new Error(
              "INVALID_PLAN"
            );
          }

          /*
          ==================================================
          CURRENCY
          ==================================================
          */

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
            throw new Error(
              "INVALID_CURRENCY"
            );
          }

          /*
          ==================================================
          PAYMENT AMOUNT
          ==================================================
          */

          const paymentAmount =
            Number(
              payment.amount
            );

          if (
            Number.isNaN(
              paymentAmount
            )
          ) {
            throw new Error(
              "INVALID_PAYMENT_AMOUNT"
            );
          }

          if (
            Math.abs(
              paymentAmount -
                expectedAmount
            ) > 0.01
          ) {
            throw new Error(
              "AMOUNT_MISMATCH"
            );
          }

          /*
          ==================================================
          USER
          ==================================================
          */

          if (
            !payment.userId
          ) {
            throw new Error(
              "USER_ID_MISSING"
            );
          }

          const userRef =
            db
              .collection(
                "users"
              )
              .doc(
                payment.userId
              );

          const userDoc =
            await transaction.get(
              userRef
            );

          if (
            !userDoc.exists
          ) {
            throw new Error(
              "USER_NOT_FOUND"
            );
          }

          /*
          ==================================================
          DUPLICATE TRANSACTION CHECK
          ==================================================
          */

          const duplicateQuery =
            db
              .collection(
                "paymentRequests"
              )
              .where(
                "status",
                "==",
                "approved"
              )
              .where(
                "bankName",
                "==",
                payment.bankName
              )
              .where(
                "accountHolderFullName",
                "==",
                payment.accountHolderFullName
              )
              .where(
                "amount",
                "==",
                paymentAmount
              )
              .where(
                "transactionDate",
                "==",
                payment.transactionDate
              )
              .where(
                "transactionTime",
                "==",
                payment.transactionTime
              )
              .limit(10);

          const duplicateSnapshot =
            await transaction.get(
              duplicateQuery
            );

          let duplicateFound =
            false;

          duplicateSnapshot.forEach(
            (
              duplicateDoc
            ) => {
              if (
                duplicateDoc.id !==
                paymentId
              ) {
                duplicateFound =
                  true;
              }
            }
          );

          if (
            duplicateFound
          ) {
            throw new Error(
              "DUPLICATE_TRANSACTION"
            );
          }

          /*
          ==================================================
          30-DAY ENTITLEMENT
          ==================================================
          */

          const approvalDate =
            new Date();

          const newExpiresAt =
            new Date(
              approvalDate.getTime() +
                SUBSCRIPTION_DAYS *
                  24 *
                  60 *
                  60 *
                  1000
            );

          /*
          ==================================================
          UPDATE PAYMENT
          ==================================================
          */

          transaction.update(
            paymentRef,
            {
              status:
                "approved",

              approvedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              approvedBy:
                adminUid,

              approvedPlan:
                plan,

              approvedCredits:
                credits,

              approvedAmount:
                paymentAmount,

              approvedCurrency:
                "USD"
            }
          );

          /*
          ==================================================
          UPDATE USER
          ==================================================
          */

          transaction.set(
            userRef,
            {
              plan,

              subscriptionPlan:
                plan,

              credits,

              creditLimit:
                credits,

              subscriptionStatus:
                "active",

              subscriptionStartedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              subscriptionExpiresAt:
                admin.firestore
                  .Timestamp
                  .fromDate(
                    newExpiresAt
                  ),

              freeVideoAvailable:
                false,

              freeVideoRemaining:
                0,

              freeVideoUsed:
                true,

              lastPaymentAmount:
                paymentAmount,

              lastPaymentRequestId:
                paymentId,

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );
        }
      );

      console.log(
        `Payment approved: ${paymentId} by ${adminUid}`
      );

      return res.json({
        success: true,

        message:
          "Payment approved and user subscription activated.",

        paymentId
      });
    } catch (error) {
      console.error(
        "Approve payment error:",
        error
      );

      let errorMsg =
        "Failed to approve payment";

      if (
        error.message ===
        "PAYMENT_NOT_FOUND"
      ) {
        errorMsg =
          "Payment request not found";
      } else if (
        error.message ===
        "ALREADY_APPROVED"
      ) {
        errorMsg =
          "This payment has already been approved";
      } else if (
        error.message ===
        "ALREADY_REJECTED"
      ) {
        errorMsg =
          "This payment was already rejected";
      } else if (
        error.message ===
        "INVALID_PAYMENT_STATUS"
      ) {
        errorMsg =
          "Payment is not pending";
      } else if (
        error.message ===
        "DUPLICATE_TRANSACTION"
      ) {
        errorMsg =
          "Duplicate transaction detected. This bank transaction was already approved.";
      } else if (
        error.message ===
        "INVALID_PLAN"
      ) {
        errorMsg =
          "Invalid plan specified. Only Pro and Premium are allowed.";
      } else if (
        error.message ===
        "INVALID_CURRENCY"
      ) {
        errorMsg =
          "Payment currency must be USD.";
      } else if (
        error.message ===
        "INVALID_PAYMENT_AMOUNT"
      ) {
        errorMsg =
          "Invalid payment amount.";
      } else if (
        error.message ===
        "AMOUNT_MISMATCH"
      ) {
        errorMsg =
          "Payment amount does not match the selected plan.";
      } else if (
        error.message ===
        "USER_ID_MISSING"
      ) {
        errorMsg =
          "Payment request has no user ID.";
      } else if (
        error.message ===
        "USER_NOT_FOUND"
      ) {
        errorMsg =
          "User account associated with this payment was not found.";
      }

      return res.status(400).json({
        success: false,
        error:
          errorMsg
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
  requireAdmin,
  async (
    req,
    res
  ) => {
    const paymentId =
      req.params.id;

    const adminUid =
      req.adminUid;

    const {
      reason
    } =
      req.body || {};

    if (
      !reason ||
      !String(
        reason
      ).trim()
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Rejection reason is required"
      });
    }

    try {
      const paymentRef =
        db
          .collection(
            "paymentRequests"
          )
          .doc(
            paymentId
          );

      const paymentDoc =
        await paymentRef.get();

      if (
        !paymentDoc.exists
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Payment request not found"
        });
      }

      const payment =
        paymentDoc.data() ||
        {};

      const status =
        String(
          payment.status ||
          "pending"
        ).toLowerCase();

      if (
        status ===
        "approved"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This payment has already been approved"
        });
      }

      if (
        status ===
        "rejected"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This payment has already been rejected"
        });
      }

      if (
        status !==
        "pending"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Payment is not pending"
        });
      }

      await paymentRef.update({
        status:
          "rejected",

        rejectedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        rejectedBy:
          adminUid,

        rejectionReason:
          String(
            reason
          ).trim()
      });

      console.log(
        `Payment rejected: ${paymentId} by ${adminUid}`
      );

      return res.json({
        success: true,

        message:
          "Payment rejected successfully.",

        paymentId
      });
    } catch (error) {
      console.error(
        "Reject payment error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to reject payment"
      });
    }
  }
);

/*
========================================================
PAYMENT / ADMIN ROUTES LOADED CONFIRMATION
========================================================
*/

console.log(
  "============================================================"
);

console.log(
  "GAVEAI PAYMENT & ADMIN ROUTES LOADED"
);

console.log(
  "GET  /api/payment-routes-status"
);

console.log(
  "GET  /api/payment-system-status"
);

console.log(
  "GET  /api/payment-bank-info"
);

console.log(
  "POST /api/payment-requests"
);

console.log(
  "GET  /api/admin/overview"
);

console.log(
  "GET  /api/admin/payments"
);

console.log(
  "GET  /api/admin/users"
);

console.log(
  "POST /api/admin/payment-requests/:id/approve"
);

console.log(
  "POST /api/admin/payment-requests/:id/reject"
);

console.log(
  "============================================================"
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
      "========================================"
    );

    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );

    console.log(
      "Video Provider: Hugging Face (Open Source)"
    );

    console.log(
      "Owner/Admin video mode: UNLIMITED"
    );

    console.log(
      "Video credit cost per clip:",
      VIDEO_CREDIT_COST
    );

    console.log(
      "========================================"
    );
  }
);

/*
========================================================
ADMIN ROUTES
========================================================
*/

app.get("/api/admin/overview", async (req, res) => {
  try {
    const adminUserId = process.env.ADMIN_USER_ID ? process.env.ADMIN_USER_ID.trim() : "";
    const requesterId = req.headers.authorization?.replace("Bearer ", "").trim();

    if (!adminUserId || requesterId !== adminUserId) {
      return res.status(403).json({ success: false, error: "Unauthorized admin access." });
    }

    const usersSnap = await db.collection("users").get();
    const paymentsSnap = await db.collection("paymentRequests").get();

    let totalUsers = usersSnap.size;
    let totalPayments = paymentsSnap.size;
    let pendingPayments = 0;

    paymentsSnap.forEach(doc => {
      const data = doc.data();
      if (data.status === "pending") {
        pendingPayments++;
      }
    });

    return res.json({
      success: true,
      overview: {
        totalUsers,
        totalPayments,
        pendingPayments
      }
    });
  } catch (error) {
    console.error("ADMIN OVERVIEW ERROR:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/payments", async (req, res) => {
  try {
    const adminUserId = process.env.ADMIN_USER_ID ? process.env.ADMIN_USER_ID.trim() : "";
    const requesterId = req.headers.authorization?.replace("Bearer ", "").trim();

    if (!adminUserId || requesterId !== adminUserId) {
      return res.status(403).json({ success: false, error: "Unauthorized admin access." });
    }

    const paymentsSnap = await db.collection("paymentRequests").orderBy("createdAt", "desc").get();
    const payments = [];

    paymentsSnap.forEach(doc => {
      payments.push({ id: doc.id, ...doc.data() });
    });

    return res.json({
      success: true,
      payments
    });
  } catch (error) {
    console.error("ADMIN PAYMENTS ERROR:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/*
========================================================
SERVER START
========================================================
*/

app.listen(PORT, () => {
  console.log(`Gave Money Tips AI Backend is running on port ${PORT} ??`);
});
