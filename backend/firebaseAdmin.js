require("dotenv").config();

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
let privateKey = process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKey) {
  throw new Error(
    "Missing Firebase environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY"
  );
}

/*
========================================================
CLEAN FIREBASE PRIVATE KEY
========================================================
*/

privateKey = privateKey.trim();

// Remove surrounding quotes if present
if (
  (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
  (privateKey.startsWith("'") && privateKey.endsWith("'"))
) {
  privateKey = privateKey.slice(1, -1).trim();
}

// Remove accidental trailing comma
privateKey = privateKey.replace(/,\s*$/, "").trim();

// Convert literal \n into real newlines if necessary
privateKey = privateKey.replace(/\\n/g, "\n");

// Remove quotes/comma that may remain after the private key
privateKey = privateKey
  .replace(/^["']+/, "")
  .replace(/["']+,?\s*$/, "")
  .trim();

// Validate Firebase private key format
if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
  throw new Error(
    "FIREBASE_PRIVATE_KEY does not contain a valid private key header"
  );
}

if (!privateKey.includes("-----END PRIVATE KEY-----")) {
  throw new Error(
    "FIREBASE_PRIVATE_KEY does not contain a valid private key footer"
  );
}

/*
========================================================
INITIALIZE FIREBASE ADMIN
========================================================
*/

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey
    })
  });
}

/*
========================================================
FIRESTORE
========================================================
*/

const db = getFirestore();

module.exports = { db };

