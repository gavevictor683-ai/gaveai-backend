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

const { db } = require("./firebaseAdmin");

const app = express();

/*
========================================================
CONFIGURATION
========================================================
*/

const VIDEO_CREDIT_COST = {
  5: 15,
  8: 24
};

const PLAN_CONFIG = {
  free: {
    credits: 0,
    durationDays: 0
  },

  pro: {
    credits: 1200,
    durationDays: 30
  },

  premium: {
    credits: 3000,
    durationDays: 30
  }
};

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

app.get("/video-provider-status", (req, res) => {
  try {
    const status = getVideoProviderStatus();

    return res.json({
      success: true,
      ...status
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

    /*
    ----------------------------------------------------
    CLEAN RESPONSE
    ----------------------------------------------------
    */

    aiReply = aiReply
      .split("*")
      .join("")
      .replace(/##/g, "")
      .replace(/#/g, "")
      .replace(/`/g, "");

    return res.json({
      reply: aiReply,

      webSearchUsed:
        Boolean(result?.webSearchUsed),

      sources:
        Array.isArray(result?.sources)
          ? result.sources.map((s) => ({
              title: s?.title || "",
              url: s?.url || "",
              provider: s?.provider || "",
              official:
                Boolean(s?.official)
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
    "IMAGEKIT VIDEO UPLOAD STARTED | FILE SIZE:",
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

/*
========================================================
CLEANUP GENERATED CLIPS
========================================================
*/

function cleanupGeneratedClips(
  clips
) {
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
GET VIDEO CREDIT COST
========================================================

5 seconds = 15 credits
8 seconds = 24 credits

No other duration is accepted by the GaveAI
credit system for now.
========================================================
*/

function getVideoCreditCost(
  duration
) {
  const normalizedDuration =
    Number(duration);

  if (
    normalizedDuration === 5
  ) {
    return 15;
  }

  if (
    normalizedDuration === 8
  ) {
    return 24;
  }

  throw new Error(
    "Unsupported video duration. Only 5-second and 8-second videos are currently supported."
  );
}

/*
========================================================
GET PLAN CONFIGURATION
========================================================
*/

function getPlanConfig(
  plan
) {
  const normalizedPlan =
    String(plan || "free")
      .trim()
      .toLowerCase();

  return (
    PLAN_CONFIG[normalizedPlan] ||
    PLAN_CONFIG.free
  );
}

/*
========================================================
DATE HELPERS
========================================================
*/

function addDays(
  date,
  days
) {
  const result =
    new Date(date);

  result.setDate(
    result.getDate() + days
  );

  return result;
}

function isSubscriptionExpired(
  expiresAt
) {
  if (!expiresAt) {
    return true;
  }

  const expiration =
    new Date(expiresAt);

  if (
    Number.isNaN(
      expiration.getTime()
    )
  ) {
    return true;
  }

  return (
    expiration.getTime() <=
    Date.now()
  );
}

/*
========================================================
NORMALIZE EXPIRED SUBSCRIPTION
========================================================

IMPORTANT:

When a Pro/Premium subscription expires:

- plan becomes free
- credits become 0
- old credits cannot be used
- credits do not roll over

The user still retains the free-video entitlement
if they never used their original free video.
========================================================
*/

async function normalizeExpiredSubscription(
  userId,
  userData
) {
  if (!userId) {
    return {
      ...userData,
      subscriptionPlan: "free",
      plan: "free",
      credits: 0
    };
  }

  const currentPlan =
    String(
      userData.subscriptionPlan ||
      userData.plan ||
      "free"
    )
      .trim()
      .toLowerCase();

  if (
    currentPlan !== "pro" &&
    currentPlan !== "premium"
  ) {
    return userData;
  }

  if (
    !isSubscriptionExpired(
      userData.subscriptionExpiresAt
    )
  ) {
    return userData;
  }

  const userRef =
    db.collection("users").doc(userId);

  await userRef.set(
    {
      subscriptionPlan: "free",
      plan: "free",
      credits: 0,
      previousSubscriptionPlan:
        currentPlan,
      subscriptionStatus:
        "expired",
      subscriptionExpiredAt:
        new Date().toISOString()
    },
    {
      merge: true
    }
  );

  console.log(
    "SUBSCRIPTION EXPIRED:",
    userId,
    currentPlan
  );

  return {
    ...userData,
    subscriptionPlan: "free",
    plan: "free",
    credits: 0,
    subscriptionStatus: "expired"
  };
}

/*
========================================================
READ USER ENTITLEMENT
========================================================
*/

async function getUserEntitlement(
  userId
) {
  if (!userId) {
    throw new Error(
      "USER_ID_REQUIRED"
    );
  }

  const userRef =
    db.collection("users").doc(userId);

  const userSnap =
    await userRef.get();

  if (!userSnap.exists) {
    return {
      exists: false
    };
  }

  let userData =
    userSnap.data() || {};

  userData =
    await normalizeExpiredSubscription(
      userId,
      userData
    );

  const subscriptionPlan =
    String(
      userData.subscriptionPlan ||
      userData.plan ||
      "free"
    )
      .trim()
      .toLowerCase();

  const credits =
    Number(
      userData.credits ?? 0
    );

  const freeVideoUsed =
    userData.freeVideoUsed === true;

  const subscriptionActive =
    (
      subscriptionPlan === "pro" ||
      subscriptionPlan === "premium"
    ) &&
    !isSubscriptionExpired(
      userData.subscriptionExpiresAt
    );

  return {
    exists: true,

    userData,

    plan:
      subscriptionActive
        ? subscriptionPlan
        : "free",

    credits:
      subscriptionActive
        ? Math.max(0, credits)
        : 0,

    freeVideoUsed,

    freeVideoAvailable:
      !freeVideoUsed,

    subscriptionActive,

    subscriptionExpiresAt:
      subscriptionActive
        ? userData.subscriptionExpiresAt ||
          null
        : null
  };
}

/*
========================================================
RESERVE FREE VIDEO
========================================================

Free user gets exactly ONE successful video.

Reservation prevents two simultaneous requests
from using the same free entitlement.

Reservation is NOT consumption.

If generation/upload fails:
reservation is released.

Only successful generation + successful ImageKit
upload consumes the free video.
========================================================
*/

async function reserveFreeVideo(
  userId
) {
  if (!userId) {
    return {
      allowed: false,
      reason: "USER_ID_REQUIRED"
    };
  }

  const userRef =
    db.collection("users").doc(userId);

  try {
    const result =
      await db.runTransaction(
        async (transaction) => {

          const userSnap =
            await transaction.get(
              userRef
            );

          if (!userSnap.exists) {
            return {
              allowed: false,
              reason: "USER_NOT_FOUND"
            };
          }

          const userData =
            userSnap.data() || {};

          /*
          ----------------------------------------------
          CHECK ACTIVE SUBSCRIPTION
          ----------------------------------------------
          */

          const currentPlan =
            String(
              userData.subscriptionPlan ||
              userData.plan ||
              "free"
            )
              .trim()
              .toLowerCase();

          const activePaidPlan =
            (
              currentPlan === "pro" ||
              currentPlan === "premium"
            ) &&
            !isSubscriptionExpired(
              userData.subscriptionExpiresAt
            );

          if (activePaidPlan) {
            return {
              allowed: false,
              reason:
                "PAID_SUBSCRIPTION_ACTIVE"
            };
          }

          /*
          ----------------------------------------------
          CHECK FREE VIDEO
          ----------------------------------------------
          */

          const freeVideoUsed =
            userData.freeVideoUsed === true;

          const generationInProgress =
            userData.freeVideoGenerationInProgress === true;

          if (freeVideoUsed) {
            return {
              allowed: false,
              reason:
                "FREE_VIDEO_USED"
            };
          }

          if (generationInProgress) {
            return {
              allowed: false,
              reason:
                "VIDEO_GENERATION_IN_PROGRESS"
            };
          }

          /*
          ----------------------------------------------
          RESERVE
          ----------------------------------------------
          */

          transaction.set(
            userRef,
            {
              freeVideoGenerationInProgress:
                true
            },
            {
              merge: true
            }
          );

          return {
            allowed: true,
            reason:
              "FREE_VIDEO_RESERVED"
          };
        }
      );

    return result;

  } catch (error) {
    console.error(
      "FREE VIDEO RESERVATION ERROR:",
      error
    );

    throw error;
  }
}

/*
========================================================
MARK FREE VIDEO SUCCESSFUL
========================================================
*/

async function markFreeVideoSuccessful(
  userId
) {
  if (!userId) {
    return;
  }

  const userRef =
    db.collection("users").doc(userId);

  await userRef.set(
    {
      freeVideoUsed: true,

      freeVideoGenerationInProgress:
        false,

      freeVideoUsedAt:
        new Date().toISOString()
    },
    {
      merge: true
    }
  );

  console.log(
    "FREE VIDEO MARKED AS USED:",
    userId
  );
}

/*
========================================================
RELEASE FREE VIDEO RESERVATION
========================================================
*/

async function releaseFreeVideoReservation(
  userId
) {
  if (!userId) {
    return;
  }

  const userRef =
    db.collection("users").doc(userId);

  try {
    await userRef.set(
      {
        freeVideoGenerationInProgress:
          false
      },
      {
        merge: true
      }
    );

    console.log(
      "FREE VIDEO RESERVATION RELEASED:",
      userId
    );

  } catch (error) {
    console.error(
      "FREE VIDEO RESERVATION RELEASE ERROR:",
      error
    );
  }
}

/*
========================================================
DEDUCT PAID VIDEO CREDITS
========================================================

Atomic transaction.

This prevents two simultaneous video requests
from spending the same credits.
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
    throw new Error(
      "Invalid credit deduction request."
    );
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
        throw new Error(
          "USER_NOT_FOUND"
        );
      }

      const userData =
        userSnap.data() || {};

      const plan =
        String(
          userData.subscriptionPlan ||
          userData.plan ||
          "free"
        )
          .trim()
          .toLowerCase();

      /*
      ----------------------------------------------
      SUBSCRIPTION CHECK
      ----------------------------------------------
      */

      if (
        plan !== "pro" &&
        plan !== "premium"
      ) {
        throw new Error(
          "PAID_SUBSCRIPTION_REQUIRED"
        );
      }

      if (
        isSubscriptionExpired(
          userData.subscriptionExpiresAt
        )
      ) {
        throw new Error(
          "SUBSCRIPTION_EXPIRED"
        );
      }

      const currentCredits =
        Number(
          userData.credits ?? 0
        );

      if (
        currentCredits <
        creditCost
      ) {
        throw new Error(
          "INSUFFICIENT_VIDEO_CREDITS"
        );
      }

      const newBalance =
        currentCredits -
        creditCost;

      transaction.set(
        userRef,
        {
          credits:
            newBalance
        },
        {
          merge: true
        }
      );

      return {
        creditsDeducted:
          creditCost,

        previousCreditBalance:
          currentCredits,

        newCreditBalance:
          newBalance,

        plan
      };
    }
  );
}

/*
========================================================
REFUND PAID VIDEO CREDITS
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
          return;
        }

        const userData =
          userSnap.data() || {};

        /*
        ----------------------------------------------
        DO NOT REFUND INTO AN EXPIRED SUBSCRIPTION
        ----------------------------------------------
        */

        const plan =
          String(
            userData.subscriptionPlan ||
            userData.plan ||
            "free"
          )
            .trim()
            .toLowerCase();

        if (
          plan !== "pro" &&
          plan !== "premium"
        ) {
          return;
        }

        if (
          isSubscriptionExpired(
            userData.subscriptionExpiresAt
          )
        ) {
          return;
        }

        const currentCredits =
          Number(
            userData.credits ?? 0
          );

        transaction.set(
          userRef,
          {
            credits:
              currentCredits +
              creditCost
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

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO PRODUCTION STARTED"
  );

  console.log(
    "PROVIDER: GaveAI Video Provider"
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
    options.duration
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

    const result =
      await generateWithGaveAIVideoProvider({
        prompt:
          currentPrompt,

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
        result.videoUrl,

      provider:
        result.provider,

      model:
        result.model
    });
  }

  return {
    success: true,

    provider:
      firstGeneratedVideo?.provider ||
      "GaveAI Video Provider",

    model:
      firstGeneratedVideo?.model ||
      null,

    productionId,

    clips,

    videoFile:
      firstGeneratedVideo?.videoFile ||
      null
  };
}

/*
========================================================
GENERATE VIDEO ROUTE
========================================================

FINAL GAVEAI VIDEO RULES

FREE:
- One successful video total.

PRO:
- 1,200 credits
- 30 days
- 5s = 15 credits
- 8s = 24 credits

PREMIUM:
- 3,000 credits
- 30 days
- 5s = 15 credits
- 8s = 24 credits

ADMIN:
- Unlimited

NO:
- automatic monthly recharge
- credit rollover
- expired credits
- free-video reuse
========================================================
*/

app.post(
  "/generate-video",
  async (req, res) => {

    /*
    ----------------------------------------------------
    USER INPUT
    ----------------------------------------------------
    */

    const userId =
      typeof req.body?.userId === "string"
        ? req.body.userId.trim()
        : "";

    let prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : "";

    if (
      !prompt &&
      typeof req.body?.message === "string"
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
    ----------------------------------------------------
    PROMPTS
    ----------------------------------------------------
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
              typeof item === "string" &&
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
    ----------------------------------------------------
    VIDEO OPTIONS
    ----------------------------------------------------
    */

    const firstFrameImage =
      typeof req.body?.firstFrameImage === "string"
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

    /*
    ----------------------------------------------------
    CREDIT COST
    ----------------------------------------------------
    */

    let creditCost;

    try {
      creditCost =
        getVideoCreditCost(
          duration
        );
    } catch (durationError) {
      return res.status(400).json({
        success: false,

        code:
          "UNSUPPORTED_VIDEO_DURATION",

        error:
          durationError.message,

        supportedDurations: [
          5,
          8
        ],

        creditCosts: {
          "5": 15,
          "8": 24
        }
      });
    }

    /*
    ----------------------------------------------------
    TOTAL CREDIT COST
    ----------------------------------------------------

    If multiple clips are requested, each clip
    consumes the duration-based cost.
    */

    const totalVideoCreditCost =
      creditCost *
      prompts.length;

    /*
    ----------------------------------------------------
    ADMIN
    ----------------------------------------------------
    */

    const adminUserId =
      process.env.ADMIN_USER_ID
        ? process.env.ADMIN_USER_ID.trim()
        : "";

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
      "USER ID:",
      userId || "anonymous"
    );

    console.log(
      "OWNER / ADMIN:",
      ownerUser
    );

    console.log(
      "DURATION:",
      duration
    );

    console.log(
      "COST PER VIDEO:",
      creditCost
    );

    console.log(
      "TOTAL CREDIT COST:",
      totalVideoCreditCost
    );

    console.log(
      "TOTAL PROMPTS:",
      prompts.length
    );

    console.log(
      "========================================"
    );

    /*
    ----------------------------------------------------
    STATE
    ----------------------------------------------------
    */

    let creditResult =
      null;

    let genResult =
      null;

    let freeVideoReserved =
      false;

    let paidUser =
      false;

    let subscriptionPlan =
      "free";

    try {

      /*
      ==================================================
      1. VIDEO ENTITLEMENT CHECK
      ==================================================
      */

      if (
        ownerUser
      ) {

        /*
        ----------------------------------------------
        ADMIN
        ----------------------------------------------
        */

        creditResult = {
          creditsDeducted: 0,

          newCreditBalance:
            null,

          previousCreditBalance:
            null
        };

        subscriptionPlan =
          "admin";

        console.log(
          "ADMIN VIDEO ACCESS: UNLIMITED"
        );

      } else {

        /*
        ----------------------------------------------
        USER ACCOUNT REQUIRED
        ----------------------------------------------
        */

        if (!userId) {
          return res.status(401).json({
            success: false,

            code:
              "USER_ID_REQUIRED",

            error:
              "You must be signed in to generate a video."
          });
        }

        /*
        ----------------------------------------------
        GET ENTITLEMENT
        ----------------------------------------------
        */

        const entitlement =
          await getUserEntitlement(
            userId
          );

        if (
          !entitlement.exists
        ) {
          return res.status(404).json({
            success: false,

            error:
              "User account was not found."
          });
        }

        subscriptionPlan =
          entitlement.plan;

        /*
        ==============================================
        PAID USER
        ==============================================
        */

        if (
          subscriptionPlan === "pro" ||
          subscriptionPlan === "premium"
        ) {

          paidUser =
            true;

          /*
          --------------------------------------------
          CHECK CREDITS
          --------------------------------------------
          */

          if (
            entitlement.credits <
            totalVideoCreditCost
          ) {
            return res.status(402).json({
              success: false,

              code:
                "INSUFFICIENT_VIDEO_CREDITS",

              error:
                "Your credits are finished or insufficient for this video.",

              requiredCredits:
                totalVideoCreditCost,

              currentCredits:
                entitlement.credits,

              plan:
                subscriptionPlan,

              subscriptionExpiresAt:
                entitlement.subscriptionExpiresAt,

              topUpRequired:
                true
            });
          }

          /*
          --------------------------------------------
          ATOMIC DEDUCTION
          --------------------------------------------
          */

          try {

            creditResult =
              await deductVideoCredits(
                userId,
                totalVideoCreditCost
              );

          } catch (creditError) {

            console.error(
              "VIDEO CREDIT DEDUCTION ERROR:",
              creditError
            );

            if (
              creditError.message ===
              "INSUFFICIENT_VIDEO_CREDITS"
            ) {
              return res.status(402).json({
                success: false,

                code:
                  "INSUFFICIENT_VIDEO_CREDITS",

                error:
                  "Your credits are finished or insufficient for this video.",

                topUpRequired:
                  true
              });
            }

            if (
              creditError.message ===
              "SUBSCRIPTION_EXPIRED"
            ) {
              return res.status(402).json({
                success: false,

                code:
                  "SUBSCRIPTION_EXPIRED",

                error:
                  "Your subscription has expired. Please purchase Pro or Premium again.",

                upgradeRequired:
                  true
              });
            }

            throw creditError;
          }

          console.log(
            "PAID USER PLAN:",
            subscriptionPlan
          );

          console.log(
            "PAID CREDITS DEDUCTED:",
            totalVideoCreditCost
          );

        } else {

          /*
          ============================================
          FREE USER
          ============================================
          */

          console.log(
            "FREE USER VIDEO REQUEST"
          );

          const reservation =
            await reserveFreeVideo(
              userId
            );

          if (
            !reservation.allowed
          ) {

            if (
              reservation.reason ===
              "FREE_VIDEO_USED"
            ) {
              return res.status(402).json({
                success: false,

                code:
                  "FREE_VIDEO_USED",

                error:
                  "You've used your free video generation. Upgrade to Pro or Premium to generate more videos.",

                upgradeRequired:
                  true,

                currentPlan:
                  "free",

                freeVideoAvailable:
                  false
              });
            }

            if (
              reservation.reason ===
              "VIDEO_GENERATION_IN_PROGRESS"
            ) {
              return res.status(409).json({
                success: false,

                code:
                  "VIDEO_GENERATION_IN_PROGRESS",

                error:
                  "A video generation is already in progress. Please wait for it to finish."
              });
            }

            if (
              reservation.reason ===
              "PAID_SUBSCRIPTION_ACTIVE"
            ) {
              return res.status(409).json({
                success: false,

                code:
                  "PAID_SUBSCRIPTION_ACTIVE",

                error:
                  "Your paid subscription is active. Please use your subscription credits."
              });
            }

            if (
              reservation.reason ===
              "USER_NOT_FOUND"
            ) {
              return res.status(404).json({
                success: false,

                error:
                  "User account was not found."
              });
            }

            return res.status(403).json({
              success: false,

              error:
                "You are not eligible for free video generation."
            });
          }

          freeVideoReserved =
            true;

          creditResult = {
            creditsDeducted: 0,

            newCreditBalance:
              0,

            previousCreditBalance:
              0
          };

          subscriptionPlan =
            "free";

          console.log(
            "FREE VIDEO RESERVED:",
            userId
          );
        }
      }

      /*
      ==================================================
      2. GENERATE VIDEO
      ==================================================
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

      } catch (generationError) {

        console.error(
          "VIDEO GENERATION ERROR:",
          generationError
        );

        /*
        ----------------------------------------------
        FREE USER
        ----------------------------------------------
        */

        if (
          freeVideoReserved
        ) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        /*
        ----------------------------------------------
        PAID USER REFUND
        ----------------------------------------------
        */

        if (
          paidUser &&
          userId &&
          creditResult &&
          creditResult.creditsDeducted > 0
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

      /*
      ==================================================
      3. VALIDATE GENERATION RESULT
      ==================================================
      */

      if (
        !genResult ||
        !genResult.success ||
        !genResult.videoFile
      ) {

        if (
          freeVideoReserved
        ) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        if (
          paidUser &&
          userId &&
          creditResult &&
          creditResult.creditsDeducted > 0
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
      ==================================================
      4. UPLOAD TO IMAGEKIT
      ==================================================
      */

      let uploadedVideo;

      try {

        uploadedVideo =
          await uploadGeneratedVideoToImageKit(
            genResult.videoFile,
            genResult.productionId
          );

      } catch (uploadError) {

        console.error(
          "IMAGEKIT GENERATED VIDEO UPLOAD ERROR:",
          uploadError
        );

        /*
        ----------------------------------------------
        FREE USER
        ----------------------------------------------
        */

        if (
          freeVideoReserved
        ) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        /*
        ----------------------------------------------
        PAID USER REFUND
        ----------------------------------------------
        */

        if (
          paidUser &&
          userId &&
          creditResult &&
          creditResult.creditsDeducted > 0
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
            "Video was generated, but uploading failed.",

          details:
            uploadError?.message
        });
      }

      /*
      ==================================================
      5. CONSUME FREE VIDEO
      ==================================================

      Only after:
      - provider generation succeeded
      - ImageKit upload succeeded
      ==================================================
      */

      if (
        freeVideoReserved
      ) {

        try {

          await markFreeVideoSuccessful(
            userId
          );

        } catch (
          entitlementCommitError
        ) {

          /*
          IMPORTANT:
          The video already exists in ImageKit.

          We do NOT release the free entitlement
          automatically here.
          */

          console.error(
            "FREE VIDEO SUCCESS COMMIT ERROR:",
            entitlementCommitError
          );

          cleanupGeneratedClips(
            genResult.clips
          );

          return res.status(500).json({
            success: false,

            error:
              "Video was generated successfully, but the free-video entitlement could not be finalized. Please contact support.",

            productionId:
              genResult.productionId,

            videoUrl:
              uploadedVideo.url
          });
        }
      }

      /*
      ==================================================
      6. CLEANUP LOCAL FILES
      ==================================================
      */

      cleanupGeneratedClips(
        genResult.clips
      );

      /*
      ==================================================
      7. SUCCESS RESPONSE
      ==================================================
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
            genResult.model,

          duration
        },

        subscriptionPlan:
          ownerUser
            ? "admin"
            : subscriptionPlan,

        creditsDeducted:
          creditResult?.creditsDeducted ||
          0,

        newCreditBalance:
          creditResult?.newCreditBalance ??
          null,

        freeVideoUsed:
          ownerUser ||
          paidUser
            ? null
            : true,

        freeVideoAvailable:
          ownerUser ||
          paidUser
            ? null
            : false,

        videoCreditCost:
          creditCost,

        totalVideoCreditCost:
          totalVideoCreditCost
      });

    } catch (error) {

      /*
      ==================================================
      CRITICAL ERROR
      ==================================================
      */

      console.error(
        "GENERATE VIDEO CRITICAL ERROR:",
        error
      );

      /*
      ----------------------------------------------
      RELEASE FREE RESERVATION
      ----------------------------------------------
      */

      if (
        freeVideoReserved
      ) {
        await releaseFreeVideoReservation(
          userId
        );
      }

      /*
      ----------------------------------------------
      REFUND PAID CREDITS
      ----------------------------------------------
      */

      if (
        paidUser &&
        userId &&
        creditResult &&
        creditResult.creditsDeducted > 0
      ) {
        await refundVideoCredits(
          userId,
          creditResult.creditsDeducted
        );
      }

      /*
      ----------------------------------------------
      CLEANUP
      ----------------------------------------------
      */

      cleanupGeneratedClips(
        genResult?.clips
      );

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
START SERVER
========================================================
*/

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {

    let providerStatus = {};

    try {
      providerStatus =
        getVideoProviderStatus() ||
        {};
    } catch (error) {
      console.error(
        "PROVIDER STATUS ERROR:",
        error
      );
    }

    console.log(
      "========================================"
    );

    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );

    console.log(
      "Video Provider:",
      providerStatus?.provider ||
        "GaveAI Video Provider"
    );

    console.log(
      "Video T2V Model:",
      providerStatus?.t2vModel ||
        "Unknown"
    );

    console.log(
      "Video I2V Model:",
      providerStatus?.i2vModel ||
        "Unknown"
    );

    console.log(
      "Video Provider Configured:",
      providerStatus?.configured ||
        false
    );

    console.log(
      "Admin video mode: UNLIMITED"
    );

    console.log(
      "Free video mode: 1 SUCCESSFUL VIDEO"
    );

    console.log(
      "Pro: 1,200 credits / 30 days"
    );

    console.log(
      "Premium: 3,000 credits / 30 days"
    );

    console.log(
      "5-second video: 15 credits"
    );

    console.log(
      "8-second video: 24 credits"
    );

    console.log(
      "Automatic monthly recharge: DISABLED"
    );

    console.log(
      "Credit rollover: DISABLED"
    );

    console.log(
      "Manual top-up: ENABLED VIA PAYMENT SYSTEM"
    );

    console.log(
      "========================================"
    );
  }
);