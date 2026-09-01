require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");

const {
  generateAIResponse
} = require("./services/groqService");

const {
  generateWithGaveAIVideoProvider,
  getVideoProviderStatus
} = require("./services/gaveaiVideoProviderService");

const {
  db
} = require("./firebaseAdmin");

const {
  requireAuth,
  requireAdmin
} = require("./middleware/authMiddleware");

const paymentRoutes =
  require("./routes/paymentRoutes");

const app = express();

/*
========================================================
CONFIGURATION
========================================================
*/

const FREE_VIDEO_DURATION = 5;

const PRO_CREDITS = 1200;
const PREMIUM_CREDITS = 3000;

const PRO_PLAN = "pro";
const PREMIUM_PLAN = "premium";
const FREE_PLAN = "free";
const ADMIN_PLAN = "admin";

const SUBSCRIPTION_DURATION_DAYS = 30;

/*
========================================================
VIDEO CREDIT PRICING
========================================================

5 seconds = 15 credits
8 seconds = 24 credits

Do NOT use a single fixed VIDEO_CREDIT_COST anymore.
========================================================
*/

function getVideoCreditCost(duration) {
  const seconds = Number(duration);

  if (seconds === 5) {
    return 15;
  }

  if (seconds === 8) {
    return 24;
  }

  throw new Error(
    "Invalid video duration. Only 5-second and 8-second videos are supported."
  );
}

/*
========================================================
PLAN CONFIGURATION
========================================================
*/

function getPlanCredits(plan) {
  const normalizedPlan =
    String(plan || "")
      .trim()
      .toLowerCase();

  if (normalizedPlan === PRO_PLAN) {
    return PRO_CREDITS;
  }

  if (normalizedPlan === PREMIUM_PLAN) {
    return PREMIUM_CREDITS;
  }

  return 0;
}

function getPlanName(plan) {
  const normalizedPlan =
    String(plan || "")
      .trim()
      .toLowerCase();

  if (
    normalizedPlan === PRO_PLAN ||
    normalizedPlan === PREMIUM_PLAN
  ) {
    return normalizedPlan;
  }

  return FREE_PLAN;
}

/*
========================================================
DATE HELPERS
========================================================
*/

function addDays(date, days) {
  const result = new Date(date);

  result.setDate(
    result.getDate() + days
  );

  return result;
}

function isValidDate(value) {
  if (!value) {
    return false;
  }

  const date = new Date(value);

  return !Number.isNaN(
    date.getTime()
  );
}

/*
========================================================
FILE UPLOAD
========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize:
      50 * 1024 * 1024
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

app.use(
  cors({
    origin: function (
      origin,
      callback
    ) {
      if (
        !origin ||
        allowedOrigins.includes(origin)
      ) {
        return callback(
          null,
          true
        );
      }

      return callback(
        new Error(
          "CORS origin not allowed"
        )
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

app.use(
  (
    req,
    res,
    next
  ) => {
    const origin =
      req.headers.origin;

    if (
      allowedOrigins.includes(
        origin
      )
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

    if (
      req.method ===
      "OPTIONS"
    ) {
      return res.sendStatus(
        204
      );
    }

    next();
  }
);

app.use(
  express.json({
    limit: "10mb"
  })
);

/*
========================================================
PAYMENT ROUTES
========================================================

Manual payment system:

User submits payment request
        ↓
Firebase paymentRequests
        ↓
Admin verifies bank transaction
        ↓
Admin approves
        ↓
Backend activates / renews entitlement
========================================================
*/

app.use(
  "/api/payments",
  paymentRoutes
);

/*
========================================================
AUTHENTICATION TEST
========================================================
*/

app.get(
  "/auth-test",
  requireAuth,
  (
    req,
    res
  ) => {
    return res.json({
      success: true,

      authenticated: true,

      user: {
        uid:
          req.user.uid,

        email:
          req.user.email,

        name:
          req.user.name,

        emailVerified:
          req.user.emailVerified
      }
    });
  }
);

/*
========================================================
HEALTH CHECK
========================================================
*/

app.get(
  "/",
  (
    req,
    res
  ) => {
    res.send(
      "Gave Money Tips AI Backend is running 🚀"
    );
  }
);

/*
========================================================
VIDEO PROVIDER STATUS
========================================================
*/

app.get(
  "/video-provider-status",
  (
    req,
    res
  ) => {
    try {
      const status =
        getVideoProviderStatus();

      return res.json({
        success: true,
        ...status
      });
    } catch (
      error
    ) {
      console.error(
        "VIDEO PROVIDER STATUS ERROR:",
        error
      );

      return res.status(
        500
      ).json({
        success: false,

        error:
          error?.message ||
          "Unable to get video provider status."
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
  async (
    req,
    res
  ) => {
    try {
      const userMessage =
        req.body.message;

      if (
        !userMessage ||
        typeof userMessage !==
          "string"
      ) {
        return res.status(
          400
        ).json({
          error:
            "Message is required"
        });
      }

      const result =
        await generateAIResponse(
          userMessage
        );

      let aiReply =
        typeof result ===
        "string"
          ? result
          : (
              result?.reply ||
              result?.message ||
              ""
            );

      /*
      ----------------------------------------------------
      RESPONSE CLEANUP
      ----------------------------------------------------
      */

      aiReply =
        aiReply
          .split("*")
          .join("")
          .replace(
            /##/g,
            ""
          )
          .replace(
            /#/g,
            ""
          )
          .replace(
            /`/g,
            ""
          );

      return res.json({
        reply:
          aiReply,

        webSearchUsed:
          Boolean(
            result?.webSearchUsed
          ),

        sources:
          Array.isArray(
            result?.sources
          )
            ? result.sources.map(
                (s) => ({
                  title:
                    s?.title ||
                    "",

                  url:
                    s?.url ||
                    "",

                  provider:
                    s?.provider ||
                    "",

                  official:
                    Boolean(
                      s?.official
                    )
                })
              )
            : []
      });
    } catch (
      error
    ) {
      console.error(
        "GROQ ERROR:",
        error
      );

      return res.status(
        500
      ).json({
        error:
          error?.message ||
          "AI request failed"
      });
    }
  }
);

/*
========================================================
UPLOAD MEDIA TO IMAGEKIT
========================================================
*/

app.post(
  "/upload-media",
  upload.single("file"),
  async (
    req,
    res
  ) => {
    try {
      if (!req.file) {
        return res.status(
          400
        ).json({
          success: false,

          error:
            "No file uploaded. Please provide a file."
        });
      }

      const file =
        req.file;

      const isVideo =
        file.mimetype.startsWith(
          "video/"
        );

      const isImage =
        file.mimetype.startsWith(
          "image/"
        );

      if (
        !isVideo &&
        !isImage
      ) {
        return res.status(
          400
        ).json({
          success: false,

          error:
            "Only image and video files are allowed."
        });
      }

      const extension =
        file.originalname
          .split(".")
          .pop() ||
        (
          isVideo
            ? "mp4"
            : "jpg"
        );

      const fileName =
        `gaveai-upload-${Date.now()}.${extension}`;

      const folder =
        isVideo
          ? "gavemoneytips/user-uploads/videos"
          : "gavemoneytips/user-uploads/images";

      console.log(
        "========================================"
      );

      console.log(
        "IMAGEKIT USER UPLOAD STARTED | FILE SIZE:",
        file.size
      );

      console.log(
        "FOLDER:",
        folder
      );

      console.log(
        "========================================"
      );

      const result =
        await imagekit.upload({
          file:
            file.buffer,

          fileName,

          folder
        });

      if (
        !result ||
        !result.url
      ) {
        throw new Error(
          "ImageKit did not return a public URL."
        );
      }

      return res.json({
        success: true,

        url:
          result.url,

        fileId:
          result.fileId ||
          null,

        name:
          result.name ||
          fileName,

        type:
          isVideo
            ? "video"
            : "image"
      });
    } catch (
      error
    ) {
      console.error(
        "IMAGEKIT USER UPLOAD ERROR:",
        error
      );

      return res.status(
        500
      ).json({
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
    !fs.existsSync(
      filePath
    )
  ) {
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
    "IMAGEKIT VIDEO UPLOAD STARTED | FILE SIZE:",
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

  return {
    url:
      result.url,

    fileId:
      result.fileId ||
      null,

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
      fs.existsSync(
        filePath
      )
    ) {
      fs.unlinkSync(
        filePath
      );

      console.log(
        "LOCAL VIDEO DELETED:",
        filePath
      );
    }
  } catch (
    error
  ) {
    console.warn(
      "VIDEO DELETE WARNING:",
      error?.message ||
        error
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
  if (
    !Array.isArray(
      clips
    )
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
GAVEAI VIDEO PRODUCTION
========================================================
*/

async function generateGaveAIVideoProduction(
  prompts,
  options = {}
) {
  if (
    !Array.isArray(
      prompts
    ) ||
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
    "PROVIDER: WaveSpeedAI"
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
      `GENERATING CLIP ${i + 1}/${prompts.length} | PROMPT: ${currentPrompt}`
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
          options.width ||
          832,

        height:
          options.height ||
          480,

        duration:
          options.duration ||
          5,

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
        `Video clip ${i + 1} failed.`
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

Free users get ONE successful 5-second video.

Reservation happens BEFORE generation.

Reservation is NOT consumption.

Only successful generation + ImageKit upload
consumes the free video.

If generation/upload fails, reservation is released.
========================================================
*/

async function reserveFreeVideo(
  userId
) {
  if (!userId) {
    return {
      allowed:
        false,

      reason:
        "USER_ID_REQUIRED"
    };
  }

  const userRef =
    db.collection(
      "users"
    ).doc(
      userId
    );

  const result =
    await db.runTransaction(
      async (
        transaction
      ) => {
        const userSnap =
          await transaction.get(
            userRef
          );

        if (
          !userSnap.exists
        ) {
          return {
            allowed:
              false,

            reason:
              "USER_NOT_FOUND"
          };
        }

        const userData =
          userSnap.data() ||
          {};

        const freeVideoUsed =
          userData.freeVideoUsed ===
          true;

        const generationInProgress =
          userData.freeVideoGenerationInProgress ===
          true;

        /*
        --------------------------------------------------
        FREE VIDEO ALREADY USED
        --------------------------------------------------
        */

        if (
          freeVideoUsed
        ) {
          return {
            allowed:
              false,

            reason:
              "FREE_VIDEO_USED"
          };
        }

        /*
        --------------------------------------------------
        ANOTHER FREE VIDEO IS GENERATING
        --------------------------------------------------
        */

        if (
          generationInProgress
        ) {
          return {
            allowed:
              false,

            reason:
              "VIDEO_GENERATION_IN_PROGRESS"
          };
        }

        /*
        --------------------------------------------------
        RESERVE
        --------------------------------------------------
        */

        transaction.set(
          userRef,
          {
            freeVideoGenerationInProgress:
              true
          },
          {
            merge:
              true
          }
        );

        return {
          allowed:
            true,

          reason:
            "FREE_VIDEO_RESERVED"
        };
      }
    );

  return result;
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
    db.collection(
      "users"
    ).doc(
      userId
    );

  await userRef.set(
    {
      freeVideoUsed:
        true,

      freeVideoGenerationInProgress:
        false,

      freeVideoUsedAt:
        new Date().toISOString()
    },
    {
      merge:
        true
    }
  );

  console.log(
    "========================================"
  );

  console.log(
    "FREE VIDEO MARKED AS USED:",
    userId
  );

  console.log(
    "========================================"
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
    db.collection(
      "users"
    ).doc(
      userId
    );

  try {
    await userRef.set(
      {
        freeVideoGenerationInProgress:
          false
      },
      {
        merge:
          true
      }
    );

    console.log(
      "FREE VIDEO RESERVATION RELEASED:",
      userId
    );
  } catch (
    error
  ) {
    console.error(
      "FREE VIDEO RESERVATION RELEASE ERROR:",
      error
    );
  }
}

/*
========================================================
EXPIRE SUBSCRIPTION IF NEEDED
========================================================

Important:

When 30 days are finished:

plan -> free
subscriptionStatus -> expired
credits -> 0

Remaining credits are permanently unavailable.

Free video status is NOT reset.
========================================================
*/

async function normalizeSubscription(
  userId,
  userData
) {
  const plan =
    getPlanName(
      userData.subscriptionPlan ||
      userData.plan ||
      FREE_PLAN
    );

  if (
    plan === FREE_PLAN
  ) {
    return {
      plan:
        FREE_PLAN,

      credits:
        0,

      expired:
        false,

      userData
    };
  }

  const expiresAt =
    userData.subscriptionExpiresAt;

  if (
    !isValidDate(
      expiresAt
    )
  ) {
    return {
      plan,

      credits:
        Number(
          userData.credits ||
          0
        ),

      expired:
        false,

      userData
    };
  }

  const expirationDate =
    new Date(
      expiresAt
    );

  const now =
    new Date();

  if (
    now < expirationDate
  ) {
    return {
      plan,

      credits:
        Number(
          userData.credits ||
          0
        ),

      expired:
        false,

      userData
    };
  }

  /*
  ------------------------------------------------------
  SUBSCRIPTION EXPIRED
  ------------------------------------------------------
  */

  const userRef =
    db.collection(
      "users"
    ).doc(
      userId
    );

  await userRef.set(
    {
      subscriptionPlan:
        FREE_PLAN,

      plan:
        FREE_PLAN,

      subscriptionStatus:
        "expired",

      credits:
        0,

      planCreditsLimit:
        0,

      subscriptionExpiredAt:
        new Date().toISOString()
    },
    {
      merge:
        true
    }
  );

  console.log(
    "SUBSCRIPTION EXPIRED:",
    userId,
    plan
  );

  return {
    plan:
      FREE_PLAN,

    credits:
      0,

    expired:
      true,

    userData: {
      ...userData,

      subscriptionPlan:
        FREE_PLAN,

      plan:
        FREE_PLAN,

      credits:
        0
    }
  };
}

/*
========================================================
GET USER VIDEO ENTITLEMENT
========================================================
*/

async function getUserVideoEntitlement(
  userId
) {
  if (!userId) {
    throw new Error(
      "USER_ID_REQUIRED"
    );
  }

  const userRef =
    db.collection(
      "users"
    ).doc(
      userId
    );

  const userSnap =
    await userRef.get();

  if (
    !userSnap.exists
  ) {
    return {
      exists:
        false
    };
  }

  const userData =
    userSnap.data() ||
    {};

  const normalized =
    await normalizeSubscription(
      userId,
      userData
    );

  const refreshedSnap =
    normalized.expired
      ? await userRef.get()
      : userSnap;

  const refreshedData =
    refreshedSnap.exists
      ? (
          refreshedSnap.data() ||
          {}
        )
      : userData;

  return {
    exists:
      true,

    plan:
      normalized.plan,

    credits:
      Number(
        refreshedData.credits ||
        0
      ),

    planCreditsLimit:
      Number(
        refreshedData.planCreditsLimit ||
        getPlanCredits(
          normalized.plan
        )
      ),

    subscriptionStatus:
      refreshedData.subscriptionStatus ||
      (
        normalized.plan ===
        FREE_PLAN
          ? "free"
          : "active"
      ),

    subscriptionExpiresAt:
      refreshedData.subscriptionExpiresAt ||
      null,

    freeVideoUsed:
      refreshedData.freeVideoUsed ===
      true,

    freeVideoGenerationInProgress:
      refreshedData.freeVideoGenerationInProgress ===
      true,

    userData:
      refreshedData
  };
}

/*
========================================================
DEDUCT PAID VIDEO CREDITS
========================================================

Uses a Firestore transaction.

This prevents two simultaneous requests from spending
the same credits.
========================================================
*/

async function deductVideoCredits(
  userId,
  creditCost
) {
  if (
    !userId ||
    !Number.isFinite(
      creditCost
    ) ||
    creditCost <= 0
  ) {
    throw new Error(
      "Invalid credit deduction request."
    );
  }

  const userRef =
    db.collection(
      "users"
    ).doc(
      userId
    );

  return await db.runTransaction(
    async (
      transaction
    ) => {
      const userSnap =
        await transaction.get(
          userRef
        );

      if (
        !userSnap.exists
      ) {
        throw new Error(
          "USER_NOT_FOUND"
        );
      }

      const userData =
        userSnap.data() ||
        {};

      const plan =
        getPlanName(
          userData.subscriptionPlan ||
          userData.plan
        );

      if (
        plan !== PRO_PLAN &&
        plan !== PREMIUM_PLAN
      ) {
        throw new Error(
          "SUBSCRIPTION_REQUIRED"
        );
      }

      const expiresAt =
        userData.subscriptionExpiresAt;

      if (
        !isValidDate(
          expiresAt
        )
      ) {
        throw new Error(
          "SUBSCRIPTION_EXPIRATION_INVALID"
        );
      }

      if (
        new Date() >=
        new Date(
          expiresAt
        )
      ) {
        throw new Error(
          "SUBSCRIPTION_EXPIRED"
        );
      }

      const currentCredits =
        Number(
          userData.credits ||
          0
        );

      if (
        currentCredits <
        creditCost
      ) {
        throw new Error(
          "INSUFFICIENT_CREDITS"
        );
      }

      const newBalance =
        currentCredits -
        creditCost;

      transaction.update(
        userRef,
        {
          credits:
            newBalance,

          lastVideoCreditCost:
            creditCost,

          lastVideoCreditDeductedAt:
            new Date().toISOString()
        }
      );

      return {
        plan,

        creditsDeducted:
          creditCost,

        previousCreditBalance:
          currentCredits,

        newCreditBalance:
          newBalance
      };
    }
  );
}

/*
========================================================
REFUND PAID VIDEO CREDITS
========================================================

If generation or ImageKit fails after credits were
deducted, restore exactly the amount deducted.

This is NOT the old credit system.

It is simply transactional failure recovery.
========================================================
*/

async function refundVideoCredits(
  userId,
  creditCost
) {
  if (
    !userId ||
    !Number.isFinite(
      creditCost
    ) ||
    creditCost <= 0
  ) {
    return;
  }

  try {
    const userRef =
      db.collection(
        "users"
      ).doc(
        userId
      );

    await db.runTransaction(
      async (
        transaction
      ) => {
        const userSnap =
          await transaction.get(
            userRef
          );

        if (
          !userSnap.exists
        ) {
          return;
        }

        const userData =
          userSnap.data() ||
          {};

        const currentCredits =
          Number(
            userData.credits ||
            0
          );

        transaction.update(
          userRef,
          {
            credits:
              currentCredits +
              creditCost,

            lastVideoCreditRefund:
              creditCost,

            lastVideoCreditRefundedAt:
              new Date().toISOString()
          }
        );
      }
    );

    console.log(
      "VIDEO CREDITS REFUNDED:",
      creditCost
    );
  } catch (
    error
  ) {
    console.error(
      "VIDEO CREDIT REFUND ERROR:",
      error
    );
  }
}

/*
========================================================
GENERATE VIDEO ROUTE
========================================================
*/

app.post(
  "/generate-video",
  requireAuth,
  async (
    req,
    res
  ) => {
    let userId =
      req.user?.uid ||
      "";

    userId =
      String(
        userId
      ).trim();

    /*
    ----------------------------------------------------
    USER PROMPT
    ----------------------------------------------------
    */

    let prompt =
      typeof req.body?.prompt ===
      "string"
        ? req.body.prompt.trim()
        : "";

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
      req.body.prompts.length >
        0
    ) {
      prompts =
        req.body.prompts
          .filter(
            (
              item
            ) =>
              typeof item ===
                "string" &&
              item.trim()
          )
          .map(
            (
              item
            ) =>
              item.trim()
          );
    }

    if (
      prompts.length === 0 &&
      prompt
    ) {
      prompts = [
        prompt
      ];
    }

    if (
      prompts.length === 0
    ) {
      return res.status(
        400
      ).json({
        success:
          false,

        error:
          "At least one video prompt is required."
      });
    }

    if (
      prompts.length > 20
    ) {
      return res.status(
        400
      ).json({
        success:
          false,

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
      typeof req.body?.firstFrameImage ===
      "string"
        ? req.body.firstFrameImage.trim()
        : undefined;

    const width =
      Number(
        req.body?.width
      ) ||
      832;

    const height =
      Number(
        req.body?.height
      ) ||
      480;

    const duration =
      Number(
        req.body?.duration
      ) ||
      5;

    /*
    ----------------------------------------------------
    ONLY 5s AND 8s
    ----------------------------------------------------
    */

    if (
      duration !== 5 &&
      duration !== 8
    ) {
      return res.status(
        400
      ).json({
        success:
          false,

        code:
          "INVALID_VIDEO_DURATION",

        error:
          "Only 5-second and 8-second videos are supported.",

        supportedDurations:
          [5, 8]
      });
    }

    const creditCost =
      getVideoCreditCost(
        duration
      );

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
        userId ===
          adminUserId
      );

    console.log(
      "========================================"
    );

    console.log(
      "GENERATE VIDEO REQUEST"
    );

    console.log(
      "PROVIDER: WaveSpeedAI"
    );

    console.log(
      "USER ID:",
      userId
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
      "CREDIT COST:",
      creditCost
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

    let paidVideoCreditsDeducted =
      false;

    let subscriptionPlan =
      FREE_PLAN;

    /*
    ====================================================
    1. CHECK VIDEO ENTITLEMENT
    ====================================================
    */

    try {
      /*
      --------------------------------------------------
      ADMIN
      --------------------------------------------------
      */

      if (
        ownerUser
      ) {
        subscriptionPlan =
          ADMIN_PLAN;

        creditResult = {
          creditsDeducted:
            0,

          newCreditBalance:
            null,

          previousCreditBalance:
            null
        };

        console.log(
          "ADMIN VIDEO ACCESS: UNLIMITED"
        );
      } else {
        /*
        ------------------------------------------------
        GET USER ENTITLEMENT
        ------------------------------------------------
        */

        const entitlement =
          await getUserVideoEntitlement(
            userId
          );

        if (
          !entitlement.exists
        ) {
          return res.status(
            404
          ).json({
            success:
              false,

            error:
              "User account was not found."
          });
        }

        subscriptionPlan =
          entitlement.plan;

        /*
        ================================================
        PAID USER
        ================================================
        */

        if (
          subscriptionPlan ===
            PRO_PLAN ||
          subscriptionPlan ===
            PREMIUM_PLAN
        ) {
          /*
          ----------------------------------------------
          CHECK EXPIRATION
          ----------------------------------------------
          */

          if (
            entitlement.subscriptionStatus ===
              "expired"
          ) {
            return res.status(
              402
            ).json({
              success:
                false,

              code:
                "SUBSCRIPTION_EXPIRED",

              error:
                "Your subscription has expired. Please purchase Pro or Premium to continue.",

              currentPlan:
                FREE_PLAN,

              credits:
                0,

              upgradeRequired:
                true
            });
          }

          /*
          ----------------------------------------------
          CHECK CREDITS
          ----------------------------------------------
          */

          if (
            entitlement.credits <
            creditCost
          ) {
            return res.status(
              402
            ).json({
              success:
                false,

              code:
                "INSUFFICIENT_CREDITS",

              error:
                entitlement.credits <=
                0
                  ? "Your credits are finished. Top Up to continue generating videos."
                  : `You need ${creditCost} credits for a ${duration}-second video.`,

              requiredCredits:
                creditCost,

              currentCredits:
                entitlement.credits,

              plan:
                subscriptionPlan,

              planCreditsLimit:
                entitlement.planCreditsLimit,

              subscriptionExpiresAt:
                entitlement.subscriptionExpiresAt,

              topUpRequired:
                entitlement.credits <=
                0
            });
          }

          /*
          ----------------------------------------------
          DEDUCT CREDITS
          ----------------------------------------------
          */

          try {
            creditResult =
              await deductVideoCredits(
                userId,
                creditCost
              );

            paidVideoCreditsDeducted =
              true;

            console.log(
              "VIDEO CREDITS DEDUCTED:",
              creditCost
            );
          } catch (
            creditError
          ) {
            console.error(
              "VIDEO CREDIT CHECK/DEDUCTION ERROR:",
              creditError
            );

            if (
              creditError.message ===
              "INSUFFICIENT_CREDITS"
            ) {
              return res.status(
                402
              ).json({
                success:
                  false,

                code:
                  "INSUFFICIENT_CREDITS",

                error:
                  `Insufficient credits for a ${duration}-second video.`,

                requiredCredits:
                  creditCost
              });
            }

            if (
              creditError.message ===
              "SUBSCRIPTION_EXPIRED"
            ) {
              return res.status(
                402
              ).json({
                success:
                  false,

                code:
                  "SUBSCRIPTION_EXPIRED",

                error:
                  "Your subscription has expired.",

                currentPlan:
                  FREE_PLAN,

                credits:
                  0
              });
            }

            throw creditError;
          }
        } else {
          /*
          ==============================================
          FREE USER
          ==============================================
          */

          /*
          ----------------------------------------------
          FREE VIDEO IS ONLY 5 SECONDS
          ----------------------------------------------
          */

          if (
            duration !==
            FREE_VIDEO_DURATION
          ) {
            return res.status(
              402
            ).json({
              success:
                false,

              code:
                "FREE_VIDEO_DURATION_LIMIT",

              error:
                "The free video is limited to 5 seconds. Upgrade to Pro or Premium for additional video options.",

              currentPlan:
                FREE_PLAN,

              requiredPlan:
                "pro_or_premium"
            });
          }

          /*
          ----------------------------------------------
          RESERVE FREE VIDEO
          ----------------------------------------------
          */

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
              return res.status(
                402
              ).json({
                success:
                  false,

                code:
                  "FREE_VIDEO_USED",

                error:
                  "You've used your free video generation. Upgrade to Pro or Premium to generate more videos.",

                upgradeRequired:
                  true,

                currentPlan:
                  FREE_PLAN,

                freeVideoUsed:
                  true,

                credits:
                  0
              });
            }

            if (
              reservation.reason ===
              "VIDEO_GENERATION_IN_PROGRESS"
            ) {
              return res.status(
                409
              ).json({
                success:
                  false,

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
              return res.status(
                404
              ).json({
                success:
                  false,

                error:
                  "User account was not found."
              });
            }

            return res.status(
              403
            ).json({
              success:
                false,

              error:
                "You are not eligible for free video generation."
            });
          }

          freeVideoReserved =
            true;

          console.log(
            "FREE VIDEO RESERVED:",
            userId
          );
        }
      }

      /*
      ==================================================
      2. GENERATE VIDEO WITH WAVESPEEDAI
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
      } catch (
        generationError
      ) {
        console.error(
          "WAVESPEED VIDEO GENERATION ERROR:",
          generationError
        );

        /*
        ----------------------------------------------
        RELEASE FREE VIDEO
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
          paidVideoCreditsDeducted &&
          creditResult?.creditsDeducted >
            0
        ) {
          await refundVideoCredits(
            userId,
            creditResult.creditsDeducted
          );
        }

        return res.status(
          500
        ).json({
          success:
            false,

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
        if (
          freeVideoReserved
        ) {
          await releaseFreeVideoReservation(
            userId
          );
        }

        if (
          paidVideoCreditsDeducted &&
          creditResult?.creditsDeducted >
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

        return res.status(
          500
        ).json({
          success:
            false,

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
      } catch (
        uploadError
      ) {
        console.error(
          "IMAGEKIT GENERATED VIDEO UPLOAD ERROR:",
          uploadError
        );

        /*
        ----------------------------------------------
        FREE VIDEO NOT CONSUMED
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
          paidVideoCreditsDeducted &&
          creditResult?.creditsDeducted >
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

        return res.status(
          500
        ).json({
          success:
            false,

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
          --------------------------------------------
          DO NOT RELEASE FREE VIDEO HERE
          --------------------------------------------

          The video already succeeded and exists
          in ImageKit.

          Releasing the entitlement could allow
          multiple successful free videos.
          --------------------------------------------
          */

          console.error(
            "FREE VIDEO SUCCESS COMMIT ERROR:",
            entitlementCommitError
          );

          cleanupGeneratedClips(
            genResult.clips
          );

          return res.status(
            500
          ).json({
            success:
              false,

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
            genResult.provider,

          model:
            genResult.model,

          duration,

          creditsUsed:
            ownerUser
              ? 0
              : freeVideoReserved
                ? 0
                : creditCost
        },

        subscriptionPlan:
          ownerUser
            ? ADMIN_PLAN
            : subscriptionPlan,

        creditsDeducted:
          ownerUser
            ? 0
            : freeVideoReserved
              ? 0
              : creditResult?.creditsDeducted ||
                0,

        newCreditBalance:
          ownerUser
            ? null
            : freeVideoReserved
              ? 0
              : creditResult?.newCreditBalance ??
                null,

        freeVideoUsed:
          ownerUser ||
          paidVideoCreditsDeducted
            ? null
            : true
      });
    } catch (
      error
    ) {
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
        paidVideoCreditsDeducted &&
        creditResult?.creditsDeducted >
          0
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

      return res.status(
        500
      ).json({
        success:
          false,

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
  process.env.PORT ||
  3000;

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
      "========================================"
    );

    console.log(
      "OWNER / ADMIN: UNLIMITED"
    );

    console.log(
      "FREE: 1 SUCCESSFUL 5-SECOND VIDEO"
    );

    console.log(
      "PRO: 1,200 CREDITS / 30 DAYS"
    );

    console.log(
      "PREMIUM: 3,000 CREDITS / 30 DAYS"
    );

    console.log(
      "5 SECOND VIDEO: 15 CREDITS"
    );

    console.log(
      "8 SECOND VIDEO: 24 CREDITS"
    );

    console.log(
      "NO DAILY CREDIT RESET"
    );

    console.log(
      "NO CREDIT ROLLOVER"
    );

    console.log(
      "NO AUTOMATIC MONTHLY RECHARGE"
    );

    console.log(
      "MANUAL TOP-UP: NEW 30-DAY ENTITLEMENT"
    );

    console.log(
      "PAYMENT ROUTES: /api/payments"
    );

    console.log(
      "========================================"
    );
  }
);

