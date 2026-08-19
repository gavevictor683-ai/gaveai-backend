require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");

const { generateAIResponse } = require("./services/groqService");
const { db } = require("./firebaseAdmin");

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

const corsOptions = {
  origin: [
    "https://gavemoneytips.blogspot.com",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
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

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (
    origin === "https://gavemoneytips.blogspot.com" ||
    origin === "http://localhost:3000"
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

app.use(
  express.json({
    limit: "10mb"
  })
);

app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running");
});

/*
========================================================
CURRENT HAITI DATE/TIME
========================================================
*/

function getHaitiDateTime() {
  const now = new Date();

  const dateFormatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "America/Port-au-Prince",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    );

  const dateLabelFormatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/Port-au-Prince",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      }
    );

  const timeFormatter =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "America/Port-au-Prince",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    );

  return {
    isoDate:
      dateFormatter.format(now),

    dateLabel:
      dateLabelFormatter.format(now),

    time:
      timeFormatter.format(now),

    timezone:
      "America/Port-au-Prince"
  };
}

/*
========================================================
DETECT SIMPLE HAITI DATE/TIME QUESTIONS
========================================================
*/

function isHaitiDateTimeQuestion(message) {
  if (
    !message ||
    typeof message !== "string"
  ) {
    return false;
  }

  const text =
    message
      .toLowerCase()
      .trim();

  const patterns = [
    "ki dat jodi a",
    "ki dat jodi a ye",
    "ki dat jodi a?",
    "ki dat li ye",
    "ki dat li ye kounya",
    "ki dat li ye kounye a",
    "ki lè li ye",
    "ki le li ye",
    "ki lè li ye kounya",
    "ki le li ye kounya",
    "ki lè li ye kounye a",
    "ki le li ye kounye a",
    "ki lè aktyèl la",
    "ki le aktyel la",
    "ki lè li ye nan haiti",
    "ki le li ye nan haiti",
    "ki lè aktyèl la nan haiti",
    "ki le aktyel la nan haiti",
    "what is today's date",
    "what date is today",
    "what time is it in haiti",
    "current time in haiti",
    "current date",
    "today's date"
  ];

  return patterns.some(
    function (pattern) {
      return text.includes(pattern);
    }
  );
}

/*
========================================================
CHAT / AI
========================================================
*/

app.post("/chat", async (req, res) => {
  try {
    const userMessage =
      req.body &&
      req.body.message;

    if (
      !userMessage ||
      typeof userMessage !== "string"
    ) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    /*
    ----------------------------------------------------
    CURRENT HAITI DATE
    ----------------------------------------------------
    */

    const haitiDateTime =
      getHaitiDateTime();

    const currentDate =
      haitiDateTime.isoDate;

    const currentDateLabel =
      haitiDateTime.dateLabel;

    /*
    ----------------------------------------------------
    SPECIAL DATE/TIME ROUTE
    ----------------------------------------------------
    Dat/lè pa bezwen Groq,
    Tavily, ni Exa.
    ----------------------------------------------------
    */

    if (
      isHaitiDateTimeQuestion(
        userMessage
      )
    ) {
      const text =
        userMessage
          .toLowerCase();

      const asksTime =
        text.includes("lè") ||
        text.includes("le ") ||
        text.includes("time");

      const asksDate =
        text.includes("dat") ||
        text.includes("date");

      let reply = "";

      if (
        asksDate &&
        asksTime
      ) {
        reply =
          "Jodi a se **" +
          haitiDateTime.dateLabel +
          "**, epi kounye a li **" +
          haitiDateTime.time +
          "** nan Haiti (zòn tan " +
          haitiDateTime.timezone +
          ").";
      } else if (asksTime) {
        reply =
          "Kounye a li **" +
          haitiDateTime.time +
          "** nan Haiti (zòn tan " +
          haitiDateTime.timezone +
          ").";
      } else {
        reply =
          "Jodi a se **" +
          haitiDateTime.dateLabel +
          "** (lè Ayiti, zòn tan " +
          haitiDateTime.timezone +
          ").";
      }

      console.log(
        "DATE/TIME REQUEST - NO WEB SEARCH - NO GROQ"
      );

      return res.json({
        reply: reply,

        webSearchUsed: false,

        currentDate:
          currentDate,

        currentDateLabel:
          currentDateLabel,

        currentTime:
          haitiDateTime.time,

        timezone:
          haitiDateTime.timezone,

        sources: []
      });
    }

    /*
    ----------------------------------------------------
    WEB SEARCH DATE RULES
    ----------------------------------------------------
    Sa yo ale kòm context pou groqService.
    ----------------------------------------------------
    */

    const webSearchContext = {
      currentDate:
        currentDate,

      currentDateLabel:
        currentDateLabel,

      timezone:
        haitiDateTime.timezone,

      rules: [
        "The current date is " +
          currentDateLabel +
          " in Haiti.",

        "The current timezone is America/Port-au-Prince.",

        "When the user asks for today's, current, latest, recent, breaking, or live information, web search must be used.",

        "Normal non-current questions should be answered by Groq without web search.",

        "Do not present an older article as if it was published today.",

        "Every current-news claim must be supported by web-search results.",

        "Use the publication date from the source when available.",

        "If there is no source published today, clearly say that no source found was published today.",

        "When today's information is unavailable, use the most recent verified sources instead of inventing a current event.",

        "Never use the model's internal knowledge to invent or fill missing current-news facts.",

        "Clearly distinguish verified facts from analysis or commentary.",

        "Do not claim that an event happened today merely because it is mentioned in an older article."
      ]
    };

    /*
    ----------------------------------------------------
    SEND TO GROQ SERVICE
    ----------------------------------------------------
    */

    const result =
      await generateAIResponse(
        userMessage,
        {
          conversation: [],

          knowledge: "",

          currentDate:
            webSearchContext.currentDate,

          currentDateLabel:
            webSearchContext.currentDateLabel,

          webSearchContext:
            webSearchContext
        }
      );

    let aiReply = "";

    if (
      result &&
      typeof result.reply === "string"
    ) {
      aiReply =
        result.reply;
    } else if (
      typeof result === "string"
    ) {
      aiReply =
        result;
    }

    if (!aiReply.trim()) {
      throw new Error(
        "AI returned an empty response."
      );
    }

    const safeSources =
      result &&
      Array.isArray(result.sources)
        ? result.sources
        : [];

    return res.json({
      reply:
        aiReply,

      webSearchUsed:
        Boolean(
          result &&
          result.webSearchUsed
        ),

      currentDate:
        currentDate,

      currentDateLabel:
        currentDateLabel,

      currentTime:
        haitiDateTime.time,

      timezone:
        haitiDateTime.timezone,

      sources:
        safeSources.map(
          (source) => ({
            title:
              source &&
              typeof source.title === "string"
                ? source.title
                : "",

            url:
              source &&
              typeof source.url === "string"
                ? source.url
                : "",

            provider:
              source &&
              typeof source.provider === "string"
                ? source.provider
                : "",

            official:
              Boolean(
                source &&
                source.official
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
      error:
        error &&
        error.message
          ? error.message
          : "Internal server error"
    });
  }
});

/*
========================================================
PROFILE PHOTO UPLOAD
========================================================
*/

app.post(
  "/upload-profile",
  upload.single("file"),
  async (req, res) => {
    try {
      const uploadedFile =
        req.file;

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
          error &&
          error.message
            ? error.message
            : "Profile photo upload failed"
      });
    }
  }
);

/*
========================================================
RESUME UPLOAD
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
          error &&
          error.message
            ? error.message
            : "Resume upload failed"
      });
    }
  }
);

/*
========================================================
COVER LETTER UPLOAD
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
          error &&
          error.message
            ? error.message
            : "Cover letter upload failed"
      });
    }
  }
);

/*
========================================================
CERTIFICATE UPLOAD
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
          error &&
          error.message
            ? error.message
            : "Certificate upload failed"
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
    console.log(
      `Gave Money Tips AI running on port ${PORT}`
    );
  }
);