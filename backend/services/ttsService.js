const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const googleTTS = require("google-tts-api");

const F5_HAITIAN_ENABLED =
  String(process.env.F5_HAITIAN_ENABLED || "false").toLowerCase() === "true";

const F5_PYTHON =
  process.env.F5_PYTHON || "python";

const F5_HAITIAN_SCRIPT =
  process.env.F5_HAITIAN_SCRIPT ||
  path.join(process.cwd(), "f5-haitian", "generate_haitian.py");

const F5_HAITIAN_REFERENCE =
  process.env.F5_HAITIAN_REFERENCE ||
  path.join(process.cwd(), "f5-haitian", "reference.wav");

const F5_HAITIAN_REFERENCE_TEXT =
  process.env.F5_HAITIAN_REFERENCE_TEXT ||
  "Bonjou, kijan ou ye? Mwen kontan pale avèk ou jodi a.";

const F5_HAITIAN_OUTPUT_DIR =
  process.env.F5_HAITIAN_OUTPUT_DIR ||
  path.join(process.cwd(), "f5-haitian", "outputs");


// ============================================================
// GAVEAI HAITIAN TTS QUEUE
// Only one F5-TTS CPU process is allowed at a time.
// ============================================================

let haitianTTSQueue = Promise.resolve();

function queueHaitianTTS(task) {
  const next = haitianTTSQueue.then(
    () => task(),
    () => task()
  );

  haitianTTSQueue = next.catch(() => {});

  return next;
}


// ============================================================
// LANGUAGE NORMALIZATION
// ============================================================

function normalizeLanguageCode(language) {
  const value = String(language || "")
    .trim()
    .toLowerCase();

  if (
    value === "ht" ||
    value === "hat" ||
    value === "haitian" ||
    value === "haitian creole" ||
    value === "haitian-creole" ||
    value === "creole" ||
    value === "kreyol" ||
    value === "kreyòl" ||
    value === "ht-ht"
  ) {
    return "ht";
  }

  if (value.startsWith("en")) return "en";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("pt")) return "pt";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("it")) return "it";

  return value || "en";
}


// ============================================================
// TEXT CLEANING
// ============================================================

function cleanTextForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}


// ============================================================
// OUTPUT FILE
// ============================================================

function makeOutputPath() {
  fs.mkdirSync(F5_HAITIAN_OUTPUT_DIR, {
    recursive: true
  });

  const id = crypto.randomBytes(12).toString("hex");

  return path.join(
    F5_HAITIAN_OUTPUT_DIR,
    `gaveai-haitian-${id}.wav`
  );
}


// ============================================================
// F5 HAITIAN TTS
// ============================================================

function runF5HaitianTTS(text) {
  return queueHaitianTTS(
    () =>
      new Promise((resolve, reject) => {
        if (!F5_HAITIAN_ENABLED) {
          return reject(
            new Error(
              "GaveAI Haitian Creole F5-TTS is not enabled."
            )
          );
        }

        if (!fs.existsSync(F5_HAITIAN_SCRIPT)) {
          return reject(
            new Error(
              `GaveAI Haitian TTS script not found: ${F5_HAITIAN_SCRIPT}`
            )
          );
        }

        if (!fs.existsSync(F5_HAITIAN_REFERENCE)) {
          return reject(
            new Error(
              `GaveAI Haitian TTS reference audio not found: ${F5_HAITIAN_REFERENCE}`
            )
          );
        }

        const outputPath = makeOutputPath();

        console.log("");
        console.log("==========================================");
        console.log("=== GAVEAI HAITIAN F5-TTS STARTING ===");
        console.log("==========================================");
        console.log("Python:", F5_PYTHON);
        console.log("Script:", F5_HAITIAN_SCRIPT);
        console.log("Reference:", F5_HAITIAN_REFERENCE);
        console.log("Reference text:", F5_HAITIAN_REFERENCE_TEXT);
        console.log("Output:", outputPath);
        console.log("Text:", text);
        console.log("==========================================");

        const child = spawn(
          F5_PYTHON,
          [
            F5_HAITIAN_SCRIPT,

            "--text",
            text,

            "--reference",
            F5_HAITIAN_REFERENCE,

            "--reference-text",
            F5_HAITIAN_REFERENCE_TEXT,

            "--output",
            outputPath
          ],
          {
            cwd: path.dirname(F5_HAITIAN_SCRIPT),
            windowsHide: true
          }
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
          const value = data.toString();

          stdout += value;

          console.log(
            `[GAVEAI F5] ${value.trim()}`
          );
        });

        child.stderr.on("data", (data) => {
          const value = data.toString();

          stderr += value;

          console.error(
            `[GAVEAI F5] ${value.trim()}`
          );
        });

        child.on("error", (error) => {
          try {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
          } catch (_) {}

          reject(error);
        });

        child.on("close", (code) => {
          if (code !== 0) {
            try {
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
            } catch (_) {}

            return reject(
              new Error(
                `GaveAI Haitian F5-TTS failed with exit code ${code}. ${stderr || stdout}`
              )
            );
          }

          if (!fs.existsSync(outputPath)) {
            return reject(
              new Error(
                "GaveAI Haitian F5-TTS completed but no audio file was created."
              )
            );
          }

          try {
            const audioBuffer =
              fs.readFileSync(outputPath);

            const audioUrl =
              `data:audio/wav;base64,${audioBuffer.toString("base64")}`;

            fs.unlinkSync(outputPath);

            console.log(
              "=== GAVEAI HAITIAN F5-TTS COMPLETE ==="
            );

            resolve(audioUrl);
          } catch (error) {
            try {
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
            } catch (_) {}

            reject(error);
          }
        });
      })
  );
}


// ============================================================
// GOOGLE TTS FOR NON-HAITIAN LANGUAGES
// ============================================================

async function getGoogleTTSUrl(text, language) {
  const languageCode =
    language === "en"
      ? "en"
      : language === "fr"
        ? "fr"
        : language === "es"
          ? "es"
          : language === "pt"
            ? "pt"
            : language === "de"
              ? "de"
              : language === "it"
                ? "it"
                : "en";

  const url = googleTTS.getAudioUrl(text, {
    lang: languageCode,
    slow: false,
    host: "https://translate.google.com"
  });

  return url;
}


// ============================================================
// MAIN AUDIO FUNCTION
// ============================================================

async function getAudioUrl(text, language = "en") {
  const cleanText = cleanTextForSpeech(text);

  if (!cleanText) {
    throw new Error(
      "No text available for GaveAI voice generation."
    );
  }

  const normalizedLanguage =
    normalizeLanguageCode(language);

  console.log(
    `[GAVEAI TTS] language=${normalizedLanguage}`
  );

  if (normalizedLanguage === "ht") {
    return await runF5HaitianTTS(cleanText);
  }

  return await getGoogleTTSUrl(
    cleanText,
    normalizedLanguage
  );
}


module.exports = {
  getAudioUrl,
  normalizeLanguageCode,
  cleanTextForSpeech
};
