const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (getApps().length === 0) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY
      .replace(/^"/, "")
      .replace(/",$/, "")
      .replace(/\\n/g, "\n")
  : undefined;

  if (!process.env.FIREBASE_PROJECT_ID) {
    throw new Error("FIREBASE_PROJECT_ID is missing");
  }

  if (!process.env.FIREBASE_CLIENT_EMAIL) {
    throw new Error("FIREBASE_CLIENT_EMAIL is missing");
  }

  if (!privateKey) {
    throw new Error("FIREBASE_PRIVATE_KEY is missing");
  }

  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey
    })
  });
}

const db = getFirestore();

module.exports = {
  db
};