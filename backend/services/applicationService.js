const { db } = require("../firebaseAdmin");

const applicationsCollection = db.collection("applications");

async function createApplication(applicationId, data) {
const now = new Date().toISOString();

const applicationData = {
id: applicationId,
jobId: data.jobId || "",
workerId: data.workerId || "",
recruiterId: data.recruiterId || "",
status: data.status || "submitted",
coverLetter: data.coverLetter || "",
resumeUrl: data.resumeUrl || "",
createdAt: now,
updatedAt: now
};

await applicationsCollection.doc(applicationId).set(applicationData);

return applicationData;
}

async function getApplication(applicationId) {
const doc = await applicationsCollection.doc(applicationId).get();

if (!doc.exists) {
return null;
}

return doc.data();
}

async function updateApplication(applicationId, updates) {
const updateData = {
...updates,
updatedAt: new Date().toISOString()
};

delete updateData.id;
delete updateData.createdAt;

await applicationsCollection.doc(applicationId).update(updateData);

return getApplication(applicationId);
}

async function deleteApplication(applicationId) {
await applicationsCollection.doc(applicationId).delete();

return {
success: true,
id: applicationId
};
}

async function getApplicationsByWorker(workerId) {
const snapshot = await applicationsCollection
.where("workerId", "==", workerId)
.get();

return snapshot.docs.map((doc) => doc.data());
}

async function getApplicationsByJob(jobId) {
const snapshot = await applicationsCollection
.where("jobId", "==", jobId)
.get();

return snapshot.docs.map((doc) => doc.data());
}

async function getApplicationsByRecruiter(recruiterId) {
const snapshot = await applicationsCollection
.where("recruiterId", "==", recruiterId)
.get();

return snapshot.docs.map((doc) => doc.data());
}

module.exports = {
createApplication,
getApplication,
updateApplication,
deleteApplication,
getApplicationsByWorker,
getApplicationsByJob,
getApplicationsByRecruiter
};
