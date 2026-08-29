const tts = require("google-tts-api");

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

    const url =
      tts.getAudioUrl(
        cleanText,
        {
          lang:
            language,
          slow:
            false,
          host:
            "https://translate.google.com"
        }
      );

    return url;

  } catch (error) {
    console.error(
      "TTS Service Error:",
      error
    );

    throw new Error(
      "Failed to generate audio URL"
    );
  }
}

/*
========================================================
NORMALIZE LANGUAGE CODES
========================================================

Whisper can return language names/codes depending
on the API response.

We normalize common ones before sending them to TTS.
========================================================
*/

function normalizeLanguageCode(lang) {
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