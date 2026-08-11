const { db } = require("../firebaseAdmin");

const workersCollection = db.collection("workers");

async function createWorker(workerId, data) {
const now = new Date().toISOString();

const workerData = {
id: workerId,
name: data.name || "",
email: data.email || "",
title: data.title || "",
country: data.country || "",
city: data.city || "",
languages: Array.isArray(data.languages) ? data.languages : [],
skills: Array.isArray(data.skills) ? data.skills : [],
experience: data.experience || "",
availability: data.availability || "",
timezone: data.timezone || "",
bio: data.bio || "",
linkedin: data.linkedin || "",
portfolio: data.portfolio || "",
photoUrl: data.photoUrl || "",
resumeUrl: data.resumeUrl || "",
certificateUrls: Array.isArray(data.certificateUrls)
? data.certificateUrls
: [],
createdAt: now,
updatedAt: now
};

await workersCollection.doc(workerId).set(workerData);

return workerData;
}

async function getWorker(workerId) {
const doc = await workersCollection.doc(workerId).get();

if (!doc.exists) {
return null;
}

return doc.data();
}

async function updateWorker(workerId, updates) {
const updateData = {
...updates,
updatedAt: new Date().toISOString()
};

delete updateData.id;
delete updateData.createdAt;

await workersCollection.doc(workerId).update(updateData);

return getWorker(workerId);
}

async function deleteWorker(workerId) {
await workersCollection.doc(workerId).delete();

return {
success: true,
id: workerId
};
}

async function getWorkers() {
const snapshot = await workersCollection.get();

return snapshot.docs.map((doc) => doc.data());
}

module.exports = {
createWorker,
getWorker,
updateWorker,
deleteWorker,
getWorkers
};
