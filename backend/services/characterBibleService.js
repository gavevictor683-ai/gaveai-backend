const crypto = require("crypto");

/*
========================================================
GAVEAI CHARACTER BIBLE
========================================================
Persistent character identity across every image, video
and storyboard scene of a project.
ZERO backslash-n escapes in this file.
========================================================
*/

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

const CHARACTER_BIBLE_FIELDS = [
  "mainCharacter",
  "supportingCharacters",

  /* Identity */
  "age",
  "gender",

  /* Face */
  "faceDescription",
  "hairStyle",
  "hairColor",
  "eyeColor",
  "eyebrowStyle",
  "noseShape",
  "lipDescription",

  /* Body */
  "appearance",
  "bodyType",
  "height",
  "skinDetails",

  /* Clothing */
  "clothing",
  "accessories",

  /* Personality */
  "personality",
  "voiceStyle",
  "speakingStyle",

  /* Visual Direction */
  "visualStyle",
  "cameraStyle",
  "environment",
  "audioDirection"
];

/*
Media fields keep the SAME face / look across generations.
They are stored but never printed as prompt text.
*/
const CHARACTER_BIBLE_MEDIA_FIELDS = [
  "referenceImageUrl",
  "lastImageUrl",
  "lastVideoUrl"
];

const ALL_CHARACTER_BIBLE_FIELDS = [
  ...CHARACTER_BIBLE_FIELDS,
  ...CHARACTER_BIBLE_MEDIA_FIELDS
];

function getFirebaseAdmin() {
  return require("../firebaseAdmin");
}

function displayValue(value) {
  if (Array.isArray(value)) {
    return value.map(displayValue).filter(Boolean).join(NL);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value || "").trim();
}

function characterBibleDocumentId(userId, projectId) {
  return crypto
    .createHash("sha256")
    .update(String(userId) + NUL + String(projectId))
    .digest("hex");
}

function buildCharacterBible(bible = {}) {
  if (typeof bible === "string") return bible.trim();

  const labels = {
  mainCharacter: "MAIN CHARACTER",
  supportingCharacters: "SUPPORTING CHARACTERS",

  age: "AGE",
  gender: "GENDER",

  faceDescription: "FACE DESCRIPTION",
  hairStyle: "HAIR STYLE",
  hairColor: "HAIR COLOR",
  eyeColor: "EYE COLOR",
  eyebrowStyle: "EYEBROW STYLE",
  noseShape: "NOSE SHAPE",
  lipDescription: "LIP DESCRIPTION",

  appearance: "APPEARANCE",
  bodyType: "BODY TYPE",
  height: "HEIGHT",
  skinDetails: "SKIN DETAILS",

  clothing: "CLOTHING",
  accessories: "ACCESSORIES",

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
      const raw = bible[field] || (field === "audioDirection" ? bible.globalAudioDirection : "");
      const value = displayValue(raw);
      return value ? labels[field] + ":" + NL + value : "";
    })
    .filter(Boolean)
    .join(NL);
}

function mergeCharacterBible(stored = {}, incoming = {}) {
  const bible = {};
  for (const field of ALL_CHARACTER_BIBLE_FIELDS) {
    const newValue = incoming[field];
    bible[field] =
      newValue !== undefined && newValue !== null && displayValue(newValue)
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
  for (const field of ALL_CHARACTER_BIBLE_FIELDS) {
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
  CHARACTER_BIBLE_FIELDS,
  CHARACTER_BIBLE_MEDIA_FIELDS,
  buildCharacterBible,
  mergeCharacterBible,
  getStoredCharacterBible,
  saveCharacterBible
};