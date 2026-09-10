const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
========================================================
GAVEAI VIDEO PROVIDER CONFIGURATION
========================================================
*/

const WAVESPEED_API_KEY =
  process.env.WAVESPEED_API_KEY;

const WAVESPEED_BASE_URL =
  "https://api.wavespeed.ai/api/v3";

/*
========================================================
VIDEO MODELS
========================================================
*/

const T2V_MODEL =
  process.env.WAVESPEED_T2V_MODEL ||
  "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast";

const I2V_MODEL =
  process.env.WAVESPEED_I2V_MODEL ||
  "wavespeed-ai/wan-2.2/i2v-480p";

/*
========================================================
POLLING
========================================================
*/

const POLL_INTERVAL =
  Number(process.env.WAVESPEED_POLL_INTERVAL) || 2000;

const MAX_WAIT_TIME =
  Number(process.env.WAVESPEED_MAX_WAIT) || 1800000;

/*
========================================================
STATUS
========================================================
*/

function getVideoProviderStatus() {
  return {
    configured: Boolean(WAVESPEED_API_KEY),
    provider: "GaveAI",
    videoGeneration: true,
    audioGeneration: true,
    maxWaitMs: MAX_WAIT_TIME
  };
}

/*
========================================================
SLEEP
========================================================
*/

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/*
========================================================
ERROR NORMALIZATION
========================================================
*/

function extractProviderError(error) {
  if (!error) {
    return "GaveAI provider request failed.";
  }

  if (error.response?.data) {
    const data = error.response.data;

    if (typeof data === "string") {
      return data;
    }

    return (
      data?.error ||
      data?.message ||
      data?.data?.error ||
      JSON.stringify(data)
    );
  }

  return (
    error.message ||
    "GaveAI provider request failed."
  );
}

/*
========================================================
SUBMIT PREDICTION
========================================================
*/

async function submitPrediction(model, input) {
  const url =
    `${WAVESPEED_BASE_URL}/${model}`;

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI PREDICTION SUBMISSION"
  );

  console.log(
    "MODEL:",
    model
  );

  console.log(
    "ENDPOINT:",
    url
  );

  console.log(
    "INPUT:",
    JSON.stringify(input, null, 2)
  );

  console.log(
    "========================================"
  );

  try {
    const response =
      await axios.post(
        url,
        input,
        {
          headers: {
            Authorization:
              `Bearer ${WAVESPEED_API_KEY}`,

            "Content-Type":
              "application/json"
          },

          timeout: 60000
        }
      );

    const body =
      response.data || {};

    const task =
      body.data || body;

    const predictionId =
      task.id;

    if (!predictionId) {
      throw new Error(
        "GaveAI did not return a prediction ID."
      );
    }

    console.log(
      "GAVEAI PREDICTION ID:",
      predictionId
    );

    return {
      predictionId,

      task,

      resultUrl:
        task?.urls?.get ||
        `${WAVESPEED_BASE_URL}/predictions/${predictionId}/result`
    };

  } catch (error) {
    const message =
      extractProviderError(error);

    console.error(
      "GAVEAI SUBMISSION ERROR:",
      message
    );

    throw new Error(
      `GaveAI submission failed: ${message}`
    );
  }
}

/*
========================================================
POLL PREDICTION
========================================================
*/

async function waitForPrediction(prediction) {
  const startedAt =
    Date.now();

  let lastStatus = null;

  while (
    Date.now() - startedAt <
    MAX_WAIT_TIME
  ) {
    try {
      const response =
        await axios.get(
          prediction.resultUrl,
          {
            headers: {
              Authorization:
                `Bearer ${WAVESPEED_API_KEY}`
            },

            timeout: 30000
          }
        );

      const body =
        response.data || {};

      const result =
        body.data || body;

      const status =
        String(
          result?.status || ""
        ).toLowerCase();

      if (status !== lastStatus) {
        console.log(
          "GAVEAI STATUS:",
          status || "unknown"
        );

        lastStatus = status;
      }

      /*
      --------------------------------------------------
      SUCCESS
      --------------------------------------------------
      */

      if (
        status === "completed" ||
        status === "succeeded" ||
        status === "success"
      ) {
        const outputs =
          Array.isArray(result?.outputs)
            ? result.outputs
            : [];

        const videoUrl =
          outputs.find(
            (item) =>
              typeof item === "string" &&
              item.trim()
          ) ||
          result?.output ||
          result?.video_url ||
          result?.videoUrl;

        if (!videoUrl) {
          throw new Error(
            "GaveAI completed the generation but returned no video URL."
          );
        }

        console.log(
          "GAVEAI VIDEO READY"
        );

        return {
          ...result,
          videoUrl
        };
      }

      /*
      --------------------------------------------------
      TERMINAL FAILURE
      --------------------------------------------------
      */

      if (
        [
          "failed",
          "cancelled",
          "canceled",
          "timeout",
          "deleted"
        ].includes(status)
      ) {
        throw new Error(
          result?.error ||
          result?.message ||
          `GaveAI generation ended with status: ${status}`
        );
      }

      /*
      --------------------------------------------------
      CONTINUE
      --------------------------------------------------
      */

      await sleep(
        POLL_INTERVAL
      );

    } catch (error) {
      const message =
        error?.message || "";

      /*
      --------------------------------------------------
      DO NOT RETRY TERMINAL ERRORS
      --------------------------------------------------
      */

      if (
        message.includes(
          "GaveAI completed the generation"
        ) ||
        message.includes(
          "GaveAI generation ended with status"
        )
      ) {
        throw error;
      }

      /*
      --------------------------------------------------
      TEMPORARY POLLING ERROR
      --------------------------------------------------
      */

      console.warn(
        "GAVEAI POLLING WARNING:",
        message
      );

      await sleep(
        POLL_INTERVAL
      );
    }
  }

  throw new Error(
    `GaveAI video generation timed out after ${MAX_WAIT_TIME / 1000} seconds.`
  );
}

/*
========================================================
DOWNLOAD GENERATED VIDEO
========================================================
*/

async function downloadVideo(videoUrl, filePath) {
  console.log(
    "DOWNLOADING GAVEAI VIDEO..."
  );

  const response =
    await axios.get(
      videoUrl,
      {
        responseType:
          "arraybuffer",

        timeout:
          120000
      }
    );

  if (
    !response.data ||
    response.data.length === 0
  ) {
    throw new Error(
      "GaveAI returned an empty video file."
    );
  }

  const buffer =
    Buffer.from(
      response.data
    );

  fs.writeFileSync(
    filePath,
    buffer
  );

  const stats =
    fs.statSync(filePath);

  if (!stats.size) {
    throw new Error(
      "Downloaded GaveAI video file is empty."
    );
  }

  console.log(
    "GAVEAI VIDEO DOWNLOADED:",
    filePath
  );

  console.log(
    "VIDEO SIZE:",
    stats.size,
    "bytes"
  );

  return {
    filePath,
    fileSize: stats.size
  };
}

/*
========================================================
VALIDATE DURATION
========================================================
*/

function normalizeDuration(value) {
  const duration =
    Number(value);

  if (
    duration === 5 ||
    duration === 8
  ) {
    return duration;
  }

  throw new Error(
    "GaveAI video duration must be exactly 5 or 8 seconds."
  );
}

/*
========================================================
VALIDATE SIZE
========================================================
*/

function normalizeVideoSize(
  width,
  height
) {
  const requestedWidth =
    Number(width) || 832;

  const requestedHeight =
    Number(height) || 480;

  /*
  Wan 2.2 T2V 480p supports:
  832*480
  480*832
  */

  if (
    requestedWidth === 832 &&
    requestedHeight === 480
  ) {
    return "832*480";
  }

  if (
    requestedWidth === 480 &&
    requestedHeight === 832
  ) {
    return "480*832";
  }

  return "832*480";
}

/*
========================================================
GENERATE VIDEO
========================================================
*/

async function generateWithGaveAIVideoProvider(
  options = {}
) {
  if (!WAVESPEED_API_KEY) {
    throw new Error(
      "GAVEAI video provider is not configured. Please set the required provider API key."
    );
  }

  const prompt =
    typeof options.prompt === "string" &&
    options.prompt.trim()
      ? options.prompt.trim()
      : "A high quality cinematic video.";

  const duration =
    normalizeDuration(
      options.duration
    );

  const firstFrameImage =
    typeof options.firstFrameImage === "string" &&
    options.firstFrameImage.trim()
      ? options.firstFrameImage.trim()
      : null;

  const lastFrameImage =
    typeof options.lastFrameImage === "string" &&
    options.lastFrameImage.trim()
      ? options.lastFrameImage.trim()
      : null;

  const seed =
    Number.isFinite(
      Number(options.seed)
    )
      ? Number(options.seed)
      : -1;

  const negativePrompt =
    typeof options.negativePrompt === "string" &&
    options.negativePrompt.trim()
      ? options.negativePrompt.trim()
      : null;

  const requestedWidth =
    Number(options.width) || 832;

  const requestedHeight =
    Number(options.height) || 480;

  const size =
    normalizeVideoSize(
      requestedWidth,
      requestedHeight
    );

  /*
  ------------------------------------------------------
  TEMP DIRECTORY
  ------------------------------------------------------
  */

  const tempDir =
    path.join(
      __dirname,
      "..",
      "temp"
    );

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(
      tempDir,
      {
        recursive: true
      }
    );
  }

  const fileName =
    `video_${Date.now()}_` +
    `${crypto.randomBytes(4).toString("hex")}.mp4`;

  const filePath =
    path.join(
      tempDir,
      fileName
    );

  try {
    console.log(
      "========================================"
    );

    console.log(
      "GAVEAI VIDEO GENERATION STARTED"
    );

    console.log(
      "PROVIDER: GaveAI"
    );

    console.log(
      "T2V MODEL:",
      T2V_MODEL
    );

    console.log(
      "I2V MODEL:",
      I2V_MODEL
    );

    console.log(
      "MODE:",
      firstFrameImage
        ? "IMAGE-TO-VIDEO"
        : "TEXT-TO-VIDEO"
    );

    console.log(
      "PROMPT:",
      prompt
    );

    console.log(
      "FIRST FRAME:",
      Boolean(firstFrameImage)
    );

    console.log(
      "LAST FRAME:",
      Boolean(lastFrameImage)
    );

    console.log(
      "DURATION:",
      duration
    );

    console.log(
      "SIZE:",
      size
    );

    console.log(
      "========================================"
    );

    /*
    ====================================================
    IMAGE TO VIDEO
    ====================================================
    */

    if (firstFrameImage) {
      const input = {
        prompt,

        image:
          firstFrameImage,

        duration,

        seed
      };

      if (lastFrameImage) {
        input.last_image =
          lastFrameImage;
      }

      if (negativePrompt) {
        input.negative_prompt =
          negativePrompt;
      }

      const prediction =
        await submitPrediction(
          I2V_MODEL,
          input
        );

      const result =
        await waitForPrediction(
          prediction
        );

      await downloadVideo(
        result.videoUrl,
        filePath
      );

      return {
        success: true,

        videoFile:
          filePath,

        videoUrl:
          result.videoUrl,

        provider:
          "GaveAI",

        model:
          I2V_MODEL,

        mode:
          "image-to-video",

        duration,

        width:
          requestedWidth,

        height:
          requestedHeight,

        fileSize:
          fs.statSync(
            filePath
          ).size,

        predictionId:
          result.id ||
          prediction.predictionId
      };
    }

    /*
    ====================================================
    TEXT TO VIDEO
    ====================================================
    */

    const input = {
      prompt,

      size,

      duration,

      seed
    };

    if (negativePrompt) {
      input.negative_prompt =
        negativePrompt;
    }

    console.log(
      "T2V INPUT:",
      JSON.stringify(
        input,
        null,
        2
      )
    );

    const prediction =
      await submitPrediction(
        T2V_MODEL,
        input
      );

    const result =
      await waitForPrediction(
        prediction
      );

    await downloadVideo(
      result.videoUrl,
      filePath
    );

    return {
      success: true,

      videoFile:
        filePath,

      videoUrl:
        result.videoUrl,

      provider:
        "GaveAI",

      model:
        T2V_MODEL,

      mode:
        "text-to-video",

      duration,

      width:
        size === "480*832"
          ? 480
          : 832,

      height:
        size === "480*832"
          ? 832
          : 480,

      fileSize:
        fs.statSync(
          filePath
        ).size,

      predictionId:
        result.id ||
        prediction.predictionId
    };

  } catch (error) {
    const message =
      error?.message ||
      "GaveAI video generation failed.";

    console.error(
      "GAVEAI VIDEO GENERATION ERROR:",
      message
    );

    /*
    ----------------------------------------------------
    CLEAN TEMP FILE
    ----------------------------------------------------
    */

    if (
      fs.existsSync(
        filePath
      )
    ) {
      try {
        fs.unlinkSync(
          filePath
        );
      } catch (cleanupError) {
        console.warn(
          "VIDEO CLEANUP WARNING:",
          cleanupError?.message ||
          cleanupError
        );
      }
    }

    throw new Error(
      message
    );
  }
}

/*
========================================================
CLEANUP VIDEO FILE
========================================================
*/

async function cleanupVideoFile(
  filePath
) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    return;
  }

  try {
    fs.unlinkSync(
      filePath
    );

    console.log(
      "TEMP VIDEO CLEANED:",
      filePath
    );

  } catch (error) {
    console.warn(
      "VIDEO CLEANUP WARNING:",
      error?.message ||
      error
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