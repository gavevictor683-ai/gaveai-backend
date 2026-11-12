const crypto = require("crypto");

const CHARACTER_BIBLE_FIELDS = [
  "mainCharacter",
  "supportingCharacters",
  "age",
  "gender",
  "appearance",
  "clothing",
  "personality",
  "voiceStyle",
  "speakingStyle",
  "visualStyle",
  "cameraStyle",
  "environment",
  "audioDirection"
];

function getFirebaseAdmin() {
  return require("../firebaseAdmin");
}

function displayValue(value) {
  if (Array.isArray(value)) {
    return value.map(displayValue).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value || "").trim();
}

function characterBibleDocumentId(userId, projectId) {
  return crypto.createHash("sha256")
    .update(`${String(userId)}\0${String(projectId)}`)
    .digest("hex");
}

function buildCharacterBible(bible = {}) {
  if (typeof bible === "string") return bible.trim();
  const labels = {
    mainCharacter: "MAIN CHARACTER",
    supportingCharacters: "SUPPORTING CHARACTERS",
    age: "AGE",
    gender: "GENDER",
    appearance: "APPEARANCE",
    clothing: "CLOTHING",
    personality: "PERSONALITY",
    voiceStyle: "VOICE STYLE",
    speakingStyle: "SPEAKING STYLE",
    visualStyle: "VISUAL STYLE",
    cameraStyle: "CAMERA STYLE",
    environment: "ENVIRONMENT",
    audioDirection: "AUDIO DIRECTION"
  };

  return CHARACTER_BIBLE_FIELDS
    .map((field) => {
      const value = displayValue(bible[field] || (field === "audioDirection" ? bible.globalAudioDirection : ""));
      return value ? `${labels[field]}:\n${value}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function mergeCharacterBible(stored = {}, incoming = {}) {
  const bible = {};
  for (const field of CHARACTER_BIBLE_FIELDS) {
    const newValue = incoming[field];
    bible[field] = newValue !== undefined && newValue !== null && displayValue(newValue)
      ? newValue
      : stored[field] || "";
  }
  return bible;
}

async function getStoredCharacterBible(userId, projectId) {
  if (!userId || !projectId) return null;
  const { db } = getFirebaseAdmin();
  const documentId = characterBibleDocumentId(userId, projectId);
  const snapshot = await db.collection("characterBible").doc(documentId).get();
  return snapshot.exists ? snapshot.data() || null : null;
}

async function saveCharacterBible(bible = {}) {
  const userId = String(bible.userId || "").trim();
  const projectId = String(bible.projectId || "").trim();
  if (!userId || !projectId) throw new Error("CHARACTER_BIBLE_ID_REQUIRED");

  const values = {};
  for (const field of CHARACTER_BIBLE_FIELDS) {
    values[field] = bible[field] || "";
  }

  const { db, admin } = getFirebaseAdmin();
  const documentId = characterBibleDocumentId(userId, projectId);
  const savedBible = {
    userId,
    projectId,
    ...values,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await db.collection("characterBible").doc(documentId).set(savedBible, { merge: true });
  return savedBible;
}

module.exports = {
  buildCharacterBible,
  mergeCharacterBible,
  getStoredCharacterBible,
  saveCharacterBible
};
