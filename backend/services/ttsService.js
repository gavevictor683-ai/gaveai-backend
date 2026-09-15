const axios = require("axios");
const tts = require("google-tts-api");

/*
========================================================
GAVEAI TEXT-TO-SPEECH SERVICE
========================================================

Generates Google TTS audio and returns a browser-playable
data:audio/mpeg URL instead of the raw Google Translate URL.

This avoids browser NotSupportedError problems with:
https://translate.google.com/translate_tts...
========================================================
*/

async function getAudioUrl(
  text,
  lang = "en"
) {
  try {
    const cleanText =
      String(text)
        .replace(/[\r\n]+/g, " ")
        .trim()
        .substring(0, 200);

    if (!cleanText) {
      throw new Error(
        "Text cannot be empty."
      );
    }

    const language =
      normalizeLanguageCode(lang);

    const googleTtsUrl =
      tts.getAudioUrl(
        cleanText,
        {
          lang: language,
          slow: false,
          host: "https://translate.google.com"
        }
      );

    console.log(
      "🔊 Downloading Google TTS audio:",
      language
    );

    const response =
      await axios.get(
        googleTtsUrl,
        {
          responseType: "arraybuffer",
          timeout: 30000,
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        }
      );

    const audioBuffer =
      Buffer.from(
        response.data
      );

    if (
      !audioBuffer ||
      audioBuffer.length === 0
    ) {
      throw new Error(
        "Google TTS returned empty audio."
      );
    }

    const audioBase64 =
      audioBuffer.toString(
        "base64"
      );

    const audioDataUrl =
      `data:audio/mpeg;base64,${audioBase64}`;

    console.log(
      "✅ TTS audio generated:",
      audioBuffer.length,
      "bytes"
    );

    return audioDataUrl;

  } catch (error) {
    console.error(
      "❌ TTS Service Error:",
      error.response?.status ||
        error.message ||
        error
    );

    throw new Error(
      "Failed to generate audio"
    );
  }
}

/*
========================================================
NORMALIZE LANGUAGE CODES
========================================================
*/

function normalizeLanguageCode(
  lang
) {
  const value =
    String(lang || "en")
      .trim()
      .toLowerCase();

  const languageMap = {
    english: "en",
    eng: "en",

    french: "fr",
    fra: "fr",
    fre: "fr",

    haitian: "ht",
    "haitian creole": "ht",
    creole: "ht",
    kreyol: "ht",
    "kreyòl": "ht",
    hat: "ht",

    spanish: "es",
    spa: "es",

    portuguese: "pt",
    por: "pt",

    german: "de",
    deu: "de",
    ger: "de",

    italian: "it",
    ita: "it",

    dutch: "nl",
    nld: "nl",
    dut: "nl",

    russian: "ru",
    rus: "ru",

    ukrainian: "uk",
    ukr: "uk",

    arabic: "ar",
    ara: "ar",

    chinese: "zh-CN",
    zho: "zh-CN",
    chi: "zh-CN",

    japanese: "ja",
    jpn: "ja",

    korean: "ko",
    kor: "ko",

    hindi: "hi",
    hin: "hi",

    bengali: "bn",
    ben: "bn",

    turkish: "tr",
    tur: "tr",

    vietnamese: "vi",
    vie: "vi",

    indonesian: "id",
    ind: "id",

    thai: "th",
    tha: "th",

    polish: "pl",
    pol: "pl",

    romanian: "ro",
    ron: "ro",
    rum: "ro",

    czech: "cs",
    ces: "cs",
    cze: "cs",

    greek: "el",
    ell: "el",
    gre: "el",

    hebrew: "he",
    heb: "he"
  };

  return (
    languageMap[value] ||
    value ||
    "en"
  );
}

module.exports = {
  getAudioUrl,
  normalizeLanguageCode
};
