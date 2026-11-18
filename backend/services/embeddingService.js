require("dotenv").config();

/*
========================================================
GAVEAI EMBEDDING SERVICE
========================================================
* Semantic memory vectors (Gemini primary)
* Local deterministic fallback so semantic memory keeps
  working even without GEMINI_API_KEY
* Every vector is tagged with the model that produced it
  so vectors from different spaces are never compared
* ZERO backslash-n escapes in this file
========================================================
*/

const NL = String.fromCharCode(10);
const EMBEDDING_MODEL = process.env.GAVEAI_EMBEDDING_MODEL || "gemini-embedding-001";
const SUMMARY_MODEL = process.env.GAVEAI_SUMMARY_MODEL || "gemini-2.5-flash";
const EMBEDDING_DIMENSIONS = 768;
const LOCAL_EMBEDDING_MODEL = "gaveai-local-hash-768";

function getApiKey() {
  return String(process.env.GEMINI_API_KEY || "").trim();
}

function getActiveEmbeddingModelName() {
  return getApiKey() ? EMBEDDING_MODEL : LOCAL_EMBEDDING_MODEL;
}

async function callGemini(model, payload) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for semantic memory embeddings and summaries.");
  }
  const operation = payload.contents ? "generateContent" : "embedContent";
 
  const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${operation}`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  }
);
  if (!response.ok) {
    throw new Error(
      "Gemini " + (payload.contents ? "summarization" : "embedding") +
      " request failed with HTTP " + response.status + "."
    );
  }
  return response.json();
}

/*
========================================================
VECTOR MODEL TAGGING
========================================================
Non-enumerable so Firestore / JSON stay clean.
========================================================
*/
function tagEmbedding(values, modelName) {
  Object.defineProperty(values, "embeddingModel", {
    value: modelName,
    enumerable: false,
    configurable: true
  });
  return values;
}

/*
========================================================
LOCAL SEMANTIC FALLBACK
========================================================
Deterministic hashed bag-of-words + character trigrams
+ bigrams, L2 normalized, 768 dimensions.
========================================================
*/
function createLocalEmbedding(text) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) throw new Error("Cannot embed empty text.");

  const tokens = normalizedText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]+/gu) || [];

  if (!tokens.length) throw new Error("Cannot embed empty text.");

  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);

  const addGram = (gram, weight) => {
    let hash = 2166136261;
    for (let index = 0; index < gram.length; index += 1) {
      hash ^= gram.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % EMBEDDING_DIMENSIONS] += weight;
  };

  tokens.forEach((token, position) => {
    addGram(token, 2);
    for (let index = 0; index + 3 <= token.length; index += 1) {
      addGram(token.slice(index, index + 3), 1);
    }
    if (position + 1 < tokens.length) {
      addGram(token + "_" + tokens[position + 1], 1.5);
    }
  });

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return tagEmbedding(vector.map((value) => value / magnitude), LOCAL_EMBEDDING_MODEL);
}

async function createEmbedding(text, taskType = "RETRIEVAL_DOCUMENT") {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) throw new Error("Cannot embed empty text.");
  if (!getApiKey()) return createLocalEmbedding(normalizedText);

  try {
    const result = await callGemini(EMBEDDING_MODEL, {
      content: { parts: [{ text: normalizedText.slice(0, 12000) }] },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS
    });
    const values = result?.embedding?.values;
    if (
      !Array.isArray(values) ||
      values.length !== EMBEDDING_DIMENSIONS ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Gemini returned an invalid embedding vector.");
    }
    return tagEmbedding(values, EMBEDDING_MODEL);
  } catch (error) {
    console.error("GAVEAI EMBEDDING FALLBACK TO LOCAL VECTOR:", error.message);
    return createLocalEmbedding(normalizedText);
  }
}

function localSummary(text) {
  const sentences = String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]?/g) || [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" ")
    .slice(0, 1600);
}

async function summarizeMemories(previousSummary, memories) {
  const entries = (Array.isArray(memories) ? memories : [])
    .map((memory) => String(memory?.role || "user") + ": " + String(memory?.content || ""))
    .join(NL);

  if (!entries.trim()) return String(previousSummary || "").trim();

  const prompt = [
    "Update this persistent user-memory summary with the older conversation details below.",
    "Preserve stable personal facts, preferences, goals, decisions, and unresolved projects.",
    "Remove repetition, do not invent facts, and keep the result under 1,500 characters.",
    "",
    "EXISTING SUMMARY:",
    String(previousSummary || "").slice(0, 1600) || "(none)",
    "",
    "OLDER MEMORIES:",
    entries.slice(0, 12000)
  ].join(NL);

  try {
    const result = await callGemini(SUMMARY_MODEL, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 700 }
    });
    const summary = String(
      result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || ""
    ).trim();
    if (summary) return summary.slice(0, 1600);
    throw new Error("Gemini returned an empty memory summary.");
  } catch (error) {
    console.error("GAVEAI MEMORY SUMMARIZATION FAILED; USING EXTRACTIVE SUMMARY:", error.message);
    return localSummary([previousSummary, entries].filter(Boolean).join(" "));
  }
}

async function summarizeProject(previousSummary, title, context) {
  const projectContent = String(context || "").trim();
  if (!projectContent) return String(previousSummary || "").trim();

  const prompt = [
    "Summarize this project for continuing it in future sessions.",
    "Preserve decisions, goals, current state, important names/details, and next steps.",
    "Do not invent facts. Keep the summary under 1,500 characters.",
    "",
    "PROJECT TITLE:",
    String(title || "").slice(0, 200),
    "",
    "PREVIOUS SUMMARY:",
    String(previousSummary || "").slice(0, 1600) || "(none)",
    "",
    "NEW PROJECT CONTEXT:",
    projectContent.slice(0, 12000)
  ].join(NL);

  try {
    const result = await callGemini(SUMMARY_MODEL, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 700 }
    });
    const summary = String(
      result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || ""
    ).trim();
    if (summary) return summary.slice(0, 1600);
    throw new Error("Gemini returned an empty project summary.");
  } catch (error) {
    console.error("GAVEAI PROJECT SUMMARIZATION FAILED; USING EXTRACTIVE SUMMARY:", error.message);
    return localSummary([previousSummary, projectContent].filter(Boolean).join(" "));
  }
}

module.exports = {
  EMBEDDING_MODEL,
  LOCAL_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  getActiveEmbeddingModelName,
  createEmbedding,
  createLocalEmbedding,
  summarizeMemories,
  summarizeProject,
  localSummary
};