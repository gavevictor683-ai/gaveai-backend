require("dotenv").config();

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

/*
========================================================
CONFIGURATION
========================================================
*/

// Cloudflare image model
const CLOUDFLARE_IMAGE_MODEL =
  "@cf/black-forest-labs/flux-1-schnell";

// Hugging Face video Space
const GAVEAI_VIDEO_PROVIDER_URL =
  process.env.GAVEAI_VIDEO_PROVIDER_URL ||
  "https://gavevictor-gaveai-video.hf.space";

// Hugging Face model
const GAVEAI_VIDEO_MODEL =
  "Wan-AI/Wan2.2-TI2V-5B-Diffusers";

// Provider timeout
const GAVEAI_VIDEO_TIMEOUT_MS =
  Number(process.env.GAVEAI_VIDEO_TIMEOUT_MS) || 600000;


/*
========================================================
VIDEO OUTPUT DIRECTORY
========================================================
*/

const VIDEO_OUTPUT_DIR = path.join(
  os.tmpdir(),
  "gaveai-videos"
);

if (!fs.existsSync(VIDEO_OUTPUT_DIR)) {
  fs.mkdirSync(VIDEO_OUTPUT_DIR, {
    recursive: true
  });
}


/*
========================================================
FFMPEG PATH
========================================================

Priority:

1. FFMPEG_PATH from .env
2. ffmpeg available in PATH
3. Windows WinGet installation
4. Common Windows installation paths
========================================================
*/

function findFFmpeg() {

  /*
  ------------------------------------------------------
  1. EXPLICIT ENVIRONMENT VARIABLE
  ------------------------------------------------------
  */

  if (
    process.env.FFMPEG_PATH &&
    fs.existsSync(process.env.FFMPEG_PATH)
  ) {
    return process.env.FFMPEG_PATH;
  }


  /*
  ------------------------------------------------------
  2. STANDARD COMMAND
  ------------------------------------------------------
  */

  if (process.platform !== "win32") {
    return "ffmpeg";
  }


  /*
  ------------------------------------------------------
  3. WINDOWS WINGET INSTALLATION
  ------------------------------------------------------
  */

  const wingetPackagesPath = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WinGet",
    "Packages"
  );

  if (fs.existsSync(wingetPackagesPath)) {

    try {

      const entries = fs.readdirSync(
        wingetPackagesPath,
        {
          withFileTypes: true
        }
      );

      for (const entry of entries) {

        if (
          !entry.isDirectory() ||
          !entry.name
            .toLowerCase()
            .startsWith("gyan.ffmpeg")
        ) {
          continue;
        }

        const packageDirectory = path.join(
          wingetPackagesPath,
          entry.name
        );

        const result = findFileRecursive(
          packageDirectory,
          "ffmpeg.exe"
        );

        if (result) {
          return result;
        }
      }

    } catch (error) {

      console.warn(
        "FFmpeg WinGet search warning:",
        error.message
      );
    }
  }


  /*
  ------------------------------------------------------
  4. COMMON WINDOWS LOCATIONS
  ------------------------------------------------------
  */

  const possiblePaths = [

    "C:\\ffmpeg\\bin\\ffmpeg.exe",

    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",

    "C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe",

    "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe"

  ];


  for (const possiblePath of possiblePaths) {

    if (fs.existsSync(possiblePath)) {
      return possiblePath;
    }
  }


  /*
  ------------------------------------------------------
  5. FALLBACK
  ------------------------------------------------------
  */

  return "ffmpeg";
}


/*
========================================================
RECURSIVE FILE SEARCH
========================================================
*/

function findFileRecursive(
  directory,
  fileName
) {

  try {

    const entries = fs.readdirSync(
      directory,
      {
        withFileTypes: true
      }
    );

    for (const entry of entries) {

      const fullPath = path.join(
        directory,
        entry.name
      );

      if (
        entry.isFile() &&
        entry.name.toLowerCase() ===
          fileName.toLowerCase()
      ) {

        return fullPath;
      }


      if (entry.isDirectory()) {

        const result =
          findFileRecursive(
            fullPath,
            fileName
          );

        if (result) {
          return result;
        }
      }
    }

  } catch (error) {

    return null;
  }

  return null;
}


/*
========================================================
FFMPEG INSTANCE
========================================================
*/

const FFMPEG_PATH = findFFmpeg();


/*
========================================================
VERIFY FFMPEG
========================================================
*/

function verifyFFmpeg() {

  if (!FFMPEG_PATH) {
    return false;
  }

  if (
    FFMPEG_PATH !== "ffmpeg" &&
    !fs.existsSync(FFMPEG_PATH)
  ) {
    return false;
  }

  return true;
}


/*
========================================================
CLOUDFLARE WORKERS AI
IMAGE GENERATION
========================================================
*/

async function generateImage(prompt) {

  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {

    return {
      success: false,
      provider: "cloudflare-workers-ai",
      message:
        "Cloudflare Account ID is not configured on the server."
    };
  }


  if (!process.env.CLOUDFLARE_API_TOKEN) {

    return {
      success: false,
      provider: "cloudflare-workers-ai",
      message:
        "Cloudflare API token is not configured on the server."
    };
  }


  if (
    !prompt ||
    typeof prompt !== "string" ||
    !prompt.trim()
  ) {

    return {
      success: false,
      provider: "cloudflare-workers-ai",
      message:
        "An image prompt is required."
    };
  }


  try {

    const url =
      "https://api.cloudflare.com/client/v4/accounts/" +
      process.env.CLOUDFLARE_ACCOUNT_ID +
      "/ai/run/" +
      CLOUDFLARE_IMAGE_MODEL;


    console.log(
      "========================================"
    );

    console.log(
      "CLOUDFLARE IMAGE REQUEST STARTED"
    );

    console.log(
      "MODEL:",
      CLOUDFLARE_IMAGE_MODEL
    );

    console.log(
      "========================================"
    );


    const response = await axios.post(
      url,
      {
        prompt: prompt.trim(),
        steps: 4
      },
      {
        headers: {
          Authorization:
            `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,

          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        timeout: 120000,

        responseType: "json"
      }
    );


    const data = response.data;


    if (!data || !data.success) {

      console.error(
        "CLOUDFLARE IMAGE ERROR:",
        data
      );

      return {
        success: false,
        provider:
          "cloudflare-workers-ai",
        model:
          CLOUDFLARE_IMAGE_MODEL,
        message:
          data?.errors?.[0]?.message ||
          `Cloudflare image generation failed with HTTP ${response.status}.`
      };
    }


    if (
      !data.result ||
      !data.result.image
    ) {

      console.error(
        "CLOUDFLARE IMAGE RESPONSE:",
        data
      );

      return {
        success: false,
        provider:
          "cloudflare-workers-ai",
        model:
          CLOUDFLARE_IMAGE_MODEL,
        message:
          "Cloudflare did not return a generated image."
      };
    }


    console.log(
      "CLOUDFLARE IMAGE GENERATION SUCCESS"
    );


    return {
      success: true,
      provider:
        "cloudflare-workers-ai",
      model:
        CLOUDFLARE_IMAGE_MODEL,
      image:
        `data:image/jpeg;base64,${data.result.image}`
    };


  } catch (error) {

    console.error(
      "CLOUDFLARE IMAGE GENERATION ERROR:",
      error.message
    );


    if (error.response) {

      console.error(
        "CLOUDFLARE HTTP STATUS:",
        error.response.status
      );

      console.error(
        "CLOUDFLARE RESPONSE:",
        error.response.data
      );
    }


    return {
      success: false,
      provider:
        "cloudflare-workers-ai",
      model:
        CLOUDFLARE_IMAGE_MODEL,
      message:
        error.response?.data?.errors?.[0]?.message ||
        error.message ||
        "Cloudflare image generation failed."
    };
  }
}


/*
========================================================
PARSE SSE
========================================================

Gradio returns Server-Sent Events.

Supported format:

event: complete
data: [...]

event: error
data: ...

========================================================
*/

function parseSSE(text) {

  const events = [];

  if (
    !text ||
    typeof text !== "string"
  ) {
    return events;
  }


  const blocks = text
    .split(/\r?\n\r?\n/)
    .map(
      block => block.trim()
    )
    .filter(Boolean);


  for (const block of blocks) {

    let eventName = "message";
    const dataLines = [];


    const lines = block.split(/\r?\n/);


    for (const line of lines) {

      if (line.startsWith("event:")) {

        eventName =
          line
            .slice(6)
            .trim();
      }


      if (line.startsWith("data:")) {

        dataLines.push(
          line
            .slice(5)
            .trim()
        );
      }
    }


    if (dataLines.length > 0) {

      events.push({
        event: eventName,
        data: dataLines.join("\n")
      });
    }
  }


  return events;
}


/*
========================================================
NORMALIZE FILE RESULT
========================================================

Gradio can return:

- string
- URL
- object.url
- object.path
- nested file object
- array

========================================================
*/

function normalizeFileResult(value) {

  if (!value) {
    return "";
  }


  /*
  ------------------------------------------------------
  STRING
  ------------------------------------------------------
  */

  if (typeof value === "string") {

    return value.trim();
  }


  /*
  ------------------------------------------------------
  URL OBJECT
  ------------------------------------------------------
  */

  if (value instanceof URL) {

    return value.toString();
  }


  /*
  ------------------------------------------------------
  ARRAY
  ------------------------------------------------------
  */

  if (Array.isArray(value)) {

    for (const item of value) {

      const result =
        normalizeFileResult(item);

      if (result) {
        return result;
      }
    }

    return "";
  }


  /*
  ------------------------------------------------------
  OBJECT URL
  ------------------------------------------------------
  */

  if (
    value.url &&
    typeof value.url === "string"
  ) {

    return value.url.trim();
  }


  /*
  ------------------------------------------------------
  URL FUNCTION
  ------------------------------------------------------
  */

  if (
    typeof value.url === "function"
  ) {

    try {

      const result =
        value.url();

      if (result instanceof URL) {
        return result.toString();
      }

      if (typeof result === "string") {
        return result.trim();
      }

      if (
        result &&
        typeof result.toString === "function"
      ) {

        const converted =
          result.toString();

        if (
          converted &&
          converted !== "[object Object]"
        ) {

          return converted.trim();
        }
      }

    } catch (error) {

      console.warn(
        "FILE URL() WARNING:",
        error.message
      );
    }
  }


  /*
  ------------------------------------------------------
  PATH
  ------------------------------------------------------
  */

  if (
    value.path &&
    typeof value.path === "string"
  ) {

    return value.path.trim();
  }


  /*
  ------------------------------------------------------
  VALUE
  ------------------------------------------------------
  */

  if (
    value.value &&
    typeof value.value === "string"
  ) {

    return value.value.trim();
  }


  /*
  ------------------------------------------------------
  NESTED FILE
  ------------------------------------------------------
  */

  if (value.file) {

    const result =
      normalizeFileResult(
        value.file
      );

    if (result) {
      return result;
    }
  }


  /*
  ------------------------------------------------------
  STRING CONVERSION
  ------------------------------------------------------
  */

  if (
    typeof value.toString === "function"
  ) {

    const converted =
      value.toString();

    if (
      converted &&
      converted !== "[object Object]"
    ) {

      return converted.trim();
    }
  }


  return "";
}


/*
========================================================
HF PROVIDER REQUEST
========================================================
*/

async function fetchProvider(
  url,
  options = {}
) {

  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => controller.abort(),
      GAVEAI_VIDEO_TIMEOUT_MS
    );


  try {

    const response =
      await fetch(
        url,
        {
          ...options,
          signal:
            controller.signal
        }
      );


    const text =
      await response.text();


    let data = null;


    try {

      data =
        JSON.parse(text);

    } catch {

      data = text;
    }


    if (!response.ok) {

      throw new Error(
        `GaveAI Video Provider HTTP ${response.status}: ` +
        (
          typeof data === "string"
            ? data
            : JSON.stringify(data)
        )
      );
    }


    return data;


  } finally {

    clearTimeout(timeout);
  }
}


/*
========================================================
HF VIDEO PROVIDER
========================================================
*/

async function generateWithGaveAIVideoProvider({
  prompt,
  numFrames = 49,
  height = 480,
  width = 832,
  guidanceScale = 5
}) {

  if (!GAVEAI_VIDEO_PROVIDER_URL) {

    throw new Error(
      "GAVEAI_VIDEO_PROVIDER_URL is not configured."
    );
  }


  if (
    !prompt ||
    typeof prompt !== "string" ||
    !prompt.trim()
  ) {

    throw new Error(
      "Video prompt is required."
    );
  }


  const baseUrl =
    GAVEAI_VIDEO_PROVIDER_URL
      .replace(/\/+$/, "");


  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI VIDEO PROVIDER REQUEST"
  );

  console.log(
    "PROVIDER:",
    baseUrl
  );

  console.log(
    "MODEL:",
    GAVEAI_VIDEO_MODEL
  );

  console.log(
    "PROMPT:",
    prompt
  );

  console.log(
    "FRAMES:",
    numFrames
  );

  console.log(
    "SIZE:",
    `${width}x${height}`
  );

  console.log(
    "========================================"
  );


  /*
  ------------------------------------------------------
  HEADERS
  ------------------------------------------------------
  */

  const headers = {
    "Content-Type":
      "application/json",

    Accept:
      "application/json"
  };


  /*
  ------------------------------------------------------
  HUGGING FACE TOKEN
  ------------------------------------------------------
  */

  if (process.env.HF_TOKEN) {

    headers.Authorization =
      `Bearer ${process.env.HF_TOKEN}`;
  }


  /*
  ------------------------------------------------------
  STEP 1
  SUBMIT GRADIO JOB
  ------------------------------------------------------
  */

  const submitUrl =
    `${baseUrl}/gradio_api/call/generate_video`;


  console.log(
    "SUBMIT URL:",
    submitUrl
  );


  const submitResponse =
    await fetchProvider(
      submitUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: [
            prompt.trim(),
            Number(numFrames),
            Number(height),
            Number(width),
            Number(guidanceScale)
          ]
        })
      }
    );


  const eventId =
    submitResponse?.event_id;


  if (!eventId) {

    console.error(
      "HF SUBMIT RESPONSE:",
      submitResponse
    );

    throw new Error(
      "Video provider did not return an event_id."
    );
  }


  console.log(
    "VIDEO PROVIDER EVENT ID:",
    eventId
  );


  /*
  ------------------------------------------------------
  STEP 2
  WAIT FOR GRADIO RESULT
  ------------------------------------------------------
  */

  const resultUrl =
    `${baseUrl}/gradio_api/call/generate_video/${eventId}`;


  console.log(
    "RESULT URL:",
    resultUrl
  );


  const resultController =
    new AbortController();


  const resultTimeout =
    setTimeout(
      () => resultController.abort(),
      GAVEAI_VIDEO_TIMEOUT_MS
    );


  let resultResponse;


  try {

    resultResponse =
      await fetch(
        resultUrl,
        {
          method: "GET",
          headers,
          signal:
            resultController.signal
        }
      );

  } catch (error) {

    if (error.name === "AbortError") {

      throw new Error(
        `Video provider timed out after ${GAVEAI_VIDEO_TIMEOUT_MS} ms.`
      );
    }

    throw error;

  } finally {

    clearTimeout(
      resultTimeout
    );
  }


  if (!resultResponse.ok) {

    const errorText =
      await resultResponse.text();

    throw new Error(
      `Video provider result request failed: HTTP ${resultResponse.status} ${errorText}`
    );
  }


  const resultText =
    await resultResponse.text();


  console.log(
    "VIDEO PROVIDER RESULT RECEIVED"
  );


  /*
  ------------------------------------------------------
  PARSE SSE
  ------------------------------------------------------
  */

  const events =
    parseSSE(resultText);


  let completedData = null;


  for (const item of events) {

    /*
    ----------------------------------------------------
    ERROR EVENT
    ----------------------------------------------------
    */

    if (
      item.event === "error"
    ) {

      throw new Error(
        `GaveAI Video Provider generation error: ${item.data}`
      );
    }


    /*
    ----------------------------------------------------
    COMPLETE EVENT
    ----------------------------------------------------
    */

    if (
      item.event === "complete" &&
      item.data
    ) {

      try {

        completedData =
          JSON.parse(item.data);

      } catch {

        completedData =
          item.data;
      }
    }
  }


  /*
  ------------------------------------------------------
  SOME GRADIO VERSIONS MAY RETURN DATA WITHOUT
  "complete" PARSING
  ------------------------------------------------------
  */

  if (!completedData) {

    const lastData =
      events.length > 0
        ? events[events.length - 1].data
        : null;


    if (lastData) {

      try {

        completedData =
          JSON.parse(lastData);

      } catch {

        completedData =
          lastData;
      }
    }
  }


  if (!completedData) {

    console.error(
      "VIDEO PROVIDER RAW RESULT:",
      resultText
    );

    throw new Error(
      "Video provider did not return a completed result."
    );
  }


  /*
  ------------------------------------------------------
  LOG COMPLETED DATA
  ------------------------------------------------------
  */

  console.log(
    "VIDEO PROVIDER COMPLETED DATA:",
    JSON.stringify(
      completedData,
      null,
      2
    )
  );


  /*
  ------------------------------------------------------
  FIND VIDEO RESULT
  ------------------------------------------------------
  */

  let videoValue =
    Array.isArray(completedData)
      ? completedData[0]
      : completedData;


  let videoUrl =
    normalizeFileResult(
      videoValue
    );


  /*
  ------------------------------------------------------
  IF ARRAY IS NESTED
  ------------------------------------------------------
  */

  if (
    !videoUrl &&
    Array.isArray(completedData)
  ) {

    videoUrl =
      normalizeFileResult(
        completedData
      );
  }


  /*
  ------------------------------------------------------
  GRADIO FILEDATA
  ------------------------------------------------------
  */

  if (
    videoValue &&
    typeof videoValue === "object"
  ) {

    if (
      videoValue.url &&
      typeof videoValue.url === "string"
    ) {

      videoUrl =
        videoValue.url;
    }


    if (
      videoValue.path &&
      typeof videoValue.path === "string"
    ) {

      videoUrl =
        videoValue.path;
    }
  }


  /*
  ------------------------------------------------------
  RELATIVE FILE PATH
  ------------------------------------------------------
  */

  if (
    videoUrl &&
    !/^https?:\/\//i.test(videoUrl)
  ) {

    const cleanPath =
      videoUrl.replace(
        /^\/+/,
        ""
      );


    /*
    Gradio may return:
    file=...
    */

    if (
      cleanPath.startsWith("file=")
    ) {

      videoUrl =
        `${baseUrl}/${cleanPath}`;

    } else {

      videoUrl =
        `${baseUrl}/file=${cleanPath}`;
    }
  }


  /*
  ------------------------------------------------------
  FINAL VIDEO URL CHECK
  ------------------------------------------------------
  */

  if (!videoUrl) {

    throw new Error(
      "Video provider completed successfully but no video URL was returned."
    );
  }


  console.log(
    "VIDEO PROVIDER VIDEO URL:",
    videoUrl
  );


  /*
  ------------------------------------------------------
  STEP 3
  DOWNLOAD MP4
  ------------------------------------------------------
  */

  const downloaded =
    await downloadVideo(
      videoUrl
    );


  console.log(
    "========================================"
  );

  console.log(
    "VIDEO DOWNLOAD SUCCESS"
  );

  console.log(
    "LOCAL FILE:",
    downloaded.filePath
  );

  console.log(
    "FILE SIZE:",
    downloaded.size,
    "bytes"
  );

  console.log(
    "========================================"
  );


  /*
  ------------------------------------------------------
  RETURN
  ------------------------------------------------------
  */

  return {

    success: true,

    provider:
      "huggingface",

    model:
      GAVEAI_VIDEO_MODEL,

    sourceUrl:
      videoUrl,

    videoFile:
      downloaded.filePath,

    filePath:
      downloaded.filePath,

    fileName:
      downloaded.fileName,

    fileSize:
      downloaded.size

  };
}


/*
========================================================
DOWNLOAD GENERATED VIDEO
========================================================
*/

async function downloadVideo(
  videoUrl,
  outputPath
) {

  const normalizedUrl =
    normalizeFileResult(
      videoUrl
    );


  if (!normalizedUrl) {

    throw new Error(
      "A valid video URL is required."
    );
  }


  /*
  ------------------------------------------------------
  VALIDATE URL
  ------------------------------------------------------
  */

  let parsedUrl;


  try {

    parsedUrl =
      new URL(
        normalizedUrl
      );

  } catch (error) {

    throw new Error(
      `Invalid video URL: ${normalizedUrl}`
    );
  }


  if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:"
  ) {

    throw new Error(
      "Video URL must use HTTP or HTTPS."
    );
  }


  /*
  ------------------------------------------------------
  CREATE OUTPUT PATH IF MISSING
  ------------------------------------------------------
  */

  if (!outputPath) {

    outputPath =
      path.join(
        VIDEO_OUTPUT_DIR,
        `gaveai-video-${crypto.randomUUID()}.mp4`
      );
  }


  console.log(
    "----------------------------------------"
  );

  console.log(
    "DOWNLOADING VIDEO"
  );

  console.log(
    "VIDEO URL:",
    normalizedUrl
  );

  console.log(
    "OUTPUT:",
    outputPath
  );

  console.log(
    "----------------------------------------"
  );


  const response =
    await axios.get(
      normalizedUrl,
      {
        responseType:
          "arraybuffer",

        timeout:
          180000,

        maxContentLength:
          Infinity,

        maxBodyLength:
          Infinity,

        headers: {
          Accept:
            "video/mp4,video/*,*/*"
        }
      }
    );


  if (!response.data) {

    throw new Error(
      "Video provider returned an empty video response."
    );
  }


  fs.writeFileSync(
    outputPath,
    Buffer.from(
      response.data
    )
  );


  const stats =
    fs.statSync(
      outputPath
    );


  if (stats.size === 0) {

    throw new Error(
      "Downloaded video file is empty."
    );
  }


  console.log(
    "VIDEO DOWNLOADED SUCCESSFULLY"
  );

  console.log(
    "FILE SIZE:",
    stats.size,
    "bytes"
  );


  return {

    filePath:
      outputPath,

    fileName:
      path.basename(outputPath),

    size:
      stats.size
  };
}


/*
========================================================
RUN FFMPEG
========================================================
*/

function runFFmpeg(args) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (!verifyFFmpeg()) {

        return reject(
          new Error(
            "FFmpeg binary was not found. Set FFMPEG_PATH in .env or install FFmpeg."
          )
        );
      }


      console.log(
        "----------------------------------------"
      );

      console.log(
        "FFMPEG STARTED"
      );

      console.log(
        "FFMPEG PATH:",
        FFMPEG_PATH
      );

      console.log(
        "----------------------------------------"
      );


      execFile(
        FFMPEG_PATH,
        args,
        {
          windowsHide:
            true,

          maxBuffer:
            1024 *
            1024 *
            20
        },
        (
          error,
          stdout,
          stderr
        ) => {

          if (error) {

            console.error(
              "FFMPEG ERROR:",
              error.message
            );

            console.error(
              "FFMPEG STDERR:",
              stderr
            );

            return reject(
              error
            );
          }


          console.log(
            "FFMPEG COMPLETED SUCCESSFULLY"
          );


          resolve({
            stdout,
            stderr
          });
        }
      );
    }
  );
}


/*
========================================================
CONCATENATE VIDEO CLIPS
========================================================
*/

async function concatenateVideos(
  videoFiles,
  outputFile
) {

  if (
    !Array.isArray(videoFiles) ||
    videoFiles.length === 0
  ) {

    throw new Error(
      "No video files were provided for concatenation."
    );
  }


  /*
  ------------------------------------------------------
  VERIFY FILES
  ------------------------------------------------------
  */

  for (const file of videoFiles) {

    if (!fs.existsSync(file)) {

      throw new Error(
        `Video clip does not exist: ${file}`
      );
    }


    const stats =
      fs.statSync(file);


    if (stats.size === 0) {

      throw new Error(
        `Video clip is empty: ${file}`
      );
    }
  }


  /*
  ------------------------------------------------------
  SINGLE VIDEO
  ------------------------------------------------------
  */

  if (videoFiles.length === 1) {

    fs.copyFileSync(
      videoFiles[0],
      outputFile
    );

    return outputFile;
  }


  console.log(
    "========================================"
  );

  console.log(
    "CONCATENATING VIDEO CLIPS"
  );

  console.log(
    "TOTAL CLIPS:",
    videoFiles.length
  );

  console.log(
    "========================================"
  );


  /*
  ------------------------------------------------------
  CREATE CONCAT FILE
  ------------------------------------------------------
  */

  const concatFile =
    path.join(
      VIDEO_OUTPUT_DIR,
      `concat-${crypto.randomUUID()}.txt`
    );


  /*
  FFmpeg concat files work best
  with absolute paths and forward slashes.
  */

  const concatContent =
    videoFiles
      .map(
        file => {

          const normalizedPath =
            path
              .resolve(file)
              .replace(/\\/g, "/")
              .replace(/'/g, "'\\''");


          return `file '${normalizedPath}'`;
        }
      )
      .join("\n");


  fs.writeFileSync(
    concatFile,
    concatContent,
    "utf8"
  );


  try {

    /*
    ----------------------------------------------------
    CONCAT + NORMALIZE VIDEO
    ----------------------------------------------------
    */

    await runFFmpeg([
      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      concatFile,

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "23",

      "-pix_fmt",
      "yuv420p",

      "-movflags",
      "+faststart",

      "-an",

      outputFile
    ]);


    /*
    ----------------------------------------------------
    VERIFY FINAL FILE
    ----------------------------------------------------
    */

    if (!fs.existsSync(outputFile)) {

      throw new Error(
        "FFmpeg completed but the final video file was not created."
      );
    }


    const stats =
      fs.statSync(
        outputFile
      );


    if (stats.size === 0) {

      throw new Error(
        "FFmpeg created an empty final video."
      );
    }


    console.log(
      "VIDEO CONCATENATION SUCCESS"
    );

    console.log(
      "FINAL FILE:",
      outputFile
    );

    console.log(
      "FINAL SIZE:",
      stats.size,
      "bytes"
    );


    return outputFile;


  } finally {

    /*
    ----------------------------------------------------
    CLEAN CONCAT FILE
    ----------------------------------------------------
    */

    try {

      if (
        fs.existsSync(
          concatFile
        )
      ) {

        fs.unlinkSync(
          concatFile
        );
      }

    } catch (cleanupError) {

      console.warn(
        "CONCAT FILE CLEANUP WARNING:",
        cleanupError.message
      );
    }
  }
}


/*
========================================================
GENERATE FULL VIDEO PRODUCTION
========================================================

This:

1. Generates each video clip with Hugging Face
2. Gets the video URL
3. Downloads every clip
4. Uses FFmpeg to join them
5. Produces one final MP4
6. Deletes temporary clips

========================================================
*/

async function generateVideoProduction(
  prompts,
  options = {}
) {

  if (
    !Array.isArray(prompts) ||
    prompts.length === 0
  ) {

    return {

      success: false,

      provider:
        "huggingface",

      message:
        "At least one video prompt is required."
    };
  }


  if (prompts.length > 20) {

    return {

      success: false,

      provider:
        "huggingface",

      message:
        "A maximum of 20 video clips can be generated in one production."
    };
  }


  /*
  ------------------------------------------------------
  FFmpeg CHECK
  ------------------------------------------------------
  */

  if (!verifyFFmpeg()) {

    return {

      success: false,

      provider:
        "ffmpeg",

      message:
        "FFmpeg was not found on the server."
    };
  }


  /*
  ------------------------------------------------------
  PRODUCTION DIRECTORY
  ------------------------------------------------------
  */

  const productionId =
    crypto.randomUUID();


  const productionDir =
    path.join(
      VIDEO_OUTPUT_DIR,
      productionId
    );


  fs.mkdirSync(
    productionDir,
    {
      recursive: true
    }
  );


  const downloadedFiles = [];


  try {

    console.log(
      "========================================"
    );

    console.log(
      "VIDEO PRODUCTION STARTED"
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
      "VIDEO PROVIDER:",
      GAVEAI_VIDEO_PROVIDER_URL
    );

    console.log(
      "MODEL:",
      GAVEAI_VIDEO_MODEL
    );

    console.log(
      "FFMPEG:",
      FFMPEG_PATH
    );

    console.log(
      "========================================"
    );


    /*
    ----------------------------------------------------
    GENERATE EACH CLIP
    ----------------------------------------------------
    */

    for (
      let i = 0;
      i < prompts.length;
      i++
    ) {

      const clipNumber =
        i + 1;


      console.log(
        "----------------------------------------"
      );

      console.log(
        `GENERATING CLIP ${clipNumber}/${prompts.length}`
      );

      console.log(
        "----------------------------------------"
      );


      const videoResult =
        await generateWithGaveAIVideoProvider({
          prompt:
            prompts[i],

          numFrames:
            options.numFrames || 49,

          height:
            options.height || 480,

          width:
            options.width || 832,

          guidanceScale:
            options.guidanceScale || 5
        });


      if (
        !videoResult.success
      ) {

        throw new Error(
          videoResult.message ||
          `Clip ${clipNumber} generation failed.`
        );
      }


      /*
      --------------------------------------------------
      DOWNLOAD CLIP
      --------------------------------------------------
      */

      const clipPath =
        path.join(
          productionDir,
          `clip-${String(
            clipNumber
          ).padStart(
            3,
            "0"
          )}.mp4`
        );


      await downloadVideo(
        videoResult.videoFile ||
        videoResult.video ||
        videoResult.sourceUrl,
        clipPath
      );


      downloadedFiles.push(
        clipPath
      );


      console.log(
        `CLIP ${clipNumber}/${prompts.length} COMPLETED`
      );
    }


    /*
    ----------------------------------------------------
    FINAL OUTPUT
    ----------------------------------------------------
    */

    const finalFile =
      path.join(
        productionDir,
        `gaveai-production-${productionId}.mp4`
      );


    await concatenateVideos(
      downloadedFiles,
      finalFile
    );


    /*
    ----------------------------------------------------
    FINAL RESULT
    ----------------------------------------------------
    */

    const stats =
      fs.statSync(
        finalFile
      );


    console.log(
      "========================================"
    );

    console.log(
      "VIDEO PRODUCTION SUCCESS"
    );

    console.log(
      "PRODUCTION ID:",
      productionId
    );

    console.log(
      "TOTAL CLIPS:",
      downloadedFiles.length
    );

    console.log(
      "FINAL VIDEO:",
      finalFile
    );

    console.log(
      "FILE SIZE:",
      stats.size,
      "bytes"
    );

    console.log(
      "========================================"
    );


    return {

      success: true,

      provider:
        "huggingface",

      model:
        GAVEAI_VIDEO_MODEL,

      productionId,

      clips:
        downloadedFiles.length,

      videoFile:
        finalFile,

      filePath:
        finalFile,

      downloadReady:
        true
    };


  } catch (error) {

    console.error(
      "========================================"
    );

    console.error(
      "VIDEO PRODUCTION ERROR"
    );

    console.error(
      error
    );

    console.error(
      "========================================"
    );


    return {

      success: false,

      provider:
        "huggingface",

      productionId,

      message:
        error?.message ||
        "Video production failed."
    };


  } finally {

    /*
    ----------------------------------------------------
    DELETE INDIVIDUAL CLIPS
    ----------------------------------------------------

    Keep final MP4.
    Remove temporary individual clips.

    ----------------------------------------------------
    */

    for (
      const file of downloadedFiles
    ) {

      try {

        if (
          fs.existsSync(file)
        ) {

          fs.unlinkSync(
            file
          );


          console.log(
            "TEMP CLIP DELETED:",
            file
          );
        }

      } catch (cleanupError) {

        console.warn(
          "VIDEO CLEANUP WARNING:",
          cleanupError.message
        );
      }
    }
  }
}


/*
========================================================
COMPATIBILITY ALIAS
========================================================

Some parts of the backend may call generateVideo().

We route it directly to Hugging Face.

========================================================
*/

async function generateVideo(
  prompt,
  options = {}
) {

  const result =
    await generateWithGaveAIVideoProvider({

      prompt,

      numFrames:
        options.numFrames || 49,

      height:
        options.height || 480,

      width:
        options.width || 832,

      guidanceScale:
        options.guidanceScale || 5
    });


  if (!result.success) {
    return result;
  }


  return {

    ...result,

    video:
      result.videoFile ||
      result.sourceUrl,

    url:
      result.sourceUrl
  };
}


/*
========================================================
EXPORTS
========================================================
*/

module.exports = {

  generateImage,

  generateVideo,

  generateVideoProduction,

  generateWithGaveAIVideoProvider,

  downloadVideo,

  concatenateVideos,

  verifyFFmpeg,

  findFFmpeg,

  FFMPEG_PATH

};