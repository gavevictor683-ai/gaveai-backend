require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");

const { generateAIResponse } =
  require("./services/groqService");

const {
  generateWithGaveAIVideoProvider
} = require("./services/gaveaiVideoProviderService");

const { db } = require("./firebaseAdmin");

const {
  requireAuth,
  requireAdmin
} = require("./middleware/authMiddleware");

const paymentRoutes =
  require("./routes/paymentRoutes");

/*
========================================================
EXPRESS APP
========================================================
*/

const app = express();

/*
========================================================
GAVEAI CREDIT SERVICE
========================================================

FINAL CREDIT SYSTEM

--------------------------------------------------------
FREE
--------------------------------------------------------
- 1 free video ONLY for the lifetime of the account
- No subscription
- No paid credits
- No daily free-video reset
- No daily credits
- No 60 credits/day

--------------------------------------------------------
PRO
--------------------------------------------------------
- $9.99 USD / 30 days
- 1,000 credits
- 5-second video = 15 credits
- 8-second video = 24 credits
- 66 x 5-second videos equivalent
- 41 x 8-second videos equivalent
- Credits do NOT rollover after expiration

--------------------------------------------------------
PREMIUM
--------------------------------------------------------
- $19.99 USD / 30 days
- 1,500 credits
- 5-second video = 15 credits
- 8-second video = 24 credits
- 100 x 5-second videos equivalent
- 62 x 8-second videos equivalent
- Credits do NOT rollover after expiration

--------------------------------------------------------
ADMIN
--------------------------------------------------------
- Unlimited
- No credits deducted

--------------------------------------------------------
IMPORTANT CREDIT FIELD
--------------------------------------------------------
creditService.js uses:

    users/{userId}.credits

Therefore all payment/credit services MUST use:

    credits

NOT:

    creditBalance

--------------------------------------------------------
IMPORTANT VIDEO COST
--------------------------------------------------------

Video cost depends on duration:

    5 seconds = 15 credits
    8 seconds = 24 credits

Do NOT use one fixed 15-credit cost for every duration.

========================================================
*/

/*
========================================================
CREDIT SERVICE
========================================================
*/

const {
  checkAndDeductCredits,
  refundCredits,
  getVideoCreditCost,
  normalizeVideoDuration
} = require("./services/creditService");

/*
========================================================
CONFIGURATION
========================================================
*/

const PORT =
  Number(process.env.PORT) || 3000;

const MAX_VIDEO_PROMPTS = 20;

const MAX_UPLOAD_SIZE =
  50 * 1024 * 1024;

/*
========================================================
GAVEAI PRODUCTION PROVIDER
========================================================

IMPORTANT:

GAVEAIproduction is the provider identity exposed
to the GAVEAI application and its users.

The underlying provider service remains hidden
behind:

    gaveaiVideoProviderService.js

Users must NOT receive:

    WaveSpeedAI

as the provider name.

========================================================
*/

const GAVEAI_PROVIDER_NAME =
  "GAVEAIproduction";

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
  const origin =
    req.headers.origin;

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
PAYMENT ROUTES
========================================================
*/

app.use(
  "/api/payments",
  paymentRoutes
);

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

    status: "online"
  });
});

/*
========================================================
CHAT
========================================================
*/

app.post("/chat", async (req, res) => {
  try {
    const userMessage =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (!userMessage) {
      return res.status(400).json({
        success: false,
        error: "Message is required."
      });
    }

    let aiReply = "";
    let webSearchUsed = false;
    let webSources = [];

    const result =
      await generateAIResponse(
        userMessage
      );

    if (typeof result === "string") {
      aiReply = result;
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
        Array.isArray(result?.sources)
          ? result.sources
          : [];
    }

    if (typeof aiReply !== "string") {
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
      of Object.entries(corrections)
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
      Array.isArray(webSources)
        ? webSources
        : [];

    return res.json({
      success: true,

      reply: aiReply,

      webSearchUsed,

      sources:
        safeSources.map(
          (source) => ({
            title:
              source?.title || "",

            url:
              source?.url || "",

            provider:
              source?.provider || "",

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
DELETE ALL GENERATED CLIP FILES
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
CALCULATE TOTAL VIDEO CREDIT COST
========================================================

5 seconds:
    15 credits / clip

8 seconds:
    24 credits / clip

Example:
3 clips × 5 sec
= 45 credits

3 clips × 8 sec
= 72 credits

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

  if (clipCount <= 0) {
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

Prompt(s)
    ↓
GAVEAIproduction
    ↓
Internal Video Provider Service
    ↓
Underlying video provider
    ↓
Wan 2.2
    ↓
MP4
    ↓
ImageKit
    ↓
Public HTTPS URL

IMPORTANT:

GAVEAIproduction is the ONLY provider identity
returned to the application/user.

The underlying provider remains internal.

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

  /*
  ----------------------------------------------------
  NORMALIZE DURATION
  ----------------------------------------------------
  */

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

      /*
      ----------------------------------------------------
      ONLY FIRST CLIP USES FIRST FRAME
      ----------------------------------------------------
      */

      const clipFirstFrame =
        i === 0
          ? options.firstFrameImage
          : undefined;

      /*
      ----------------------------------------------------
      VIDEO PROVIDER SERVICE
      ----------------------------------------------------
      */

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

      if (!firstGeneratedVideo) {
        firstGeneratedVideo =
          result;
      }

      /*
      ----------------------------------------------------
      IMPORTANT PROVIDER MASKING
      ----------------------------------------------------

      Never expose the underlying provider returned
      by the internal service.

      The application always receives:

          GAVEAIproduction

      ----------------------------------------------------
      */

      clips.push({

        index:
          i + 1,

        prompt:
          currentPrompt,

        videoFile:
          result.videoFile,

        videoUrl:
          result.videoUrl || null,

        outputUrl:
          result.outputUrl || null,

        provider:
          GAVEAI_PROVIDER_NAME,

        model:
          result.model || null,

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

      success: true,

      /*
      IMPORTANT:
      Never return the internal provider identity.
      */

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

    let creditResult = null;

    let genResult = null;

    let creditsRefunded = false;

    try {

      /*
      ==================================================
      USER ID
      ==================================================
      */

      userId =
        typeof req.body?.userId === "string"
          ? req.body.userId.trim()
          : "";

      /*
      ==================================================
      SINGLE PROMPT
      ==================================================
      */

      let prompt =
        typeof req.body?.prompt === "string"
          ? req.body.prompt.trim()
          : "";

      /*
      ==================================================
      SUPPORT MESSAGE
      ==================================================
      */

      if (
        !prompt &&
        typeof req.body?.message === "string"
      ) {
        prompt =
          req.body.message
            .replace(/^\/generate-video\s*/i, "")
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
                typeof item === "string" &&
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
        typeof req.body?.firstFrameImage === "string"
          ? req.body.firstFrameImage.trim()
          : undefined;

      /*
      ==================================================
      SUBJECT REFERENCE
      ==================================================
      */

      const subjectReference =
        typeof req.body?.subjectReference === "string"
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

      } catch (durationError) {

        return res.status(400).json({

          success: false,

          error:
            durationError?.message ||
            "Only 5-second and 8-second videos are supported."
        });
      }

      const width =
        Number(req.body?.width) || 832;

      const height =
        Number(req.body?.height) || 480;

      const seed =
        req.body?.seed;

      const negativePrompt =
        typeof req.body?.negativePrompt === "string"
          ? req.body.negativePrompt.trim()
          : undefined;

      const resolution =
        typeof req.body?.resolution === "string"
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
          userId === adminUserId
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
        "FIRST FRAME:",
        Boolean(firstFrameImage)
      );

      console.log(
        "SUBJECT REFERENCE:",
        Boolean(subjectReference)
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

      ADMIN HAS UNLIMITED VIDEO GENERATION.

      NO CREDIT DEDUCTION.

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

        /*
        ------------------------------------------------
        IMAGEKIT UPLOAD
        ------------------------------------------------
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

        /*
        ------------------------------------------------
        CLEAN LOCAL FILES
        ------------------------------------------------
        */

        cleanupGeneratedClips(
          genResult.clips
        );

        /*
        ------------------------------------------------
        OWNER SUCCESS
        ------------------------------------------------
        */

        return res.json({

          success: true,

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

            /*
            IMPORTANT:
            Always expose GAVEAIproduction.
            */

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
          creditResult?.plan || "free"
        );

        console.log(
          "CREDITS DEDUCTED:",
          creditResult?.creditsDeducted || 0
        );

        console.log(
          "PREVIOUS CREDITS:",
          creditResult?.previousCredits
        );

        console.log(
          "NEW CREDITS:",
          creditResult?.newCredits
        );

      } catch (creditError) {

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
              creditError.plan || null
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

      } catch (generationError) {

        console.error(
          "GAVEAI VIDEO GENERATION ERROR:",
          generationError
        );

        /*
        ------------------------------------------------
        REFUND CREDITS
        ------------------------------------------------
        */

        if (
          userId &&
          creditResult &&
          !creditsRefunded
        ) {

          try {

            const refundAmount =
              creditResult?.creditSource ===
              "subscription"
                ? creditResult?.creditsDeducted || 0
                : 0;

            /*
            --------------------------------------------
            PAID USER REFUND
            --------------------------------------------
            */

            if (refundAmount > 0) {

              const refundResult =
                await refundCredits(
                  userId,
                  refundAmount
                );

              creditsRefunded =
                Boolean(
                  refundResult?.success
                );
            }

            /*
            --------------------------------------------
            FREE USER REFUND
            --------------------------------------------
            */

            else if (
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

          } catch (refundError) {

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
                ? creditResult?.creditsDeducted || 0
                : 0;

            if (refundAmount > 0) {

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

          } catch (refundError) {

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

      } catch (uploadError) {

        console.error(
          "IMAGEKIT GENERATED VIDEO UPLOAD ERROR:",
          uploadError
        );

        /*
        ------------------------------------------------
        REFUND CREDITS
        ------------------------------------------------
        */

        if (
          userId &&
          creditResult &&
          !creditsRefunded
        ) {

          try {

            const refundAmount =
              creditResult?.creditSource ===
              "subscription"
                ? creditResult?.creditsDeducted || 0
                : 0;

            if (refundAmount > 0) {

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

          } catch (refundError) {

            console.error(
              "IMAGEKIT REFUND ERROR:",
              refundError
            );
          }
        }

        /*
        ------------------------------------------------
        CLEAN LOCAL FILES
        ------------------------------------------------
        */

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

        success: true,

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

          /*
          IMPORTANT:
          Never expose underlying provider.
          */

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

      /*
      ==================================================
      SAFETY REFUND
      ==================================================
      */

      if (
        userId &&
        creditResult &&
        !creditsRefunded
      ) {

        try {

          const refundAmount =
            creditResult?.creditSource ===
            "subscription"
              ? creditResult?.creditsDeducted || 0
              : 0;

          if (refundAmount > 0) {

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

        } catch (refundError) {

          console.error(
            "SAFETY REFUND ERROR:",
            refundError
          );
        }
      }

      /*
      ==================================================
      CLEANUP
      ==================================================
      */

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
        typeof req.body.userId === "string"
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

        success: true,

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
        typeof req.body.userId === "string"
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

        success: true,

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
        typeof req.body.userId === "string"
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

        success: true,

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
        typeof req.body.userId === "string"
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

        success: true,

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
          .collection("paymentRequests")
          .get()
      ]);

      let totalUsers =
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

      usersSnap.forEach((doc) => {

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

        let expiresAt = null;

        if (
          user.subscriptionExpiresAt
        ) {

          if (
            typeof user.subscriptionExpiresAt.toDate ===
            "function"
          ) {

            expiresAt =
              user.subscriptionExpiresAt
                .toDate()
                .getTime();

          } else if (
            user.subscriptionExpiresAt.seconds
          ) {

            expiresAt =
              Number(
                user.subscriptionExpiresAt.seconds
              ) * 1000;

          } else {

            const parsed =
              new Date(
                user.subscriptionExpiresAt
              ).getTime();

            if (
              !Number.isNaN(parsed)
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
      });

      paymentsSnap.forEach((doc) => {

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
              payment.amount || 0
            );

          if (
            !Number.isNaN(amount)
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
      });

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
            totalRevenue.toFixed(2)
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

      snap.forEach((doc) => {

        payments.push({

          id:
            doc.id,

          ...doc.data()
        });
      });

      payments.sort((a, b) => {

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

              return Number(
                value.seconds
              ) * 1000;
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
          getTime(b.createdAt) -
          getTime(a.createdAt)
        );
      });

      return res.json({

        success: true,

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

      usersSnap.forEach((doc) => {

        users.push({

          id:
            doc.id,

          ...doc.data()
        });
      });

      return res.json({

        success: true,

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
  "VIDEO ROUTE: /generate-video READY"
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
  "CREDIT SYSTEM: FREE + PRO + PREMIUM"
);

console.log(
  "FREE VIDEO: 1 lifetime only"
);

console.log(
  "PRO: 1,000 credits / 30 days"
);

console.log(
  "PREMIUM: 1,500 credits / 30 days"
);

console.log(
  "CREDIT FIELD: users/{userId}.credits"
);

console.log(
  "NO creditBalance FIELD"
);

console.log(
  "5-SECOND VIDEO: 15 CREDITS"
);

console.log(
  "8-SECOND VIDEO: 24 CREDITS"
);

console.log(
  "PAYMENT ROUTE: /api/payments READY"
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
      "Image generation service: EXISTING"
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

