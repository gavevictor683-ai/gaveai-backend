const googleTTS = require("google-tts-api");
const { GoogleGenAI } = require("@google/genai");

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const geminiAI =
  GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey: GEMINI_API_KEY
      })
    : null;

/*
|--------------------------------------------------------------------------
| LANGUAGE NORMALIZATION
|--------------------------------------------------------------------------
*/

function normalizeLanguageCode(language) {
  const raw = String(language || "")
    .trim()
    .toLowerCase()
    .replace("_", "-");

  const map = {
    en: "en",
    "en-us": "en",
    "en-gb": "en",

    ht: "ht",
    "ht-ht": "ht",
    hat: "ht",
    haitian: "ht",
    "haitian-creole": "ht",
    creole: "ht",
    kreyol: "ht",

    fr: "fr",
    "fr-fr": "fr",
    "fr-ca": "fr",

    es: "es",
    "es-es": "es",
    "es-us": "es",

    pt: "pt",
    "pt-br": "pt",

    de: "de",
    it: "it",
    nl: "nl",
    ru: "ru",
    uk: "uk",
    pl: "pl",
    ro: "ro",
    cs: "cs",
    el: "el",
    he: "he",
    ar: "ar",
    hi: "hi",
    zh: "zh",
    ja: "ja",
    ko: "ko",
    tr: "tr",
    vi: "vi",
    th: "th",
    id: "id",
    ms: "ms",
    sv: "sv",
    da: "da",
    no: "no",
    fi: "fi",
    hu: "hu",
    bg: "bg",
    hr: "hr",
    sk: "sk",
    sr: "sr",
    sw: "sw",
    ta: "ta",
    te: "te",
    bn: "bn",
    gu: "gu",
    mr: "mr",
    pa: "pa",
    ur: "ur",
    tl: "tl",
    cy: "cy",
    is: "is",
    la: "la",
    eo: "eo"
  };

  if (map[raw]) {
    return map[raw];
  }

  const base = raw.split("-")[0];

  if (map[base]) {
    return map[base];
  }

  return "en";
}

/*
|--------------------------------------------------------------------------
| PCM -> WAV
|--------------------------------------------------------------------------
|
| Gemini TTS returns raw PCM:
| 24,000 Hz
| mono
| 16-bit
|
*/

function createWavHeader(
  dataLength,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16
) {
  const header = Buffer.alloc(44);

  const byteRate =
    sampleRate *
    channels *
    bitsPerSample /
    8;

  const blockAlign =
    channels *
    bitsPerSample /
    8;

  header.write("RIFF", 0);

  header.writeUInt32LE(
    36 + dataLength,
    4
  );

  header.write("WAVE", 8);

  header.write("fmt ", 12);

  header.writeUInt32LE(
    16,
    16
  );

  header.writeUInt16LE(
    1,
    20
  );

  header.writeUInt16LE(
    channels,
    22
  );

  header.writeUInt32LE(
    sampleRate,
    24
  );

  header.writeUInt32LE(
    byteRate,
    28
  );

  header.writeUInt16LE(
    blockAlign,
    32
  );

  header.writeUInt16LE(
    bitsPerSample,
    34
  );

  header.write("data", 36);

  header.writeUInt32LE(
    dataLength,
    40
  );

  return header;
}

/*
|--------------------------------------------------------------------------
| GEMINI HAITIAN CREOLE TTS
|--------------------------------------------------------------------------
*/

async function getGeminiHaitianCreoleAudioUrl(
  text
) {
  if (!geminiAI) {
    throw new Error(
      "GEMINI_API_KEY is not configured."
    );
  }

  const cleanText =
    String(text || "")
      .trim()
      .slice(0, 1200);

  if (!cleanText) {
    throw new Error(
      "No text provided for Gemini TTS."
    );
  }

  const response =
    await geminiAI.models.generateContent({
      model:
        "gemini-3.1-flash-tts-preview",

      contents: [
        {
          parts: [
            {
              text:
                `Speak the following text naturally in Haitian Creole (Kreyòl Ayisyen).

Use authentic Haitian Creole pronunciation, rhythm, intonation and natural conversational pauses.

Do not spell out words.

Do not pronounce Haitian Creole words as English.

Do not pronounce Haitian Creole words as French.

Speak clearly, naturally and warmly, like a native Haitian speaker.

Do not translate the text.

Only speak the provided text.

Text:
${cleanText}`
            }
          ]
        }
      ],

      config: {
        responseModalities: [
          "AUDIO"
        ],

        speechConfig: {
          languageCode: "ht",

          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Kore"
            }
          }
        }
      }
    });

  const parts =
    response?.candidates?.[0]
      ?.content?.parts || [];

  let pcmBuffer = null;

  for (const part of parts) {
    if (
      part?.inlineData?.data
    ) {
      pcmBuffer =
        Buffer.from(
          part.inlineData.data,
          "base64"
        );

      break;
    }
  }

  if (!pcmBuffer) {
    throw new Error(
      "Gemini did not return audio data."
    );
  }

  const wavHeader =
    createWavHeader(
      pcmBuffer.length,
      24000,
      1,
      16
    );

  const wavBuffer =
    Buffer.concat([
      wavHeader,
      pcmBuffer
    ]);

  return (
    "data:audio/wav;base64," +
    wavBuffer.toString("base64")
  );
}

/*
|--------------------------------------------------------------------------
| GOOGLE TTS FALLBACK / OTHER LANGUAGES
|--------------------------------------------------------------------------
*/

async function getGoogleAudioUrl(
  text,
  language
) {
  const cleanText =
    String(text || "")
      .trim()
      .slice(0, 200);

  if (!cleanText) {
    throw new Error(
      "No text provided for TTS."
    );
  }

  const url =
    googleTTS.getAudioUrl(
      cleanText,
      {
        lang: language,
        slow: false,
        host:
          "https://translate.google.com"
      }
    );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Google TTS request failed: ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  return (
    "data:audio/mpeg;base64," +
    buffer.toString("base64")
  );
}

/*
|--------------------------------------------------------------------------
| MAIN TTS FUNCTION
|--------------------------------------------------------------------------
*/

async function getAudioUrl(
  text,
  language = "en"
) {
  const normalizedLanguage =
    normalizeLanguageCode(
      language
    );

  /*
  |--------------------------------------------------------------------------
  | HAITIAN CREOLE
  |--------------------------------------------------------------------------
  |
  | Gemini is the primary TTS engine for Kreyòl.
  | Google remains a fallback if Gemini fails.
  |
  */

  if (
    normalizedLanguage === "ht"
  ) {
    try {
      console.log(
        "🎙️ GaveAI TTS: Gemini Haitian Creole"
      );

      return await getGeminiHaitianCreoleAudioUrl(
        text
      );
    } catch (geminiError) {
      console.error(
        "⚠️ Gemini Haitian Creole TTS failed:",
        geminiError?.message ||
          geminiError
      );

      console.log(
        "🔄 GaveAI TTS: falling back to Google TTS"
      );

      return await getGoogleAudioUrl(
        text,
        "ht"
      );
    }
  }

  /*
  |--------------------------------------------------------------------------
  | OTHER LANGUAGES
  |--------------------------------------------------------------------------
  */

  return await getGoogleAudioUrl(
    text,
    normalizedLanguage
  );
}

module.exports = {
  getAudioUrl,
  normalizeLanguageCode
};