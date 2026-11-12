require("dotenv").config();

const EMBEDDING_MODEL = process.env.GAVEAI_EMBEDDING_MODEL || "gemini-embedding-001";
const SUMMARY_MODEL = process.env.GAVEAI_SUMMARY_MODEL || "gemini-2.5-flash";
const EMBEDDING_DIMENSIONS = 768;

function getApiKey() {
  return String(process.env.GEMINI_API_KEY || "").trim();
}

async function callGemini(model, payload) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for semantic memory embeddings and summaries.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${payload.contents ? "generateContent" : "embedContent"}`,
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
    throw new Error(`Gemini ${payload.contents ? "summarization" : "embedding"} request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function createEmbedding(text, taskType = "RETRIEVAL_DOCUMENT") {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) throw new Error("Cannot embed empty text.");
  const result = await callGemini(EMBEDDING_MODEL, {
    content: { parts: [{ text: normalizedText.slice(0, 12000) }] },
    taskType,
    outputDimensionality: EMBEDDING_DIMENSIONS
  });
  const values = result?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS ||
      values.some((value) => !Number.isFinite(value))) {
    throw new Error("Gemini returned an invalid embedding vector.");
  }
  return values;
}

function localSummary(text) {
  const sentences = String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]?/g) || [];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean).slice(0, 8).join(" ").slice(0, 1600);
}

async function summarizeMemories(previousSummary, memories) {
  const entries = memories.map((memory) => `${memory.role}: ${memory.content}`).join("\n");
  if (!entries.trim()) return String(previousSummary || "").trim();
  try {
    const result = await callGemini(SUMMARY_MODEL, {
      contents: [{
        role: "user",
        parts: [{
          text: `Update this persistent user-memory summary with the older conversation details below. Preserve stable personal facts, preferences, goals, decisions, and unresolved projects. Remove repetition, do not invent facts, and keep the result under 1,500 characters.\n\nEXISTING SUMMARY:\n${String(previousSummary || "").slice(0, 1600) || "(none)"}\n\nOLDER MEMORIES:\n${entries.slice(0, 12000)}`
        }]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 700 }
    });
    const summary = String(result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "").trim();
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
  try {
    const result = await callGemini(SUMMARY_MODEL, {
      contents: [{
        role: "user",
        parts: [{
          text: `Summarize this project for continuing it in future sessions. Preserve decisions, goals, current state, important names/details, and next steps. Do not invent facts. Keep the summary under 1,500 characters.\n\nPROJECT TITLE:\n${String(title || "").slice(0, 200)}\n\nPREVIOUS SUMMARY:\n${String(previousSummary || "").slice(0, 1600) || "(none)"}\n\nNEW PROJECT CONTEXT:\n${projectContent.slice(0, 12000)}`
        }]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 700 }
    });
    const summary = String(result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "").trim();
    if (summary) return summary.slice(0, 1600);
    throw new Error("Gemini returned an empty project summary.");
  } catch (error) {
    console.error("GAVEAI PROJECT SUMMARIZATION FAILED; USING EXTRACTIVE SUMMARY:", error.message);
    return localSummary([previousSummary, projectContent].filter(Boolean).join(" "));
  }
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  createEmbedding,
  summarizeMemories,
  summarizeProject,
  localSummary
};
