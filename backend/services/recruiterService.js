const { db } = require("../firebaseAdmin");

const recruitersCollection = db.collection("recruiters");

async function createRecruiter(recruiterId, data) {
const now = new Date().toISOString();

const recruiterData = {
id: recruiterId,
name: data.name || "",
email: data.email || "",
company: data.company || "",
companyWebsite: data.companyWebsite || "",
location: data.location || "",
industry: data.industry || "",
description: data.description || "",
logoUrl: data.logoUrl || "",
linkedin: data.linkedin || "",
verified: data.verified === true,
createdAt: now,
updatedAt: now
};

await recruitersCollection.doc(recruiterId).set(recruiterData);

return recruiterData;
}

async function getRecruiter(recruiterId) {
const doc = await recruitersCollection.doc(recruiterId).get();

if (!doc.exists) {
return null;
}

return doc.data();
}

async function updateRecruiter(recruiterId, updates) {
const updateData = {
...updates,
updatedAt: new Date().toISOString()
};

delete updateData.id;
delete updateData.createdAt;

await recruitersCollection.doc(recruiterId).update(updateData);

return getRecruiter(recruiterId);
}

async function deleteRecruiter(recruiterId) {
await recruitersCollection.doc(recruiterId).delete();

return {
success: true,
id: recruiterId
};
}

async function getRecruiters() {
const snapshot = await recruitersCollection.get();

return snapshot.docs.map((doc) => doc.data());
}

module.exports = {
createRecruiter,
getRecruiter,
updateRecruiter,
deleteRecruiter,
getRecruiters
};
