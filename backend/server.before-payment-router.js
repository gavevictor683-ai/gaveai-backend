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

/*
========================================================
JSON BODY
========================================================
*/

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

    let aiReply = "";
    let webSearchUsed = false;
    let webSources = [];

    const result = await generateAIResponse(
      userMessage
    );

    if (typeof result === "string") {
      aiReply = result;
    } else {
      aiReply =
        result?.reply ||
        result?.message ||
        "";

      webSearchUsed = Boolean(
        result?.webSearchUsed
      );

      webSources = Array.isArray(
        result?.sources
      )
        ? result.sources
        : [];
    }

    if (typeof aiReply !== "string") {
      aiReply = String(aiReply ?? "");
    }

    /*
    ----------------------------------------------------
    CLEAN RESPONSE
    ----------------------------------------------------
    */

    aiReply = aiReply
      .split("*")
      .join("");

    aiReply = aiReply.replace(/##/g, "");

    aiReply = aiReply.replace(/#/g, "");

    aiReply = aiReply.replace(/`/g, "");

    /*
    ----------------------------------------------------
    HAITIAN CREOLE CORRECTIONS
    ----------------------------------------------------
    */

    const corrections = {
      "resime": "rezime",
      "ekperyans": "eksperyans",
      "metè": "mete",
      "Metè": "Mete",
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
      "karvyè": "karyè",
      "rasamble": "rasanble",
      "Rasamble": "Rasanble",
      "objatif": "objektif",
      "objatif ou": "objektif ou",
      "vèfye": "verifye",
      "Vèfye": "Verifye",
      "vèifye": "verifye",
      "Vèifye": "Verifye",
      "ekspèyans": "eksperyans",
      "komense": "kòmanse",
      "fe": "fè",
      "rekrute": "rekritè",
      "aktyèl aktivite": "aktivite",
      "aktyèl konpetans": "konpetans",
      "aktyèl travay": "travay",
      "fonksyònèl": "fonksyonèl",
      "konvenab": "ki pi bon",
      "edite": "modifye",
      "pwodikte": "pwodiktivite"
    };

    Object.keys(corrections).forEach((word) => {
      aiReply = aiReply.replaceAll(
        word,
        corrections[word]
      );
    });

    const safeSources = Array.isArray(
      webSources
    )
      ? webSources
      : [];

    return res.json({
      reply: aiReply,

      webSearchUsed: webSearchUsed,

      sources: safeSources.map((source) => ({
        title: source?.title || "",

        url: source?.url || "",

        provider: source?.provider || "",

        official: Boolean(
          source?.official
        )
      }))
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

  const fileBuffer = fs.readFileSync(
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

  const result = await imagekit.upload({
    file: fileBuffer,

    fileName: fileName,

    folder:
      "gavemoneytips/generated-videos"
  });

  if (!result || !result.url) {
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
    url: result.url,

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
DELETE ALL GENERATED CLIP FILES
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

Prompt(s)
    ↓
GaveAI Video Provider
    ↓
WaveSpeedAI
    ↓
Wan 2.2
    ↓
MP4
    ↓
ImageKit
    ↓
Public HTTPS URL

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

    const result =
      await generateWithGaveAIVideoProvider({
        prompt: currentPrompt,

        firstFrameImage:
          clipFirstFrame,

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
        `GaveAI video clip ${
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

      outputUrl:
        result.outputUrl,

      provider:
        result.provider,

      model:
        result.model,

      predictionId:
        result.predictionId,

      duration:
        result.duration,

      width:
        result.width,

      height:
        result.height
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

    provider:
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
REFUND VIDEO CREDITS
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
      db
        .collection("users")
        .doc(userId);

    const userSnap =
      await userRef.get();

    if (!userSnap.exists) {
      return;
    }

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
GENERATE VIDEO
========================================================
*/

app.post(
  "/generate-video",
  async (req, res) => {
    const VIDEO_CREDIT_COST = 15;

    let userId = "";

    let creditResult = null;

    let genResult = null;

    try {
      /*
      ----------------------------------------------------
      USER ID
      ----------------------------------------------------
      */

      userId =
        typeof req.body?.userId === "string"
          ? req.body.userId.trim()
          : "";

      /*
      ----------------------------------------------------
      SINGLE PROMPT
      ----------------------------------------------------
      */

      let prompt =
        typeof req.body?.prompt === "string"
          ? req.body.prompt.trim()
          : "";

      /*
      ----------------------------------------------------
      SUPPORT MESSAGE
      ----------------------------------------------------
      */

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
      MULTIPLE PROMPTS
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

      /*
      ----------------------------------------------------
      IF NO PROMPTS ARRAY
      ----------------------------------------------------
      */

      if (
        prompts.length === 0 &&
        prompt
      ) {
        prompts = [prompt];
      }

      /*
      ----------------------------------------------------
      VALIDATION
      ----------------------------------------------------
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
        prompts.length > 20
      ) {
        return res.status(400).json({
          success: false,

          error:
            "A maximum of 20 video clips can be generated in one production."
        });
      }

      /*
      ----------------------------------------------------
      FIRST FRAME
      ----------------------------------------------------
      */

      const firstFrameImage =
        typeof req.body?.firstFrameImage === "string"
          ? req.body.firstFrameImage.trim()
          : undefined;

      /*
      ----------------------------------------------------
      SUBJECT REFERENCE
      ----------------------------------------------------
      */

      const subjectReference =
        typeof req.body?.subjectReference === "string"
          ? req.body.subjectReference.trim()
          : undefined;

      /*
      ----------------------------------------------------
      VIDEO OPTIONS
      ----------------------------------------------------
      */

      const width =
        Number(req.body?.width) || 832;

      const height =
        Number(req.body?.height) || 480;

      const duration =
        Number(req.body?.duration) || 5;

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
      LOG REQUEST
      ----------------------------------------------------
      */

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
        "FIRST FRAME:",
        Boolean(firstFrameImage)
      );

      console.log(
        "SUBJECT REFERENCE:",
        Boolean(subjectReference)
      );

      console.log(
        "========================================"
      );

      /*
      ====================================================
      OWNER / ADMIN
      ====================================================
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
              genResult?.message ||
              "Video production failed.",

            productionId:
              genResult?.productionId ||
              null,

            failedClip:
              genResult?.failedClip ||
              null
          });
        }

        /*
        ----------------------------------------------------
        IMAGEKIT UPLOAD
        ----------------------------------------------------
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
        ----------------------------------------------------
        CLEAN LOCAL FILES
        ----------------------------------------------------
        */

        cleanupGeneratedClips(
          genResult.clips
        );

        /*
        ----------------------------------------------------
        OWNER SUCCESS
        ----------------------------------------------------
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

          creditsDeducted: 0,

          newCreditBalance: null
        });
      }

      /*
      ====================================================
      REGULAR USER
      ====================================================
      */

      /*
      ----------------------------------------------------
      USER CREDIT CHECK
      ----------------------------------------------------
      */

      if (userId) {
        try {
          const userRef =
            db
              .collection("users")
              .doc(userId);

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

          const currentCredits =
            Number(
              userData.credits ??
              userData.dailyCredits ??
              0
            );

          if (
            currentCredits <
            VIDEO_CREDIT_COST
          ) {
            return res.status(402).json({
              success: false,

              error:
                "Insufficient credits.",

              requiredCredits:
                VIDEO_CREDIT_COST,

              currentCredits:
                currentCredits
            });
          }

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

            newCreditBalance:
              newCreditBalance,

            previousCreditBalance:
              currentCredits
          };
        } catch (creditError) {
          console.error(
            "VIDEO CREDIT ERROR:",
            creditError
          );

          return res.status(500).json({
            success: false,

            error:
              "Unable to process video credits.",

            details:
              creditError?.message ||
              "Credit system error."
          });
        }
      } else {
        /*
        --------------------------------------------------
        NO USER ID
        --------------------------------------------------
        */

        creditResult = {
          creditsDeducted: 0,

          newCreditBalance: null
        };
      }

      /*
      ----------------------------------------------------
      GENERATE VIDEO
      ----------------------------------------------------
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
          "WAVESPEED VIDEO GENERATION ERROR:",
          generationError
        );

        /*
        --------------------------------------------------
        REFUND
        --------------------------------------------------
        */

        if (
          userId &&
          creditResult &&
          creditResult.creditsDeducted > 0
        ) {
          await refundVideoCredits(
            userId,
            VIDEO_CREDIT_COST
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
      ----------------------------------------------------
      GENERATION FAILED
      ----------------------------------------------------
      */

      if (
        !genResult ||
        !genResult.success
      ) {
        if (
          userId &&
          creditResult &&
          creditResult.creditsDeducted > 0
        ) {
          await refundVideoCredits(
            userId,
            VIDEO_CREDIT_COST
          );
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
            null
        });
      }

      /*
      ----------------------------------------------------
      IMAGEKIT UPLOAD
      ----------------------------------------------------
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
        --------------------------------------------------
        REFUND
        --------------------------------------------------
        */

        if (
          userId &&
          creditResult &&
          creditResult.creditsDeducted > 0
        ) {
          await refundVideoCredits(
            userId,
            VIDEO_CREDIT_COST
          );
        }

        /*
        --------------------------------------------------
        CLEAN LOCAL FILES
        --------------------------------------------------
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
            "ImageKit upload failed."
        });
      }

      /*
      ----------------------------------------------------
      DELETE LOCAL VIDEO FILES
      ----------------------------------------------------
      */

      cleanupGeneratedClips(
        genResult.clips
      );

      /*
      ----------------------------------------------------
      FINAL RESPONSE
      ----------------------------------------------------
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

        creditsDeducted:
          creditResult?.creditsDeducted ||
          0,

        newCreditBalance:
          creditResult?.newCreditBalance ??
          null
      });
    } catch (error) {
      console.error(
        "GENERATE VIDEO ERROR:",
        error
      );

      /*
      ----------------------------------------------------
      SAFETY REFUND
      ----------------------------------------------------
      */

      if (
        userId &&
        creditResult &&
        creditResult.creditsDeducted > 0
      ) {
        await refundVideoCredits(
          userId,
          VIDEO_CREDIT_COST
        );
      }

      /*
      ----------------------------------------------------
      CLEANUP
      ----------------------------------------------------
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
          error:
            "No profile photo uploaded"
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
          error:
            "Only JPG, JPEG, PNG, and WEBP files are allowed for profile photos"
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
              photoUrl:
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

        photoUrl:
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
          error:
            "No resume uploaded"
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
              resumeURL:
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

        resumeURL:
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
          error:
            "No cover letter uploaded"
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
              coverLetterURL:
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

        coverLetterURL:
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
          error:
            "No certificate PDF uploaded"
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
        error:
          error?.message ||
          "Certificate upload failed."
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
  "VIDEO PROVIDER: WaveSpeedAI"
);

console.log(
  "VIDEO SERVICE: gaveaiVideoProviderService.js"
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
    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );

    console.log(
      "Owner/Admin video mode: UNLIMITED"
    );

    console.log(
      "Video provider: WaveSpeedAI"
    );

    console.log(
      "Image generation service: EXISTING"
    );
  }
)