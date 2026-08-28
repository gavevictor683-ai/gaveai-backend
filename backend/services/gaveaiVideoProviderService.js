require("dotenv").config();

/*
========================================================
GAVEAI VIDEO PROVIDER
========================================================

Provider:
    WaveSpeedAI

Models:
    Text-to-Video:
    wavespeed-ai/wan-2.2/t2v-480p

    Image-to-Video:
    wavespeed-ai/wan-2.2/image-to-video

Flow:

    GaveAI Backend
          ↓
    This Provider
          ↓
    WaveSpeedAI
          ↓
    Wan 2.2
          ↓
    Prediction ID
          ↓
    Poll Result
          ↓
    Temporary Video URL
          ↓
    Download MP4 locally
          ↓
    server.js uploads to ImageKit

IMPORTANT:
- Never expose WAVESPEED_API_KEY to frontend.
- WaveSpeed output URLs are temporary.
- server.js is responsible for uploading the final MP4
  to ImageKit.
========================================================
*/

const fs = require("fs");
const path = require("path");

/*
========================================================
CONFIGURATION
========================================================
*/

const WAVESPEED_API_KEY =
  process.env.WAVESPEED_API_KEY
    ? process.env.WAVESPEED_API_KEY.trim()
    : "";

const WAVESPEED_BASE_URL =
  process.env.WAVESPEED_BASE_URL ||
  "https://api.wavespeed.ai/api/v3";

const T2V_MODEL =
  process.env.WAVESPEED_VIDEO_T2V_MODEL ||
  "wavespeed-ai/wan-2.2/t2v-480p";

const I2V_MODEL =
  process.env.WAVESPEED_VIDEO_I2V_MODEL ||
  "wavespeed-ai/wan-2.2/image-to-video";

/*
Default generation settings.

Wan 2.2 T2V 480p:
- 832*480 landscape
- 480*832 portrait
- duration: 5 or 8 seconds
*/

const DEFAULT_WIDTH = 832;
const DEFAULT_HEIGHT = 480;

const DEFAULT_DURATION = 5;

const DEFAULT_SEED = -1;

/*
Polling:
WaveSpeed recommends starting around 2 seconds.
We gradually increase to reduce unnecessary requests.
*/

const INITIAL_POLL_INTERVAL = 2000;

const MAX_POLL_INTERVAL = 10000;

const MAX_WAIT_MS =
  Number(
    process.env.WAVESPEED_VIDEO_MAX_WAIT_MS
  ) ||
  30 * 60 * 1000;

/*
========================================================
HELPERS
========================================================
*/

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cleanString(value) {
  return String(value || "").trim();
}

function isHttpUrl(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function clampNumber(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}

/*
========================================================
RESOLUTION
========================================================

The existing GaveAI server sends:

width
height

WaveSpeed Wan 2.2 T2V expects:

"832*480"
or
"480*832"

For I2V, the current API uses:

resolution:
"480p"
or
"720p"

========================================================
*/

function getT2VSize(width, height) {
  let w = Math.round(
    clampNumber(width, DEFAULT_WIDTH)
  );

  let h = Math.round(
    clampNumber(height, DEFAULT_HEIGHT)
  );

  /*
  Portrait
  */

  if (h > w) {
    return "480*832";
  }

  /*
  Landscape
  */

  return "832*480";
}

function getI2VResolution(
  width,
  height,
  requestedResolution
) {
  const resolution =
    cleanString(
      requestedResolution
    ).toLowerCase();

  if (
    resolution === "720p" ||
    resolution === "720"
  ) {
    return "720p";
  }

  if (
    resolution === "480p" ||
    resolution === "480"
  ) {
    return "480p";
  }

  /*
  Automatically choose based on dimensions.
  */

  const w = clampNumber(
    width,
    DEFAULT_WIDTH
  );

  const h = clampNumber(
    height,
    DEFAULT_HEIGHT
  );

  if (w >= 1200 || h >= 720) {
    return "720p";
  }

  return "480p";
}

/*
========================================================
DURATION
========================================================

Wan 2.2 supports 5 or 8 seconds.

If caller sends something else, normalize it.
========================================================
*/

function normalizeDuration(value) {
  const duration =
    Math.round(
      clampNumber(
        value,
        DEFAULT_DURATION
      )
    );

  if (duration >= 8) {
    return 8;
  }

  return 5;
}

/*
========================================================
SEED
========================================================
*/

function normalizeSeed(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return DEFAULT_SEED;
  }

  const seed = Number(value);

  if (!Number.isFinite(seed)) {
    return DEFAULT_SEED;
  }

  return Math.trunc(seed);
}

/*
========================================================
API ERROR EXTRACTION
========================================================
*/

async function extractResponseBody(response) {
  const text =
    await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text
    };
  }
}

function extractErrorMessage(
  body,
  fallback
) {
  if (!body) {
    return fallback;
  }

  if (
    body.error &&
    typeof body.error === "string"
  ) {
    return body.error;
  }

  if (
    body.error &&
    body.error.message
  ) {
    return body.error.message;
  }

  if (
    body.message &&
    typeof body.message === "string"
  ) {
    return body.message;
  }

  if (
    body.data &&
    body.data.error
  ) {
    return body.data.error;
  }

  return fallback;
}

/*
========================================================
SUBMIT PREDICTION
========================================================

WaveSpeed API:

POST
https://api.wavespeed.ai/api/v3/{model_id}

========================================================
*/

async function submitPrediction(
  model,
  input
) {
  if (!WAVESPEED_API_KEY) {
    throw new Error(
      "WAVESPEED_API_KEY is not configured."
    );
  }

  if (!model) {
    throw new Error(
      "WaveSpeed video model is not configured."
    );
  }

  const url =
    `${WAVESPEED_BASE_URL}/${model}`;

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI WAVESPEED SUBMIT"
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
    JSON.stringify(
      input,
      null,
      2
    )
  );

  console.log(
    "========================================"
  );

  let response;

  try {
    response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${WAVESPEED_API_KEY}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(input),

          signal:
            AbortSignal.timeout(
              60 * 1000
            )
        }
      );
  } catch (error) {
    throw new Error(
      `WaveSpeed submission request failed: ${
        error?.message ||
        "Network error"
      }`
    );
  }

  const body =
    await extractResponseBody(
      response
    );

  if (!response.ok) {
    const message =
      extractErrorMessage(
        body,
        `WaveSpeed returned HTTP ${response.status}.`
      );

    throw new Error(
      `WaveSpeed submission failed: ${message}`
    );
  }

  /*
  WaveSpeed normally returns:

  {
    code: 200,
    message: "success",
    data: {
      id: "...",
      status: "created",
      urls: {
        get: "..."
      }
    }
  }
  */

  const task =
    body?.data || body;

  const predictionId =
    task?.id ||
    task?.prediction_id ||
    task?.task_id;

  if (!predictionId) {
    console.error(
      "WAVESPEED INVALID SUBMISSION RESPONSE:",
      body
    );

    throw new Error(
      "WaveSpeed did not return a prediction ID."
    );
  }

  const resultUrl =
    task?.urls?.get ||
    `${WAVESPEED_BASE_URL}/predictions/${predictionId}/result`;

  console.log(
    "WAVESPEED PREDICTION ID:",
    predictionId
  );

  console.log(
    "WAVESPEED RESULT URL:",
    resultUrl
  );

  return {
    predictionId:
      String(predictionId),

    resultUrl:
      String(resultUrl),

    task
  };
}

/*
========================================================
GET PREDICTION RESULT
========================================================
*/

async function getPredictionResult(
  resultUrl
) {
  let response;

  try {
    response =
      await fetch(
        resultUrl,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${WAVESPEED_API_KEY}`,

            Accept:
              "application/json"
          },

          signal:
            AbortSignal.timeout(
              30 * 1000
            )
        }
      );
  } catch (error) {
    throw new Error(
      `WaveSpeed result request failed: ${
        error?.message ||
        "Network error"
      }`
    );
  }

  const body =
    await extractResponseBody(
      response
    );

  if (!response.ok) {
    const message =
      extractErrorMessage(
        body,
        `WaveSpeed result returned HTTP ${response.status}.`
      );

    const error =
      new Error(
        `WaveSpeed result request failed: ${message}`
      );

    error.retryable =
      response.status === 429 ||
      response.status >= 500;

    throw error;
  }

  const result =
    body?.data || body;

  if (!result) {
    throw new Error(
      "WaveSpeed returned an empty result."
    );
  }

  return result;
}

/*
========================================================
POLL PREDICTION
========================================================

Terminal failures:

failed
cancelled
timeout
deleted

Success:

completed

Everything else continues polling.
========================================================
*/

async function waitForPrediction(
  prediction
) {
  const resultUrl =
    prediction.resultUrl;

  const predictionId =
    prediction.predictionId;

  const deadline =
    Date.now() + MAX_WAIT_MS;

  let pollInterval =
    INITIAL_POLL_INTERVAL;

  let transientFailures = 0;

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI WAVESPEED POLLING STARTED"
  );

  console.log(
    "PREDICTION ID:",
    predictionId
  );

  console.log(
    "========================================"
  );

  while (
    Date.now() < deadline
  ) {
    let result;

    try {
      result =
        await getPredictionResult(
          resultUrl
        );

      transientFailures = 0;
    } catch (error) {
      /*
      GET requests are safe to retry.
      Do NOT automatically retry the
      original POST submission.
      */

      if (
        error?.retryable &&
        transientFailures < 5
      ) {
        transientFailures++;

        const retryDelay =
          Math.min(
            10000,
            1000 *
              Math.pow(
                2,
                transientFailures - 1
              )
          );

        console.warn(
          "WAVESPEED TEMPORARY RESULT ERROR:",
          error.message
        );

        console.warn(
          `Retrying result request in ${retryDelay}ms...`
        );

        await sleep(
          retryDelay
        );

        continue;
      }

      throw error;
    }

    const status =
      cleanString(
        result.status
      ).toLowerCase();

    console.log(
      "WAVESPEED STATUS:",
      status || "unknown"
    );

    /*
    ================================================
    SUCCESS
    ================================================
    */

    if (
      status === "completed"
    ) {
      const outputs =
        Array.isArray(
          result.outputs
        )
          ? result.outputs
          : [];

      if (
        outputs.length === 0
      ) {
        throw new Error(
          "WaveSpeed marked the prediction completed but returned no outputs."
        );
      }

      console.log(
        "WAVESPEED GENERATION COMPLETED"
      );

      console.log(
        "OUTPUT COUNT:",
        outputs.length
      );

      return {
        ...result,
        outputs
      };
    }

    /*
    ================================================
    FAILURE
    ================================================
    */

    const failureStatuses =
      new Set([
        "failed",
        "cancelled",
        "timeout",
        "deleted"
      ]);

    if (
      failureStatuses.has(
        status
      )
    ) {
      const errorMessage =
        result.error ||
        `WaveSpeed prediction ended with status: ${status}`;

      throw new Error(
        `WaveSpeed video generation failed: ${errorMessage}`
      );
    }

    /*
    ================================================
    CONTINUE POLLING
    ================================================
    */

    await sleep(
      pollInterval
    );

    pollInterval =
      Math.min(
        MAX_POLL_INTERVAL,
        pollInterval + 1000
      );
  }

  throw new Error(
    `WaveSpeed video generation timed out after ${Math.round(
      MAX_WAIT_MS / 60000
    )} minute(s). Prediction ID: ${predictionId}`
  );
}

/*
========================================================
EXTRACT OUTPUT URL
========================================================

WaveSpeed outputs can contain:
- URL strings
- structured objects

For the video provider we need a downloadable URL.
========================================================
*/

function extractOutputUrl(
  outputs
) {
  if (
    !Array.isArray(outputs)
  ) {
    return null;
  }

  for (
    const output of outputs
  ) {
    if (
      typeof output === "string" &&
      isHttpUrl(output)
    ) {
      return output;
    }

    if (
      output &&
      typeof output === "object"
    ) {
      const candidates = [
        output.url,
        output.video_url,
        output.videoUrl,
        output.download_url,
        output.downloadUrl
      ];

      for (
        const candidate of candidates
      ) {
        if (
          isHttpUrl(candidate)
        ) {
          return candidate;
        }
      }
    }
  }

  return null;
}

/*
========================================================
DOWNLOAD GENERATED VIDEO
========================================================

WaveSpeed output URLs are temporary, so we download
the MP4 to the Render server before server.js sends
it to ImageKit.

========================================================
*/

async function downloadVideo(
  videoUrl,
  predictionId
) {
  if (
    !isHttpUrl(videoUrl)
  ) {
    throw new Error(
      "WaveSpeed returned an invalid video URL."
    );
  }

  const tempDirectory =
    path.join(
      process.cwd(),
      "tmp",
      "gaveai-videos"
    );

  fs.mkdirSync(
    tempDirectory,
    {
      recursive: true
    }
  );

  const safeId =
    String(
      predictionId ||
        Date.now()
    ).replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );

  const filePath =
    path.join(
      tempDirectory,
      `gaveai-${safeId}.mp4`
    );

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO DOWNLOAD STARTED"
  );

  console.log(
    "SOURCE:",
    videoUrl
  );

  console.log(
    "DESTINATION:",
    filePath
  );

  console.log(
    "========================================"
  );

  let response;

  try {
    response =
      await fetch(
        videoUrl,
        {
          method: "GET",

          signal:
            AbortSignal.timeout(
              10 * 60 * 1000
            )
        }
      );
  } catch (error) {
    throw new Error(
      `Unable to download generated video: ${
        error?.message ||
        "Network error"
      }`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Generated video download failed with HTTP ${response.status}.`
    );
  }

  if (!response.body) {
    throw new Error(
      "Generated video response has no readable body."
    );
  }

  const fileStream =
    fs.createWriteStream(
      filePath
    );

  try {
    /*
    Node.js 18+ fetch returns a Web ReadableStream.
    Convert it into a Node stream.
    */

    const { Readable } =
      require("stream");

    const nodeStream =
      Readable.fromWeb(
        response.body
      );

    await new Promise(
      (resolve, reject) => {
        nodeStream.pipe(
          fileStream
        );

        nodeStream.on(
          "error",
          reject
        );

        fileStream.on(
          "finish",
          resolve
        );

        fileStream.on(
          "error",
          reject
        );
      }
    );
  } catch (error) {
    try {
      if (
        fs.existsSync(
          filePath
        )
      ) {
        fs.unlinkSync(
          filePath
        );
      }
    } catch {}

    throw new Error(
      `Failed to save generated video locally: ${
        error?.message ||
        "File write error"
      }`
    );
  }

  const stats =
    fs.statSync(
      filePath
    );

  if (
    !stats.size ||
    stats.size <= 0
  ) {
    try {
      fs.unlinkSync(
        filePath
      );
    } catch {}

    throw new Error(
      "Downloaded video file is empty."
    );
  }

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO DOWNLOAD SUCCESS"
  );

  console.log(
    "FILE:",
    filePath
  );

  console.log(
    "SIZE:",
    stats.size
  );

  console.log(
    "========================================"
  );

  return filePath;
}

/*
========================================================
BUILD T2V INPUT
========================================================
*/

function buildT2VInput({
  prompt,
  width,
  height,
  duration,
  seed,
  negativePrompt
}) {
  const input = {
    prompt:
      cleanString(prompt),

    size:
      getT2VSize(
        width,
        height
      ),

    duration:
      normalizeDuration(
        duration
      ),

    seed:
      normalizeSeed(seed)
  };

  if (
    negativePrompt &&
    cleanString(
      negativePrompt
    )
  ) {
    input.negative_prompt =
      cleanString(
        negativePrompt
      );
  }

  return input;
}

/*
========================================================
BUILD I2V INPUT
========================================================
*/

function buildI2VInput({
  prompt,
  firstFrameImage,
  width,
  height,
  duration,
  seed,
  negativePrompt,
  resolution,
  lastImage
}) {
  if (
    !isHttpUrl(
      firstFrameImage
    )
  ) {
    throw new Error(
      "Image-to-video requires firstFrameImage to be a public HTTP/HTTPS image URL."
    );
  }

  const input = {
    prompt:
      cleanString(prompt),

    image:
      firstFrameImage,

    resolution:
      getI2VResolution(
        width,
        height,
        resolution
      ),

    duration:
      normalizeDuration(
        duration
      ),

    seed:
      normalizeSeed(seed)
  };

  if (
    negativePrompt &&
    cleanString(
      negativePrompt
    )
  ) {
    input.negative_prompt =
      cleanString(
        negativePrompt
      );
  }

  if (
    lastImage &&
    isHttpUrl(
      lastImage
    )
  ) {
    input.last_image =
      lastImage;
  }

  return input;
}

/*
========================================================
MAIN VIDEO GENERATOR
========================================================

This is the function server.js imports:

const {
  generateWithGaveAIVideoProvider
} = require(
  "./services/gaveaiVideoProviderService"
);

========================================================
*/

async function generateWithGaveAIVideoProvider(
  options = {}
) {
  const prompt =
    cleanString(
      options.prompt
    );

  if (!prompt) {
    throw new Error(
      "Video prompt is required."
    );
  }

  if (!WAVESPEED_API_KEY) {
    throw new Error(
      "WAVESPEED_API_KEY is missing. Add it to your environment variables."
    );
  }

  const width =
    clampNumber(
      options.width,
      DEFAULT_WIDTH
    );

  const height =
    clampNumber(
      options.height,
      DEFAULT_HEIGHT
    );

  const duration =
    normalizeDuration(
      options.duration
    );

  const seed =
    normalizeSeed(
      options.seed
    );

  const negativePrompt =
    cleanString(
      options.negativePrompt ||
      options.negative_prompt
    );

  /*
  firstFrameImage is the image we want
  Wan 2.2 to animate.

  The server/frontend can send either:
  firstFrameImage
  or
  image
  */

  const firstFrameImage =
    cleanString(
      options.firstFrameImage ||
      options.image
    );

  /*
  Optional last frame.
  */

  const lastImage =
    cleanString(
      options.lastImage ||
      options.last_image
    );

  /*
  Optional resolution.
  */

  const requestedResolution =
    cleanString(
      options.resolution
    );

  /*
  ======================================================
  CHOOSE VIDEO MODE
  ======================================================

  Image provided:
      I2V

  No image:
      T2V
  ======================================================
  */

  const useImageToVideo =
    Boolean(
      firstFrameImage
    );

  let model;

  let input;

  let mode;

  if (
    useImageToVideo
  ) {
    model =
      process.env.WAVESPEED_VIDEO_I2V_MODEL ||
      I2V_MODEL;

    mode =
      "image-to-video";

    input =
      buildI2VInput({
        prompt,

        firstFrameImage,

        width,
        height,

        duration,

        seed,

        negativePrompt,

        resolution:
          requestedResolution,

        lastImage
      });
  } else {
    model =
      process.env.WAVESPEED_VIDEO_T2V_MODEL ||
      T2V_MODEL;

    mode =
      "text-to-video";

    input =
      buildT2VInput({
        prompt,

        width,
        height,

        duration,

        seed,

        negativePrompt
      });
  }

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
    "MODE:",
    mode
  );

  console.log(
    "MODEL:",
    model
  );

  console.log(
    "PROMPT:",
    prompt
  );

  console.log(
    "HAS FIRST FRAME:",
    Boolean(
      firstFrameImage
    )
  );

  console.log(
    "========================================"
  );

  /*
  ======================================================
  SUBMIT
  ======================================================
  */

  const prediction =
    await submitPrediction(
      model,
      input
    );

  /*
  ======================================================
  POLL
  ======================================================
  */

  const result =
    await waitForPrediction(
      prediction
    );

  /*
  ======================================================
  EXTRACT OUTPUT
  ======================================================
  */

  const videoUrl =
    extractOutputUrl(
      result.outputs
    );

  if (!videoUrl) {
    console.error(
      "WAVESPEED OUTPUTS:",
      JSON.stringify(
        result.outputs,
        null,
        2
      )
    );

    throw new Error(
      "WaveSpeed completed the video generation but no downloadable video URL was found."
    );
  }

  /*
  ======================================================
  DOWNLOAD
  ======================================================
  */

  const videoFile =
    await downloadVideo(
      videoUrl,
      prediction.predictionId
    );

  /*
  ======================================================
  FINAL RESULT
  ======================================================
  */

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO PROVIDER SUCCESS"
  );

  console.log(
    "PROVIDER: WaveSpeedAI"
  );

  console.log(
    "MODEL:",
    model
  );

  console.log(
    "MODE:",
    mode
  );

  console.log(
    "PREDICTION ID:",
    prediction.predictionId
  );

  console.log(
    "VIDEO FILE:",
    videoFile
  );

  console.log(
    "VIDEO URL:",
    videoUrl
  );

  console.log(
    "========================================"
  );

  return {
    success: true,

    provider:
      "WaveSpeedAI",

    model,

    mode,

    predictionId:
      prediction.predictionId,

    videoFile,

    videoUrl,

    outputUrl:
      videoUrl,

    status:
      "completed",

    duration,

    width,

    height
  };
}

/*
========================================================
HEALTH / CONFIG INFO
========================================================

Useful for debugging without exposing API keys.
========================================================
*/

function getVideoProviderStatus() {
  return {
    provider:
      "WaveSpeedAI",

    configured:
      Boolean(
        WAVESPEED_API_KEY
      ),

    baseUrl:
      WAVESPEED_BASE_URL,

    t2vModel:
      T2V_MODEL,

    i2vModel:
      I2V_MODEL,

    maxWaitMs:
      MAX_WAIT_MS
  };
}

/*
========================================================
EXPORTS
========================================================
*/

module.exports = {
  generateWithGaveAIVideoProvider,
  getVideoProviderStatus
};

