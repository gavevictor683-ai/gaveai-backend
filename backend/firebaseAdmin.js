const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");

const serviceAccountPath = path.join(
__dirname,
"gave-money-tips-firebase-adminsdk-fbsvc-69aa8a7cbb(key).json"
);

const serviceAccount = require(serviceAccountPath);

if (getApps().length === 0) {
initializeApp({
credential: cert({
projectId: String(serviceAccount.project_id).trim(),
clientEmail: String(serviceAccount.client_email).trim(),
privateKey: String(serviceAccount.private_key).replace(/\n/g, "\n")
})
});
}

const db = getFirestore();

module.exports = {
db
};