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
GAVEAI VIDEO ENTITLEMENT SYSTEM
========================================================

FINAL BUSINESS RULES

FREE
- 1 successful free video per new account
- Free video is not credits
- Free video is consumed only after:
    WaveSpeedAI generation succeeds
    AND
    ImageKit upload succeeds
- Failed generation/upload releases the reservation

PRO
- $9.99
- 1,200 credits per 30-day entitlement
- 5 seconds = 15 credits
- 8 seconds = 24 credits
- Expires after 30 days
- Remaining credits do NOT roll over

PREMIUM
- $19.99
- 3,000 credits per 30-day entitlement
- 5 seconds = 15 credits
- 8 seconds = 24 credits
- Expires after 30 days
- Remaining credits do NOT roll over

TOP UP
- Manual payment
- Admin verifies payment
- Approved top-up gives new credits
- New top-up creates a NEW 30-day entitlement
- No automatic monthly recharge
- No rollover
- No waiting for previous expiration when credits are finished

IMPORTANT:
This route ONLY consumes video entitlements.
Payment approval/top-up logic belongs to the admin payment system.
========================================================
*/

/*
========================================================
VIDEO CREDIT PRICING
========================================================
*/

const VIDEO_CREDIT_COSTS = {
  5: 15,
  8: 24
};

function getVideoCreditCost(duration) {
  const normalizedDuration = Number(duration);

  if (normalizedDuration === 5) {
    return VIDEO_CREDIT_COSTS[5];
  }

  if (normalizedDuration === 8) {
    return VIDEO_CREDIT_COSTS[8];
  }

  return null;
}

/*
========================================================
PLAN CONFIGURATION
========================================================
*/

const PLAN_CONFIG = {
  free: {
    price: 0,
    credits: 0,
    durationDays: null
  },

  pro: {
    price: 9.99,
    credits: 1200,
    durationDays: 30
  },

  premium: {
    price: 19.99,
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
UPLOAD MEDIA TO IMAGEKIT
========================================================
*/

app.post(
  "/upload-media",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "No file uploaded. Please provide a file."
        });
      }

      const file = req.file;

      const isVideo =
        file.mimetype.startsWith("video/");

      const isImage =
        file.mimetype.startsWith("image/");

      if (!isVideo && !isImage) {
        return res.status(400).json({
          success: false,
          error:
            "Only image and video files are allowed."
        });
      }

      const extension =
        file.originalname.split(".").pop() ||
        (isVideo ? "mp4" : "jpg");

      const fileName =
        `gaveai-upload-${Date.now()}.${extension}`;

      const folder = isVideo
        ? "gavemoneytips/user-uploads/videos"
        : "gavemoneytips/user-uploads/images";

      const result =
        await imagekit.upload({
          file: file.buffer,
          fileName,
          folder
        });

      if (!result || !result.url) {
        throw new Error(
          "ImageKit did not return a public URL."
        );
      }

      return res.json({
        success: true,
        url: result.url,
        fileId:
          result.fileId || null,
        name:
          result.name || fileName,
        type:
          isVideo ? "video" : "image"
      });

    } catch (error) {
      console.error(
        "IMAGEKIT USER UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Upload failed"
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

  const result =
    await imagekit.upload({
      file: fileBuffer,
      fileName,
      folder:
        "gavemoneytips/generated-videos"
    });

  if (!result || !result.url) {
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

/*
========================================================
CLEANUP GENERATED CLIPS
========================================================
*/

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
    "PROVIDER: WaveSpeedAI"
  );

  console.log(
    "MODEL:",
    getVideoProviderStatus()?.t2vModel ||
      "Unknown"
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
          options.duration,

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
      "WaveSpeedAI",

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
FREE VIDEO RESERVATION
========================================================

ONE FREE VIDEO PER ACCOUNT.

Reservation is temporary.

It becomes consumed ONLY after:
1. Video generation succeeds
2. ImageKit upload succeeds

If either fails:
reservation is released.
========================================================
*/

async function reserveFreeVideo(userId) {
  if (!userId) {
    return {
      allowed: false,
      reason: "USER_ID_REQUIRED"
    };
  }

  const userRef =
    db.collection("users").doc(userId);

  return db.runTransaction(
    async (transaction) => {
      const userSnap =
        await transaction.get(userRef);

      if (!userSnap.exists) {
        return {
          allowed: false,
          reason: "USER_NOT_FOUND"
        };
      }

      const userData =
        userSnap.data() || {};

      const freeVideoUsed =
        userData.freeVideoUsed === true;

      const generationInProgress =
        userData.freeVideoGenerationInProgress === true;

      if (freeVideoUsed) {
        return {
          allowed: false,
          reason: "FREE_VIDEO_USED"
        };
      }

      if (generationInProgress) {
        return {
          allowed: false,
          reason:
            "VIDEO_GENERATION_IN_PROGRESS"
        };
      }

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
}

/*
========================================================
MARK FREE VIDEO SUCCESSFUL
========================================================
*/

async function markFreeVideoSuccessful(userId) {
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

async function releaseFreeVideoReservation(userId) {
  if (!userId) {
    return;
  }

  try {
    const userRef =
      db.collection("users").doc(userId);

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
CHECK PAID SUBSCRIPTION
========================================================

IMPORTANT:
Credits alone are NOT enough.

The paid entitlement must have:
- pro OR premium
- credits > 0
- subscriptionExpiresAt in the future

When expiration passes:
- access is denied
- remaining credits are unusable
- credits are NOT rolled over
- no automatic recharge occurs

The payment/top-up system is responsible for creating
the next 30-day entitlement.
========================================================
*/

function getSubscriptionExpirationDate(userData) {
  const rawExpiration =
    userData.subscriptionExpiresAt;

  if (!rawExpiration) {
    return null;
  }

  if (
    typeof rawExpiration.toDate === "function"
  ) {
    return rawExpiration.toDate();
  }

  if (
    rawExpiration instanceof Date
  ) {
    return rawExpiration;
  }

  const parsed =
    new Date(rawExpiration);

  if (
    Number.isNaN(parsed.getTime())
  ) {
    return null;
  }

  return parsed;
}

function isPaidSubscriptionActive(userData) {
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
    return false;
  }

  const expiration =
    getSubscriptionExpirationDate(
      userData
    );

  if (!expiration) {
    return false;
  }

  return expiration.getTime() > Date.now();
}

/*
========================================================
ATOMIC PAID CREDIT DEDUCTION
========================================================

Prevents two simultaneous requests from spending the
same credits.
========================================================
*/

async function deductPaidVideoCredits(
  userId,
  creditCost
) {
  const userRef =
    db.collection("users").doc(userId);

  return db.runTransaction(
    async (transaction) => {
      const userSnap =
        await transaction.get(userRef);

      if (!userSnap.exists) {
        return {
          success: false,
          reason: "USER_NOT_FOUND"
        };
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

      if (
        plan !== "pro" &&
        plan !== "premium"
      ) {
        return {
          success: false,
          reason:
            "PAID_SUBSCRIPTION_REQUIRED"
        };
      }

      const expiration =
        getSubscriptionExpirationDate(
          userData
        );

      if (
        !expiration ||
        expiration.getTime() <= Date.now()
      ) {
        return {
          success: false,
          reason:
            "SUBSCRIPTION_EXPIRED"
        };
      }

      const currentCredits =
        Number(
          userData.credits ?? 0
        );

      if (
        currentCredits < creditCost
      ) {
        return {
          success: false,
          reason:
            "INSUFFICIENT_CREDITS",
          currentCredits
        };
      }

      const newCreditBalance =
        currentCredits -
        creditCost;

      transaction.set(
        userRef,
        {
          credits:
            newCreditBalance
        },
        {
          merge: true
        }
      );

      return {
        success: true,
        plan,
        previousCreditBalance:
          currentCredits,
        newCreditBalance,
        creditsDeducted:
          creditCost,
        subscriptionExpiresAt:
          expiration.toISOString()
      };
    }
  );
}

/*
========================================================
ATOMIC PAID CREDIT REFUND
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
          await transaction.get(userRef);

        if (!userSnap.exists) {
          return;
        }

        const userData =
          userSnap.data() || {};

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
      "PAID VIDEO CREDITS REFUNDED:",
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
GENERATE VIDEO
========================================================
*/

app.post(
  "/generate-video",
  async (req, res) => {

    let userId =
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
            /^\/generate-video\s*/i,
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
      Array.isArray(req.body?.prompts) &&
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
    ONLY 5s AND 8s ARE SUPPORTED BY GAVEAI PRICING
    ----------------------------------------------------
    */

    const creditCost =
      getVideoCreditCost(duration);

    if (!creditCost) {
      return res.status(400).json({
        success: false,
        code:
          "UNSUPPORTED_VIDEO_DURATION",
        error:
          "Video duration must be either 5 seconds or 8 seconds.",
        supportedDurations: [5, 8],
        pricing: {
          "5": 15,
          "8": 24
        }
      });
    }

    /*
    ----------------------------------------------------
    ADMIN / OWNER
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

    /*
    ----------------------------------------------------
    STATE
    ----------------------------------------------------
    */

    let creditResult = null;
    let genResult = null;

    let freeVideoReserved = false;
    let paidUser = false;

    let subscriptionPlan =
      "free";

    try {

      /*
      ==================================================
      1. VIDEO ENTITLEMENT
      ==================================================
      */

      if (!ownerUser && userId) {

        const userRef =
          db.collection("users").doc(userId);

        const userSnap =
          await userRef.get();

        if (!userSnap.exists) {
          return res.status(404).json({
            success: false,
            error:
              "User account was not found."
          });
        }

        const userData =
          userSnap.data() || {};

        subscriptionPlan =
          String(
            userData.subscriptionPlan ||
            userData.plan ||
            "free"
          )
            .trim()
            .toLowerCase();

        /*
        ==================================================
        PAID PLAN
        ==================================================
        */

        if (
          subscriptionPlan === "pro" ||
          subscriptionPlan === "premium"
        ) {

          paidUser = true;

          /*
          ------------------------------------------------
          ATOMIC CREDIT CHECK + DEDUCTION
          ------------------------------------------------
          */

          creditResult =
            await deductPaidVideoCredits(
              userId,
              creditCost
            );

          if (
            !creditResult.success
          ) {

            if (
              creditResult.reason ===
              "SUBSCRIPTION_EXPIRED"
            ) {
              return res.status(402).json({
                success: false,
                code:
                  "SUBSCRIPTION_EXPIRED",
                error:
                  "Your subscription has expired. Please purchase Pro or Premium again to continue generating videos.",
                currentPlan:
                  subscriptionPlan,
                currentCredits:
                  Number(
                    userData.credits ?? 0
                  )
              });
            }

            if (
              creditResult.reason ===
              "INSUFFICIENT_CREDITS"
            ) {
              return res.status(402).json({
                success: false,
                code:
                  "INSUFFICIENT_VIDEO_CREDITS",
                error:
                  "Your video credits are finished. Top Up to continue generating videos.",
                currentPlan:
                  subscriptionPlan,
                requiredCredits:
                  creditCost,
                currentCredits:
                  creditResult.currentCredits,
                duration,
                pricing: {
                  "5": 15,
                  "8": 24
                }
              });
            }

            if (
              creditResult.reason ===
              "PAID_SUBSCRIPTION_REQUIRED"
            ) {
              return res.status(402).json({
                success: false,
                code:
                  "PAID_SUBSCRIPTION_REQUIRED",
                error:
                  "An active Pro or Premium subscription is required."
              });
            }

            return res.status(403).json({
              success: false,
              error:
                "You are not eligible for paid video generation."
            });
          }

          console.log(
            "PAID VIDEO CREDIT DEDUCTION:",
            {
              plan:
                creditResult.plan,
              duration,
              creditCost,
              newBalance:
                creditResult.newCreditBalance
            }
          );

        } else {

          /*
          ==================================================
          FREE USER
          ==================================================
          */

          subscriptionPlan =
            "free";

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
            newCreditBalance: 0
          };

          console.log(
            "FREE VIDEO RESERVED:",
            userId
          );
        }

      } else {

        /*
        ==================================================
        ADMIN
        ==================================================
        */

        creditResult = {
          creditsDeducted: 0,
          newCreditBalance: null
        };

        console.log(
          ownerUser
            ? "ADMIN VIDEO ACCESS: UNLIMITED"
            : "ANONYMOUS VIDEO REQUEST"
        );
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
          "WAVESPEED VIDEO GENERATION ERROR:",
          generationError
        );

        /*
        ------------------------------------------------
        FREE USER
        ------------------------------------------------
        */

        if (freeVideoReserved) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        /*
        ------------------------------------------------
        PAID USER
        ------------------------------------------------
        */

        if (
          paidUser &&
          userId &&
          creditResult?.creditsDeducted > 0
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
      3. VALIDATE GENERATION
      ==================================================
      */

      if (
        !genResult ||
        !genResult.success ||
        !genResult.videoFile
      ) {

        if (freeVideoReserved) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        if (
          paidUser &&
          userId &&
          creditResult?.creditsDeducted > 0
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
        FREE:
        Reservation remains available.
        */

        if (freeVideoReserved) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        /*
        PAID:
        Refund exact cost used.
        */

        if (
          paidUser &&
          userId &&
          creditResult?.creditsDeducted > 0
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
      */

      if (freeVideoReserved) {

        try {

          await markFreeVideoSuccessful(
            userId
          );

        } catch (entitlementError) {

          /*
          IMPORTANT:
          Video already exists in ImageKit.
          Do NOT automatically give another free video.
          */

          console.error(
            "FREE VIDEO SUCCESS COMMIT ERROR:",
            entitlementError
          );

          cleanupGeneratedClips(
            genResult.clips
          );

          return res.status(500).json({
            success: false,
            error:
              "Video was generated successfully, but the free video entitlement could not be finalized. Please contact support.",
            productionId:
              genResult.productionId,
            videoUrl:
              uploadedVideo.url
          });
        }
      }

      /*
      ==================================================
      6. CLEANUP
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

      let remainingCredits = null;

      let expiresAt = null;

      if (
        paidUser &&
        creditResult
      ) {
        remainingCredits =
          creditResult.newCreditBalance;

        expiresAt =
          creditResult.subscriptionExpiresAt;
      }

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

        /*
        ----------------------------------------------
        PLAN
        ----------------------------------------------
        */

        subscriptionPlan:
          ownerUser
            ? "admin"
            : subscriptionPlan,

        /*
        ----------------------------------------------
        VIDEO PRICING
        ----------------------------------------------
        */

        duration,

        creditsCost:
          ownerUser || !paidUser
            ? 0
            : creditCost,

        /*
        ----------------------------------------------
        CREDITS
        ----------------------------------------------
        */

        creditsDeducted:
          creditResult?.creditsDeducted ||
          0,

        newCreditBalance:
          remainingCredits,

        /*
        ----------------------------------------------
        EXPIRATION
        ----------------------------------------------
        */

        subscriptionExpiresAt:
          expiresAt,

        /*
        ----------------------------------------------
        FREE VIDEO
        ----------------------------------------------
        */

        freeVideoUsed:
          ownerUser || paidUser
            ? null
            : true,

        freeVideoAvailable:
          ownerUser || paidUser
            ? null
            : false
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

      if (freeVideoReserved) {
        await releaseFreeVideoReservation(
          userId
        );
      }

      if (
        paidUser &&
        userId &&
        creditResult?.creditsDeducted > 0
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

    const providerStatus =
      getVideoProviderStatus();

    console.log(
      "========================================"
    );

    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );

    console.log(
      "Video Provider:",
      providerStatus?.provider ||
        "WaveSpeedAI"
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
      "Owner/Admin video mode: UNLIMITED"
    );

    console.log(
      "Free video mode: 1 SUCCESSFUL VIDEO"
    );

    console.log(
      "5-second video: 15 credits"
    );

    console.log(
      "8-second video: 24 credits"
    );

    console.log(
      "Paid subscription: 30-DAY ENTITLEMENT"
    );

    console.log(
      "Credits rollover: DISABLED"
    );

    console.log(
      "Automatic monthly recharge: DISABLED"
    );

    console.log(
      "Manual top-up: ENABLED BY PAYMENT SYSTEM"
    );

    console.log(
      "========================================"
    );
  }
);

