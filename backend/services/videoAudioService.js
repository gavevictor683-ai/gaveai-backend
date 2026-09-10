require("dotenv").config();

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const axios = require("axios");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

/*
========================================================
GAVEAI VIDEO AUDIO SERVICE
========================================================

PROVIDER-INDEPENDENT VIDEO AUDIO SYSTEM

Supports:

- GaveAI TTS
- Voice / dialogue
- Narration
- Music generation
- Sound effects
- Ambience
- Scene-level audio
- Multi-scene video audio
- FFmpeg mixing
- Final MP4 audio embedding
- Legacy addVoiceToVideo()
- Legacy processGeneratedVideo()

The video provider can be:

- GaveAI
- WaveSpeed internally
- Replicate
- Hugging Face
- ZeroGPU
- Any future provider

IMPORTANT:

All generated audio is physically muxed into the final MP4.

The downloaded MP4 is NOT silent.

========================================================
*/


/*
========================================================
CONFIGURATION
========================================================
*/

const GAVEAI_AUDIO_API_KEY =
  process.env.WAVESPEED_API_KEY || "";

const GAVEAI_AUDIO_BASE_URL =
  process.env.GAVEAI_AUDIO_BASE_URL ||
  "https://api.wavespeed.ai/api/v3";

const GAVEAI_TTS_MODEL =
  process.env.GAVEAI_TTS_MODEL ||
  "minimax/speech-2.6-hd";

const GAVEAI_MUSIC_MODEL =
  process.env.GAVEAI_MUSIC_MODEL ||
  "sonilo/text-to-music";

const GAVEAI_SFX_MODEL =
  process.env.GAVEAI_SFX_MODEL ||
  "sonilo/v1/text-to-sfx";

const DEFAULT_LANGUAGE =
  process.env.GAVEAI_DEFAULT_TTS_LANGUAGE || "en";

const DEFAULT_SPEAKING_RATE =
  Number(process.env.GAVEAI_TTS_SPEAKING_RATE) || 1;

const TTS_TIMEOUT =
  Number(process.env.GAVEAI_TTS_TIMEOUT_MS) || 120000;

const POLL_INTERVAL =
  Number(process.env.WAVESPEED_POLL_INTERVAL) || 2000;

const MAX_WAIT =
  Number(process.env.WAVESPEED_MAX_WAIT) ||
  30 * 60 * 1000;

const FFMPEG_PRESET =
  process.env.GAVEAI_FFMPEG_PRESET || "veryfast";


/*
========================================================
HELPERS
========================================================
*/

function cleanString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}


function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


function ensureApiKey() {
  if (!GAVEAI_AUDIO_API_KEY) {
    throw new Error(
      "GaveAI audio generation is not configured. WAVESPEED_API_KEY is missing."
    );
  }
}


function ensureDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true
    });
  }

  return directory;
}


function getTempDirectory() {
  return ensureDirectory(
    path.join(
      os.tmpdir(),
      "gaveai-audio"
    )
  );
}


function createTempFile(extension) {
  const safeExtension =
    extension.startsWith(".")
      ? extension
      : `.${extension}`;

  return path.join(
    getTempDirectory(),
    `gaveai-${crypto.randomUUID()}${safeExtension}`
  );
}


function validateVideoFile(videoFile) {
  if (!videoFile) {
    throw new Error(
      "Video file path is missing."
    );
  }

  if (!fs.existsSync(videoFile)) {
    throw new Error(
      `Video file does not exist: ${videoFile}`
    );
  }

  const stats =
    fs.statSync(videoFile);

  if (!stats.isFile()) {
    throw new Error(
      "Generated video path is not a file."
    );
  }

  if (stats.size <= 0) {
    throw new Error(
      "Generated video file is empty."
    );
  }

  return true;
}


function normalizeDuration(duration) {
  const value =
    Number(duration);

  if (value === 8) {
    return 8;
  }

  return 5;
}


function normalizeAudioDuration(duration) {
  const value =
    Number(duration);

  if (!Number.isFinite(value) || value <= 0) {
    return 5;
  }

  return Math.max(
    1,
    Math.min(
      60,
      value
    )
  );
}


/*
========================================================
ERROR NORMALIZATION
========================================================
*/

function extractProviderError(error) {
  if (!error) {
    return "Unknown GaveAI audio provider error.";
  }

  const data =
    error.response?.data;

  if (typeof data === "string") {
    return data;
  }

  if (data?.error) {
    if (typeof data.error === "string") {
      return data.error;
    }

    if (data.error.message) {
      return data.error.message;
    }
  }

  if (data?.message) {
    return data.message;
  }

  if (data?.detail) {
    return data.detail;
  }

  if (error.message) {
    return error.message;
  }

  return String(error);
}


/*
========================================================
LANGUAGE MAP
========================================================
*/

const LANGUAGE_ALIASES = {

  english: "en",
  en: "en",

  french: "fr",
  français: "fr",
  francais: "fr",
  fr: "fr",

  haitian: "ht",
  "haitian creole": "ht",
  "kreyol ayisyen": "ht",
  "kreyòl ayisyen": "ht",
  creole: "ht",
  créole: "ht",
  ht: "ht",

  spanish: "es",
  español: "es",
  espanol: "es",
  es: "es",

  portuguese: "pt",
  português: "pt",
  portugues: "pt",
  pt: "pt",

  german: "de",
  deutsch: "de",
  de: "de",

  italian: "it",
  italiano: "it",
  it: "it",

  dutch: "nl",
  nederlands: "nl",
  nl: "nl",

  russian: "ru",
  русский: "ru",
  ru: "ru",

  ukrainian: "uk",
  українська: "uk",
  uk: "uk",

  arabic: "ar",
  العربية: "ar",
  ar: "ar",

  hindi: "hi",
  हिन्दी: "hi",
  hi: "hi",

  bengali: "bn",
  বাংলা: "bn",
  bn: "bn",

  chinese: "zh-CN",
  mandarin: "zh-CN",
  中文: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-tw": "zh-TW",

  japanese: "ja",
  日本語: "ja",
  ja: "ja",

  korean: "ko",
  한국어: "ko",
  ko: "ko",

  vietnamese: "vi",
  "tiếng việt": "vi",
  vi: "vi",

  thai: "th",
  ไทย: "th",
  th: "th",

  turkish: "tr",
  türkçe: "tr",
  turkce: "tr",
  tr: "tr",

  polish: "pl",
  polski: "pl",
  pl: "pl",

  romanian: "ro",
  română: "ro",
  romana: "ro",
  ro: "ro",

  czech: "cs",
  čeština: "cs",
  cestina: "cs",
  cs: "cs",

  greek: "el",
  ελληνικά: "el",
  el: "el",

  swedish: "sv",
  svenska: "sv",
  sv: "sv",

  danish: "da",
  dansk: "da",
  da: "da",

  norwegian: "no",
  norsk: "no",
  no: "no",

  finnish: "fi",
  suomi: "fi",
  fi: "fi",

  hebrew: "he",
  עברית: "he",
  he: "he",

  indonesian: "id",
  bahasa: "id",
  indonesia: "id",
  id: "id",

  malay: "ms",
  melayu: "ms",
  ms: "ms",

  filipino: "fil",
  tagalog: "fil",
  fil: "fil",

  swahili: "sw",
  kiswahili: "sw",
  sw: "sw",

  tamil: "ta",
  தமிழ்: "ta",
  ta: "ta",

  telugu: "te",
  తెలుగు: "te",
  te: "te",

  marathi: "mr",
  मराठी: "mr",
  mr: "mr",

  gujarati: "gu",
  ગુજરાતી: "gu",
  gu: "gu",

  kannada: "kn",
  ಕನ್ನಡ: "kn",
  kn: "kn",

  malayalam: "ml",
  മലയാളം: "ml",
  ml: "ml"
};


function normalizeLanguage(language) {

  const value =
    cleanString(language)
      .toLowerCase();

  if (!value) {
    return DEFAULT_LANGUAGE;
  }

  if (
    LANGUAGE_ALIASES[value]
  ) {
    return LANGUAGE_ALIASES[value];
  }

  if (
    /^[a-z]{2}$/i.test(value)
  ) {
    return value;
  }

  if (
    /^[a-z]{2}-[a-z]{2}$/i.test(value)
  ) {
    return value;
  }

  return DEFAULT_LANGUAGE;
}


/*
========================================================
LANGUAGE DETECTION
========================================================
*/

function detectLanguageFromText(text) {

  const value =
    cleanString(text)
      .toLowerCase();

  if (!value) {
    return DEFAULT_LANGUAGE;
  }

  const haitianWords = [
    "mwen",
    "ou",
    "li",
    "nou",
    "yo",
    "fè",
    "fe",
    "epi",
    "pou",
    "nan",
    "ak",
    "yon",
    "bonjou",
    "bonswa",
    "mesi",
    "kijan",
    "mwen vle",
    "tanpri",
    "kote",
    "pa gen"
  ];

  const frenchWords = [
    "bonjour",
    "bonsoir",
    "merci",
    "je",
    "tu",
    "vous",
    "nous",
    "avec",
    "pour",
    "une",
    "un",
    "dans",
    "est",
    "faire",
    "dit"
  ];

  const spanishWords = [
    "hola",
    "buenos",
    "gracias",
    "yo",
    "tú",
    "usted",
    "para",
    "con",
    "una",
    "uno",
    "que",
    "es"
  ];

  const portugueseWords = [
    "olá",
    "obrigado",
    "obrigada",
    "eu",
    "você",
    "para",
    "com",
    "uma",
    "que",
    "não"
  ];

  const germanWords = [
    "hallo",
    "danke",
    "ich",
    "du",
    "sie",
    "und",
    "für",
    "mit",
    "nicht",
    "ist"
  ];

  const italianWords = [
    "ciao",
    "grazie",
    "io",
    "tu",
    "lei",
    "con",
    "per",
    "una",
    "che",
    "non"
  ];

  function score(words) {

    return words.reduce(
      (total, word) => {

        return (
          total +
          (
            value.includes(
              ` ${word} `
            ) ||
            value.startsWith(
              `${word} `
            ) ||
            value.endsWith(
              ` ${word}`
            )
              ? 1
              : 0
          )
        );

      },
      0
    );
  }

  const scores = {

    ht:
      score(haitianWords),

    fr:
      score(frenchWords),

    es:
      score(spanishWords),

    pt:
      score(portugueseWords),

    de:
      score(germanWords),

    it:
      score(italianWords)
  };

  let bestLanguage =
    DEFAULT_LANGUAGE;

  let bestScore = 0;

  for (
    const [language, languageScore]
      of Object.entries(scores)
  ) {

    if (
      languageScore >
      bestScore
    ) {

      bestScore =
        languageScore;

      bestLanguage =
        language;
    }
  }

  return bestLanguage;
}


/*
========================================================
EXTRACT SPOKEN DIALOGUE
========================================================
*/

function extractDialogue(prompt) {

  const text =
    cleanString(prompt);

  if (!text) {
    return "";
  }

  const quotedPatterns = [

    /"([^"]+)"/,
    /'([^']+)'/,
    /“([^”]+)”/,
    /‘([^’]+)’/
  ];

  for (
    const pattern
      of quotedPatterns
  ) {

    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {

      return cleanString(
        match[1]
      );
    }
  }

  const englishPatterns = [

    /\bsay(?:ing)?\s*[:\-]?\s*(.+)$/i,
    /\bsays?\s*[:\-]?\s*(.+)$/i,
    /\bspeaks?\s*[:\-]?\s*(.+)$/i,
    /\bmake\s+[^.]*?\bsay\s+(.+)$/i,
    /\blet\s+[^.]*?\bsay\s+(.+)$/i
  ];

  for (
    const pattern
      of englishPatterns
  ) {

    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {

      return cleanString(
        match[1]
      )
        .replace(/[.!?]+$/, "")
        .trim();
    }
  }

  const frenchPatterns = [

    /\bdit(?:e|es)?\s*[:\-]?\s*(.+)$/i,
    /\bdire\s*[:\-]?\s*(.+)$/i,
    /\bdisant\s*[:\-]?\s*(.+)$/i,
    /\bfaire\s+[^.]*?\bdire\s+(.+)$/i
  ];

  for (
    const pattern
      of frenchPatterns
  ) {

    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {

      return cleanString(
        match[1]
      )
        .replace(/[.!?]+$/, "")
        .trim();
    }
  }

  const haitianPatterns = [

    /\bdi\s*[:\-]?\s*(.+)$/i,
    /\bdiy\s*[:\-]?\s*(.+)$/i,
    /\bfè\s+[^.]*?\bdi\s+(.+)$/i,
    /\bfe\s+[^.]*?\bdi\s+(.+)$/i,
    /\bli\s+di\s+(.+)$/i
  ];

  for (
    const pattern
      of haitianPatterns
  ) {

    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {

      return cleanString(
        match[1]
      )
        .replace(/[.!?]+$/, "")
        .trim();
    }
  }

  const spanishPatterns = [

    /\bdecir\s*[:\-]?\s*(.+)$/i,
    /\bdice\s*[:\-]?\s*(.+)$/i,
    /\bdiciendo\s*[:\-]?\s*(.+)$/i
  ];

  for (
    const pattern
      of spanishPatterns
  ) {

    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {

      return cleanString(
        match[1]
      )
        .replace(/[.!?]+$/, "")
        .trim();
    }
  }

  const directSpeechPatterns = [

    /^say\s+(.+)$/i,
    /^saying\s+(.+)$/i,
    /^dit\s+(.+)$/i,
    /^di\s+(.+)$/i,
    /^dis\s+(.+)$/i,
    /^decir\s+(.+)$/i
  ];

  for (
    const pattern
      of directSpeechPatterns
  ) {

    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {

      return cleanString(
        match[1]
      );
    }
  }

  return "";
}


/*
========================================================
GAVEAI AUDIO PROVIDER
========================================================
*/

async function submitAudioTask({
  model,
  input
}) {

  ensureApiKey();

  try {

    const response =
      await axios.post(
        `${GAVEAI_AUDIO_BASE_URL}/${model}`,
        input,
        {
          headers: {
            Authorization:
              `Bearer ${GAVEAI_AUDIO_API_KEY}`,
            "Content-Type":
              "application/json"
          },
          timeout:
            TTS_TIMEOUT
        }
      );

    const data =
      response.data;

    const prediction =
      data?.data ||
      data;

    const predictionId =
      prediction?.id ||
      prediction?.prediction_id ||
      prediction?.task_id;

    if (!predictionId) {

      const directUrl =
        prediction?.output ||
        prediction?.url ||
        prediction?.audio ||
        prediction?.audio_url;

      if (directUrl) {

        return {
          id: null,
          directUrl,
          raw: data
        };
      }

      throw new Error(
        "GaveAI audio provider did not return a task ID or audio URL."
      );
    }

    return {
      id:
        predictionId,
      directUrl: null,
      raw: data
    };

  } catch (error) {

    throw new Error(
      `GaveAI audio submission failed: ${extractProviderError(error)}`
    );
  }
}


async function waitForAudioTask({
  predictionId,
  directUrl
}) {

  if (directUrl) {
    return {
      output:
        directUrl
    };
  }

  if (!predictionId) {
    throw new Error(
      "GaveAI audio prediction ID is missing."
    );
  }

  ensureApiKey();

  const startedAt =
    Date.now();

  while (
    Date.now() - startedAt <
    MAX_WAIT
  ) {

    try {

      const response =
        await axios.get(
          `${GAVEAI_AUDIO_BASE_URL}/predictions/${predictionId}`,
          {
            headers: {
              Authorization:
                `Bearer ${GAVEAI_AUDIO_API_KEY}`
            },
            timeout:
              TTS_TIMEOUT
          }
        );

      const data =
        response.data;

      const prediction =
        data?.data ||
        data;

      const status =
        String(
          prediction?.status ||
          ""
        ).toLowerCase();

      if (
        status === "completed" ||
        status === "succeeded" ||
        status === "success"
      ) {

        return prediction;
      }

      if (
        status === "failed" ||
        status === "error" ||
        status === "canceled" ||
        status === "cancelled"
      ) {

        throw new Error(
          `GaveAI audio generation failed: ${
            prediction?.error ||
            prediction?.message ||
            "Provider returned a terminal failure."
          }`
        );
      }

    } catch (error) {

      if (
        String(error.message || "")
          .startsWith(
            "GaveAI audio generation failed:"
          )
      ) {
        throw error;
      }

      if (
        error.response?.status >= 400 &&
        error.response?.status < 500
      ) {
        throw new Error(
          `GaveAI audio polling failed: ${extractProviderError(error)}`
        );
      }
    }

    await sleep(
      POLL_INTERVAL
    );
  }

  throw new Error(
    `GaveAI audio generation timed out after ${MAX_WAIT}ms.`
  );
}


/*
========================================================
EXTRACT AUDIO URL
========================================================
*/

function extractAudioUrl(result) {

  if (!result) {
    return "";
  }

  if (
    typeof result === "string" &&
    /^https?:\/\//i.test(result)
  ) {
    return result;
  }

  const candidates = [

    result.output,
    result.audio,
    result.audio_url,
    result.url,
    result.file,
    result.download_url,

    result.output?.audio,
    result.output?.url,
    result.output?.audio_url,

    result.result?.audio,
    result.result?.url,
    result.result?.audio_url
  ];

  for (
    const candidate
      of candidates
  ) {

    if (
      typeof candidate === "string" &&
      /^https?:\/\//i.test(candidate)
    ) {

      return candidate;
    }
  }

  if (
    Array.isArray(result.output)
  ) {

    for (
      const item
        of result.output
    ) {

      if (
        typeof item === "string" &&
        /^https?:\/\//i.test(item)
      ) {

        return item;
      }

      if (
        item?.url
      ) {

        return item.url;
      }
    }
  }

  throw new Error(
    "GaveAI audio provider completed without returning an audio URL."
  );
}


/*
========================================================
DOWNLOAD AUDIO
========================================================
*/

async function downloadAudio(
  audioUrl,
  extension = ".mp3"
) {

  if (!audioUrl) {
    throw new Error(
      "Audio URL is missing."
    );
  }

  const filePath =
    createTempFile(
      extension
    );

  try {

    const response =
      await axios.get(
        audioUrl,
        {
          responseType:
            "arraybuffer",
          timeout:
            TTS_TIMEOUT
        }
      );

    const buffer =
      Buffer.from(
        response.data
      );

    if (
      !buffer.length
    ) {

      throw new Error(
        "Downloaded GaveAI audio file is empty."
      );
    }

    await fs.promises.writeFile(
      filePath,
      buffer
    );

    return {
      filePath,
      fileName:
        path.basename(
          filePath
        ),
      size:
        buffer.length
    };

  } catch (error) {

    try {
      if (
        fs.existsSync(filePath)
      ) {
        await fs.promises.unlink(
          filePath
        );
      }
    } catch (_) {}

    throw new Error(
      `GaveAI audio download failed: ${extractProviderError(error)}`
    );
  }
}


/*
========================================================
GENERATE TTS
========================================================
*/

async function generateTTS(
  text,
  options = {}
) {

  const spokenText =
    cleanString(text);

  if (!spokenText) {
    throw new Error(
      "TTS text is empty."
    );
  }

  const language =
    normalizeLanguage(
      options.language ||
      detectLanguageFromText(
        spokenText
      )
    );

  const voice =
    cleanString(
      options.voice
    ) ||
    "Friendly_Person";

  const speed =
    Number(
      options.speed
    ) ||
    (
      options.slow
        ? 0.8
        : DEFAULT_SPEAKING_RATE
    );

  console.log(
    "========================================"
  );

  console.log(
    "GAVEAI TTS STARTED"
  );

  console.log(
    "MODEL:",
    GAVEAI_TTS_MODEL
  );

  console.log(
    "LANGUAGE:",
    language
  );

  console.log(
    "VOICE:",
    voice
  );

  console.log(
    "TEXT:",
    spokenText
  );

  console.log(
    "========================================"
  );

  const input = {

    text:
      spokenText,

    voice:
      voice,

    language:
      language,

    speed:
      speed
  };

  if (
    options.pitch !== undefined
  ) {
    input.pitch =
      options.pitch;
  }

  if (
    options.emotion
  ) {
    input.emotion =
      options.emotion;
  }

  const submitted =
    await submitAudioTask({
      model:
        GAVEAI_TTS_MODEL,
      input
    });

  const result =
    await waitForAudioTask({
      predictionId:
        submitted.id,
      directUrl:
        submitted.directUrl
    });

  const audioUrl =
    extractAudioUrl(
      result
    );

  const downloaded =
    await downloadAudio(
      audioUrl,
      ".mp3"
    );

  return {

    ...downloaded,

    type:
      "voice",

    provider:
      "GaveAI",

    model:
      GAVEAI_TTS_MODEL,

    language,

    voice,

    text:
      spokenText
  };
}


/*
========================================================
GENERATE MUSIC
========================================================
*/

async function generateMusic(
  prompt,
  duration,
  options = {}
) {

  const musicPrompt =
    cleanString(prompt);

  if (!musicPrompt) {
    throw new Error(
      "Music prompt is empty."
    );
  }

  const finalDuration =
    normalizeAudioDuration(
      duration
    );

  console.log(
    "GAVEAI MUSIC STARTED:",
    musicPrompt
  );

  const input = {

    prompt:
      musicPrompt,

    duration:
      finalDuration
  };

  if (
    options.instrumental !== undefined
  ) {

    input.instrumental =
      Boolean(
        options.instrumental
      );
  }

  const submitted =
    await submitAudioTask({

      model:
        GAVEAI_MUSIC_MODEL,

      input
    });

  const result =
    await waitForAudioTask({

      predictionId:
        submitted.id,

      directUrl:
        submitted.directUrl
    });

  const audioUrl =
    extractAudioUrl(
      result
    );

  const downloaded =
    await downloadAudio(
      audioUrl,
      ".mp3"
    );

  return {

    ...downloaded,

    type:
      "music",

    provider:
      "GaveAI",

    model:
      GAVEAI_MUSIC_MODEL,

    prompt:
      musicPrompt,

    duration:
      finalDuration
  };
}


/*
========================================================
GENERATE SFX
========================================================
*/

async function generateSFX(
  prompt,
  duration,
  options = {}
) {

  const sfxPrompt =
    cleanString(prompt);

  if (!sfxPrompt) {
    throw new Error(
      "SFX prompt is empty."
    );
  }

  const finalDuration =
    normalizeAudioDuration(
      duration
    );

  console.log(
    "GAVEAI SFX STARTED:",
    sfxPrompt
  );

  const input = {

    prompt:
      sfxPrompt,

    duration:
      finalDuration
  };

  const submitted =
    await submitAudioTask({

      model:
        GAVEAI_SFX_MODEL,

      input
    });

  const result =
    await waitForAudioTask({

      predictionId:
        submitted.id,

      directUrl:
        submitted.directUrl
    });

  const audioUrl =
    extractAudioUrl(
      result
    );

  const downloaded =
    await downloadAudio(
      audioUrl,
      ".mp3"
    );

  return {

    ...downloaded,

    type:
      "sfx",

    provider:
      "GaveAI",

    model:
      GAVEAI_SFX_MODEL,

    prompt:
      sfxPrompt,

    duration:
      finalDuration
  };
}


/*
========================================================
FFMPEG RUNNER
========================================================
*/

async function runFFmpeg(
  args
) {

  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not configured."
    );
  }

  await new Promise(
    (resolve, reject) => {

      const process =
        spawn(
          ffmpegPath,
          args,
          {
            windowsHide:
              true
          }
        );

      let stderr = "";

      process.stderr.on(
        "data",
        (data) => {

          stderr +=
            data.toString();
        }
      );

      process.on(
        "error",
        (error) => {

          reject(error);
        }
      );

      process.on(
        "close",
        (code) => {

          if (code !== 0) {

            reject(
              new Error(
                `FFmpeg failed with exit code ${code}: ${stderr.slice(-5000)}`
              )
            );

            return;
          }

          resolve();
        }
      );
    }
  );
}


/*
========================================================
CREATE SILENCE
========================================================
*/

async function createSilence(
  duration,
  outputFile
) {

  const finalDuration =
    normalizeAudioDuration(
      duration
    );

  const output =
    outputFile ||
    createTempFile(
      ".mp3"
    );

  await runFFmpeg([

    "-y",

    "-f",
    "lavfi",

    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",

    "-t",
    String(
      finalDuration
    ),

    "-q:a",
    "2",

    output
  ]);

  return output;
}


/*
========================================================
MIX SCENE AUDIO
========================================================

Voice + music + SFX + ambience

are mixed together into ONE audio track.

That audio track is then embedded into
the final MP4.

========================================================
*/

async function mixSceneAudio({
  voiceFile,
  musicFile,
  sfxFile,
  ambienceFile,
  duration,
  outputFile
}) {

  const finalDuration =
    normalizeAudioDuration(
      duration
    );

  const files = [

    voiceFile,
    musicFile,
    sfxFile,
    ambienceFile

  ].filter(
    (file) =>
      file &&
      fs.existsSync(file)
  );

  if (
    files.length === 0
  ) {

    return createSilence(
      finalDuration,
      outputFile
    );
  }

  const output =
    outputFile ||
    createTempFile(
      ".mp3"
    );

  const args = [
    "-y"
  ];

  for (
    const file
      of files
  ) {

    args.push(
      "-i",
      file
    );
  }

  if (
    files.length === 1
  ) {

    args.push(

      "-map",
      "0:a:0",

      "-af",
      "apad",

      "-t",
      String(
        finalDuration
      ),

      "-c:a",
      "libmp3lame",

      "-b:a",
      "192k",

      output
    );

  } else {

    const inputs =
      files
        .map(
          (_, index) =>
            `[${index}:a:0]`
        )
        .join("");

    args.push(

      "-filter_complex",

      `${inputs}amix=inputs=${files.length}:duration=longest:dropout_transition=0,apad,atrim=duration=${finalDuration}[a]`,

      "-map",
      "[a]",

      "-c:a",
      "libmp3lame",

      "-b:a",
      "192k",

      output
    );
  }

  await runFFmpeg(
    args
  );

  if (
    !fs.existsSync(output)
  ) {

    throw new Error(
      "FFmpeg completed but mixed scene audio was not created."
    );
  }

  return output;
}


/*
========================================================
CREATE SCENE AUDIO
========================================================
*/

async function createSceneAudio(
  scene,
  options = {}
) {

  const currentScene =
    scene || {};

  const duration =
    normalizeDuration(
      currentScene.duration ||
      options.duration ||
      5
    );

  const voiceText =
    cleanString(
      currentScene.voiceText ||
      currentScene.voice?.text ||
      currentScene.dialogue ||
      currentScene.narration ||
      currentScene.voicePrompt
    );

  const musicPrompt =
    cleanString(
      currentScene.musicPrompt ||
      currentScene.music
    );

  const sfxPrompt =
    cleanString(
      currentScene.sfxPrompt ||
      currentScene.sfx
    );

  const ambiencePrompt =
    cleanString(
      currentScene.ambiencePrompt ||
      currentScene.ambience
    );

  const audioResults = [];

  let voiceAudio = null;
  let musicAudio = null;
  let sfxAudio = null;
  let ambienceAudio = null;

  try {

    /*
    ----------------------------------------------------
    VOICE
    ----------------------------------------------------
    */

    if (voiceText) {

      voiceAudio =
        await generateTTS(
          voiceText,
          {
            language:
              currentScene.language ||
              currentScene.voice?.language ||
              options.language,

            voice:
              currentScene.voiceName ||
              currentScene.voice?.name ||
              currentScene.voice,

            speed:
              currentScene.speed ||
              currentScene.voice?.speed,

            emotion:
              currentScene.emotion ||
              currentScene.voice?.emotion
          }
        );

      audioResults.push(
        voiceAudio
      );
    }


    /*
    ----------------------------------------------------
    MUSIC
    ----------------------------------------------------
    */

    if (musicPrompt) {

      musicAudio =
        await generateMusic(
          musicPrompt,
          duration,
          {
            instrumental:
              currentScene.instrumental
          }
        );

      audioResults.push(
        musicAudio
      );
    }


    /*
    ----------------------------------------------------
    SFX
    ----------------------------------------------------
    */

    if (sfxPrompt) {

      sfxAudio =
        await generateSFX(
          sfxPrompt,
          duration
        );

      audioResults.push(
        sfxAudio
      );
    }


    /*
    ----------------------------------------------------
    AMBIENCE
    ----------------------------------------------------
    */

    if (ambiencePrompt) {

      ambienceAudio =
        await generateSFX(
          ambiencePrompt,
          duration
        );

      ambienceAudio.type =
        "ambience";

      audioResults.push(
        ambienceAudio
      );
    }


    /*
    ----------------------------------------------------
    MIX EVERYTHING
    ----------------------------------------------------
    */

    const mixedAudio =
      await mixSceneAudio({

        voiceFile:
          voiceAudio?.filePath,

        musicFile:
          musicAudio?.filePath,

        sfxFile:
          sfxAudio?.filePath,

        ambienceFile:
          ambienceAudio?.filePath,

        duration
      });


    return {

      duration,

      audioFile:
        mixedAudio,

      voice:
        voiceAudio,

      music:
        musicAudio,

      sfx:
        sfxAudio,

      ambience:
        ambienceAudio,

      audioTracks:
        audioResults
    };

  } catch (error) {

    cleanupAudioFiles(
      [
        voiceAudio?.filePath,
        musicAudio?.filePath,
        sfxAudio?.filePath,
        ambienceAudio?.filePath
      ]
    );

    throw error;
  }
}


/*
========================================================
RENDER MULTI-SCENE AUDIO
========================================================

Every scene gets:

video + scene audio

Then FFmpeg creates:

FINAL MULTI-SCENE MP4

with one continuous embedded AAC audio stream.

========================================================
*/

async function renderGaveAIAudioForScenes(
  scenes,
  options = {}
) {

  if (
    !Array.isArray(scenes) ||
    scenes.length === 0
  ) {

    return {
      success: true,
      audioAdded: false,
      videoFile:
        options.videoFile || null,
      scenes: []
    };
  }

  const processedScenes = [];

  try {

    for (
      let index = 0;
      index < scenes.length;
      index++
    ) {

      const scene =
        scenes[index];

      if (
        !scene?.videoFile
      ) {

        throw new Error(
          `Scene ${index + 1} video file is missing.`
        );
      }

      validateVideoFile(
        scene.videoFile
      );

      const duration =
        normalizeDuration(
          scene.duration
        );

      const sceneAudio =
        await createSceneAudio(
          scene,
          {
            ...options,
            duration
          }
        );

      processedScenes.push({

        ...scene,

        duration,

        audioFile:
          sceneAudio.audioFile,

        audio:
          sceneAudio
      });
    }


    /*
    ====================================================
    CREATE EACH VIDEO + AUDIO PAIR
    ====================================================
    */

    const sceneOutputs = [];

    for (
      let index = 0;
      index < processedScenes.length;
      index++
    ) {

      const scene =
        processedScenes[index];

      const output =
        createTempFile(
          ".mp4"
        );

      await runFFmpeg([

        "-y",

        "-i",
        scene.videoFile,

        "-i",
        scene.audioFile,

        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        "-c:v",
        "copy",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-af",
        "apad",

        "-shortest",

        "-movflags",
        "+faststart",

        output
      ]);

      if (
        !fs.existsSync(output)
      ) {

        throw new Error(
          `FFmpeg failed to create audio scene ${index + 1}.`
        );
      }

      sceneOutputs.push(
        output
      );
    }


    /*
    ====================================================
    CONCAT SCENES
    ====================================================
    */

    if (
      sceneOutputs.length === 1
    ) {

      const finalFile =
        options.outputFile ||
        createTempFile(
          ".mp4"
        );

      await runFFmpeg([

        "-y",

        "-i",
        sceneOutputs[0],

        "-c:v",
        "copy",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-movflags",
        "+faststart",

        finalFile
      ]);

      return {

        success: true,

        audioAdded: true,

        videoFile:
          finalFile,

        fileName:
          path.basename(
            finalFile
          ),

        fileSize:
          fs.statSync(
            finalFile
          ).size,

        sceneCount:
          1,

        scenes:
          processedScenes
      };
    }


    const concatList =
      createTempFile(
        ".txt"
      );

    const concatContent =
      sceneOutputs
        .map(
          (file) =>
            `file '${file.replace(/'/g, "'\\''")}'`
        )
        .join("\n");

    await fs.promises.writeFile(
      concatList,
      concatContent,
      "utf8"
    );

    const finalFile =
      options.outputFile ||
      createTempFile(
        ".mp4"
      );

    /*
    ----------------------------------------------------
    Re-encode the final concatenated file so
    every scene has one compatible audio stream.
    ----------------------------------------------------
    */

    await runFFmpeg([

      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      concatList,

      "-c:v",
      "libx264",

      "-preset",
      FFMPEG_PRESET,

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-movflags",
      "+faststart",

      finalFile
    ]);

    if (
      !fs.existsSync(finalFile)
    ) {

      throw new Error(
        "FFmpeg completed but final multi-scene MP4 was not created."
      );
    }

    const finalStats =
      await fs.promises.stat(
        finalFile
      );

    if (
      finalStats.size <= 0
    ) {

      throw new Error(
        "Final multi-scene MP4 is empty."
      );
    }

    return {

      success: true,

      audioAdded: true,

      videoFile:
        finalFile,

      fileName:
        path.basename(
          finalFile
        ),

      fileSize:
        finalStats.size,

      sceneCount:
        processedScenes.length,

      scenes:
        processedScenes,

      audio: {

        embedded: true,

        format:
          "AAC",

        synchronized:
          true
      }
    };

  } catch (error) {

    console.error(
      "GAVEAI MULTI-SCENE AUDIO ERROR:",
      error
    );

    throw error;
  }
}


/*
========================================================
CLEAN AUDIO FILES
========================================================
*/

function cleanupAudioFile(
  audioFile
) {

  if (!audioFile) {
    return;
  }

  try {

    if (
      fs.existsSync(
        audioFile
      )
    ) {

      fs.unlinkSync(
        audioFile
      );

      console.log(
        "GAVEAI AUDIO DELETED:",
        audioFile
      );
    }

  } catch (error) {

    console.warn(
      "GAVEAI AUDIO CLEANUP WARNING:",
      error.message
    );
  }
}


function cleanupAudioFiles(
  files
) {

  if (
    !Array.isArray(files)
  ) {
    return;
  }

  for (
    const file
      of files
  ) {

    cleanupAudioFile(
      file
    );
  }
}


/*
========================================================
MERGE VIDEO + VOICE
========================================================

Legacy-compatible function.

The video continues normally.

Audio is padded when necessary so the final
video does not become shorter than the video itself.

========================================================
*/

async function mergeVideoAndVoice({
  videoFile,
  audioFile,
  outputFile
}) {

  validateVideoFile(
    videoFile
  );

  if (!audioFile) {

    throw new Error(
      "Audio file is missing."
    );
  }

  if (
    !fs.existsSync(audioFile)
  ) {

    throw new Error(
      `Audio file does not exist: ${audioFile}`
    );
  }

  const finalOutput =
    outputFile ||
    createTempFile(
      ".mp4"
    );

  console.log(
    "========================================"
  );

  console.log(
    "FFMPEG AUDIO MERGE STARTED"
  );

  console.log(
    "VIDEO:",
    videoFile
  );

  console.log(
    "AUDIO:",
    audioFile
  );

  console.log(
    "OUTPUT:",
    finalOutput
  );

  console.log(
    "FFMPEG:",
    ffmpegPath
  );

  console.log(
    "========================================"
  );

  await runFFmpeg([

    "-y",

    "-i",
    videoFile,

    "-i",
    audioFile,

    "-map",
    "0:v:0",

    "-map",
    "1:a:0",

    "-c:v",
    "copy",

    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-af",
    "apad",

    "-shortest",

    "-movflags",
    "+faststart",

    finalOutput
  ]);

  if (
    !fs.existsSync(
      finalOutput
    )
  ) {

    throw new Error(
      "FFmpeg completed but final video file was not created."
    );
  }

  const stats =
    await fs.promises.stat(
      finalOutput
    );

  if (
    stats.size <= 0
  ) {

    throw new Error(
      "FFmpeg created an empty final video."
    );
  }

  console.log(
    "========================================"
  );

  console.log(
    "FFMPEG AUDIO MERGE SUCCESS"
  );

  console.log(
    "FINAL VIDEO:",
    finalOutput
  );

  console.log(
    "FINAL SIZE:",
    stats.size
  );

  console.log(
    "========================================"
  );

  return {

    filePath:
      finalOutput,

    fileName:
      path.basename(
        finalOutput
      ),

    size:
      stats.size
  };
}


/*
========================================================
CREATE TTS AUDIO
========================================================

Legacy-compatible wrapper.

Old code called:

createTTSAudio({
  text,
  language,
  slow
})

It now uses GaveAI instead of Google TTS.

========================================================
*/

async function createTTSAudio({
  text,
  language,
  slow = false,
  voice,
  speed,
  pitch,
  emotion
}) {

  const spokenText =
    cleanString(text);

  if (!spokenText) {

    throw new Error(
      "TTS text is empty."
    );
  }

  const finalLanguage =
    language
      ? normalizeLanguage(
          language
        )
      : detectLanguageFromText(
          spokenText
        );

  return generateTTS(
    spokenText,
    {
      language:
        finalLanguage,

      voice,

      slow,

      speed,

      pitch,

      emotion
    }
  );
}


/*
========================================================
ADD VOICE TO VIDEO
========================================================

Legacy public function.

Works with any generated video provider.

========================================================
*/

async function addVoiceToVideo({
  videoFile,
  prompt,
  voiceText,
  language,
  voice,
  speed,
  pitch,
  emotion,
  slow = false,
  enabled = true
}) {

  validateVideoFile(
    videoFile
  );

  if (!enabled) {

    return {

      success: true,

      voiceAdded: false,

      videoFile,

      audioFile: null,

      voiceText: "",

      language:
        normalizeLanguage(
          language
        )
    };
  }

  let spokenText =
    cleanString(
      voiceText
    );

  if (!spokenText) {

    spokenText =
      extractDialogue(
        prompt
      );
  }

  if (!spokenText) {

    console.log(
      "NO SPOKEN DIALOGUE FOUND."
    );

    console.log(
      "VIDEO WILL BE RETURNED WITHOUT ADDED VOICE."
    );

    return {

      success: true,

      voiceAdded: false,

      videoFile,

      audioFile: null,

      voiceText: "",

      language:
        normalizeLanguage(
          language
        )
    };
  }

  const finalLanguage =
    language
      ? normalizeLanguage(
          language
        )
      : detectLanguageFromText(
          spokenText
        );

  let ttsAudio =
    null;

  let mergedVideo =
    null;

  try {

    ttsAudio =
      await createTTSAudio({

        text:
          spokenText,

        language:
          finalLanguage,

        voice,

        speed,

        pitch,

        emotion,

        slow
      });

    mergedVideo =
      await mergeVideoAndVoice({

        videoFile,

        audioFile:
          ttsAudio.filePath
      });

    return {

      success: true,

      voiceAdded: true,

      videoFile:
        mergedVideo.filePath,

      audioFile:
        ttsAudio.filePath,

      voiceText:
        spokenText,

      language:
        finalLanguage,

      fileName:
        mergedVideo.fileName,

      fileSize:
        mergedVideo.size
    };

  } catch (error) {

    console.error(
      "GAVEAI VIDEO AUDIO ERROR:",
      error
    );

    cleanupAudioFile(
      ttsAudio?.filePath
    );

    throw error;
  }
}


/*
========================================================
PROVIDER-INDEPENDENT POST PROCESSING
========================================================
*/

async function processGeneratedVideo({
  videoFile,
  prompt,
  voiceText,
  language,
  voice,
  speed,
  pitch,
  emotion,
  enableVoice = true,
  slowVoice = false
}) {

  if (!videoFile) {

    throw new Error(
      "processGeneratedVideo requires videoFile."
    );
  }

  if (!enableVoice) {

    return {

      success: true,

      voiceAdded: false,

      videoFile,

      voiceText:
        cleanString(
          voiceText
        ),

      language:
        normalizeLanguage(
          language
        )
    };
  }

  return addVoiceToVideo({

    videoFile,

    prompt,

    voiceText,

    language,

    voice,

    speed,

    pitch,

    emotion,

    slow:
      slowVoice,

    enabled:
      true
  });
}


/*
========================================================
HEALTH / STATUS
========================================================
*/

function getVideoAudioStatus() {

  return {

    configured:
      Boolean(
        ffmpegPath &&
        GAVEAI_AUDIO_API_KEY
      ),

    provider:
      "GaveAI",

    ttsProvider:
      "GaveAI",

    musicProvider:
      "GaveAI",

    sfxProvider:
      "GaveAI",

    ttsModel:
      GAVEAI_TTS_MODEL,

    musicModel:
      GAVEAI_MUSIC_MODEL,

    sfxModel:
      GAVEAI_SFX_MODEL,

    ffmpeg:
      ffmpegPath
        ? "CONFIGURED"
        : "NOT CONFIGURED",

    defaultLanguage:
      DEFAULT_LANGUAGE,

    speakingRate:
      DEFAULT_SPEAKING_RATE,

    multiSceneAudio:
      true,

    embeddedAudio:
      true
  };
}


/*
========================================================
EXPORTS
========================================================
*/

module.exports = {

  /*
  Legacy functions
  */

  addVoiceToVideo,

  processGeneratedVideo,

  createTTSAudio,

  mergeVideoAndVoice,

  extractDialogue,

  detectLanguageFromText,

  normalizeLanguage,

  getVideoAudioStatus,

  /*
  New GaveAI audio functions
  */

  generateTTS,

  generateMusic,

  generateSFX,

  createSilence,

  mixSceneAudio,

  createSceneAudio,

  renderGaveAIAudioForScenes,

  cleanupAudioFile,

  cleanupAudioFiles
};

