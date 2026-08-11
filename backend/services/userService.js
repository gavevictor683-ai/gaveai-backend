const { db } = require("../firebaseAdmin");

const usersCollection = db.collection("users");

async function createUser(userId, userData = {}) {
  const userRef = usersCollection.doc(userId);

  const user = {
    name: userData.name || "",
    email: userData.email || "",
    role: userData.role || "worker",
    plan: userData.plan || "free",
    photoUrl: userData.photoUrl || "",
    resumeUrl: userData.resumeUrl || "",
    certificateUrls: Array.isArray(userData.certificateUrls)
      ? userData.certificateUrls
      : [],
    skills: Array.isArray(userData.skills) ? userData.skills : [],
    title: userData.title || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await userRef.set(user);

  return {
    id: userId,
    ...user
  };
}

async function getUser(userId) {
  const userRef = usersCollection.doc(userId);
  const snapshot = await userRef.get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data()
  };
}

async function updateUser(userId, updates = {}) {
  const userRef = usersCollection.doc(userId);

  const allowedFields = [
    "name",
    "email",
    "role",
    "plan",
    "photoUrl",
    "resumeUrl",
    "certificateUrls",
    "skills",
    "title"
  ];

  const safeUpdates = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      safeUpdates[field] = updates[field];
    }
  }

  safeUpdates.updatedAt = new Date().toISOString();

  await userRef.update(safeUpdates);

  return getUser(userId);
}

async function deleteUser(userId) {
  await usersCollection.doc(userId).delete();

  return {
    success: true,
    id: userId
  };
}

module.exports = {
  createUser,
  getUser,
  updateUser,
  deleteUser
};