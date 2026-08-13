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
  Clean Firebase private key coming from Render/.env.

  Handles:
  - surrounding quotes
  - trailing comma
  - escaped \\n
  - actual newlines
*/
privateKey = privateKey.trim();

if (privateKey.startsWith('"') && privateKey.endsWith('",')) {
  privateKey = privateKey.slice(1, -2);
} else if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
  privateKey = privateKey.slice(1, -1);
} else if (privateKey.startsWith("'") && privateKey.endsWith("',")) {
  privateKey = privateKey.slice(1, -2);
} else if (privateKey.startsWith("'") && privateKey.endsWith("'")) {
  privateKey = privateKey.slice(1, -1);
}

privateKey = privateKey.replace(/\\n/g, "\n");

privateKey = privateKey.trim();

if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
  throw new Error("FIREBASE_PRIVATE_KEY does not contain a valid private key header");
}

if (!privateKey.includes("-----END PRIVATE KEY-----")) {
  throw new Error("FIREBASE_PRIVATE_KEY does not contain a valid private key footer");
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey
    })
  });
}

const db = getFirestore();

module.exports = {
  db
};