const { db } = require("../firebaseAdmin");

const jobsCollection = db.collection("jobs");

async function createJob(jobId, data) {
const now = new Date().toISOString();

const jobData = {
id: jobId,
recruiterId: data.recruiterId || "",
company: data.company || "",
title: data.title || "",
description: data.description || "",
location: data.location || "",
employmentType: data.employmentType || "",
workMode: data.workMode || "",
salary: data.salary || "",
skills: Array.isArray(data.skills) ? data.skills : [],
languages: Array.isArray(data.languages) ? data.languages : [],
experience: data.experience || "",
deadline: data.deadline || "",
status: data.status || "open",
createdAt: now,
updatedAt: now
};

await jobsCollection.doc(jobId).set(jobData);

return jobData;
}

async function getJob(jobId) {
const doc = await jobsCollection.doc(jobId).get();

if (!doc.exists) {
return null;
}

return doc.data();
}

async function updateJob(jobId, updates) {
const updateData = {
...updates,
updatedAt: new Date().toISOString()
};

delete updateData.id;
delete updateData.createdAt;

await jobsCollection.doc(jobId).update(updateData);

return getJob(jobId);
}

async function deleteJob(jobId) {
await jobsCollection.doc(jobId).delete();

return {
success: true,
id: jobId
};
}

async function getJobs() {
const snapshot = await jobsCollection.get();

return snapshot.docs.map((doc) => doc.data());
}

async function getJobsByRecruiter(recruiterId) {
const snapshot = await jobsCollection
.where("recruiterId", "==", recruiterId)
.get();

return snapshot.docs.map((doc) => doc.data());
}

module.exports = {
createJob,
getJob,
updateJob,
deleteJob,
getJobs,
getJobsByRecruiter
};
