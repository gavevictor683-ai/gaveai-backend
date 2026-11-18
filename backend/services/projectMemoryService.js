const crypto = require("crypto");

/*
========================================================
GAVEAI PROJECT MEMORY
========================================================
Per-project long term memory (chat, images, videos,
storyboards). ZERO backslash-n escapes in this file.
========================================================
*/

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

function getFirebaseAdmin() {
  return require("../firebaseAdmin");
}

function getEmbeddingService() {
  return require("./embeddingService");
}

function projectDocumentId(userId, projectId) {
  return crypto
    .createHash("sha256")
    .update(String(userId) + NUL + String(projectId))
    .digest("hex");
}

function boundedText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

async function getProjectMemory(userId, projectId) {
  const normalizedUserId = boundedText(userId, 256);
  const normalizedProjectId = boundedText(projectId, 256);
  if (!normalizedUserId || !normalizedProjectId) return null;

  const { db } = getFirebaseAdmin();
  const snapshot = await db
    .collection("projectMemory")
    .doc(projectDocumentId(normalizedUserId, normalizedProjectId))
    .get();

  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  return { ...data, userId: normalizedUserId, projectId: normalizedProjectId };
}

async function saveProjectMemory(userId, projectId, updates = {}) {
  const normalizedUserId = boundedText(userId, 256);
  const normalizedProjectId = boundedText(projectId, 256);
  if (!normalizedUserId || !normalizedProjectId) {
    throw new Error("PROJECT_MEMORY_ID_REQUIRED");
  }

  const existing = await getProjectMemory(normalizedUserId, normalizedProjectId);
  const title = boundedText(updates.title || existing?.title, 200);

  const context = [
    existing?.context || "",
    updates.context || updates.summary || ""
  ]
    .filter(Boolean)
    .join(NL)
    .slice(-50000);

  const incomingSummary = boundedText(updates.summary, 1600);
  const summary = incomingSummary
    ? await getEmbeddingService().summarizeProject(existing?.summary || "", title, context)
    : boundedText(existing?.summary, 1600);

  const { db, admin } = getFirebaseAdmin();
  const reference = db
    .collection("projectMemory")
    .doc(projectDocumentId(normalizedUserId, normalizedProjectId));

  const record = {
  userId: normalizedUserId,
  projectId: normalizedProjectId,

  /* Core */
  title,

  projectType:
    updates.projectType ||
    existing?.projectType ||
    "",

  projectStatus:
    updates.projectStatus ||
    existing?.projectStatus ||
    "active",

  /* Characters */
  mainCharacter:
    updates.mainCharacter ||
    existing?.mainCharacter ||
    "",

  supportingCharacters:
    updates.supportingCharacters ||
    existing?.supportingCharacters ||
    "",

  characterBibleId:
    updates.characterBibleId ||
    existing?.characterBibleId ||
    "",

  /* Visual Continuity */
  visualStyle:
    updates.visualStyle ||
    existing?.visualStyle ||
    "",

  cameraStyle:
    updates.cameraStyle ||
    existing?.cameraStyle ||
    "",

  environment:
    updates.environment ||
    existing?.environment ||
    "",

  audioDirection:
    updates.audioDirection ||
    existing?.audioDirection ||
    "",

  /* Story */
  genre:
    updates.genre ||
    existing?.genre ||
    "",

  theme:
    updates.theme ||
    existing?.theme ||
    "",

  objective:
    updates.objective ||
    existing?.objective ||
    "",

  /* Progress Tracking */
  currentScene:
    updates.currentScene ||
    existing?.currentScene ||
    "",

  currentEpisode:
    updates.currentEpisode ||
    existing?.currentEpisode ||
    "",

  currentChapter:
    updates.currentChapter ||
    existing?.currentChapter ||
    "",

  nextStep:
    updates.nextStep ||
    existing?.nextStep ||
    "",

  /* Memory */
  summary:
    summary || incomingSummary,

  context,

  /* Media */
  lastImageUrl:
    updates.lastImageUrl ||
    existing?.lastImageUrl ||
    "",

  lastVideoUrl:
    updates.lastVideoUrl ||
    existing?.lastVideoUrl ||
    "",

  referenceImageUrl:
    updates.referenceImageUrl ||
    existing?.referenceImageUrl ||
    "",

  /* Analytics */
  version:
    Number(existing?.version || 0) + 1,

  lastInteractionAt:
    admin.firestore.FieldValue.serverTimestamp(),

  updatedAt:
    admin.firestore.FieldValue.serverTimestamp(),

  ...(!existing
    ? {
        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      }
    : {})
};


  await reference.set(record, { merge: true });
  return { ...record, projectId: normalizedProjectId };
}

module.exports = {
  getProjectMemory,
  saveProjectMemory
};
