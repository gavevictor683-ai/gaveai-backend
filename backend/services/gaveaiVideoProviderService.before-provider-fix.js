require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { InferenceClient } = require("@huggingface/inference");

/*
========================================================
GAVEAI VIDEO PROVIDER
========================================================

Provider:
    Hugging Face Inference Providers

Inference Provider:
    fal-ai

Model:
    Wan-AI/Wan2.2-TI2V-5B

Flow:

    GaveAI Backend
          ↓
    Hugging Face InferenceClient
          ↓
    fal-ai
          ↓
    Wan2.2-TI2V-5B
          ↓
    Video bytes
          ↓
    Temporary MP4
          ↓
    server.js uploads to ImageKit
========================================================
*/

const HF_API_TOKEN =
  process.env.HUGGINGFACE_API_TOKEN
    ? process.env.HUGGINGFACE_API_TOKEN.trim()
    : "";

const MODEL_ID =
  process.env.HUGGINGFACE_VIDEO_MODEL ||
  "Wan-AI/Wan2.2-TI2V-5B";

const HF_PROVIDER = "fal-ai";

/*
========================================================
STATUS
========================================================
*/

function getVideoProviderStatus() {
  return {
    configured: !!HF_API_TOKEN,
    provider: "Hugging Face Inference Providers",
    inferenceProvider: HF_PROVIDER,
    t2vModel: MODEL_ID,
    i2vModel: MODEL_ID
  };
}

/*
========================================================
GENERATE VIDEO
========================================================
*/

async function generateWithGaveAIVideoProvider(options = {}) {
  if (!HF_API_TOKEN) {
    throw new Error(
      "HUGGINGFACE_API_TOKEN is not configured."
    );
  }

  const prompt =
    options.prompt ||
    "A high quality cinematic video";

  const tempDir = path.join(
    __dirname,
    "..",
    "temp"
  );

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, {
      recursive: true
    });
  }

  const fileName =
    `video_${Date.now()}_` +
    `${crypto.randomBytes(4).toString("hex")}.mp4`;

  const filePath =
    path.join(tempDir, fileName);

  console.log("========================================");
  console.log(
    "GAVEAI VIDEO GENERATION STARTED"
  );
  console.log(
    "PROVIDER: Hugging Face Inference Providers"
  );
  console.log(
    "INFERENCE PROVIDER:",
    HF_PROVIDER
  );
  console.log(
    "MODEL:",
    MODEL_ID
  );
  console.log(
    "PROMPT:",
    prompt
  );
  console.log("========================================");

  try {
    const client = new InferenceClient(
      HF_API_TOKEN
    );

    /*
    Hugging Face routes the request to fal-ai.
    The official API returns the generated
    video as raw bytes.
    */

    const video = await client.textToVideo(
      prompt,
      {
        model: MODEL_ID,
        provider: HF_PROVIDER
      }
    );

    if (!video) {
      throw new Error(
        "Hugging Face returned an empty video response."
      );
    }

    /*
    Convert the returned video bytes
    into a Node.js Buffer.
    */

    const videoBuffer =
      Buffer.from(video);

    if (!videoBuffer.length) {
      throw new Error(
        "Generated video contains no data."
      );
    }

    fs.writeFileSync(
      filePath,
      videoBuffer
    );

    console.log(
      "VIDEO SAVED:",
      filePath
    );

    console.log(
      "VIDEO SIZE:",
      videoBuffer.length,
      "bytes"
    );

    console.log("========================================");
    console.log(
      "GAVEAI VIDEO GENERATION SUCCESS"
    );
    console.log("========================================");

    return {
      success: true,

      videoFile: filePath,

      provider:
        "Hugging Face / fal-ai",

      model: MODEL_ID,

      mode: "text-to-video",

      duration: null,

      width: null,

      height: null,

      fileSize:
        videoBuffer.length
    };

  } catch (error) {

    console.error(
      "========================================"
    );

    console.error(
      "HUGGING FACE VIDEO GENERATION ERROR:"
    );

    console.error(
      error?.message || error
    );

    console.error(
      "========================================"
    );

    if (
      fs.existsSync(filePath)
    ) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }

    throw error;
  }
}

/*
========================================================
CLEANUP
========================================================
*/

async function cleanupVideoFile(
  filePath
) {
  if (
    filePath &&
    fs.existsSync(filePath)
  ) {
    try {

      fs.unlinkSync(filePath);

      console.log(
        "Cleaned up temp video file:",
        filePath
      );

    } catch (error) {

      console.warn(
        "Failed to cleanup temp video:",
        error.message
      );

    }
  }
}

/*
========================================================
EXPORTS
========================================================
*/

module.exports = {
  getVideoProviderStatus,
  generateWithGaveAIVideoProvider,
  cleanupVideoFile
};