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

const app = express();

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
    const status =
      getVideoProviderStatus();

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
    const userMessage =
      req.body.message;

    if (
      !userMessage ||
      typeof userMessage !== "string"
    ) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    const result =
      await generateAIResponse(
        userMessage
      );

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
    NETWAYAJ REPONS
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
UPLOAD MEDIA TO IMAGEKIT (USER UPLOADS)
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
          error: "No file uploaded. Please provide a file."
        });
      }

      const file = req.file;
      const isVideo = file.mimetype.startsWith("video/");
      const isImage = file.mimetype.startsWith("image/");

      if (!isVideo && !isImage) {
        return res.status(400).json({
          success: false,
          error: "Only image and video files are allowed."
        });
      }

      const extension = file.originalname.split('.').pop() || (isVideo ? "mp4" : "jpg");
      const fileName = `gaveai-upload-${Date.now()}.${extension}`;
      const folder = isVideo ? "gavemoneytips/user-uploads/videos" : "gavemoneytips/user-uploads/images";

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

      const result = await imagekit.upload({
        file: file.buffer,
        fileName: fileName,
        folder: folder
      });

      if (!result || !result.url) {
        throw new Error(
          "ImageKit did not return a public URL."
        );
      }

      return res.json({
        success: true,
        url: result.url,
        fileId: result.fileId || null,
        name: result.name || fileName,
        type: isVideo ? "video" : "image"
      });

    } catch (error) {
      console.error(
        "IMAGEKIT USER UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: error?.message || "Upload failed"
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
      }/${prompts.length} | PROMPT: ${currentPrompt}`
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

RULE:

Free user gets ONE successful video.

We reserve the attempt BEFORE generation so two
simultaneous requests cannot consume the same free
entitlement.

IMPORTANT:

Reservation is NOT consumption.

If generation or ImageKit fails, the reservation
is released and the user can retry.

Only after WaveSpeed generation AND ImageKit upload
succeed do we set freeVideoUsed = true.
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

          const freeVideoUsed =
            userData.freeVideoUsed === true;

          const generationInProgress =
            userData.freeVideoGenerationInProgress === true;

          /*
          ----------------------------------------------
          FREE VIDEO ALREADY USED
          ----------------------------------------------
          */

          if (freeVideoUsed) {
            return {
              allowed: false,
              reason: "FREE_VIDEO_USED"
            };
          }

          /*
          ----------------------------------------------
          ANOTHER VIDEO IS CURRENTLY GENERATING
          ----------------------------------------------
          */

          if (generationInProgress) {
            return {
              allowed: false,
              reason:
                "VIDEO_GENERATION_IN_PROGRESS"
            };
          }

          /*
          ----------------------------------------------
          RESERVE FREE VIDEO
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

Called when generation or ImageKit upload fails.

This means the free video entitlement remains available.
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
REFUND PAID VIDEO CREDITS
========================================================

This remains for the existing paid-user credit system.

FREE users do NOT use this function.

Free users are controlled by freeVideoUsed.
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

    const userSnap =
      await userRef.get();

    if (userSnap.exists) {
      const userData =
        userSnap.data() || {};

      const currentCredits =
        Number(
          userData.credits ?? 0
        );

      await userRef.set(
        {
          credits:
            currentCredits +
            creditCost
        },
        {
          merge: true
        }
      );

      console.log(
        "PAID VIDEO CREDITS REFUNDED:",
        creditCost
      );
    }

  } catch (error) {
    console.error(
      "CREDIT REFUND ERROR:",
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
  async (req, res) => {

    /*
    ----------------------------------------------------
    EXISTING PAID CREDIT COST
    ----------------------------------------------------

    This is temporarily kept for Pro/Premium users
    until SogePay subscription/payment limits are
    connected.
    */

    const VIDEO_CREDIT_COST = 15;

    /*
    ----------------------------------------------------
    USER INPUT
    ----------------------------------------------------
    */

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
      "========================================"
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
      1. VIDEO ENTITLEMENT CHECK
      ==================================================
      */

      if (
        !ownerUser &&
        userId
      ) {

        try {

          const userRef =
            db.collection("users").doc(userId);

          const userSnap =
            await userRef.get();

          if (
            !userSnap.exists
          ) {
            return res.status(404).json({
              success: false,
              error:
                "User account was not found."
            });
          }

          const userData =
            userSnap.data() || {};

          /*
          ----------------------------------------------
          DETERMINE PLAN
          ----------------------------------------------
          */

          subscriptionPlan =
            String(
              userData.subscriptionPlan ||
              userData.plan ||
              "free"
            )
              .trim()
              .toLowerCase();

          /*
          ==============================================
          PAID USER
          ==============================================

          Until SogePay is connected, Pro/Premium
          continue using the existing credits system.

          This prevents someone from simply changing
          their plan field and receiving unlimited videos.
          ==============================================
          */

          if (
            subscriptionPlan === "pro" ||
            subscriptionPlan === "premium"
          ) {

            paidUser = true;

            const currentCredits =
              Number(
                userData.credits ??
                userData.dailyCredits ??
                0
              );

            console.log(
              "PAID USER PLAN:",
              subscriptionPlan
            );

            console.log(
              "PAID USER CREDITS:",
              currentCredits
            );

            /*
            --------------------------------------------
            CREDIT CHECK
            --------------------------------------------
            */

            if (
              currentCredits <
              VIDEO_CREDIT_COST
            ) {
              return res.status(402).json({
                success: false,

                code:
                  "INSUFFICIENT_VIDEO_CREDITS",

                error:
                  "Insufficient credits.",

                requiredCredits:
                  VIDEO_CREDIT_COST,

                currentCredits
              });
            }

            /*
            --------------------------------------------
            DEDUCT PAID VIDEO CREDITS
            --------------------------------------------
            */

            const newCreditBalance =
              currentCredits -
              VIDEO_CREDIT_COST;

            await userRef.set(
              {
                credits:
                  newCreditBalance
              },
              {
                merge: true
              }
            );

            creditResult = {
              creditsDeducted:
                VIDEO_CREDIT_COST,

              newCreditBalance,

              previousCreditBalance:
                currentCredits
            };

            console.log(
              "PAID VIDEO CREDITS DEDUCTED:",
              VIDEO_CREDIT_COST
            );

          } else {

            /*
            ==========================================
            FREE USER
            ==========================================
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

              /*
              ----------------------------------------
              FREE VIDEO ALREADY USED
              ----------------------------------------
              */

              if (
                reservation.reason ===
                "FREE_VIDEO_USED"
              ) {
                return res.status(402).json({
                  success: false,

                  code:
                    "FREE_VIDEO_USED",

                  error:
                    "You've used your free video generation. Upgrade your plan to generate more videos.",

                  upgradeRequired:
                    true,

                  currentPlan:
                    "free"
                });
              }

              /*
              ----------------------------------------
              GENERATION ALREADY RUNNING
              ----------------------------------------
              */

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

              /*
              ----------------------------------------
              USER NOT FOUND
              ----------------------------------------
              */

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

            console.log(
              "FREE VIDEO RESERVED:",
              userId
            );
          }

        } catch (
          entitlementError
        ) {

          console.error(
            "VIDEO ENTITLEMENT ERROR:",
            entitlementError
          );

          return res.status(500).json({
            success: false,

            error:
              "Unable to verify video access."
          });
        }

      } else {

        /*
        ============================================
        ADMIN / ANONYMOUS
        ============================================
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
        FREE USER:
        RELEASE RESERVATION
        ----------------------------------------------

        The user can retry because the video did
        not successfully generate.
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
        PAID USER:
        REFUND CREDITS
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
      GENERATION RESULT VALIDATION
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
      3. UPLOAD SUCCESSFUL VIDEO TO IMAGEKIT
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
        IMPORTANT:
        Free video is NOT consumed if ImageKit fails.
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
        REFUND PAID USER
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
      4. MARK FREE VIDEO AS USED
      ==================================================

      THIS IS THE ONLY PLACE WHERE THE FREE VIDEO
      IS CONSUMED.

      At this point:

      WaveSpeed = SUCCESS
      ImageKit  = SUCCESS

      Therefore the user has actually received
      a successful video.
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
          ------------------------------------------------
          IMPORTANT SAFETY HANDLING
          ------------------------------------------------

          The video itself succeeded and is already
          stored in ImageKit.

          We DO NOT refund the free entitlement here
          automatically because that could allow the
          user to receive multiple successful videos if
          the client retries after this point.

          We log the error so it can be repaired safely.
          ------------------------------------------------
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
              "Video was generated successfully, but the video entitlement could not be finalized. Please contact support.",

            productionId:
              genResult.productionId,

            videoUrl:
              uploadedVideo.url
          });
        }
      }

      /*
      ==================================================
      5. CLEANUP LOCAL FILES
      ==================================================
      */

      cleanupGeneratedClips(
        genResult.clips
      );

      /*
      ==================================================
      6. SUCCESS RESPONSE
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
            genResult.model
        },

        /*
        ----------------------------------------------
        PLAN INFORMATION
        ----------------------------------------------
        */

        subscriptionPlan:
          ownerUser
            ? "admin"
            : subscriptionPlan,

        /*
        ----------------------------------------------
        CREDIT INFORMATION
        ----------------------------------------------
        */

        creditsDeducted:
          creditResult?.creditsDeducted ||
          0,

        newCreditBalance:
          creditResult?.newCreditBalance ??
          null,

        /*
        ----------------------------------------------
        FREE VIDEO INFORMATION
        ----------------------------------------------
        */

        freeVideoUsed:
          ownerUser ||
          paidUser
            ? null
            : true
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
      "Failed free generations: RETRY ALLOWED"
    );

    console.log(
      "Paid video mode: EXISTING CREDIT SYSTEM"
    );

    console.log(
      "========================================"
    );
  }
);