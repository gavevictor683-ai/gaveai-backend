const crypto = require("crypto");

function getFirebaseAdmin() {
  return require("../firebaseAdmin");
}

function getEmbeddingService() {
  return require("./embeddingService");
}

function projectDocumentId(userId, projectId) {
  return crypto.createHash("sha256")
    .update(`${String(userId)}\0${String(projectId)}`)
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
  const snapshot = await db.collection("projectMemory")
    .doc(projectDocumentId(normalizedUserId, normalizedProjectId))
    .get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  return { ...data, userId: normalizedUserId, projectId: normalizedProjectId };
}

async function saveProjectMemory(userId, projectId, updates = {}) {
  const normalizedUserId = boundedText(userId, 256);
  const normalizedProjectId = boundedText(projectId, 256);
  if (!normalizedUserId || !normalizedProjectId) throw new Error("PROJECT_MEMORY_ID_REQUIRED");

  const existing = await getProjectMemory(normalizedUserId, normalizedProjectId);
  const title = boundedText(updates.title || existing?.title, 200);
  const context = [
    existing?.context || "",
    updates.context || updates.summary || ""
  ].filter(Boolean).join("\n\n").slice(-12000);
  const incomingSummary = boundedText(updates.summary, 1600);
  const summary = incomingSummary
    ? await getEmbeddingService().summarizeProject(existing?.summary || "", title, context)
    : boundedText(existing?.summary, 1600);
  const { db, admin } = getFirebaseAdmin();
  const reference = db.collection("projectMemory")
    .doc(projectDocumentId(normalizedUserId, normalizedProjectId));
  const record = {
    userId: normalizedUserId,
    projectId: normalizedProjectId,
    title,
    summary: summary || incomingSummary,
    context,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(!existing ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {})
  };
  await reference.set(record, { merge: true });
  return { ...record, projectId: normalizedProjectId };
}

module.exports = {
  getProjectMemory,
  saveProjectMemory
};
