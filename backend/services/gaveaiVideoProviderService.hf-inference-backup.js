const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
========================================================
CONFIGURATION
========================================================
*/

const HF_API_TOKEN = process.env.HUGGINGFACE_API_TOKEN;

const MODEL_ID =
  process.env.HUGGINGFACE_VIDEO_MODEL ||
  "Wan-AI/Wan2.2-TI2V-5B";

const HF_VIDEO_API =
  "https://router.huggingface.co/hf-inference/models";

/*
========================================================
STATUS
========================================================
*/

function getVideoProviderStatus() {
  return {
    configured: !!HF_API_TOKEN,
    provider: "Hugging Face Inference",
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
      "HUGGINGFACE_API_TOKEN is not configured in environment variables."
    );
  }

  const prompt =
    typeof options.prompt === "string" && options.prompt.trim()
      ? options.prompt.trim()
      : "A high quality cinematic video";

  const tempDir = path.join(__dirname, "..", "temp");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const fileName =
    `video_${Date.now()}_` +
    `${crypto.randomBytes(4).toString("hex")}.mp4`;

  const filePath = path.join(tempDir, fileName);

  try {
    console.log("========================================");
    console.log("GAVEAI VIDEO GENERATION STARTED");
    console.log("PROVIDER: Hugging Face Inference");
    console.log("MODEL:", MODEL_ID);
    console.log("PROMPT:", prompt);
    console.log("========================================");

    const response = await axios.post(
      `${HF_VIDEO_API}/${MODEL_ID}`,
      {
        inputs: prompt
      },
      {
        headers: {
          Authorization: `Bearer ${HF_API_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "video/mp4"
        },
        responseType: "arraybuffer",
        timeout: 300000
      }
    );

    if (!response.data || response.data.length === 0) {
      throw new Error(
        "Hugging Face returned an empty video response."
      );
    }

    const contentType =
      response.headers?.["content-type"] || "";

    if (
      contentType.includes("application/json") ||
      contentType.includes("text/plain")
    ) {
      let errorMessage;

      try {
        const text = Buffer.from(response.data).toString("utf8");

        try {
          const parsed = JSON.parse(text);

          errorMessage =
            parsed?.error ||
            parsed?.message ||
            text;
        } catch {
          errorMessage = text;
        }
      } catch {
        errorMessage =
          "Hugging Face returned an invalid response.";
      }

      throw new Error(
        errorMessage ||
        "Hugging Face video generation failed."
      );
    }

    fs.writeFileSync(
      filePath,
      Buffer.from(response.data)
    );

    console.log(
      "VIDEO GENERATED SUCCESSFULLY:",
      filePath
    );

    console.log(
      "VIDEO SIZE:",
      response.data.length,
      "bytes"
    );

    return {
      success: true,
      videoFile: filePath,
      videoUrl: null,
      provider: "Hugging Face Inference",
      model: MODEL_ID,
      mode: "text-to-video",
      duration: Number(options.duration) || 5,
      width: Number(options.width) || 832,
      height: Number(options.height) || 480,
      fileSize: response.data.length
    };

  } catch (error) {
    let errorMessage =
      error?.message ||
      "Hugging Face video generation failed.";

    if (error?.response?.data) {
      try {
        const raw = Buffer.from(
          error.response.data
        ).toString("utf8");

        try {
          const parsed = JSON.parse(raw);

          errorMessage =
            parsed?.error ||
            parsed?.message ||
            raw ||
            errorMessage;
        } catch {
          errorMessage = raw || errorMessage;
        }
      } catch {
        // Keep original error message.
      }
    }

    console.error(
      "HUGGING FACE VIDEO GENERATION ERROR:",
      errorMessage
    );

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.warn(
          "VIDEO CLEANUP WARNING:",
          cleanupError?.message || cleanupError
        );
      }
    }

    throw new Error(errorMessage);
  }
}

/*
========================================================
CLEANUP
========================================================
*/

async function cleanupVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }

  try {
    fs.unlinkSync(filePath);

    console.log(
      "TEMP VIDEO CLEANED:",
      filePath
    );
  } catch (error) {
    console.warn(
      "VIDEO CLEANUP WARNING:",
      error?.message || error
    );
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

