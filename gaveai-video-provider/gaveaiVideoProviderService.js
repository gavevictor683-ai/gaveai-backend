const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
========================================================
WAVESPEEDAI CONFIGURATION
========================================================
*/

const WAVESPEED_API_KEY =
  process.env.WAVESPEED_API_KEY;

const WAVESPEED_BASE_URL =
  "https://api.wavespeed.ai/api/v3";

/*
--------------------------------------------------------
MODELS
--------------------------------------------------------
*/

// New business-friendly T2V model:
// Wan 2.2 T2V 480p Ultra Fast
const T2V_MODEL =
  process.env.WAVESPEED_T2V_MODEL ||
  "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast";

// Keep existing I2V model
const I2V_MODEL =
  process.env.WAVESPEED_I2V_MODEL ||
  "wavespeed-ai/wan-2.2/i2v-480p";

/*
--------------------------------------------------------
POLLING
--------------------------------------------------------
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

    provider: "WaveSpeedAI",

    t2vModel: T2V_MODEL,

    i2vModel: I2V_MODEL,

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
NORMALIZE ERROR
========================================================
*/

function extractWaveSpeedError(error) {
  if (!error) {
    return "WaveSpeedAI request failed.";
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
    "WaveSpeedAI request failed."
  );
}

/*
========================================================
SUBMIT PREDICTION
========================================================
*/

async function submitPrediction(
  model,
  input
) {
  const url =
    `${WAVESPEED_BASE_URL}/${model}`;

  console.log(
    "========================================"
  );

  console.log(
    "WAVESPEEDAI PREDICTION SUBMISSION"
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
        "WaveSpeedAI did not return a prediction ID."
      );
    }

    console.log(
      "WAVESPEEDAI PREDICTION ID:",
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
      extractWaveSpeedError(error);

    console.error(
      "WAVESPEEDAI SUBMISSION ERROR:",
      message
    );

    throw new Error(
      `WaveSpeed submission failed: ${message}`
    );
  }
}

/*
========================================================
POLL PREDICTION
========================================================
*/

async function waitForPrediction(
  prediction
) {
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

      if (
        status !== lastStatus
      ) {
        console.log(
          "WAVESPEEDAI STATUS:",
          status || "unknown"
        );

        lastStatus =
          status;
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
          Array.isArray(
            result?.outputs
          )
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
            "WaveSpeedAI completed the generation but returned no video URL."
          );
        }

        console.log(
          "WAVESPEEDAI VIDEO READY:",
          videoUrl
        );

        return {
          ...result,

          videoUrl
        };
      }

      /*
      --------------------------------------------------
      FAILED
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
          `WaveSpeedAI generation ended with status: ${status}`
        );
      }

      /*
      --------------------------------------------------
      CONTINUE POLLING
      --------------------------------------------------
      */

      await sleep(
        POLL_INTERVAL
      );

    } catch (error) {
      const message =
        error?.message || "";

      /*
      ----------------------------------------------
      Terminal errors
      ----------------------------------------------
      */

      if (
        message.includes(
          "WaveSpeedAI completed"
        ) ||
        message.includes(
          "WaveSpeedAI generation ended"
        )
      ) {
        throw error;
      }

      /*
      ----------------------------------------------
      Temporary polling error
      ----------------------------------------------
      */

      console.warn(
        "WAVESPEEDAI POLLING WARNING:",
        message
      );

      await sleep(
        POLL_INTERVAL
      );
    }
  }

  throw new Error(
    `WaveSpeedAI video generation timed out after ${MAX_WAIT_TIME / 1000} seconds.`
  );
}

/*
========================================================
DOWNLOAD GENERATED VIDEO
========================================================
*/

async function downloadVideo(
  videoUrl,
  filePath
) {
  console.log(
    "DOWNLOADING WAVESPEED VIDEO..."
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
      "WaveSpeedAI returned an empty video file."
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

  if (
    !stats.size
  ) {
    throw new Error(
      "Downloaded WaveSpeedAI video file is empty."
    );
  }

  console.log(
    "WAVESPEED VIDEO DOWNLOADED:",
    filePath
  );

  console.log(
    "VIDEO SIZE:",
    stats.size,
    "bytes"
  );

  return {
    filePath,

    fileSize:
      stats.size
  };
}

/*
========================================================
GENERATE VIDEO
========================================================
*/

async function generateWithGaveAIVideoProvider(
  options = {}
) {
  if (
    !WAVESPEED_API_KEY
  ) {
    throw new Error(
      "WAVESPEED_API_KEY is not configured in environment variables."
    );
  }

  const prompt =
    typeof options.prompt === "string" &&
    options.prompt.trim()
      ? options.prompt.trim()
      : "A high quality cinematic video.";

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

  if (
    !fs.existsSync(tempDir)
  ) {
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

  /*
  ------------------------------------------------------
  INPUT OPTIONS
  ------------------------------------------------------
  */

  const firstFrameImage =
    typeof options.firstFrameImage === "string" &&
    options.firstFrameImage.trim()
      ? options.firstFrameImage.trim()
      : null;

  const duration =
    Number(options.duration) || 5;

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
      : undefined;

  const requestedWidth =
    Number(options.width) || 832;

  const requestedHeight =
    Number(options.height) || 480;

  try {
    console.log(
      "========================================"
    );

    console.log(
      "GAVEAI VIDEO GENERATION STARTED"
    );

    console.log(
      "PROVIDER: WaveSpeedAI"
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
      "PROMPT:",
      prompt
    );

    console.log(
      "FIRST FRAME:",
      Boolean(firstFrameImage)
    );

    console.log(
      "DURATION:",
      duration
    );

    console.log(
      "SIZE:",
      `${requestedWidth}x${requestedHeight}`
    );

    console.log(
      "========================================"
    );

    /*
    ====================================================
    IMAGE TO VIDEO
    ====================================================
    */

    if (
      firstFrameImage
    ) {
      const input = {
        prompt,

        image:
          firstFrameImage,

        duration,

        seed
      };

      if (
        negativePrompt
      ) {
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
          "WaveSpeedAI",

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

      /*
      Wan 2.2 T2V 480p Ultra Fast
      uses 480p output.
      */

      size:
        "832*480",

      duration,

      seed
    };

    if (
      negativePrompt
    ) {
      input.negative_prompt =
        negativePrompt;
    }

    console.log(
      "T2V INPUT:",
      JSON.stringify(input, null, 2)
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
        "WaveSpeedAI",

      model:
        T2V_MODEL,

      mode:
        "text-to-video",

      duration,

      width:
        832,

      height:
        480,

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
      "WaveSpeedAI video generation failed.";

    console.error(
      "WAVESPEED VIDEO GENERATION ERROR:",
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
      } catch (
        cleanupError
      ) {
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

