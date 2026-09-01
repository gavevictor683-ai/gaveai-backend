require("dotenv").config();

const {
  initializeApp,
  cert,
  getApps,
  getApp
} = require("firebase-admin/app");

const {
  getFirestore
} = require("firebase-admin/firestore");

const {
  getAuth
} = require("firebase-admin/auth");

/*
========================================================
FIREBASE ENVIRONMENT VARIABLES
========================================================
*/

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

privateKey = String(privateKey).trim();

/*
--------------------------------------------------------
Remove surrounding quotes if present
--------------------------------------------------------
*/

if (
  (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
  (privateKey.startsWith("'") && privateKey.endsWith("'"))
) {
  privateKey = privateKey.slice(1, -1).trim();
}

/*
--------------------------------------------------------
Convert literal \\n into real newlines
--------------------------------------------------------
*/

privateKey = privateKey.replace(/\\n/g, "\n");

/*
--------------------------------------------------------
Remove accidental trailing comma
--------------------------------------------------------
*/

privateKey = privateKey.replace(/,\s*$/, "").trim();

/*
--------------------------------------------------------
Remove accidental surrounding quotes again
--------------------------------------------------------
*/

privateKey = privateKey
  .replace(/^["']+/, "")
  .replace(/["']+,\s*$/, "")
  .trim();

/*
========================================================
VALIDATE FIREBASE PRIVATE KEY
========================================================
*/

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

let app;

if (getApps().length === 0) {
  app = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey
    })
  });
} else {
  app = getApp();
}

/*
========================================================
FIRESTORE
========================================================
*/

const db = getFirestore(app);

/*
========================================================
FIREBASE AUTH
========================================================
*/

const auth = getAuth(app);

/*
========================================================
EXPORTS
========================================================

server.js bezwen:
const { db, admin } = require("./firebaseAdmin");

Sa pèmèt li itilize:
admin.auth()
admin.firestore.FieldValue.serverTimestamp()
admin.firestore.Timestamp.fromDate()
========================================================
*/

const admin = {
  auth: () => auth,

  firestore: {
    FieldValue: {
      serverTimestamp:
        require("firebase-admin/firestore").FieldValue.serverTimestamp,

      arrayUnion:
        require("firebase-admin/firestore").FieldValue.arrayUnion,

      arrayRemove:
        require("firebase-admin/firestore").FieldValue.arrayRemove,

      increment:
        require("firebase-admin/firestore").FieldValue.increment,

      delete:
        require("firebase-admin/firestore").FieldValue.delete
    },

    Timestamp:
      require("firebase-admin/firestore").Timestamp
  }
};

module.exports = {
  db,
  auth,
  admin
};

