require("dotenv").config();

const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/*
========================================================
STT SERVICE
========================================================

🎤 Audio
   ↓
Groq Whisper
   ↓
Transcript + Detected Language

Supported formats:
m4a, mp3, mp4, wav, webm, ogg, opus, flac, etc.
========================================================
*/

async function transcribeAudio(
  audioBuffer,
  mimeType = "audio/m4a",
  fileName = "voice-input.m4a"
) {
  try {
    if (!audioBuffer) {
      throw new Error(
        "Audio buffer is required."
      );
    }

    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error(
        "Audio input must be a Buffer."
      );
    }

    if (!process.env.GROQ_API_KEY) {
      throw new Error(
        "GROQ_API_KEY is missing from .env"
      );
    }

    /*
    ----------------------------------------------------
    NORMALIZE MIME TYPE
    ----------------------------------------------------
    */

    let normalizedMimeType =
      String(mimeType || "audio/m4a")
        .split(";")[0]
        .trim()
        .toLowerCase();

    /*
    Some browsers send:
      audio/x-m4a
      audio/mp4

    Normalize them to audio/m4a.
    */

    if (
      normalizedMimeType === "audio/x-m4a" ||
      normalizedMimeType === "audio/mp4"
    ) {
      normalizedMimeType =
        "audio/m4a";
    }

    /*
    ----------------------------------------------------
    NORMALIZE FILE NAME
    ----------------------------------------------------
    */

    let safeFileName =
      String(
        fileName || "voice-input.m4a"
      ).trim();

    if (!safeFileName) {
      safeFileName =
        "voice-input.m4a";
    }

    /*
    If browser gives a generic filename,
    make sure the extension matches M4A.
    */

    if (
      normalizedMimeType === "audio/m4a" &&
      !safeFileName
        .toLowerCase()
        .endsWith(".m4a")
    ) {
      safeFileName += ".m4a";
    }

    /*
    ----------------------------------------------------
    CREATE FILE FOR GROQ
    ----------------------------------------------------
    */

    const file = new File(
      [audioBuffer],
      safeFileName,
      {
        type: normalizedMimeType
      }
    );

    console.log(
      "STT REQUEST:",
      {
        fileName:
          safeFileName,
        mimeType:
          normalizedMimeType,
        size:
          audioBuffer.length
      }
    );

    /*
    ----------------------------------------------------
    GROQ WHISPER
    ----------------------------------------------------
    */

    const transcription =
      await groq.audio.transcriptions.create({
        file: file,

        model:
          "whisper-large-v3-turbo",

        response_format:
          "verbose_json"
      });

    /*
    ----------------------------------------------------
    TRANSCRIPT
    ----------------------------------------------------
    */

    const transcript =
      transcription &&
      typeof transcription.text ===
        "string"
        ? transcription.text.trim()
        : "";

    /*
    ----------------------------------------------------
    LANGUAGE
    ----------------------------------------------------

    Groq Whisper returns language
    when using verbose_json.
    ----------------------------------------------------
    */

    const language =
      transcription &&
      transcription.language
        ? String(
            transcription.language
          ).trim()
        : "";

    if (!transcript) {
      throw new Error(
        "No speech was detected in the audio."
      );
    }

    console.log(
      "STT SUCCESS:",
      {
        transcript:
          transcript,
        language:
          language
      }
    );

    return {
      success: true,
      transcript:
        transcript,
      language:
        language
    };

  } catch (error) {
    console.error(
      "STT SERVICE ERROR:",
      error
    );

    throw new Error(
      error &&
      error.message
        ? error.message
        : "Speech-to-text transcription failed."
    );
  }
}

module.exports = {
  transcribeAudio
};