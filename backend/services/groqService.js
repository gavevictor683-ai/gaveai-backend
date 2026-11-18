const Groq = require("groq-sdk");
const { searchWithTavily } = require("./tavilyService");
const { searchWithExa } = require("./exaService");
const {
  saveMemory,
  getMemory,
  getConversationHistory,
  getUserProfile,
  updateUserProfile,
  extractProfileFacts
} = require("./aiMemoryService");
const { getProjectMemory, saveProjectMemory } = require("./projectMemoryService");
const { getStoredCharacterBible, buildCharacterBible } = require("./characterBibleService");

/*
========================================================
GAVEAI - GROQ SERVICE
========================================================
GLOBAL MEMORY (not only storyboard):
  * chat conversations
  * voice conversations
  * image generation / editing
  * video generation
  * storyboard projects

ORDER OF OPERATIONS:
  1. Restore conversation history (client OR Firestore)
  2. Retrieve long term + semantic + profile + project + bible
  3. Web search when the question is time sensitive
  4. Generate the answer
  5. Save memory AFTER the answer

IMPORTANT - NL CONSTANT:
NL is a real newline produced WITHOUT a backslash escape.
This file contains ZERO backslash-n sequences on purpose so
no copy/paste tool, formatter or export pipeline can corrupt
its string literals.
========================================================
*/

const NL = String.fromCharCode(10);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const OUTPUT_TOKEN_BUDGETS = {
  normal: positiveInteger(process.env.GROQ_NORMAL_MAX_OUTPUT_TOKENS, 4000),
  explanation: positiveInteger(process.env.GROQ_EXPLANATION_MAX_OUTPUT_TOKENS, 8000),
  code: positiveInteger(process.env.GROQ_CODE_MAX_OUTPUT_TOKENS, 16000),
  largeCode: positiveInteger(process.env.GROQ_LARGE_CODE_MAX_OUTPUT_TOKENS, 32000)
};

const MAX_OUTPUT_CHUNK_TOKENS = Math.min(8000, Math.max(1000, Math.floor(Number(process.env.GROQ_MAX_OUTPUT_CHUNK_TOKENS) || 4000)));
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 16000;
const SERVER_HISTORY_MESSAGES = 20;
const MAX_SEARCH_RESULTS = 5;
const MIN_SEARCH_SOURCES = 2;
const MAX_SOURCE_TITLE_CHARS = 180;
const MAX_SOURCE_TEXT_CHARS = 700;
const MAX_SEARCH_CONTEXT_CHARS = 7000;
const MAX_MEMORY_PROMPT_CHARS = 30000;

/*
========================================================
HAITI DATE / TIME
========================================================
*/
function getHaitiDateTime() {
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Port-au-Prince",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Port-au-Prince",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);
  const getPart = (parts, type) => {
    const item = parts.find((part) => part.type === type);
    return item ? item.value : "";
  };
  const year = getPart(dateParts, "year");
  const month = getPart(dateParts, "month");
  const day = getPart(dateParts, "day");
  const hour = getPart(timeParts, "hour");
  const minute = getPart(timeParts, "minute");
  const second = getPart(timeParts, "second");
  const date = `${year}-${month}-${day}`;
  const currentDateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Port-au-Prince",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(now);
  return {
    date,
    currentDate: date,
    currentDateLabel,
    currentTime: `${hour}:${minute}:${second}`,
    timezone: "America/Port-au-Prince"
  };
}

/*
========================================================
TEXT HELPERS
========================================================
*/
function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function limitText(value, max) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function getOutputTokenBudget(message) {
  const text = cleanText(message).toLowerCase();
  const requestsCode = /\b(code|coding|program|function|script|file|repository|html|javascript|typescript|python)\b|kòd|fichye/.test(text);
  const requestsLargeOutput = /\b(very large|entire|whole|complete|full file|from scratch|5000|5,000|32k|32000)\b|trè gwo|gwo kòd|gwo blok/.test(text);
  const requestsDetailedExplanation = /\b(explain|explanation|in detail|detailed|comprehensive|deep dive)\b|eksplik|detaye/.test(text);
  if (requestsCode && requestsLargeOutput) return OUTPUT_TOKEN_BUDGETS.largeCode;
  if (requestsCode) return OUTPUT_TOKEN_BUDGETS.code;
  if (requestsDetailedExplanation) return OUTPUT_TOKEN_BUDGETS.explanation;
  return OUTPUT_TOKEN_BUDGETS.normal;
}

function getCompletionTokenCount(completion, content) {
  const reportedCount = Number(completion?.usage?.completion_tokens);
  return Number.isFinite(reportedCount) && reportedCount > 0
    ? reportedCount
    : Math.max(1, Math.ceil(String(content || "").length / 4));
}

/*
========================================================
LANGUAGE DETECTION
========================================================
Logic unchanged. When it returns "auto", buildSystemPrompt
already instructs the model to detect the user's language
and answer in that same language.
========================================================
*/
function normalizeLanguage(message) {
  const text = cleanText(message)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/\b(ki sa|kisa|kijan|poukisa|kiles|kiyes|ki ekip|chanpyon|champyon|mondyal|koup di mond|mwen|nan|yon|bonjou|bonswa|mesi|tanpri|kreyol)\b/.test(text)) {
    return "ht";
  }
  if (/\b(quelle|quel|qu est|qui|quoi|comment|pourquoi|est ce|bonjour|je|vous|dans|une|un|avec)\b/.test(text)) {
    return "fr";
  }
  if (/\b(que|quien|quienes|cuando|donde|como|por que|hola|gracias|usted|ustedes|nosotros|espanol|buenos dias)\b/.test(text)) {
    return "es";
  }
  if (/\b(quem|quando|onde|como|porque|ola|obrigado|obrigada|voce|voces|portugues|bom dia)\b/.test(text)) {
    return "pt";
  }
  if (/\b(wer|was|wann|wo|wie|warum|hallo|danke|deutsch|guten tag|ich|und)\b/.test(text)) {
    return "de";
  }
  if (/\b(chi|cosa|quando|dove|come|perche|ciao|grazie|italiano|buongiorno)\b/.test(text)) {
    return "it";
  }
  if (/[а-яё]/i.test(text)) return "ru";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0900-\u097f]/.test(text)) return "hi";
  return "auto";
}

/*
========================================================
CREATOR / IDENTITY
========================================================
*/
function isCreatorQuestion(message) {
  const text = cleanText(message).toLowerCase();
  const patterns = [
    "who created you",
    "who made you",
    "who built you",
    "who is your creator",
    "who developed you",
    "who is behind you",
    "kiyes ki kreye w",
    "kiyes ki te kreye w",
    "kiles ki kreye w",
    "kiles ki te kreye w",
    "kreyatè w",
    "kreyate w",
    "kreyater w",
    "ki moun ki kreye w",
    "ki moun ki te kreye w",
    "ki moun ki fe w",
    "ki moun ki fè w",
    "ki moun ki dèyè w",
    "ki moun ki deye w",
    "qui t'a créé",
    "qui ta créé",
    "qui t'a cree",
    "qui vous a créé",
    "qui vous a cree",
    "qui a créé gaveai",
    "qui a cree gaveai",
    "qui a créé gave money tips",
    "qui a cree gave money tips"
  ];
  return patterns.some((pattern) => text.includes(pattern));
}

function creatorResponse(language) {
  if (language === "ht") {
    return [
      "**GaveAI**, ki rele tou **Gave Money Tips AI**, se yon asistan entèlijans atifisyèl ki fè pati pwojè **Gave Money Tips**.",
      "**Kiyès ki kreye GaveAI?**",
      "**Gave Victor** se kreyatè GaveAI / Gave Money Tips AI an 2026."
    ].join(NL + NL);
  }
  if (language === "fr") {
    return [
      "**GaveAI**, également appelé **Gave Money Tips AI**, est un assistant d'intelligence artificielle faisant partie du projet **Gave Money Tips**.",
      "**Qui a créé GaveAI ?**",
      "**Gave Victor** est le créateur de GaveAI / Gave Money Tips AI en 2026."
    ].join(NL + NL);
  }
  return [
    "**GaveAI**, also known as **Gave Money Tips AI**, is an artificial intelligence assistant that is part of the **Gave Money Tips** project.",
    "**Who created GaveAI?**",
    "**Gave Victor** is the creator of GaveAI / Gave Money Tips AI in 2026."
  ].join(NL + NL);
}

/*
========================================================
WEB SEARCH DETECTION
========================================================
`text` is accent-stripped, so every pattern below is
written WITHOUT accents on purpose.
========================================================
*/
function needsWebSearch(message) {
  const text = cleanText(message)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const currentPatterns = [
    "latest", "today", "right now", "currently", "current", "recent", "recently",
    "this week", "this month", "breaking news", "news today", "latest news",
    "price today", "current price", "live price", "stock price", "exchange rate",
    "weather today", "what happened today", "what's happening", "whats happening",
    "jodi a", "kounye a", "denye nouvel", "nouvel jodi a", "pri jodi a",
    "pri kounye a", "sa k ap pase", "sa kap pase",
    "aujourd'hui", "actualites", "dernieres nouvelles", "nouvelles recentes",
    "en ce moment", "actuellement", "prix actuel", "taux actuel"
  ];
  if (currentPatterns.some((pattern) => text.includes(pattern))) return true;

  const sportsResultPatterns = [
    /\b(world cup|fifa|champion|championship|winner|who won|which team won)\b/,
    /\b(gagnant|coupe du monde|mondiale|champion du monde)\b/,
    /\b(copa mundial|copa del mundo|campeon mundial|campeon del mundo|quien gano|que equipo gano)\b/,
    /\b(copa do mundo|campeao do mundo|quem venceu|qual equipe venceu)\b/,
    /\b(koup di mond|chanpyon|champyon|ki ekip|ki moun ki genyen|ki moun ki te genyen)\b/
  ];
  if (sportsResultPatterns.some((pattern) => pattern.test(text))) return true;

  const searchPatterns = [
    "search the web", "search online", "look it up", "find online", "google this",
    "web search", "verify online",
    "cheche sou entenet", "cheche sou internet", "verifye sou entenet",
    "verifye sou internet", "gade sou entenet",
    "cherche sur internet", "recherche sur internet", "verifie en ligne"
  ];
  if (searchPatterns.some((pattern) => text.includes(pattern))) return true;

  const currentEventsPatterns = [
    "election", "elections", "eleksyon", "vote results", "president", "prime minister",
    "world cup", "coupe du monde", "koup di mond", "copa del mundo", "copa do mundo",
    "who won", "ki moun ki genyen", "final score", "standings", "transfer news",
    "release date", "box office", "stock", "bitcoin price", "crypto price",
    "match result", "results of", "this season", "this year", "nouvel"
  ];
  if (currentEventsPatterns.some((pattern) => text.includes(pattern))) return true;

  if (/\b20(2[4-9]|3[0-9])\b/.test(text)) return true;

  return false;
}

function buildFallbackSearchQuery(query) {
  const cleaned = cleanText(query)
    .replace(/^(who|what|when|where|why|how|is|are|did|does|do|can|could|will)\s+/i, "")
    .replace(/\b(please|tell me|explain|kijan|poukisa|ki moun ki|kiyes ki|eske)\b/gi, " ")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const year = new Date().getFullYear();
  return /\b(19|20)\d{2}\b/.test(cleaned) ? cleaned : `${cleaned} ${year}`;
}

/*
========================================================
SOURCE NORMALIZATION
========================================================
*/
function normalizeSource(item, provider) {
  if (!item || typeof item !== "object") return null;
  const url = item.url || item.link || item.source_url || "";
  if (!url) return null;
  const title = item.title || item.name || "";
  const content =
    item.content ||
    item.text ||
    item.snippet ||
    item.description ||
    (Array.isArray(item.highlights) ? item.highlights.join(" ") : "") ||
    "";
  return {
    provider,
    title: limitText(title, MAX_SOURCE_TITLE_CHARS),
    url: String(url).trim(),
    content: limitText(content, MAX_SOURCE_TEXT_CHARS)
  };
}

/*
========================================================
WEB SEARCH: TAVILY FIRST, EXA FALLBACK
========================================================
*/
async function performWebSearch(query, attempt = 0) {
  const sources = [];

  /* TAVILY (PRIMARY) */
  try {
    if (typeof searchWithTavily === "function") {
      console.log("GAVEAI WEB SEARCH: TAVILY");
      const result = await searchWithTavily(query, { maxResults: MAX_SEARCH_RESULTS });
      let results = [];
      if (Array.isArray(result)) results = result;
      else if (result && Array.isArray(result.results)) results = result.results;
      for (const item of results.slice(0, MAX_SEARCH_RESULTS)) {
        const source = normalizeSource(item, "Tavily");
        if (source) sources.push(source);
      }
    }
  } catch (error) {
    console.error("TAVILY SEARCH ERROR:", error && error.message ? error.message : error);
  }

  /* EXA (FALLBACK ONLY WHEN TAVILY DID NOT RETURN ENOUGH SOURCES) */
  if (sources.length < MIN_SEARCH_SOURCES) {
    try {
      if (typeof searchWithExa === "function") {
        console.log("GAVEAI WEB SEARCH: EXA FALLBACK");
        const result = await searchWithExa(query, { maxResults: MAX_SEARCH_RESULTS });
        let results = [];
        if (Array.isArray(result)) results = result;
        else if (result && Array.isArray(result.results)) results = result.results;
        for (const item of results.slice(0, MAX_SEARCH_RESULTS)) {
          const source = normalizeSource(item, "Exa");
          if (source) sources.push(source);
        }
      }
    } catch (error) {
      console.error("EXA SEARCH ERROR:", error && error.message ? error.message : error);
    }
  }

  /* Deduplicate URLs */
  const unique = [];
  const seen = new Set();
  for (const source of sources) {
    const key = source.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
    if (unique.length >= MAX_SEARCH_RESULTS) break;
  }

  /* One automatic retry with a simpler query before giving up */
  if (!unique.length && attempt === 0) {
    const fallbackQuery = buildFallbackSearchQuery(query);
    if (fallbackQuery && fallbackQuery.toLowerCase() !== cleanText(query).toLowerCase()) {
      console.log("GAVEAI WEB SEARCH RETRY:", fallbackQuery);
      return performWebSearch(fallbackQuery, attempt + 1);
    }
  }

  /* Compact search context */
  let context = "";
  for (const source of unique) {
    const block = [
      `SOURCE: ${source.provider}`,
      `TITLE: ${source.title}`,
      `URL: ${source.url}`,
      `INFO: ${source.content}`
    ].join(NL) + NL;
    if (context.length + block.length > MAX_SEARCH_CONTEXT_CHARS) break;
    context += block;
  }

  return { sources: unique, context: context.trim() };
}

/*
========================================================
CONVERSATION COMPRESSION
========================================================
*/
function prepareConversation(conversation) {
  if (!Array.isArray(conversation)) return [];
  const recent = conversation.slice(-MAX_HISTORY_MESSAGES);
  const messages = [];
  let totalChars = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    if (!item) continue;
    const role = item.role === "assistant" || item.role === "bot" ? "assistant" : "user";
    const content = item.content || item.message || item.text || item.reply || "";
    const clean = limitText(content, 1200);
    if (!clean) continue;
    const line = `${role}: ${clean}`;
    if (totalChars + line.length > MAX_HISTORY_CHARS) break;
    messages.unshift({ role, content: clean });
    totalChars += line.length;
  }
  return messages;
}

/*
========================================================
RESTORE CHAT HISTORY FROM FIRESTORE
========================================================
This is what makes the CHAT remember previous sessions even
when the frontend sends no conversation array (homepage).
========================================================
*/
async function restoreServerConversation(userId) {
  if (!userId) return [];
  try {
    const saved = await getConversationHistory(userId, SERVER_HISTORY_MESSAGES);
    if (!Array.isArray(saved) || !saved.length) return [];
    return prepareConversation(
      saved.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      }))
    );
  } catch (error) {
    console.error("GAVEAI CHAT HISTORY RESTORE FAILED:", error.message);
    return [];
  }
}

/*
========================================================
SYSTEM PROMPT
========================================================
Every line below is a complete single-line string.
NL supplies real newlines. No bare text, no broken quotes.
========================================================
*/
function buildSystemPrompt(language, dateInfo, hasWebSearch, searchAttempted = false) {
  let languageInstruction;
  const normalizedLanguage = String(language || "en").toLowerCase().trim();
  if (
    normalizedLanguage === "ht" ||
    normalizedLanguage === "ht-ht" ||
    normalizedLanguage === "hat" ||
    normalizedLanguage === "haitian" ||
    normalizedLanguage === "haitian-creole" ||
    normalizedLanguage === "creole" ||
    normalizedLanguage === "kreyol"
  ) {
    languageInstruction = "Answer in Haitian Creole (Kreyòl Ayisyen) unless the user clearly asks for another language. Understand Haitian Creole even when it uses informal spelling, missing accents, abbreviations, slang, phonetic spelling, or mixed Haitian Creole with French or English. Do not ask the user to translate Haitian Creole. Preserve the user meaning and respond naturally in Haitian Creole.";
  } else if (["fr", "fr-fr", "fra", "french"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in French unless the user clearly asks for another language.";
  } else if (["es", "es-es", "spa", "spanish"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Spanish unless the user clearly asks for another language.";
  } else if (["pt", "pt-br", "pt-pt", "por", "portuguese"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Portuguese unless the user clearly asks for another language.";
  } else if (["de", "de-de", "deu", "german"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in German unless the user clearly asks for another language.";
  } else if (["it", "it-it", "ita", "italian"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Italian unless the user clearly asks for another language.";
  } else if (["nl", "nl-nl", "nld", "dutch"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Dutch unless the user clearly asks for another language.";
  } else if (["ko", "ko-kr", "kor", "korean"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Korean unless the user clearly asks for another language.";
  } else if (["ja", "ja-jp", "jpn", "japanese"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Japanese unless the user clearly asks for another language.";
  } else if (["zh", "zh-cn", "zh-tw", "zho", "chi", "chinese"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Chinese unless the user clearly asks for another language.";
  } else if (["ar", "ar-sa", "ara", "arabic"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Arabic unless the user clearly asks for another language.";
  } else if (["hi", "hi-in", "hin", "hindi"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Hindi unless the user clearly asks for another language.";
  } else if (["ru", "ru-ru", "rus", "russian"].includes(normalizedLanguage)) {
    languageInstruction = "Answer in Russian unless the user clearly asks for another language.";
  } else {
    languageInstruction = "Answer in the same language used by the user. Detect the user's language from the message and respond naturally in that language.";
  }

  const searchInstruction = hasWebSearch
    ? "Web search results are provided in the latest user message. Use those results as evidence for current and date-specific facts. Answer the exact question directly, and do not contradict the results with stale model memory."
    : searchAttempted
      ? "A web search was attempted, but no usable sources were returned. Do not claim that you verified the result or guess from memory. Clearly say you could not verify the current or date-specific fact."
      : "No web search was performed. Answer stable facts from general knowledge, but do not claim that you searched or verified current/date-specific results.";

  return [
    "You are GaveAI, also known as Gave Money Tips AI. ",
    "You are a helpful, accurate, concise AI assistant.",
    NL,
    "CREATOR: Gave Victor created GaveAI / Gave Money Tips AI in 2026.",
    NL,
    languageInstruction,
    NL,
    "PERSISTENT MEMORY (applies to the whole platform, not only storyboard): You have long-term memory tied to the user's account. It covers chat conversations, voice conversations, image requests, video requests and storyboard projects. The supplied context can contain messages from today, from days ago, from weeks ago and from months ago, plus long-term summaries, the user profile, project memory and the character bible. Earlier messages in this request are real previous turns of this same conversation, even after a page refresh or a new session.",
    NL,
    "NEVER say 'I don't have access to previous messages', 'I can't remember past conversations', 'each session starts fresh', or that memory resets after a refresh when memory context or previous turns are supplied. When the user asks what they said before, what they asked you to build, or asks you to continue, recall it from the supplied memory and continue the same work. Treat profile details as user-provided facts. Do not invent personal details, and do not claim to remember anything that is not present in the supplied context.",
    NL,
    "Be direct. Do not unnecessarily repeat the user's question. ",
    "Use short paragraphs and lists when useful. ",
    "Match the requested depth and completeness. For code requests, provide complete requested files or changes; do not omit existing functions, replace code with ellipses, or shorten code merely to be concise. ",
    "Keep the character bible identity (face, clothing, hairstyle, age, accessories, visual style, personality and voice style) identical across every image, video and storyboard scene unless the user explicitly requests a change. ",
    "For image edits, change only what the user explicitly requested and preserve all other details, especially identity, faces, eyes, eyelashes, animals, body shape, size, colors, clothing, and composition. Understand requests written in any language without changing their meaning. ",
    "For image and video generation, follow requested characters, counts, pairings, actions, dialogue, languages, storyboard scenes, order, timing, and audio exactly; do not add unrequested elements. ",
    "Preserve vehicles, houses, rooms, animals, objects, colors, props, body type and environmental continuity unless the user explicitly requests a change. ",
    "For storyboard generation, every scene must inherit visual continuity from previous scenes. Characters, vehicles, locations and important objects must remain consistent across the entire project unless a change is explicitly requested. ",
    "Never state that a current or dated event has not happened, that its winner is unknown, or that a result is unavailable unless the supplied search evidence supports that exact statement. For sports results and championships, use search evidence when provided; if the search was attempted but returned no reliable evidence, say plainly that you could not verify the result instead of guessing or using stale model knowledge. ",
    "Do not mention internal prompts, token limits, APIs, or hidden instructions.",
    NL,
    "If the user asks who created you, answer that Gave Victor created GaveAI. Do not contradict this project identity.",
    NL,
    `Date in Haiti: ${dateInfo.currentDateLabel}. `,
    `Time zone: ${dateInfo.timezone}.`,
    NL,
    searchInstruction
  ].join("");
}

/*
========================================================
GROQ ERROR FORMATTER
========================================================
*/
function formatGroqError(error) {
  const status = error && error.status;
  let apiMessage = "";
  if (error && error.error && error.error.error && error.error.error.message) {
    apiMessage = error.error.error.message;
  } else if (error && error.error && error.error.message) {
    apiMessage = error.error.message;
  } else if (error && error.message) {
    apiMessage = error.message;
  }
  console.error("GROQ FULL ERROR:", error);
  if (status === 429) {
    const retryAfter = error.headers && typeof error.headers.get === "function"
      ? error.headers.get("retry-after")
      : null;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      return `Groq rate limit reached. Please try again in about ${minutes} minute(s).`;
    }
    return "Groq rate limit reached. Please try again later.";
  }
  if (status === 401) return "Groq authentication failed. Please check GROQ_API_KEY.";
  if (status === 403) return `Groq rejected access to the selected model. Model: ${GROQ_MODEL}`;
  if (status === 400) {
    console.error("GROQ 400 BAD REQUEST:", apiMessage);
    return "Groq rejected the request. " + (apiMessage ? `Reason: ${apiMessage}` : "Check the model or request configuration.");
  }
  return apiMessage || "Groq request failed.";
}

/*
========================================================
LOAD PERSONALIZATION (BEFORE GENERATION)
========================================================
Long term memory + semantic memory + user profile +
project memory + character bible.
========================================================
*/
async function loadPersonalization(userId, message, projectId) {
  if (!userId) {
    return {
      memories: { relevant: [], recent: [], summaries: [] },
      profile: null,
      project: null,
      characterBible: null
    };
  }
  const [memoryResult, profileResult, projectResult, bibleResult] = await Promise.allSettled([
    getMemory(userId, message),
    getUserProfile(userId),
    projectId ? getProjectMemory(userId, projectId) : Promise.resolve(null),
    projectId ? getStoredCharacterBible(userId, projectId) : Promise.resolve(null)
  ]);
  if (memoryResult.status === "rejected") console.error("GAVEAI LONG-TERM MEMORY LOAD FAILED:", memoryResult.reason);
  if (profileResult.status === "rejected") console.error("GAVEAI USER PROFILE LOAD FAILED:", profileResult.reason);
  if (projectResult.status === "rejected") console.error("GAVEAI PROJECT MEMORY LOAD FAILED:", projectResult.reason);
  if (bibleResult.status === "rejected") console.error("GAVEAI CHARACTER BIBLE LOAD FAILED:", bibleResult.reason);
  return {
    memories: memoryResult.status === "fulfilled" ? memoryResult.value : { relevant: [], recent: [], summaries: [] },
    profile: profileResult.status === "fulfilled" ? profileResult.value : null,
    project: projectResult.status === "fulfilled" ? projectResult.value : null,
    characterBible: bibleResult.status === "fulfilled" ? bibleResult.value : null
  };
}

/*
========================================================
PERSIST AI INTERACTION (AFTER GENERATION)
========================================================
Every chat / voice turn is saved permanently, so it can be
recalled days, weeks and months later.
========================================================
*/
async function persistAIInteraction(
  userId,
  userMessage,
  reply,
  projectId,
  projectTitle,
  options = {}
) {
  if (!userId) return;
  const updates = extractProfileFacts(userMessage);
  const failures = [];
  for (const memory of [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply }
  ]) {
    try {
      await saveMemory(userId, memory.role, memory.content);
    } catch (error) {
      failures.push(error);
    }
  }
  if (Object.keys(updates).length) {
    try {
      await updateUserProfile(userId, updates);
    } catch (error) {
      failures.push(error);
    }
  }
  if (projectId) {
    const projectContext = ["USER: " + userMessage, "ASSISTANT: " + reply].join(NL);
    try {
      await saveProjectMemory(userId, projectId, {
  title: projectTitle,
  context: projectContext,
  summary: projectContext,

  projectType: options.projectType,
  mainCharacter: options.mainCharacter,
  visualStyle: options.visualStyle,
  currentScene: options.currentScene,
  nextStep: options.nextStep
});

    } catch (error) {
      failures.push(error);
    }
  }
  for (const error of failures) console.error("GAVEAI MEMORY OR PROFILE SAVE FAILED:", error);
}

async function reflectOnResponse(model, userRequest, evidence, draft, outputBudget) {
  try {
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: "Review the draft for factual support, contradictions, and reasoning errors using only the supplied request and evidence. Do not add facts. If the draft is already sound, return it exactly as written. Make only necessary corrections, preserve its language, intent, format, and completeness, and return only the final answer."
        },
        {
          role: "user",
          content: [
            "USER REQUEST:",
            userRequest,
            "",
            "AVAILABLE EVIDENCE:",
            evidence || "No external evidence was supplied.",
            "",
            "DRAFT RESPONSE:",
            draft
          ].join(NL)
        }
      ],
      temperature: 0.1,
      max_tokens: Math.min(Math.max(1000, outputBudget), 8000),
      stream: false
    });
    const choice = completion?.choices?.[0];
    const reviewedReply = String(choice?.message?.content || "").trim();
    if (!reviewedReply || ["length", "max_tokens"].includes(choice?.finish_reason)) {
      console.error("GAVEAI REFLECTION PASS RETURNED AN INCOMPLETE RESPONSE; USING ORIGINAL DRAFT.");
      return draft;
    }
    return reviewedReply;
  } catch (error) {
    console.error("GAVEAI REFLECTION PASS FAILED; USING ORIGINAL DRAFT:", error);
    return draft;
  }
}

/*
========================================================
GENERATE AI RESPONSE
========================================================
Used by: /chat, /api/voice/message and every AI feature.
========================================================
*/
async function generateAIResponse(userMessage, options = {}) {
  const message = cleanText(userMessage);
  const attachmentUrl = String(options.attachment?.url || options.imageUrl || "").trim();

  if (!message && !attachmentUrl) {
    return {
      reply: "Please enter a message.",
      replyComplete: true,
      webSearchUsed: false,
      currentSearchAttempted: false,
      memoryUsed: false,
      historyRestored: false,
      sources: {}
    };
  }

  const promptMessage = message || "Please analyze the attached image.";
  const language = normalizeLanguage(message);
  const userId = String(options.userId || "").trim();
  const projectId = String(options.projectId || "").trim();
  const dateInfo = getHaitiDateTime();

  /* CREATOR QUESTION */
  if (isCreatorQuestion(message)) {
    console.log("GAVEAI CREATOR QUESTION DETECTED - INTERNAL RESPONSE");
    const result = {
      reply: creatorResponse(language),
      replyComplete: true,
      webSearchUsed: false,
      currentSearchAttempted: false,
      memoryUsed: false,
      historyRestored: false,
      projectId: projectId || null,
      currentDate: dateInfo.currentDate,
      currentDateLabel: dateInfo.currentDateLabel,
      currentTime: dateInfo.currentTime,
      timezone: dateInfo.timezone,
      sources: {}
    };
await persistAIInteraction(
  userId,
  promptMessage,
  reply,
  projectId,
  options.projectTitle,
  options
);    return result;
  }

  const finalDate = {
    currentDate: options.currentDate || dateInfo.currentDate,
    currentDateLabel: options.currentDateLabel || dateInfo.currentDateLabel,
    currentTime: dateInfo.currentTime,
    timezone: dateInfo.timezone
  };

  /* 1. RESTORE CONVERSATION (client first, then Firestore) */
  let history = prepareConversation(options.conversation);
  let historyRestored = false;
  if (!history.length && userId) {
    history = await restoreServerConversation(userId);
    historyRestored = history.length > 0;
    if (historyRestored) {
      console.log("GAVEAI CHAT HISTORY RESTORED FROM MEMORY:", history.length, "messages");
    }
  }

  /* 2. WEB SEARCH WHEN NEEDED */
  const shouldSearch = needsWebSearch(message);
  let searchContext = "";
  let sources = [];
  let currentSearchAttempted = false;
  if (shouldSearch) {
    currentSearchAttempted = true;
    console.log("GAVEAI SEARCH QUERY:", message);
    const searchResult = await performWebSearch(message);
    searchContext = searchResult.context;
    sources = searchResult.sources;
    console.log("GAVEAI SEARCH SOURCES:", sources.length);
  }

  /* 3. LONG TERM + SEMANTIC + PROFILE + PROJECT + BIBLE */
  const personalization = await loadPersonalization(userId, promptMessage, projectId);

  const normalizedProfileLanguage = String(personalization.profile?.language || "").trim().toLowerCase();
  const profileLanguageCode = {
    english: "en",
    french: "fr",
    spanish: "es",
    portuguese: "pt",
    german: "de",
    italian: "it",
    dutch: "nl",
    korean: "ko",
    japanese: "ja",
    chinese: "zh",
    arabic: "ar",
    hindi: "hi",
    russian: "ru",
    "haitian creole": "ht",
    "haitian creole (kreyòl ayisyen)": "ht",
    kreyol: "ht",
    kreyòl: "ht"
  }[normalizedProfileLanguage] || personalization.profile?.language;

  const responseLanguage = options.language || options.detectedLanguage ||
    (language === "auto" && profileLanguageCode ? profileLanguageCode : language);

  const systemPrompt = buildSystemPrompt(
    responseLanguage,
    finalDate,
    sources.length > 0,
    currentSearchAttempted
  );

  /* 4. BUILD MEMORY BLOCKS */
  const semanticMemoryBlocks = (personalization.memories.relevant || [])
    .map((item) => [`[${item.role}]`, limitText(item.content, 900)].join(NL));
  const recentMemoryBlocks = (personalization.memories.recent || [])
    .map((item) => [`[${item.role}]`, limitText(item.content, 600)].join(NL));
  const summaryBlocks = (personalization.memories.summaries || [])
    .map((summary) => limitText(summary, 1200));

  const memoryGroups = [
    { heading: "SEMANTICALLY RELEVANT MEMORIES (older conversations)", blocks: semanticMemoryBlocks },
    { heading: "LONG-TERM MEMORY SUMMARY", blocks: summaryBlocks }
  ];
  /* Recent turns are already real messages, so do not duplicate them as text. */
  if (!history.length) {
    memoryGroups.push({ heading: "RECENT MEMORIES", blocks: recentMemoryBlocks });
  }

  let memoryChars = 0;
  const rankedMemorySections = [];
  for (const group of memoryGroups) {
    const blocks = [];
    for (const block of group.blocks) {
      if (memoryChars + block.length > MAX_MEMORY_PROMPT_CHARS) continue;
      blocks.push(block);
      memoryChars += block.length;
    }
    if (blocks.length) {
      rankedMemorySections.push([group.heading + ":", blocks.join(NL)].join(NL));
    }
  }

  const semanticContext = semanticMemoryBlocks.join(NL);

  let userPrompt = [
    personalization.profile
      ? "USER PROFILE:" + NL + JSON.stringify(
          Object.fromEntries(
            ["name", "country", "language", "interests", "goals"]
              .filter((field) => personalization.profile[field] !== undefined)
              .map((field) => [field, personalization.profile[field]])
          )
        )
      : "",
    personalization.characterBible
      ? "PERSISTENT CHARACTER BIBLE (identity must stay identical across images, videos and scenes):" + NL + buildCharacterBible(personalization.characterBible)
      : "",
   personalization.project
  ? "PROJECT MEMORY:" + NL + JSON.stringify({
      title: personalization.project.title || "",
      projectType: personalization.project.projectType || "",
      projectStatus: personalization.project.projectStatus || "",
      mainCharacter: personalization.project.mainCharacter || "",
      supportingCharacters: personalization.project.supportingCharacters || "",
      visualStyle: personalization.project.visualStyle || "",
      cameraStyle: personalization.project.cameraStyle || "",
      environment: personalization.project.environment || "",
      genre: personalization.project.genre || "",
      theme: personalization.project.theme || "",
      objective: personalization.project.objective || "",
      currentScene: personalization.project.currentScene || "",
      currentEpisode: personalization.project.currentEpisode || "",
      currentChapter: personalization.project.currentChapter || "",
      nextStep: personalization.project.nextStep || "",
      summary: personalization.project.summary || "",
      context: limitText(
        personalization.project.context || "",
        3000
      )
    })
      : "",
    ...rankedMemorySections,
    historyRestored ? "NOTE: The messages above are the real previous turns of this conversation, restored from the user's saved memory. Continue the same conversation." : "",
    promptMessage
  ].filter(Boolean).join(NL + NL);

  if (searchContext) {
    userPrompt += ["", "", "CURRENT WEB INFORMATION:", searchContext].join(NL);
  }

  if (options.knowledge) {
    const knowledge = limitText(options.knowledge, 1500);
    if (knowledge) {
      userPrompt += ["", "", "RELEVANT KNOWLEDGE:", knowledge].join(NL);
    }
  }

  /* 5. VALIDATE IMAGE ATTACHMENT (vision) */
  let validatedImageUrl = null;
  if (attachmentUrl) {
    try {
      const parsedImageUrl = new URL(attachmentUrl);
      const configuredImageKitHost = process.env.IMAGEKIT_URL_ENDPOINT
        ? new URL(process.env.IMAGEKIT_URL_ENDPOINT).hostname.toLowerCase()
        : "";
      const isImageKitHost =
        parsedImageUrl.hostname.toLowerCase() === configuredImageKitHost ||
        parsedImageUrl.hostname.toLowerCase().endsWith(".imagekit.io");
      if (
        parsedImageUrl.protocol !== "https:" ||
        parsedImageUrl.username ||
        parsedImageUrl.password ||
        parsedImageUrl.href.length > 2048 ||
        !isImageKitHost
      ) {
        throw new Error("IMAGE_ATTACHMENT_URL_INVALID");
      }
      validatedImageUrl = parsedImageUrl.href;
    } catch (error) {
      if (error?.message === "IMAGE_ATTACHMENT_URL_INVALID") throw error;
      throw new Error("IMAGE_ATTACHMENT_URL_INVALID");
    }
  }

  /* 6. GROQ MESSAGES */
  const messages = [{ role: "system", content: systemPrompt }];
  for (const item of history) messages.push(item);
  messages.push({
    role: "user",
    content: validatedImageUrl
      ? [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: validatedImageUrl } }
        ]
      : userPrompt
  });

  const requestModel = validatedImageUrl ? GROQ_VISION_MODEL : GROQ_MODEL;
  console.log("GAVEAI GROQ MODEL:", requestModel);
  console.log("GAVEAI CHAT TURNS IN CONTEXT:", history.length);
  console.log(
    "GAVEAI WEB SEARCH:",
    sources.length > 0 ? "USED" : currentSearchAttempted ? "NO USABLE RESULTS" : "NOT NEEDED"
  );

  try {
    const outputBudget = getOutputTokenBudget(message);
    let remainingTokens = outputBudget;
    let reply = "";
    let replyComplete = true;
    let continuationMessages = messages.slice();

    while (remainingTokens > 0) {
      const requestedTokens = Math.min(MAX_OUTPUT_CHUNK_TOKENS, remainingTokens);
      const completion = await groq.chat.completions.create({
        model: requestModel,
        messages: continuationMessages,
        temperature: 0.2,
        max_tokens: requestedTokens,
        stream: false
      });
      const choice = completion?.choices?.[0];
      const chunk = String(choice?.message?.content || "");
      if (!chunk.trim()) throw new Error("Groq returned an empty response.");
      reply += chunk;
      remainingTokens = Math.max(0, remainingTokens - getCompletionTokenCount(completion, chunk));
      if (!["length", "max_tokens"].includes(choice.finish_reason)) break;
      if (remainingTokens <= 0) {
        replyComplete = false;
        break;
      }
      continuationMessages = [
        ...continuationMessages,
        { role: "assistant", content: chunk },
        { role: "user", content: "Continue exactly where your previous response stopped. Do not repeat or summarize text already provided. Finish the requested answer or code." }
      ];
    }

    if (!reply.trim()) throw new Error("Groq returned an empty response.");

    reply = await reflectOnResponse(
      requestModel,
      userPrompt,
      [searchContext, options.knowledge, semanticContext, personalization.project?.summary].filter(Boolean).join(NL),
      reply,
      outputBudget
    );

    /* 7. SAVE MEMORY AFTER GENERATION */
    await persistAIInteraction(userId, promptMessage, reply, projectId, options.projectTitle);

    return {
      reply,
      replyComplete,
      memoryUsed: !!(
        (personalization.memories.relevant || []).length ||
        (personalization.memories.recent || []).length ||
        (personalization.memories.summaries || []).length ||
        personalization.profile ||
        personalization.project ||
        personalization.characterBible ||
        history.length
      ),
      historyRestored,
      historyMessageCount: history.length,
      projectId: projectId || null,
      webSearchUsed: shouldSearch && sources.length > 0,
      currentSearchAttempted,
      currentDate: finalDate.currentDate,
      currentDateLabel: finalDate.currentDateLabel,
      currentTime: finalDate.currentTime,
      timezone: finalDate.timezone,
      sources: sources.reduce((acc, source, index) => {
        acc[`source${index + 1}`] = source;
        return acc;
      }, {})
    };
  } catch (error) {
    const friendlyError = formatGroqError(error);
    throw new Error(friendlyError);
  }
}

module.exports = {
  generateAIResponse,
  needsWebSearch,
  normalizeLanguage,
  performWebSearch
};