/*
========================================================
GAVEAI GLOBAL LONG TERM MEMORY
========================================================
* Memory is GLOBAL (chat, voice, image, video, storyboard)
* Semantic search runs across the ENTIRE history, not
  only the last 20 messages -> days / weeks / months
* Long-term summaries preserve older context
* getConversationHistory restores chat after refresh
* ZERO backslash-n escapes in this file
========================================================
*/

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

const MEMORY_LIMIT = 1000;
const RECENT_MEMORY_LIMIT = 20;
const SEMANTIC_MEMORY_LIMIT = 20;
const SUMMARY_LIMIT = 10;
const SEMANTIC_MIN_SCORE = 0.22;

function getFirebaseAdmin() {
  return require("../firebaseAdmin");
}

function getEmbeddingService() {
  return require("./embeddingService");
}

function cleanString(value, maxLength = 1000) {
  return String(value || "").trim().slice(0, maxLength);
}

function firstLine(value) {
  return String(value || "").split(NL)[0].split(CR)[0].trim();
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (Number.isFinite(value.seconds)) return value.seconds * 1000;
  if (Number.isFinite(value._seconds)) {
    return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return Number.isFinite(value) ? value : 0;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) {
    return -1;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return -1;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return leftMagnitude && rightMagnitude
    ? dot / Math.sqrt(leftMagnitude * rightMagnitude)
    : -1;
}

function sortByCreatedAt(documents) {
  return documents.sort(
    (left, right) => timestampValue(left.data()?.createdAt) - timestampValue(right.data()?.createdAt)
  );
}

function adminTimestamp() {
  return getFirebaseAdmin().admin.firestore.FieldValue.serverTimestamp();
}

/*
========================================================
SAVE MEMORY (AFTER GENERATION)
========================================================
*/
async function saveMemory(userId, role, content) {
  const normalizedUserId = cleanString(userId, 256);
  const normalizedRole = role === "assistant" ? "assistant" : role === "user" ? "user" : "";
  const normalizedContent = cleanString(content, 12000);
  if (!normalizedUserId || !normalizedRole || !normalizedContent) return;

  const { db, admin } = getFirebaseAdmin();
  const embeddingService = getEmbeddingService();

  let embedding = null;
  try {
    embedding = await embeddingService.createEmbedding(normalizedContent, "RETRIEVAL_DOCUMENT");
  } catch (error) {
    console.error("GAVEAI MEMORY EMBEDDING FAILED; SAVING MEMORY WITHOUT VECTOR:", error.message);
  }

  const memoryRef = db.collection("aiMemory").doc();
  const indexRef = db.collection("aiMemoryIndex").doc(normalizedUserId);

  await db.runTransaction(async (transaction) => {
    const indexSnapshot = await transaction.get(indexRef);
    const indexData = indexSnapshot.exists ? indexSnapshot.data() || {} : {};
    const previousIds = Array.isArray(indexData.memoryIds) ? indexData.memoryIds : [];
    const memoryIds = [
      ...previousIds.filter((id) => typeof id === "string" && id !== memoryRef.id),
      memoryRef.id
    ].slice(-MEMORY_LIMIT);

    transaction.set(memoryRef, {
      userId: normalizedUserId,
      role: normalizedRole,
      content: normalizedContent,
      ...(embedding
        ? {
            embedding,
            embeddingModel: embedding.embeddingModel || embeddingService.EMBEDDING_MODEL
          }
        : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.set(indexRef, {
      userId: normalizedUserId,
      memoryIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  await summarizeOldMemories(normalizedUserId);
}

async function summarizeOldMemories(userId) {
  const { db } = getFirebaseAdmin();
  const memoriesSnapshot = await db.collection("aiMemory").where("userId", "==", userId).get();
  const memories = sortByCreatedAt(memoriesSnapshot.docs);
  if (memories.length <= MEMORY_LIMIT) return;

  const summariesSnapshot = await db.collection("aiMemorySummaries").where("userId", "==", userId).get();
  const summarizedIds = new Set(
    summariesSnapshot.docs.flatMap((document) =>
      Array.isArray(document.data()?.memoryIds) ? document.data().memoryIds : []
    )
  );

  const olderMemories = memories
    .slice(0, -MEMORY_LIMIT)
    .filter((document) => !summarizedIds.has(document.id))
    .slice(0, 10)
    .map((document) => ({ id: document.id, ...(document.data() || {}) }));

  if (!olderMemories.length) return;

  const previousSummary = summariesSnapshot.docs
    .map((document) => document.data() || {})
    .sort((left, right) =>
      timestampValue(right.updatedAt || right.createdAt) -
      timestampValue(left.updatedAt || left.createdAt)
    )[0]?.summary || "";

  const summary = await getEmbeddingService().summarizeMemories(previousSummary, olderMemories);

  const summaryId = require("crypto")
    .createHash("sha256")
    .update(olderMemories.map((memory) => memory.id).sort().join(NUL))
    .digest("hex");

  await db.collection("aiMemorySummaries").doc(summaryId).set({
    userId,
    summary,
    memoryIds: olderMemories.map((memory) => memory.id),
    createdAt: adminTimestamp(),
    updatedAt: adminTimestamp()
  }, { merge: true });
}

/*
========================================================
GET MEMORY (BEFORE GENERATION)
========================================================
Semantic search covers the WHOLE account history.
========================================================
*/
async function getMemory(userId, query = "") {
  const normalizedUserId = cleanString(userId, 256);
  if (!normalizedUserId) return { relevant: [], recent: [], summaries: [] };

  const { db } = getFirebaseAdmin();
  const embeddingService = getEmbeddingService();

  const [snapshot, summariesSnapshot] = await Promise.all([
    db.collection("aiMemory").where("userId", "==", normalizedUserId).get(),
    db.collection("aiMemorySummaries").where("userId", "==", normalizedUserId).get()
  ]);

  const documents = sortByCreatedAt(snapshot.docs);
  const recentDocuments = documents.slice(-RECENT_MEMORY_LIMIT);

  const summaries = summariesSnapshot.docs
    .sort((left, right) =>
      timestampValue(right.data()?.updatedAt || right.data()?.createdAt) -
      timestampValue(left.data()?.updatedAt || left.data()?.createdAt)
    )
    .map((document) => document.data()?.summary)
    .filter((summary) => typeof summary === "string" && summary.trim())
    .slice(0, SUMMARY_LIMIT);

  let queryEmbedding = null;
  if (String(query || "").trim()) {
    try {
      queryEmbedding = await embeddingService.createEmbedding(query, "RETRIEVAL_QUERY");
    } catch (error) {
      console.error("GAVEAI SEMANTIC MEMORY SEARCH FAILED; USING RECENT MEMORIES:", error.message);
    }
  }

  const queryModel = queryEmbedding?.embeddingModel || embeddingService.EMBEDDING_MODEL;
  const recentIds = new Set(recentDocuments.map((document) => document.id));

  const relevant = queryEmbedding
    ? documents
        .filter((document) => {
          const data = document.data() || {};
          if (!Array.isArray(data.embedding)) return false;
          if (recentIds.has(document.id)) return false;
          return (data.embeddingModel || embeddingService.EMBEDDING_MODEL) === queryModel;
        })
        .map((document) => ({
          document,
          score: cosineSimilarity(document.data()?.embedding, queryEmbedding)
        }))
        .filter((item) => item.score >= SEMANTIC_MIN_SCORE)
        .sort((left, right) =>
          right.score - left.score ||
          timestampValue(right.document.data()?.createdAt) -
          timestampValue(left.document.data()?.createdAt)
        )
        .slice(0, SEMANTIC_MEMORY_LIMIT)
        .map((item) => {
          const data = item.document.data() || {};
          return {
            id: item.document.id,
            role: data.role === "assistant" ? "assistant" : data.role === "user" ? "user" : "",
            content: cleanString(data.content, 12000),
            createdAt: data.createdAt || null,
            relevance: item.score
          };
        })
        .filter((memory) => memory.role && memory.content)
    : [];

  const recent = recentDocuments
    .map((document) => {
      const data = document.data() || {};
      return {
        id: document.id,
        role: data.role === "assistant" ? "assistant" : data.role === "user" ? "user" : "",
        content: cleanString(data.content, 12000),
        createdAt: data.createdAt || null
      };
    })
    .filter((memory) => memory.role && memory.content);

  return { relevant, recent, summaries };
}

/*
========================================================
CONVERSATION HISTORY (RESTORE AFTER REFRESH)
========================================================
Used by GET /api/ai/history
========================================================
*/
async function getConversationHistory(userId, limit = 40) {
  const normalizedUserId = cleanString(userId, 256);
  if (!normalizedUserId) return [];

  const { db } = getFirebaseAdmin();
  const snapshot = await db.collection("aiMemory").where("userId", "==", normalizedUserId).get();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40));

  return sortByCreatedAt(snapshot.docs)
    .slice(-safeLimit)
    .map((document) => {
      const data = document.data() || {};
      const created = timestampValue(data.createdAt);
      return {
        id: document.id,
        role: data.role === "assistant" ? "assistant" : "user",
        content: cleanString(data.content, 12000),
        createdAt: created ? new Date(created).toISOString() : null
      };
    })
    .filter((message) => message.content);
}

async function getUserProfile(userId) {
  const normalizedUserId = cleanString(userId, 256);
  if (!normalizedUserId) return null;
  const { db } = getFirebaseAdmin();
  const snapshot = await db.collection("userProfiles").doc(normalizedUserId).get();
  return snapshot.exists ? { userId: normalizedUserId, ...snapshot.data() } : null;
}

async function updateUserProfile(userId, updates = {}) {
  const normalizedUserId = cleanString(userId, 256);
  if (!normalizedUserId) return null;

  const { db, admin } = getFirebaseAdmin();
  const profileUpdates = {};

  for (const field of ["name", "country", "language"]) {
    const value = cleanString(updates[field], 120);
    if (value) profileUpdates[field] = value;
  }

  for (const field of ["interests", "goals"]) {
    const values = Array.isArray(updates[field]) ? updates[field] : [];
    const uniqueValues = Array.from(
      new Set(values.map((value) => cleanString(value, 200)).filter(Boolean))
    );
    if (uniqueValues.length) {
      profileUpdates[field] = admin.firestore.FieldValue.arrayUnion(...uniqueValues);
    }
  }

  if (!Object.keys(profileUpdates).length) return getUserProfile(normalizedUserId);

  await db.collection("userProfiles").doc(normalizedUserId).set({
    userId: normalizedUserId,
    ...profileUpdates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return getUserProfile(normalizedUserId);
}

/*
========================================================
PROFILE FACT EXTRACTION
========================================================
No newline characters inside regex literals.
Multi-line captures are trimmed with firstLine().
========================================================
*/
function extractProfileFacts(message) {
  const text = String(message || "").trim();
  if (!text) return {};

  const updates = {};
  const patterns = {
    name: /(?:\bmy name is\b|\bcall me\b|\bmy name's\b|\bnon mwen se\b|\bmwen rele\b|\bje m'appelle\b|\bme llamo\b|\bmi nombre es\b)\s+([\p{L}][\p{L}'’-]{0,48})/iu,
    country: /(?:\bi live in\b|\bi'm from\b|\bi am from\b|\bi come from\b|\bmwen rete nan\b|\bmwen ap viv nan\b|\bmwen soti nan\b|\bj'habite en\b|\bje vis en\b|\bje viens de\b|\bvivo en\b|\bsoy de\b)\s+([^.!?;]{2,200})/iu,
    language: /(?:\bi prefer(?: to speak)?\b|\bi speak\b|\bmy preferred language is\b|\blang mwen pi renmen se\b|\bmwen pale\b)\s+([\p{L}][\p{L} -]{0,48})/iu,
    interest: /(?:\bi like\b|\bi love\b|\bi enjoy\b|\bi'm interested in\b|\bi am interested in\b|\bmy interests include\b|\bmwen renmen\b|\bmwen enterese nan\b|\bj'aime\b|\bme interesa\b)\s+([^.!?;]{2,200})/iu,
    goal: /(?:\bmy goal is(?: to)?\b|\bmy goals are\b|\bi want to\b|\bi plan to\b|\bi hope to\b|\bobjectifs? (?:mwen|me) (?:se|yo se)\b|\bmon objectif est de\b)\s+([^.!?;]{2,200})/iu
  };

  const name = text.match(patterns.name)?.[1];
  if (name) updates.name = cleanString(firstLine(name), 120);

  const country = text.match(patterns.country)?.[1];
  if (country) {
    const countryName = firstLine(country)
      .split(",")
      .pop()
      .trim()
      .replace(/\s+(?:with|and|but|because|so)\b.*$/i, "");
    if (countryName) updates.country = cleanString(countryName, 120);
  }

  const language = text.match(patterns.language)?.[1];
  if (language) {
    updates.language = cleanString(firstLine(language), 120).replace(/[.!?].*$/, "");
  }

  const interest = text.match(patterns.interest)?.[1];
  if (interest) updates.interests = [cleanString(firstLine(interest), 200)];

  const goal = text.match(patterns.goal)?.[1];
  if (goal) updates.goals = [cleanString(firstLine(goal), 200)];

  return updates;
}

module.exports = {
  saveMemory,
  getMemory,
  getConversationHistory,
  getUserProfile,
  updateUserProfile,
  extractProfileFacts
};