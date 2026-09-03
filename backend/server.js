require("dotenv").config();
const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");
const { generateAIResponse } = require("./services/groqService");
const {
generateWithGaveAIVideoProvider,
getVideoProviderStatus
} = require("./services/gaveaiVideoProviderService");
const { db, admin } = require("./firebaseAdmin");
const app = express();

/*
========================================================
GAVEAI FINAL CONFIGURATION
========================================================
*/
const PORT = process.env.PORT || 3000;

/*
--------------------------------------------------------
ADMIN
--------------------------------------------------------
*/
const ADMIN_USER_ID =
process.env.ADMIN_USER_ID ||
"8eGkRNjIqycQa4ZIVwX8r6LVm4u1";

/*
--------------------------------------------------------
FINAL VIDEO CREDIT SYSTEM
--------------------------------------------------------
*/
const FREE_VIDEO_COUNT = 1;
const PRO_PRICE = 9.99;
const PRO_CREDITS = 1000;
const PREMIUM_PRICE = 19.99;
const PREMIUM_CREDITS = 1500;
const SUBSCRIPTION_DAYS = 30;

/*
--------------------------------------------------------
VIDEO PRICING
--------------------------------------------------------
5 seconds = 15 credits
8 seconds = 24 credits
*/
const VIDEO_PRICING = {
5: 15,
8: 24
};

/*
--------------------------------------------------------
BANK
--------------------------------------------------------
*/
const GAVEAI_BANK_INFO = {
bankName: "SOGEBANK",
accountHolder: "Gave Victor",
accountNumber: "2611111879",
swiftBic: "SOGHHTPP",
currency: "USD"
};

/*
========================================================
HELPER FUNCTIONS
========================================================
*/
function normalizePlan(plan) {
const value = String(plan || "")
.trim()
.toLowerCase();
if (
value === "pro" ||
value === "premium"
) {
return value;
}
return "free";
}

function getPlanCredits(plan) {
const normalized = normalizePlan(plan);
if (normalized === "pro") {
return PRO_CREDITS;
}
if (normalized === "premium") {
return PREMIUM_CREDITS;
}
return 0;
}

function getPlanPrice(plan) {
const normalized = normalizePlan(plan);
if (normalized === "pro") {
return PRO_PRICE;
}
if (normalized === "premium") {
return PREMIUM_PRICE;
}
return 0;
}

function getVideoCreditCost(duration) {
const seconds = Number(duration);
if (seconds === 5) {
return VIDEO_PRICING[5];
}
if (seconds === 8) {
return VIDEO_PRICING[8];
}
return null;
}

function timestampToMillis(value) {
if (!value) {
return null;
}
try {
if (
typeof value.toDate === "function"
) {
return value.toDate().getTime();
}
if (
value.seconds !== undefined
) {
return Number(value.seconds) * 1000;
}
const parsed =
new Date(value).getTime();
return Number.isNaN(parsed)
? null
: parsed;
} catch (error) {
return null;
}
}

/*
--------------------------------------------------------
SAFE DATE SERIALIZATION
--------------------------------------------------------
*/
function timestampToISO(value) {
const millis =
timestampToMillis(value);
if (!millis) {
return null;
}
try {
return new Date(
millis
).toISOString();
} catch (error) {
return null;
}
}

/*
--------------------------------------------------------
FREE VIDEO STATE
--------------------------------------------------------
*/
function normalizeFreeVideoState(
userData = {}
) {
const plan =
normalizePlan(
userData.subscriptionPlan ||
userData.plan ||
"free"
);
const hasRemaining =
userData.freeVideoRemaining !==
undefined &&
userData.freeVideoRemaining !==
null;
const hasAvailable =
userData.freeVideoAvailable !==
undefined &&
userData.freeVideoAvailable !==
null;
const hasUsed =
userData.freeVideoUsed !==
undefined &&
userData.freeVideoUsed !==
null;
let remaining = null;
let available = null;
let used = null;
if (hasRemaining) {
const numericRemaining =
Number(
userData.freeVideoRemaining
);
if (
Number.isFinite(
numericRemaining
)
) {
remaining =
Math.max(
0,
Math.floor(
numericRemaining
)
);
}
}
if (hasAvailable) {
available =
userData.freeVideoAvailable ===
true;
}
if (hasUsed) {
used =
userData.freeVideoUsed ===
true;
}
if (
available === null &&
remaining !== null
) {
available =
remaining > 0;
}
if (
used === null &&
available !== null
) {
used =
!available;
}
if (
available === null &&
used !== null
) {
available =
!used;
}
if (
available === null &&
remaining === null &&
used === null
) {
available = true;
remaining = FREE_VIDEO_COUNT;
used = false;
}
if (available === null) {
available =
remaining > 0;
}
if (remaining === null) {
remaining =
available
? FREE_VIDEO_COUNT
: 0;
}
if (used === null) {
used =
!available ||
remaining <= 0;
}
return {
freeVideoAvailable:
Boolean(available),
freeVideoRemaining:
Math.max(
0,
Number(
remaining || 0
)
),
freeVideoUsed:
Boolean(used)
};
}

/*
--------------------------------------------------------
SUBSCRIPTION
--------------------------------------------------------
*/
function isSubscriptionActive(
userData
) {
const plan =
normalizePlan(
userData?.subscriptionPlan ||
userData?.plan
);
if (
plan !== "pro" &&
plan !== "premium"
) {
return false;
}
const expiresAt =
timestampToMillis(
userData.subscriptionExpiresAt
);
if (!expiresAt) {
return false;
}
return expiresAt > Date.now();
}

function calculateExpirationDate() {
return new Date(
Date.now() +
SUBSCRIPTION_DAYS *
24 *
60 *
60 *
1000
);
}

/*
--------------------------------------------------------
HELPER: CHECK IF PAYMENT IS TRASHED
--------------------------------------------------------
*/
function isPaymentTrashed(payment) {
return payment.deleted === true;
}

/*
========================================================
FILE UPLOAD
========================================================
*/
const upload = multer({
storage: multer.memoryStorage(),
limits: {
fileSize:
50 * 1024 * 1024
}
});

/*
========================================================
IMAGEKIT
========================================================
*/
const imagekit = new ImageKit({
publicKey:
process.env.IMAGEKIT_PUBLIC_KEY,
privateKey:
process.env.IMAGEKIT_PRIVATE_KEY,
urlEndpoint:
process.env.IMAGEKIT_URL_ENDPOINT
});

/*
========================================================
CORS
========================================================
*/
const allowedOrigins = [
"https://gavemoneystips.blogspot.com",
"https://gavemoneytips.blogspot.com",
"http://localhost:3000"
];
app.use(
cors({
origin: function (
origin,
callback
) {
if (
!origin ||
allowedOrigins.includes(origin)
) {
return callback(
null,
true
);
}
return callback(
new Error(
"CORS origin not allowed"
)
);
},
methods: [
"GET",
"POST",
"OPTIONS"
],
allowedHeaders: [
"Content-Type",
"Authorization",
"Accept",
"Origin"
],
credentials: false,
optionsSuccessStatus: 204
})
);
app.use(
(
req,
res,
next
) => {
const origin =
req.headers.origin;
if (
allowedOrigins.includes(
origin
)
) {
res.header(
"Access-Control-Allow-Origin",
origin
);
res.header(
"Access-Control-Allow-Methods",
"GET, POST, OPTIONS"
);
res.header(
"Access-Control-Allow-Headers",
"Content-Type, Authorization, Accept, Origin"
);
}
if (
req.method ===
"OPTIONS"
) {
return res.sendStatus(
204
);
}
next();
}
);
app.use(
express.json({
limit: "10mb"
})
);

/*
========================================================
HEALTH CHECK
========================================================
*/
app.get(
"/",
(
req,
res
) => {
res.send(
"Gave Money Tips AI Backend is running 🚀"
);
}
);

/*
========================================================
GAVEAI VIDEO PROVIDER STATUS
========================================================
*/
app.get(
"/video-provider-status",
async (
req,
res
) => {
try {
const status =
await getVideoProviderStatus();
return res.json({
success: true,
provider:
"GaveAI",
status
});
} catch (error) {
console.error(
"GAVEAI VIDEO PROVIDER STATUS ERROR:",
error
);
return res.status(
500
).json({
success: false,
provider:
"GaveAI",
error:
error?.message ||
"Unable to get GaveAI video provider status."
});
}
}
);

/*
========================================================
CHAT
========================================================
*/
app.post(
"/chat",
async (
req,
res
) => {
try {
const userMessage =
req.body.message;
if (
!userMessage ||
typeof userMessage !==
"string"
) {
return res.status(
400
).json({
error:
"Message is required"
});
}
const result =
await generateAIResponse(
userMessage
);
let aiReply =
typeof result ===
"string"
? result
: (
result?.reply ||
result?.message ||
""
);
aiReply =
aiReply
.split("*")
.join("")
.replace(
/##/g,
""
)
.replace(
/#/g,
""
)
.replace(
/`/g,
""
);
return res.json({
reply:
aiReply,
webSearchUsed:
Boolean(
result?.webSearchUsed
),
sources:
Array.isArray(
result?.sources
)
? result.sources.map(
(
s
) => ({
title:
s?.title ||
"",
url:
s?.url ||
"",
provider:
s?.provider ||
"",
official:
Boolean(
s?.official
)
})
)
: []
});
} catch (error) {
console.error(
"GROQ ERROR:",
error
);
return res.status(
500
).json({
error:
error?.message ||
"AI request failed"
});
}
}
);

/*
========================================================
IMAGEKIT VIDEO UPLOAD
========================================================
*/
async function uploadGeneratedVideoToImageKit(
filePath,
productionId
) {
if (
!filePath ||
!fs.existsSync(
filePath
)
) {
throw new Error(
"Generated video file does not exist."
);
}
const fileBuffer =
fs.readFileSync(
filePath
);
if (
!fileBuffer ||
fileBuffer.length ===
0
) {
throw new Error(
"Generated video file is empty."
);
}
const fileName =
`gaveai-production-${
productionId ||
Date.now()
}.mp4`;
const result =
await imagekit.upload({
file:
fileBuffer,
fileName,
folder:
"gavemoneytips/generated-videos"
});
if (
!result ||
!result.url
) {
throw new Error(
"ImageKit did not return a public video URL."
);
}
return {
url:
result.url,
fileId:
result.fileId ||
null,
name:
result.name ||
fileName
};
}

/*
========================================================
LOCAL VIDEO CLEANUP
========================================================
*/
function deleteLocalVideoFile(
filePath
) {
try {
if (
filePath &&
fs.existsSync(
filePath
)
) {
fs.unlinkSync(
filePath
);
console.log(
"LOCAL VIDEO DELETED:",
filePath
);
}
} catch (error) {
console.warn(
"VIDEO DELETE WARNING:",
error?.message ||
error
);
}
}

function cleanupGeneratedClips(
clips
) {
if (
!Array.isArray(
clips
)
) {
return;
}
for (
const clip of clips
) {
if (
clip?.videoFile
) {
deleteLocalVideoFile(
clip.videoFile
);
}
}
}

/*
========================================================
GAVEAI VIDEO PRODUCTION
========================================================
*/
async function generateGaveAIVideoProduction(
prompts,
options = {}
) {
if (
!Array.isArray(
prompts
) ||
prompts.length ===
0
) {
throw new Error(
"At least one video prompt is required."
);
}
const duration =
Number(
options.duration
) || 5;
const creditCost =
getVideoCreditCost(
duration
);
if (!creditCost) {
throw new Error(
"Video duration must be either 5 or 8 seconds."
);
}
const clips = [];
let firstGeneratedVideo =
null;
const productionId =
`gaveai-${Date.now()}`;
console.log(
"========================================"
);
console.log(
"GAVEAI VIDEO PRODUCTION STARTED"
);
console.log(
"PROVIDER: GaveAI"
);
console.log(
"DURATION:",
duration,
"seconds"
);
console.log(
"CREDIT COST PER CLIP:",
creditCost
);
console.log(
"TOTAL CLIPS:",
prompts.length
);
console.log(
"========================================"
);
for (
let i = 0;
i < prompts.length;
i++
) {
const currentPrompt =
prompts[i];
console.log(
`GENERATING CLIP ${
i + 1
}/${prompts.length}`
);
const result =
await generateWithGaveAIVideoProvider(
{
prompt:
currentPrompt,
firstFrameImage:
i === 0
? options.firstFrameImage
: undefined,
width:
options.width ||
832,
height:
options.height ||
480,
duration,
seed:
options.seed,
negativePrompt:
options.negativePrompt,
resolution:
options.resolution
}
);
if (
!result ||
!result.success ||
!result.videoFile
) {
throw new Error(
`Video clip ${
i + 1
} failed.`
);
}
if (
!firstGeneratedVideo
) {
firstGeneratedVideo =
result;
}
clips.push({
index:
i + 1,
prompt:
currentPrompt,
videoFile:
result.videoFile,
videoUrl:
result.videoUrl ||
null,
provider:
"GaveAI",
model:
result.model ||
null
});
}
const finalVideoFile =
firstGeneratedVideo?.finalVideoFile ||
firstGeneratedVideo?.videoFile ||
null;
return {
success:
true,
provider:
"GaveAI",
model:
firstGeneratedVideo?.model ||
null,
productionId,
clips,
videoFile:
finalVideoFile
};
}

/*
========================================================
FREE VIDEO — LIFETIME ONLY
========================================================
*/
async function consumeFreeVideo(
userId
) {
if (!userId) {
throw new Error(
"USER_ID_REQUIRED"
);
}
const userRef =
db.collection(
"users"
).doc(
userId
);
return await db.runTransaction(
async (
transaction
) => {
const userSnap =
await transaction.get(
userRef
);
if (
!userSnap.exists
) {
throw new Error(
"USER_NOT_FOUND"
);
}
const userData =
userSnap.data() ||
{};
const plan =
normalizePlan(
userData.subscriptionPlan ||
userData.plan
);
if (
plan !== "free"
) {
throw new Error(
"PAID_PLAN"
);
}
const freeState =
normalizeFreeVideoState(
userData
);
const available =
freeState.freeVideoAvailable &&
freeState.freeVideoRemaining >
0;
if (!available) {
throw new Error(
"FREE_VIDEO_ALREADY_USED"
);
}
transaction.set(
userRef,
{
freeVideoAvailable:
false,
freeVideoRemaining:
0,
freeVideoUsed:
true,
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
},
{
merge:
true
}
);
return {
freeVideoUsed:
true
};
}
);
}

/*
========================================================
PAID CREDIT DEDUCTION
========================================================
*/
async function deductVideoCredits(
userId,
creditCost
) {
if (
!userId ||
!creditCost ||
creditCost <= 0
) {
throw new Error(
"INVALID_CREDIT_REQUEST"
);
}
const userRef =
db.collection(
"users"
).doc(
userId
);
return await db.runTransaction(
async (
transaction
) => {
const userSnap =
await transaction.get(
userRef
);
if (
!userSnap.exists
) {
throw new Error(
"USER_NOT_FOUND"
);
}
const userData =
userSnap.data() ||
{};
const plan =
normalizePlan(
userData.subscriptionPlan ||
userData.plan
);
if (
plan !== "pro" &&
plan !== "premium"
) {
throw new Error(
"NO_PAID_PLAN"
);
}
const expiresAt =
timestampToMillis(
userData.subscriptionExpiresAt
);
if (
!expiresAt ||
expiresAt <=
Date.now()
) {
throw new Error(
"SUBSCRIPTION_EXPIRED"
);
}
const currentCredits =
Number(
userData.credits ??
0
);
if (
!Number.isFinite(
currentCredits
)
) {
throw new Error(
"INVALID_CREDIT_BALANCE"
);
}
if (
currentCredits <
creditCost
) {
const error =
new Error(
"INSUFFICIENT_CREDITS"
);
error.currentCredits =
currentCredits;
throw error;
}
const newBalance =
currentCredits -
creditCost;
transaction.set(
userRef,
{
credits:
newBalance,
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
},
{
merge:
true
}
);
return {
creditsDeducted:
creditCost,
previousCreditBalance:
currentCredits,
newCreditBalance:
newBalance
};
}
);
}

/*
========================================================
PAID CREDIT REFUND
========================================================
*/
async function refundVideoCredits(
userId,
creditCost
) {
if (
!userId ||
!creditCost ||
creditCost <= 0
) {
return;
}
try {
const userRef =
db.collection(
"users"
).doc(
userId
);
await db.runTransaction(
async (
transaction
) => {
const userSnap =
await transaction.get(
userRef
);
if (
!userSnap.exists
) {
return;
}
const userData =
userSnap.data() ||
{};
const currentCredits =
Number(
userData.credits ??
0
);
transaction.set(
userRef,
{
credits:
currentCredits +
creditCost,
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
},
{
merge:
true
}
);
}
);
console.log(
"VIDEO CREDITS REFUNDED:",
creditCost
);
} catch (error) {
console.error(
"CREDIT REFUND ERROR:",
error
);
}
}

/*
========================================================
GENERATE VIDEO
========================================================
*/
app.post(
"/generate-video",
async (
req,
res
) => {
let userId =
typeof req.body?.userId ===
"string"
? req.body.userId.trim()
: "";
let prompt =
typeof req.body?.prompt ===
"string"
? req.body.prompt.trim()
: "";
if (
!prompt &&
typeof req.body?.message ===
"string"
) {
prompt =
req.body.message
.replace(
/^\/generate-video\s*/i,
""
)
.trim();
}
let prompts = [];
if (
Array.isArray(
req.body?.prompts
)
) {
prompts =
req.body.prompts
.filter(
(
item
) =>
typeof item ===
"string" &&
item.trim()
)
.map(
(
item
) =>
item.trim()
);
}
if (
prompts.length ===
0 &&
prompt
) {
prompts = [
prompt
];
}
if (
prompts.length ===
0
) {
return res.status(
400
).json({
success:
false,
error:
"At least one video prompt is required."
});
}
if (
prompts.length >
20
) {
return res.status(
400
).json({
success:
false,
error:
"A maximum of 20 video clips can be generated."
});
}
if (!userId) {
return res.status(
401
).json({
success:
false,
error:
"User authentication is required for video generation."
});
}
const duration =
Number(
req.body?.duration
) || 5;
const creditsPerClip =
getVideoCreditCost(
duration
);
if (!creditsPerClip) {
return res.status(
400
).json({
success:
false,
error:
"Video duration must be either 5 or 8 seconds."
});
}
const userRef =
db.collection(
"users"
).doc(
userId
);
const userSnap =
await userRef.get();
if (
!userSnap.exists
) {
return res.status(
404
).json({
success:
false,
error:
"User account was not found."
});
}
const userData =
userSnap.data() ||
{};
const plan =
normalizePlan(
userData.subscriptionPlan ||
userData.plan
);
const adminUserId =
process.env.ADMIN_USER_ID
? process.env.ADMIN_USER_ID.trim()
: ADMIN_USER_ID;
const ownerUser =
userId ===
adminUserId;
const totalCreditCost =
prompts.length *
creditsPerClip;
console.log(
"========================================"
);
console.log(
"GAVEAI GENERATE VIDEO REQUEST"
);
console.log(
"USER ID:",
userId
);
console.log(
"VIDEO PROVIDER:",
"GaveAI"
);
console.log(
"PLAN:",
plan
);
console.log(
"ADMIN:",
ownerUser
);
console.log(
"DURATION:",
duration
);
console.log(
"PROMPTS:",
prompts.length
);
console.log(
"CREDITS PER CLIP:",
creditsPerClip
);
console.log(
"TOTAL CREDIT COST:",
totalCreditCost
);
console.log(
"========================================"
);
if (
!ownerUser &&
plan === "free"
) {
if (
prompts.length !==
1
) {
return res.status(
400
).json({
success:
false,
error:
"The Free plan includes one free video only."
});
}
}
if (
!ownerUser &&
(
plan === "pro" ||
plan === "premium"
)
) {
if (
!isSubscriptionActive(
userData
)
) {
return res.status(
402
).json({
success:
false,
error:
"Your subscription has expired. Please purchase a new plan."
});
}
}
let creditResult =
null;
let freeVideoConsumed =
false;
let genResult =
null;
try {
if (
!ownerUser
) {
if (
plan === "free"
) {
try {
await consumeFreeVideo(
userId
);
freeVideoConsumed =
true;
} catch (
freeError
) {
console.error(
"FREE VIDEO ERROR:",
freeError
);
if (
freeError.message ===
"FREE_VIDEO_ALREADY_USED"
) {
return res.status(
402
).json({
success:
false,
error:
"Your lifetime free video has already been used. Please choose Pro or Premium."
});
}
if (
freeError.message ===
"PAID_PLAN"
) {
return res.status(
400
).json({
success:
false,
error:
"Account plan changed. Please retry."
});
}
throw freeError;
}
} else {
creditResult =
await deductVideoCredits(
userId,
totalCreditCost
);
}
}
try {
genResult =
await generateGaveAIVideoProduction(
prompts,
{
firstFrameImage:
typeof req.body
?.firstFrameImage ===
"string"
? req.body.firstFrameImage.trim()
: undefined,
width:
Number(
req.body?.width
) || 832,
height:
Number(
req.body?.height
) || 480,
duration
}
);
} catch (
generationError
) {
console.error(
"GAVEAI VIDEO GENERATION ERROR:",
generationError
);
if (
creditResult &&
creditResult.creditsDeducted >
0
) {
await refundVideoCredits(
userId,
creditResult.creditsDeducted
);
}
if (
freeVideoConsumed
) {
try {
await userRef.update({
freeVideoAvailable:
true,
freeVideoRemaining:
FREE_VIDEO_COUNT,
freeVideoUsed:
false,
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
});
} catch (
restoreError
) {
console.error(
"FREE VIDEO RESTORE ERROR:",
restoreError
);
}
}
return res.status(
500
).json({
success:
false,
provider:
"GaveAI",
error:
generationError?.message ||
"GaveAI video production failed."
});
}
if (
!genResult ||
!genResult.success ||
!genResult.videoFile ||
!fs.existsSync(
genResult.videoFile
)
) {
if (
creditResult &&
creditResult.creditsDeducted >
0
) {
await refundVideoCredits(
userId,
creditResult.creditsDeducted
);
}
if (
freeVideoConsumed
) {
try {
await userRef.update({
freeVideoAvailable:
true,
freeVideoRemaining:
FREE_VIDEO_COUNT,
freeVideoUsed:
false,
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
});
} catch (
restoreError
) {
console.error(
"FREE VIDEO RESTORE ERROR:",
restoreError
);
}
}
cleanupGeneratedClips(
genResult?.clips
);
return res.status(
500
).json({
success:
false,
provider:
"GaveAI",
error:
"GaveAI generated the video, but the final video file could not be found."
});
}
let uploadedVideo;
try {
uploadedVideo =
await uploadGeneratedVideoToImageKit(
genResult.videoFile,
genResult.productionId
);
} catch (
uploadError
) {
console.error(
"IMAGEKIT UPLOAD ERROR:",
uploadError
);
if (
creditResult &&
creditResult.creditsDeducted >
0
) {
await refundVideoCredits(
userId,
creditResult.creditsDeducted
);
}
if (
freeVideoConsumed
) {
try {
await userRef.update({
freeVideoAvailable:
true,
freeVideoRemaining:
FREE_VIDEO_COUNT,
freeVideoUsed:
false,
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
});
} catch (
restoreError
) {
console.error(
"FREE VIDEO RESTORE ERROR:",
restoreError
);
}
}
cleanupGeneratedClips(
genResult.clips
);
if (
genResult.videoFile &&
!genResult.clips.some(
(
clip
) =>
clip.videoFile ===
genResult.videoFile
)
) {
deleteLocalVideoFile(
genResult.videoFile
);
}
return res.status(
500
).json({
success:
false,
provider:
"GaveAI",
error:
"GaveAI generated the video, but uploading failed.",
details:
uploadError?.message
});
}
cleanupGeneratedClips(
genResult.clips
);
if (
genResult.videoFile &&
!genResult.clips.some(
(
clip
) =>
clip.videoFile ===
genResult.videoFile
)
) {
deleteLocalVideoFile(
genResult.videoFile
);
}
return res.json({
success:
true,
reply:
"Video generated successfully!",
generatedMedia: {
type:
"video",
url:
uploadedVideo.url,
downloadUrl:
uploadedVideo.url,
productionId:
genResult.productionId,
clips:
genResult.clips,
provider:
"GaveAI",
model:
genResult.model
},
provider:
"GaveAI",
plan,
duration,
clipsGenerated:
prompts.length,
creditsPerClip,
totalCreditCost,
creditsDeducted:
creditResult?.creditsDeducted ||
0,
newCreditBalance:
creditResult?.newCreditBalance ??
null,
freeVideoUsed:
freeVideoConsumed
});
} catch (error) {
console.error(
"GAVEAI GENERATE VIDEO CRITICAL ERROR:",
error
);
if (
creditResult &&
creditResult.creditsDeducted >
0
) {
await refundVideoCredits(
userId,
creditResult.creditsDeducted
);
}
cleanupGeneratedClips(
genResult?.clips
);
if (
genResult?.videoFile &&
!genResult?.clips?.some(
(
clip
) =>
clip.filePath ===
genResult.videoFile ||
clip.videoFile ===
genResult.videoFile
)
) {
deleteLocalVideoFile(
genResult.videoFile
);
}
return res.status(
500
).json({
success:
false,
provider:
"GaveAI",
error:
error?.message ||
"GaveAI video generation failed."
});
}
}
);

/*
========================================================
AUTHENTICATION
========================================================
*/
const requireAdmin =
async (
req,
res,
next
) => {
try {
const authHeader =
req.headers.authorization;
if (
!authHeader ||
!authHeader.startsWith(
"Bearer "
)
) {
return res.status(
401
).json({
success:
false,
error:
"Unauthorized: No Firebase token provided"
});
}
const token =
authHeader
.substring(
"Bearer ".length
)
.trim();
const decodedToken =
await admin
.auth()
.verifyIdToken(
token
);
if (
decodedToken.uid !==
ADMIN_USER_ID
) {
return res.status(
403
).json({
success:
false,
error:
"Forbidden: Admin access required"
});
}
req.adminUid =
decodedToken.uid;
next();
} catch (error) {
console.error(
"Admin authentication error:",
error
);
return res.status(
401
).json({
success:
false,
error:
"Invalid or expired Firebase token"
});
}
};

const requireAuthenticatedUser =
async (
req,
res,
next
) => {
try {
const authHeader =
req.headers.authorization;
if (
!authHeader ||
!authHeader.startsWith(
"Bearer "
)
) {
return res.status(
401
).json({
success:
false,
error:
"Unauthorized: No Firebase token provided"
});
}
const token =
authHeader
.substring(
"Bearer ".length
)
.trim();
const decodedToken =
await admin
.auth()
.verifyIdToken(
token
);
req.authenticatedUser =
decodedToken;
req.userUid =
decodedToken.uid;
next();
} catch (error) {
console.error(
"User authentication error:",
error
);
return res.status(
401
).json({
success:
false,
error:
"Invalid or expired Firebase token"
});
}
};

/*
========================================================
PAYMENT REQUEST
========================================================
*/
app.post(
"/api/payment-requests",
requireAuthenticatedUser,
async (
req,
res
) => {
try {
const userId =
req.userUid;
const {
plan,
amount,
currency,
bankName,
accountHolderFullName,
transactionDate,
transactionTime,
description,
proofImageUrl
} = req.body || {};
const planLower =
normalizePlan(
plan
);
if (
planLower !== "pro" &&
planLower !== "premium"
) {
return res.status(
400
).json({
success:
false,
error:
"Invalid plan. Select Pro or Premium."
});
}
if (
amount ===
undefined ||
amount ===
null ||
amount ===
"" ||
Number.isNaN(
Number(amount)
)
) {
return res.status(
400
).json({
success:
false,
error:
"Transaction amount is required"
});
}
const normalizedCurrency =
String(
currency ||
""
)
.trim()
.toUpperCase();
if (
normalizedCurrency !==
"USD"
) {
return res.status(
400
).json({
success:
false,
error:
"Payments must be made in USD."
});
}
if (
!bankName ||
!String(
bankName
).trim()
) {
return res.status(
400
).json({
success:
false,
error:
"Bank Name is required"
});
}
if (
!accountHolderFullName ||
!String(
accountHolderFullName
).trim()
) {
return res.status(
400
).json({
success:
false,
error:
"Account Holder Full Name is required"
});
}
if (
!transactionDate
) {
return res.status(
400
).json({
success:
false,
error:
"Transaction Date is required"
});
}
if (
!transactionTime
) {
return res.status(
400
).json({
success:
false,
error:
"Transaction Time is required"
});
}
if (
!proofImageUrl ||
!String(
proofImageUrl
).trim()
) {
return res.status(
400
).json({
success:
false,
error:
"Payment Proof / Screenshot is required"
});
}
const numericAmount =
Number(
amount
);
const expectedAmount =
getPlanPrice(
planLower
);
if (
Math.abs(
numericAmount -
expectedAmount
) > 0.01
) {
return res.status(
400
).json({
success:
false,
error:
`The ${planLower} plan requires a payment of $${expectedAmount.toFixed(
2
)} USD`
});
}
const userRef =
db.collection(
"users"
).doc(
userId
);
const userSnap =
await userRef.get();
if (
!userSnap.exists
) {
return res.status(
404
).json({
success:
false,
error:
"User profile not found"
});
}
const userData =
userSnap.data() ||
{};
const paymentRequest = {
userId,
userEmail:
userData.email ||
req.authenticatedUser
.email ||
"",
userFullName:
userData.fullName ||
userData.displayName ||
"",
plan:
planLower,
amount:
numericAmount,
currency:
"USD",
bankName:
String(
bankName
).trim(),
accountHolderFullName:
String(
accountHolderFullName
).trim(),
transactionDate:
String(
transactionDate
).trim(),
transactionTime:
String(
transactionTime
).trim(),
description:
description
? String(
description
).trim()
: "",
proofImageUrl:
String(
proofImageUrl
).trim(),
status:
"pending",
deleted:
false,
createdAt:
admin.firestore
.FieldValue
.serverTimestamp()
};
const paymentRef =
await db
.collection(
"paymentRequests"
)
.add(
paymentRequest
);
return res.status(
201
).json({
success:
true,
message:
"Payment request submitted successfully. Admin will verify the payment.",
id:
paymentRef.id
});
} catch (error) {
console.error(
"Create payment request error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to create payment request"
});
}
}
);

/*
========================================================
ADMIN OVERVIEW
========================================================
IMPORTANT: Does NOT count trashed payments
========================================================
*/
app.get(
"/api/admin/overview",
requireAdmin,
async (
req,
res
) => {
try {
const [
usersSnap,
paymentsSnap
] =
await Promise.all([
db.collection(
"users"
).get(),
db.collection(
"paymentRequests"
).get()
]);
const totalUsers =
usersSnap.size;
let activePro =
0;
let activePremium =
0;
let expiredSubs =
0;
let pendingPayments =
0;
let approvedPayments =
0;
let rejectedPayments =
0;
let totalRevenue =
0;
usersSnap.forEach(
(
doc
) => {
const user =
doc.data() ||
{};
const plan =
normalizePlan(
user.subscriptionPlan ||
user.plan
);
if (
plan === "pro" ||
plan === "premium"
) {
if (
isSubscriptionActive(
user
)
) {
if (
plan ===
"pro"
) {
activePro++;
} else {
activePremium++;
}
} else {
expiredSubs++;
}
}
}
);
paymentsSnap.forEach(
(
doc
) => {
const payment =
doc.data() ||
{};
/*
IMPORTANT: Skip trashed payments
*/
if (payment.deleted === true) {
return;
}
const status =
String(
payment.status ||
"pending"
)
.trim()
.toLowerCase();
if (
status ===
"pending"
) {
pendingPayments++;
}
if (
status ===
"approved"
) {
approvedPayments++;
const amount =
Number(
payment.amount ||
0
);
if (
Number.isFinite(
amount
)
) {
totalRevenue +=
amount;
}
}
if (
status ===
"rejected"
) {
rejectedPayments++;
}
}
);
return res.json({
success:
true,
totalUsers,
activePro,
activePremium,
expiredSubs,
pendingPayments,
approvedPayments,
rejectedPayments,
totalRevenue:
Number(
totalRevenue.toFixed(
2
)
)
});
} catch (error) {
console.error(
"Admin overview error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to load overview"
});
}
}
);

/*
========================================================
ADMIN PAYMENTS — WITH TRASH FILTER
========================================================
*/
app.get(
"/api/admin/payments",
requireAdmin,
async (
req,
res
) => {
try {
const filter =
String(
req.query.filter ||
"all"
)
.trim()
.toLowerCase();
/*
CRITICAL FIX: Added "trash" to valid filters
*/
const validFilters = [
"all",
"pending",
"approved",
"rejected",
"trash"
];
if (
!validFilters.includes(
filter
)
) {
return res.status(
400
).json({
success:
false,
error:
"Invalid payment filter"
});
}
let snap;
if (
filter ===
"all"
) {
snap =
await db
.collection(
"paymentRequests"
)
.get();
} else if (
filter ===
"trash"
) {
/*
CRITICAL FIX: Return ONLY trashed payments
*/
snap =
await db
.collection(
"paymentRequests"
)
.where(
"deleted",
"==",
true
)
.get();
} else {
snap =
await db
.collection(
"paymentRequests"
)
.where(
"status",
"==",
filter
)
.get();
}
const payments =
[];
const userIds =
new Set();
snap.forEach(
(
doc
) => {
const data =
doc.data() ||
{};
/*
CRITICAL FIX: For non-trash filters, exclude trashed payments
*/
if (filter !== "trash" && data.deleted === true) {
return;
}
payments.push({
id:
doc.id,
...data
});
if (
data.userId
) {
userIds.add(
data.userId
);
}
}
);
payments.sort(
(
a,
b
) =>
(
timestampToMillis(
b.createdAt
) || 0
) -
(
timestampToMillis(
a.createdAt
) || 0
)
);
const userDataMap =
{};
await Promise.all(
Array.from(
userIds
).map(
async (
uid
) => {
try {
const userSnap =
await db
.collection(
"users"
)
.doc(
uid
)
.get();
if (
userSnap.exists
) {
userDataMap[
uid
] = {
id:
userSnap.id,
...userSnap.data()
};
}
} catch (
userError
) {
console.error(
`Could not load user ${uid}:`,
userError
);
}
}
)
);
const enrichedPayments =
payments.map(
(
payment
) => {
const userData =
userDataMap[
payment.userId
] || {};
return {
...payment,
createdAtISO:
timestampToISO(
payment.createdAt
),
approvedAtISO:
timestampToISO(
payment.approvedAt
),
rejectedAtISO:
timestampToISO(
payment.rejectedAt
),
userData,
userFullName:
payment.userFullName ||
userData.fullName ||
userData.displayName ||
"",
userEmail:
payment.userEmail ||
userData.email ||
"",
userProfilePhoto:
userData.profilePhoto ||
userData.photoURL ||
userData.avatar ||
""
};
}
);
return res.json({
success:
true,
payments:
enrichedPayments,
count:
enrichedPayments.length
});
} catch (error) {
console.error(
"Admin payments error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to load payments"
});
}
}
);

/*
========================================================
ADMIN USERS — Does NOT count trashed payments in stats
========================================================
*/
app.get(
"/api/admin/users",
requireAdmin,
async (
req,
res
) => {
try {
const usersSnap =
await db
.collection(
"users"
)
.get();
const paymentsSnap =
await db
.collection(
"paymentRequests"
)
.get();
const userPaymentStats =
{};
paymentsSnap.forEach(
(
doc
) => {
const payment =
doc.data() ||
{};
const uid =
payment.userId;
if (!uid) {
return;
}
/*
CRITICAL FIX: Skip trashed payments in user stats
*/
if (payment.deleted === true) {
return;
}
if (
!userPaymentStats[
uid
]
) {
userPaymentStats[
uid
] = {
approved:
0,
total:
0,
lastAmount:
0,
lastDate:
null,
lastRequestId:
""
};
}
userPaymentStats[
uid
].total++;
if (
String(
payment.status ||
""
)
.toLowerCase() ===
"approved"
) {
userPaymentStats[
uid
].approved++;
const paymentDate =
timestampToMillis(
payment.approvedAt
);
const existing =
userPaymentStats[
uid
].lastDate;
if (
paymentDate &&
(
!existing ||
paymentDate >
existing
)
) {
userPaymentStats[
uid
].lastDate =
paymentDate;
userPaymentStats[
uid
].lastAmount =
Number(
payment.amount ||
0
);
userPaymentStats[
uid
].lastRequestId =
doc.id;
}
}
}
);
const users =
[];
usersSnap.forEach(
(
doc
) => {
const data =
doc.data() ||
{};
const plan =
normalizePlan(
data.subscriptionPlan ||
data.plan
);
let subscriptionStatus =
"free";
if (
plan === "pro" ||
plan === "premium"
) {
subscriptionStatus =
isSubscriptionActive(
data
)
? "active"
: "expired";
}
const stats =
userPaymentStats[
doc.id
] || {
approved:
0,
total:
0,
lastAmount:
0,
lastDate:
null,
lastRequestId:
""
};
const freeVideoState =
normalizeFreeVideoState(
data
);
const planCreditLimit =
getPlanCredits(
plan
);
const rawCredits =
Number(
data.credits ??
0
);
const credits =
Number.isFinite(
rawCredits
)
? rawCredits
: 0;
const subscriptionStartedAtISO =
timestampToISO(
data.subscriptionStartedAt
);
const subscriptionExpiresAtISO =
timestampToISO(
data.subscriptionExpiresAt
);
const lastPaymentDateISO =
stats.lastDate
? new Date(
stats.lastDate
).toISOString()
: null;
users.push({
id:
doc.id,
...data,
plan,
subscriptionPlan:
plan,
subscriptionStatus,
credits,
creditLimit:
planCreditLimit,
freeVideoAvailable:
freeVideoState.freeVideoAvailable,
freeVideoRemaining:
freeVideoState.freeVideoRemaining,
freeVideoUsed:
freeVideoState.freeVideoUsed,
subscriptionStartedAtISO,
subscriptionExpiresAtISO,
approvedPaymentsCount:
stats.approved,
totalPaymentRequests:
stats.total,
lastPaymentAmount:
stats.lastAmount,
lastPaymentDate:
stats.lastDate,
lastPaymentDateISO,
lastPaymentRequestId:
stats.lastRequestId,
lastPaymentAtISO:
lastPaymentDateISO
});
}
);
users.sort(
(
a,
b
) =>
(
timestampToMillis(
b.createdAt
) || 0
) -
(
timestampToMillis(
a.createdAt
) || 0
)
);
return res.json({
success:
true,
users,
count:
users.length
});
} catch (error) {
console.error(
"Admin users error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to load users"
});
}
}
);

/*
========================================================
ADMIN APPROVE PAYMENT
========================================================
*/
app.post(
"/api/admin/payment-requests/:id/approve",
requireAdmin,
async (
req,
res
) => {
const paymentId =
req.params.id;
const adminUid =
req.adminUid;
try {
await db.runTransaction(
async (
transaction
) => {
const paymentRef =
db
.collection(
"paymentRequests"
)
.doc(
paymentId
);
const paymentDoc =
await transaction.get(
paymentRef
);
if (
!paymentDoc.exists
) {
throw new Error(
"PAYMENT_NOT_FOUND"
);
}
const payment =
paymentDoc.data() ||
{};
const currentStatus =
String(
payment.status ||
"pending"
)
.trim()
.toLowerCase();
if (
currentStatus ===
"approved"
) {
throw new Error(
"ALREADY_APPROVED"
);
}
if (
currentStatus ===
"rejected"
) {
throw new Error(
"ALREADY_REJECTED"
);
}
if (
currentStatus !==
"pending"
) {
throw new Error(
"INVALID_PAYMENT_STATUS"
);
}
const plan =
normalizePlan(
payment.plan
);
if (
plan !== "pro" &&
plan !== "premium"
) {
throw new Error(
"INVALID_PLAN"
);
}
const credits =
getPlanCredits(
plan
);
const expectedAmount =
getPlanPrice(
plan
);
const paymentCurrency =
String(
payment.currency ||
""
)
.trim()
.toUpperCase();
if (
paymentCurrency !==
"USD"
) {
throw new Error(
"INVALID_CURRENCY"
);
}
const paymentAmount =
Number(
payment.amount
);
if (
!Number.isFinite(
paymentAmount
)
) {
throw new Error(
"INVALID_PAYMENT_AMOUNT"
);
}
if (
Math.abs(
paymentAmount -
expectedAmount
) > 0.01
) {
throw new Error(
"AMOUNT_MISMATCH"
);
}
if (
!payment.userId
) {
throw new Error(
"USER_ID_MISSING"
);
}
const userRef =
db
.collection(
"users"
)
.doc(
payment.userId
);
const userDoc =
await transaction.get(
userRef
);
if (
!userDoc.exists
) {
throw new Error(
"USER_NOT_FOUND"
);
}
const userData =
userDoc.data() ||
{};
const approvedPaymentsSnapshot =
await transaction.get(
db
.collection(
"paymentRequests"
)
.where(
"status",
"==",
"approved"
)
);
let duplicateFound =
false;
approvedPaymentsSnapshot.forEach(
(
duplicateDoc
) => {
if (
duplicateDoc.id ===
paymentId
) {
return;
}
const duplicate =
duplicateDoc.data() ||
{};
const sameBank =
String(
duplicate.bankName ||
""
)
.trim()
.toLowerCase() ===
String(
payment.bankName ||
""
)
.trim()
.toLowerCase();
const sameAccountHolder =
String(
duplicate.accountHolderFullName ||
""
)
.trim()
.toLowerCase() ===
String(
payment.accountHolderFullName ||
""
)
.trim()
.toLowerCase();
const sameAmount =
Math.abs(
Number(
duplicate.amount ||
0
) -
paymentAmount
) <=
0.01;
const sameDate =
String(
duplicate.transactionDate ||
""
).trim() ===
String(
payment.transactionDate ||
""
).trim();
const sameTime =
String(
duplicate.transactionTime ||
""
).trim() ===
String(
payment.transactionTime ||
""
).trim();
if (
sameBank &&
sameAccountHolder &&
sameAmount &&
sameDate &&
sameTime
) {
duplicateFound =
true;
}
}
);
if (
duplicateFound
) {
throw new Error(
"DUPLICATE_TRANSACTION"
);
}
const existingExpiry =
timestampToMillis(
userData.subscriptionExpiresAt
);
const existingPlan =
normalizePlan(
userData.subscriptionPlan ||
userData.plan
);
const currentlyActive =
(
existingPlan ===
"pro" ||
existingPlan ===
"premium"
) &&
existingExpiry &&
existingExpiry >
Date.now();
const existingCredits =
Number(
userData.credits ??
0
);
const safeExistingCredits =
Number.isFinite(
existingCredits
)
? existingCredits
: 0;
const newCreditBalance =
currentlyActive
? safeExistingCredits +
credits
: credits;
const newExpiresAt =
calculateExpirationDate();
const freeVideoState =
normalizeFreeVideoState(
userData
);
transaction.update(
paymentRef,
{
status:
"approved",
approvedAt:
admin.firestore
.FieldValue
.serverTimestamp(),
approvedBy:
adminUid,
approvedPlan:
plan,
approvedCredits:
credits,
approvedAmount:
paymentAmount,
approvedCurrency:
"USD",
entitlementDays:
SUBSCRIPTION_DAYS,
creditMode:
currentlyActive
? "top_up"
: "new_subscription"
}
);
transaction.set(
userRef,
{
plan,
subscriptionPlan:
plan,
credits:
newCreditBalance,
creditLimit:
credits,
subscriptionStatus:
"active",
subscriptionStartedAt:
admin.firestore
.FieldValue
.serverTimestamp(),
subscriptionExpiresAt:
admin.firestore
.Timestamp
.fromDate(
newExpiresAt
),
freeVideoAvailable:
freeVideoState.freeVideoAvailable,
freeVideoRemaining:
freeVideoState.freeVideoRemaining,
freeVideoUsed:
freeVideoState.freeVideoUsed,
lastPaymentAmount:
paymentAmount,
lastPaymentRequestId:
paymentId,
lastPaymentAt:
admin.firestore
.FieldValue
.serverTimestamp(),
updatedAt:
admin.firestore
.FieldValue
.serverTimestamp()
},
{
merge:
true
}
);
}
);
return res.json({
success:
true,
message:
"Payment approved. Plan credits were added and a new 30-day entitlement was activated.",
paymentId
});
} catch (error) {
console.error(
"Approve payment error:",
error
);
let errorMsg =
"Failed to approve payment";
if (
error.message ===
"PAYMENT_NOT_FOUND"
) {
errorMsg =
"Payment request not found";
} else if (
error.message ===
"ALREADY_APPROVED"
) {
errorMsg =
"This payment has already been approved";
} else if (
error.message ===
"ALREADY_REJECTED"
) {
errorMsg =
"This payment was already rejected";
} else if (
error.message ===
"DUPLICATE_TRANSACTION"
) {
errorMsg =
"Duplicate transaction detected. This bank transaction was already approved.";
} else if (
error.message ===
"INVALID_PLAN"
) {
errorMsg =
"Invalid plan specified.";
} else if (
error.message ===
"INVALID_CURRENCY"
) {
errorMsg =
"Payment currency must be USD.";
} else if (
error.message ===
"INVALID_PAYMENT_AMOUNT"
) {
errorMsg =
"Invalid payment amount.";
} else if (
error.message ===
"AMOUNT_MISMATCH"
) {
errorMsg =
"Payment amount does not match the selected plan.";
} else if (
error.message ===
"USER_ID_MISSING"
) {
errorMsg =
"Payment request has no user ID.";
} else if (
error.message ===
"USER_NOT_FOUND"
) {
errorMsg =
"User account associated with this payment was not found.";
}
return res.status(
400
).json({
success:
false,
error:
errorMsg
});
}
}
);

/*
========================================================
ADMIN REJECT PAYMENT
========================================================
*/
app.post(
"/api/admin/payment-requests/:id/reject",
requireAdmin,
async (
req,
res
) => {
const paymentId =
req.params.id;
const adminUid =
req.adminUid;
const reason =
req.body?.reason;
if (
!reason ||
!String(
reason
).trim()
) {
return res.status(
400
).json({
success:
false,
error:
"Rejection reason is required"
});
}
try {
const paymentRef =
db
.collection(
"paymentRequests"
)
.doc(
paymentId
);
const paymentDoc =
await paymentRef.get();
if (
!paymentDoc.exists
) {
return res.status(
404
).json({
success:
false,
error:
"Payment request not found"
});
}
const payment =
paymentDoc.data() ||
{};
const status =
String(
payment.status ||
"pending"
).toLowerCase();
if (
status ===
"approved"
) {
return res.status(
400
).json({
success:
false,
error:
"This payment has already been approved"
});
}
if (
status ===
"rejected"
) {
return res.status(
400
).json({
success:
false,
error:
"This payment has already been rejected"
});
}
if (
status !==
"pending"
) {
return res.status(
400
).json({
success:
false,
error:
"Payment is not pending"
});
}
await paymentRef.update({
status:
"rejected",
rejectedAt:
admin.firestore
.FieldValue
.serverTimestamp(),
rejectedBy:
adminUid,
rejectionReason:
String(
reason
).trim()
});
return res.json({
success:
true,
message:
"Payment rejected successfully.",
paymentId
});
} catch (error) {
console.error(
"Reject payment error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to reject payment"
});
}
}
);

/*
========================================================
ADMIN TRASH PAYMENT — SOFT DELETE
========================================================
CRITICAL FIX: New route to move payment to trash
Does NOT delete the document, only marks it as deleted
========================================================
*/
app.post(
"/api/admin/payment-requests/:id/trash",
requireAdmin,
async (
req,
res
) => {
const paymentId =
req.params.id;
const adminUid =
req.adminUid;
try {
const paymentRef =
db
.collection(
"paymentRequests"
)
.doc(
paymentId
);
const paymentDoc =
await paymentRef.get();
if (
!paymentDoc.exists
) {
return res.status(
404
).json({
success:
false,
error:
"Payment request not found"
});
}
const payment =
paymentDoc.data() ||
{};
if (payment.deleted === true) {
return res.status(
400
).json({
success:
false,
error:
"This payment is already in trash"
});
}
/*
CRITICAL: Soft delete only — preserve all original data
*/
await paymentRef.update({
deleted:
true,
deletedAt:
admin.firestore
.FieldValue
.serverTimestamp(),
deletedBy:
adminUid
});
console.log(
"PAYMENT MOVED TO TRASH:",
paymentId
);
return res.json({
success:
true,
message:
"Payment moved to trash successfully.",
paymentId
});
} catch (error) {
console.error(
"Trash payment error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to move payment to trash"
});
}
}
);

/*
========================================================
ADMIN RESTORE PAYMENT
========================================================
CRITICAL FIX: New route to restore payment from trash
Removes the deleted state, preserves original status
========================================================
*/
app.post(
"/api/admin/payment-requests/:id/restore",
requireAdmin,
async (
req,
res
) => {
const paymentId =
req.params.id;
const adminUid =
req.adminUid;
try {
const paymentRef =
db
.collection(
"paymentRequests"
)
.doc(
paymentId
);
const paymentDoc =
await paymentRef.get();
if (
!paymentDoc.exists
) {
return res.status(
404
).json({
success:
false,
error:
"Payment request not found"
});
}
const payment =
paymentDoc.data() ||
{};
if (payment.deleted !== true) {
return res.status(
400
).json({
success:
false,
error:
"This payment is not in trash"
});
}
/*
CRITICAL: Remove deleted state, preserve original status
*/
await paymentRef.update({
deleted:
admin.firestore
.FieldValue.delete(),
deletedAt:
admin.firestore
.FieldValue.delete(),
deletedBy:
admin.firestore
.FieldValue.delete(),
restoredAt:
admin.firestore
.FieldValue
.serverTimestamp(),
restoredBy:
adminUid
});
console.log(
"PAYMENT RESTORED FROM TRASH:",
paymentId
);
return res.json({
success:
true,
message:
"Payment restored successfully.",
paymentId
});
} catch (error) {
console.error(
"Restore payment error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to restore payment"
});
}
}
);

/*
========================================================
ADMIN BATCH RESTORE PAYMENTS
========================================================
CRITICAL FIX: New route to restore multiple payments at once
========================================================
*/
app.post(
"/api/admin/payment-requests/batch-restore",
requireAdmin,
async (
req,
res
) => {
const adminUid =
req.adminUid;
const paymentIds =
req.body?.paymentIds;
if (
!Array.isArray(paymentIds) ||
paymentIds.length === 0
) {
return res.status(
400
).json({
success:
false,
error:
"paymentIds array is required"
});
}
try {
const batch =
db.batch();
let restoredCount = 0;
for (
const paymentId of paymentIds
) {
const paymentRef =
db
.collection(
"paymentRequests"
)
.doc(
paymentId
);
const paymentDoc =
await paymentRef.get();
if (
!paymentDoc.exists
) {
continue;
}
const payment =
paymentDoc.data() ||
{};
if (payment.deleted !== true) {
continue;
}
batch.update(
paymentRef,
{
deleted:
admin.firestore
.FieldValue.delete(),
deletedAt:
admin.firestore
.FieldValue.delete(),
deletedBy:
admin.firestore
.FieldValue.delete(),
restoredAt:
admin.firestore
.FieldValue
.serverTimestamp(),
restoredBy:
adminUid
}
);
restoredCount++;
}
if (restoredCount === 0) {
return res.json({
success:
true,
message:
"No payments needed restoration.",
restoredCount:
0
});
}
await batch.commit();
console.log(
"BATCH RESTORE COMPLETED:",
restoredCount,
"payments"
);
return res.json({
success:
true,
message:
`${restoredCount} payment(s) restored successfully.`,
restoredCount
});
} catch (error) {
console.error(
"Batch restore error:",
error
);
return res.status(
500
).json({
success:
false,
error:
"Failed to restore payments"
});
}
}
);

/*
========================================================
SERVER START
========================================================
*/
console.log(
"============================================================"
);
console.log(
"GAVEAI FINAL VIDEO + PAYMENT SYSTEM LOADED"
);
console.log(
"VIDEO PROVIDER: GaveAI"
);
console.log(
"FREE: 1 lifetime video"
);
console.log(
"PRO: $9.99 / 1,000 credits / 30 days"
);
console.log(
"PREMIUM: $19.99 / 1,500 credits / 30 days"
);
console.log(
"5 seconds: 15 credits"
);
console.log(
"8 seconds: 24 credits"
);
console.log(
"NO DAILY CREDITS"
);
console.log(
"NO 60 CREDITS/DAY"
);
console.log(
"CREDITS DO NOT ROLLOVER AFTER EXPIRATION"
);
console.log(
"TOP-UP: ADD PLAN CREDITS + NEW 30 DAYS"
);
console.log(
"ADMIN VIDEO GENERATION: UNLIMITED"
);
console.log(
"------------------------------------------------------------"
);
console.log(
"PAYMENT TRASH SYSTEM: ENABLED"
);
console.log(
"POST /api/admin/payment-requests/:id/trash"
);
console.log(
"POST /api/admin/payment-requests/:id/restore"
);
console.log(
"POST /api/admin/payment-requests/batch-restore"
);
console.log(
"GET /api/admin/payments?filter=trash"
);
console.log(
"============================================================"
);
app.listen(
PORT,
() => {
console.log(
`Gave Money Tips AI running on port ${PORT}`
);
console.log(
"Video Provider: GaveAI"
);
}
);