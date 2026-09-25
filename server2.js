require("dotenv").config();
const express = require("express");
const cors = require("cors");
const ImageKit = require("imagekit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");
const { generateAIResponse } = require("./backend/services/groqService");
const { transcribeAudio } = require("./backend/services/sttService");
const { getAudioUrl, normalizeLanguageCode } = require("./backend/services/ttsService");
const { generateWithGaveAIVideoProvider, getVideoProviderStatus } = require("./backend/services/gaveaiVideoProviderService");
const { db, admin } = require("./backend/firebaseAdmin");
const { renderGaveAIAudioForScenes, cleanupAudioFiles } = require("./backend/services/videoAudioService");

const app = express();

/* =========================================================
CONFIG
========================================================= */
const PORT = process.env.PORT || 3000;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "8eGkRNjIqycQa4ZIVwX8r6LVm4u1";
const FREE_VIDEO_COUNT = 1;
const PLANS = {
  pro: { price: 9.99, credits: 1000, durationDays: 30 },
  premium: { price: 19.99, credits: 1500, durationDays: 30 }
};
const VIDEO_CREDITS = { 5: 15, 8: 24 };
const GAVEAI_IMAGE_MODEL = process.env.GAVEAI_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
const GAVEAI_IMAGE_EDIT_VISION_MODEL = process.env.GAVEAI_IMAGE_EDIT_VISION_MODEL || "@cf/google/gemma-4-26b-a4b-it";
const GAVEAI_IMAGE_INPAINT_MODEL = process.env.GAVEAI_IMAGE_INPAINT_MODEL || "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const BANK_INFO = {
  bankName: "SOGEBANK",
  accountHolder: "Gave Victor",
  accountNumber: "2611111879",
  swift: "SOGHHTPP",
  currency: "USD"
};
const MAX_VIDEO_QUEUE = 10;
const MAX_CONCURRENT_VIDEOS = 2;
let activeVideoGenerations = 0;
let queuedVideoGenerations = 0;

/* [NEW] STRICT PROMPT RULES - Forces AI to follow user prompt exactly */
const STRICT_PROMPT_RULES = "STRICT GAVEAI EXECUTION RULES: Follow the user's prompt exactly. Do not add, remove, or change anything not explicitly requested. Do not add objects, characters, text, logos, watermarks, effects, music, narration, dialogue, SFX, or ambience unless the user explicitly requests them. Preserve all user-specified details exactly. Only perform the minimum technical normalization required by the API.";

const STRICT_EDIT_RULES = "STRICT IMAGE EDITING RULES: The uploaded reference image is the source of truth. ONLY modify the specific elements the user explicitly asks to modify. EVERYTHING ELSE must remain completely unchanged. Make the smallest possible change necessary to satisfy the user's request.";

function wrapStrictPrompt(userPrompt, isEdit = false) {
  const clean = String(userPrompt || "").trim();
  if (!clean) return clean;
  const rules = isEdit ? STRICT_EDIT_RULES : STRICT_PROMPT_RULES;
  return `${rules}\n\nUSER REQUEST: ${clean}`;
}

/* =========================================================
IMAGEKIT
========================================================= */
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

/* =========================================================
MULTER
========================================================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/* =========================================================
HELPERS
========================================================= */
function normalizePlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  if (plan === "pro") return "pro";
  if (plan === "premium") return "premium";
  return null;
}
function getPlanCredits(plan) {
  const normalized = normalizePlan(plan);
  return normalized ? PLANS[normalized].credits : 0;
}
function getPlanPrice(plan) {
  const normalized = normalizePlan(plan);
  return normalized ? PLANS[normalized].price : 0;
}
function getVideoCreditCost(duration) {
  return Number(duration) === 8 ? VIDEO_CREDITS[8] : VIDEO_CREDITS[5];
}
function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value._seconds === "number") return (value._seconds * 1000) + Math.floor((value._nanoseconds || 0) / 1000000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function timestampToISO(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value && typeof value._seconds === "number") return new Date((value._seconds * 1000) + Math.floor((value._nanoseconds || 0) / 1000000)).toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function calculateExpirationDate() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date;
}
function isSubscriptionActive(userData = {}) {
  const plan = normalizePlan(userData.subscriptionPlan || userData.plan);
  if (!plan) return false;
  const expiresAt = timestampToMillis(userData.subscriptionExpiresAt);
  if (!expiresAt) return false;
  return expiresAt > Date.now();
}
function getUserPlan(userData = {}) {
  const plan = normalizePlan(userData.subscriptionPlan || userData.plan);
  if (!plan) return null;
  if (!isSubscriptionActive(userData)) return null;
  return plan;
}
function isAdmin(userId) {
  return String(userId || "").trim() === String(ADMIN_USER_ID || "").trim();
}
function normalizeFreeVideoState(userData = {}) {
  const used = userData.freeVideoUsed === true || Number(userData.freeVideoRemaining ?? 1) <= 0 || userData.freeVideoAvailable === false;
  return {
    freeVideoUsed: used,
    freeVideoRemaining: used ? 0 : FREE_VIDEO_COUNT,
    freeVideoAvailable: !used
  };
}
function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) { console.error("File cleanup error:", error.message); }
}
function ensureDirectory(directory) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  return directory;
}
function genericVideoError(error, userId) {
  const message = String(error?.message || "").toLowerCase();
  const adminUser = isAdmin(userId);
  const providerCreditError = message.includes("wavespeed") && (message.includes("insufficient") || message.includes("credit") || message.includes("balance") || message.includes("quota") || message.includes("exhausted") || message.includes("limit"));
  if (adminUser && providerCreditError) return "Top up your account to get your unlimited credits and sell credits to other users.";
  if (message.includes("insufficient_credits") || message.includes("insufficient credits") || message.includes("not enough credits")) return "You don't have credits. Choose a plan to generate video.";
  if (message.includes("paid_plan_required") || message.includes("paid plan required")) return "You don't have credits. Choose a plan to generate video.";
  if (message.includes("subscription_expired") || message.includes("subscription expired")) return "Your subscription has expired. Choose a plan to generate video.";
  if (message.includes("free_video_already_used") || message.includes("free video already used")) return "Your 1 lifetime free video has already been used. Choose a plan to generate another video.";
  if (message.includes("video_duration_invalid")) return "Video duration must be 5 or 8 seconds.";
  if (message.includes("video_queue_full")) return "GaveAI video generation queue is full. Please try again shortly.";
  return "GaveAI video generation failed. Please try again.";
}

/* [NEW] Process expired credit entitlements for a user */
async function processExpiredEntitlements(userId) {
  if (isAdmin(userId)) return 0;

  try {
    const snapshot = await db.collection("creditEntitlements")
      .where("userId", "==", userId)
      .where("status", "==", "active")
      .get();

    const now = Date.now();
    let totalExpiredCredits = 0;
    const expiredEntitlements = [];

    for (const doc of snapshot.docs) {
      const ent = doc.data() || {};
      const expiresAt = timestampToMillis(ent.expiresAt);

      if (expiresAt > 0 && expiresAt <= now) {
        const unusedCredits = Math.max(
          0,
          safeNumber(ent.creditsRemaining, 0)
        );

        if (unusedCredits > 0) {
          totalExpiredCredits += unusedCredits;
        }

        expiredEntitlements.push({
          ref: doc.ref,
          unusedCredits
        });
      }
    }

    if (expiredEntitlements.length === 0) {
      return 0;
    }

    const userRef = db.collection("users").doc(userId);
    const poolRef = db.collection("creditPool").doc("inventory");
    const nowTimestamp = admin.firestore.Timestamp.now();

    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const poolSnap = await transaction.get(poolRef);

      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const poolData = poolSnap.exists ? poolSnap.data() || {} : {};

      const currentCredits = Math.max(
        0,
        safeNumber(userData.credits, 0)
      );

      const availableCredits = Math.max(
        0,
        safeNumber(poolData.availableCredits, 0)
      );

      const totalReturnedCredits = Math.max(
        0,
        safeNumber(poolData.totalReturnedCredits, 0)
      );

      const newUserCredits = Math.max(
        0,
        currentCredits - totalExpiredCredits
      );

      const newAvailableCredits =
        availableCredits + totalExpiredCredits;

      const newTotalReturnedCredits =
        totalReturnedCredits + totalExpiredCredits;

      transaction.set(
        userRef,
        {
          credits: newUserCredits,
          updatedAt: nowTimestamp
        },
        { merge: true }
      );

      transaction.set(
        poolRef,
        {
          availableCredits: newAvailableCredits,
          totalReturnedCredits: newTotalReturnedCredits,
          totalResoldCredits: Math.max(
            0,
            safeNumber(poolData.totalResoldCredits, 0)
          ),
          updatedAt: nowTimestamp
        },
        { merge: true }
      );

      for (const item of expiredEntitlements) {
        transaction.update(item.ref, {
          status: "expired",
          creditsRemaining: 0,
          expiredCredits: item.unusedCredits,
          expiredAt: nowTimestamp,
          updatedAt: nowTimestamp
        });

        if (item.unusedCredits > 0) {
          const ledgerRef = createCreditLedgerRef();

          transaction.set(ledgerRef, {
            type: "RETURNED",
            userId,
            credits: item.unusedCredits,
            source: "credit_entitlement",
            destination: "credit_pool",
            reason: "credit_entitlement_expired",
            entitlementId: item.ref.id,
            createdAt: nowTimestamp
          });
        }
      }
    });

    console.log(
      `CREDIT POOL: Returned ${totalExpiredCredits} expired unused credits from user ${userId}.`
    );

    return totalExpiredCredits;
  } catch (error) {
    console.error("EXPIRED ENTITLEMENTS ERROR:", error);
    return 0;
  }
}

/* =========================================================
CREDIT ENTITLEMENT EXPIRATION
Credits expire after 2 calendar months.
Subscription expiration remains controlled separately.
========================================================= */

function addCreditExpirationMonths(dateValue, months = 2) {
  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return new Date();
  }

  const originalDay = date.getDate();

  date.setDate(1);
  date.setMonth(date.getMonth() + months);

  const lastDayOfTargetMonth = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0
  ).getDate();

  date.setDate(
    Math.min(originalDay, lastDayOfTargetMonth)
  );

  return date;
}

function getCreditEntitlementExpiration(createdAt = new Date()) {
  return admin.firestore.Timestamp.fromDate(
    addCreditExpirationMonths(createdAt, 2)
  );
}

function createCreditLedgerRef() {
  return db.collection("creditPoolTransactions").doc();
}

/* [NEW] Create credit entitlement record when payment is approved */
async function createCreditEntitlement(userId, plan, credits, expiresAt, paymentId) {
  const now = admin.firestore.Timestamp.now();
  return await db.collection("creditEntitlements").add({
    userId,
    plan,
    creditsGranted: credits,
    creditsUsed: 0,
    creditsRemaining: credits,
    createdAt: now,
    expiresAt,
    status: "active",
    paymentReference: paymentId,
    updatedAt: now
  });
}

/* =========================================================
CORS
========================================================= */
const allowedOrigins = ["https://gavemoneystips.blogspot.com", "https://gavemoneytips.blogspot.com", "http://localhost:3000"];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn("Blocked CORS origin:", origin);
    return callback(new Error("CORS origin not allowed."));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin"],
  credentials: true
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* =========================================================
ROOT - [FIXED] Removed mojibake
========================================================= */
app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running");
});

/* =========================================================
HEALTH - [FIXED] Removed mojibake
========================================================= */
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    message: "Gave Money Tips AI Backend is running",
    provider: "GaveAI",
    firebaseConfigured: !!db,
    imageGenerationConfigured: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    imageProvider: "GaveAI",
    imageModel: GAVEAI_IMAGE_MODEL,
    imageKitConfigured: !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT),
    audioConfigured: true,
    activeVideoGenerations,
    queuedVideoGenerations,
    maxConcurrentVideos: MAX_CONCURRENT_VIDEOS,
    maxVideoQueue: MAX_VIDEO_QUEUE
  });
});

/* =========================================================
PLANS
========================================================= */
app.get("/api/plans", (req, res) => {
  res.json({
    success: true,
    free: { price: 0, lifetimeVideos: 1, credits: 0 },
    pro: { ...PLANS.pro },
    premium: { ...PLANS.premium },
    videoCredits: { 5: VIDEO_CREDITS[5], 8: VIDEO_CREDITS[8] },
    noDailyCredits: true,
    noRollover: true,
    topUpAddsNew30DayEntitlement: true
  });
});

app.get("/api/payment-bank-info", requireAuthenticatedUser, (req, res) => {
  res.json({ success: true, bank: BANK_INFO });
});

app.get("/api/payment-status", requireAuthenticatedUser, (req, res) => {
  res.json({ success: true, paymentSystem: "manual-bank-transfer", adminApprovalRequired: true, bank: BANK_INFO, plans: PLANS });
});

app.get("/api/video-provider-status", requireAuthenticatedUser, async (req, res) => {
  try {
    const providerStatus = await getVideoProviderStatus();
    res.json({ success: true, provider: "GaveAI", status: providerStatus });
  } catch (error) {
    console.error("Video provider status error:", error);
    res.json({ success: true, provider: "GaveAI", status: "available" });
  }
});

/* =========================================================
FIREBASE AUTH
========================================================= */
async function requireAuthenticatedUser(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "User authentication is required." });
    }
    const idToken = authorization.substring(7).trim();
    if (!idToken) return res.status(401).json({ success: false, error: "User authentication is required." });
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    if (!decodedToken?.uid) return res.status(401).json({ success: false, error: "Invalid authentication token." });
    req.userUid = decodedToken.uid;
    req.userToken = decodedToken;
    next();
  } catch (error) {
    console.error("Firebase authentication error:", error);
    return res.status(401).json({ success: false, error: "User authentication is required." });
  }
}

async function requireAdmin(req, res, next) {
  try {
    if (!isAdmin(req.userUid)) return res.status(403).json({ success: false, error: "Administrator access required." });
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: "Administrator access required." });
  }
}

/* =========================================================
FIRESTORE USER HELPERS
========================================================= */
async function getUserDocument(userId) {
  if (!userId) return null;
  const snapshot = await db.collection("users").doc(userId).get();
  if (!snapshot.exists) return null;
  return { id: snapshot.id, ...snapshot.data() };
}

async function getOrCreateUserDocument(userId) {
  if (!userId) throw new Error("User ID is required.");
  const ref = db.collection("users").doc(userId);
  const snapshot = await ref.get();
  if (snapshot.exists) return { ref, data: snapshot.data() || {} };
  const now = admin.firestore.Timestamp.now();
  const initialData = {
    uid: userId, credits: 0, plan: null, subscriptionPlan: null, subscriptionExpiresAt: null,
    freeVideoUsed: false, freeVideoRemaining: FREE_VIDEO_COUNT, freeVideoAvailable: true,
    createdAt: now, updatedAt: now
  };
  await ref.set(initialData, { merge: true });
  return { ref, data: initialData };
}

async function getUserCredits(userId) {
  const userData = await getUserDocument(userId);
  if (!userData) return 0;
  return Math.max(0, safeNumber(userData.credits, 0));
}

async function uploadBufferToImageKit(buffer, fileName, folder) {
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("Upload buffer is required.");
  if (!process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_PRIVATE_KEY || !process.env.IMAGEKIT_URL_ENDPOINT) {
    throw new Error("ImageKit is not configured.");
  }
  const result = await imagekit.upload({ file: buffer, fileName, folder, useUniqueFileName: true });
  return { url: result.url, fileId: result.fileId || null, name: result.name || fileName, filePath: result.filePath || null };
}

/* =========================================================
ACCOUNT - [CHANGED] Process expired entitlements first
========================================================= */
app.get("/api/account", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    /* [NEW] Process expired entitlements before returning account */
    await processExpiredEntitlements(userId);
    const userData = await getUserDocument(userId);
    if (!userData) {
      return res.json({
        success: true,
        user: { uid: userId, credits: 0, plan: null, subscriptionPlan: null, subscriptionExpiresAt: null, ...normalizeFreeVideoState({}) }
      });
    }
    const freeState = normalizeFreeVideoState(userData);
    const activePlan = getUserPlan(userData);
    res.json({
      success: true,
      user: {
        ...userData, uid: userId,
        credits: Math.max(0, safeNumber(userData.credits, 0)),
        plan: activePlan, subscriptionPlan: activePlan,
        subscriptionExpiresAt: timestampToISO(userData.subscriptionExpiresAt),
        freeVideoUsed: freeState.freeVideoUsed,
        freeVideoRemaining: freeState.freeVideoRemaining,
        freeVideoAvailable: freeState.freeVideoAvailable,
        isAdmin: isAdmin(userId)
      }
    });
  } catch (error) {
    console.error("Account error:", error);
    res.status(500).json({ success: false, error: "Unable to load account." });
  }
});

app.get("/api/imagekit-auth", requireAuthenticatedUser, (req, res) => {
  try {
    if (!process.env.IMAGEKIT_PRIVATE_KEY) return res.status(500).json({ success: false, error: "ImageKit is not configured." });
    const authenticationParameters = imagekit.getAuthenticationParameters();
    res.json({ success: true, ...authenticationParameters });
  } catch (error) {
    console.error("ImageKit auth error:", error);
    res.status(500).json({ success: false, error: "Unable to create ImageKit authentication parameters." });
  }
});

/* =========================================================
CHAT
========================================================= */
app.post("/chat", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const message = String(req.body?.message || req.body?.prompt || "").trim();
    const imageUrl = req.body?.imageUrl || null;
    if (!message) return res.status(400).json({ success: false, error: "Message is required." });
    const conversation = Array.isArray(req.body?.conversation) ? req.body.conversation : [];
    const aiResult = await generateAIResponse(message, { userId, imageUrl, conversation });
    const reply = typeof aiResult === "string" ? aiResult : aiResult?.reply || aiResult?.response || aiResult?.content || aiResult?.message || "";
    if (!reply) throw new Error("AI did not generate a response.");
    res.json({ success: true, reply, response: reply, message: reply });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ success: false, error: "GaveAI could not generate a response. Please try again." });
  }
});

/* =========================================================
IMAGE GENERATION / EDITING
========================================================= */
async function prepareFluxReferenceImage(imageUrl) {
  const source = String(imageUrl || "").trim();
  if (!source) return null;
  try {
    let inputBuffer;
    let inputMime = "image/jpeg";
    if (source.startsWith("data:image/")) {
      const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      if (!match) throw new Error("IMAGE_REFERENCE_INVALID");
      inputMime = match[1];
      inputBuffer = Buffer.from(match[2], "base64");
    } else if (source.startsWith("http://") || source.startsWith("https://")) {
      const response = await axios.get(source, { responseType: "arraybuffer", timeout: 60000, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024, validateStatus: () => true });
      if (response.status < 200 || response.status >= 300) throw new Error("IMAGE_REFERENCE_DOWNLOAD_FAILED");
      inputBuffer = Buffer.from(response.data);
      const detectedMime = String(response.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (detectedMime.startsWith("image/")) inputMime = detectedMime;
    } else {
      throw new Error("IMAGE_REFERENCE_INVALID");
    }
    if (!inputBuffer || !inputBuffer.length) throw new Error("IMAGE_REFERENCE_EMPTY");
    const resizedBuffer = await sharp(inputBuffer).rotate().resize({ width: 511, height: 511, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    const metadata = await sharp(resizedBuffer).metadata();
    if (!metadata.width || !metadata.height || metadata.width >= 512 || metadata.height >= 512) {
      throw new Error("IMAGE_REFERENCE_SIZE_INVALID");
    }
    return { buffer: resizedBuffer, mimeType: "image/jpeg", fileName: "reference-image.jpg" };
  } catch (error) {
    if (String(error?.message || "").startsWith("IMAGE_REFERENCE_")) throw error;
    console.error("FLUX reference image preparation error:", error);
    throw new Error("IMAGE_REFERENCE_PROCESSING_FAILED");
  }
}

async function analyzeImageEditRegion(imageBuffer, mimeType, editInstruction) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("Cloudflare AI credentials are missing.");
  const imageBase64 = imageBuffer.toString("base64");
  const response = await axios.post(
    "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/ai/run/" + GAVEAI_IMAGE_EDIT_VISION_MODEL,
    {
      messages: [
        { role: "system", content: "You are a precise image-editing vision assistant. Return only valid JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: `Analyze this image and identify the smallest practical rectangular region containing the object or area the user wants to edit.\nUSER REQUEST:\n${String(editInstruction || "").trim()}\nReturn ONLY JSON:\n{"found": true, "target": "short description", "x": 0, "y": 0, "width": 0, "height": 0}\nCoordinates must be normalized from 0 to 1000.` },
            { type: "image_url", image_url: { url: "data:" + (mimeType || "image/jpeg") + ";base64," + imageBase64 } }
          ]
        }
      ],
      temperature: 0,
      max_completion_tokens: 300
    },
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, timeout: 120000 }
  );
  const result = response.data?.result || {};
  const choices = result.choices || [];
  let content = choices[0]?.message?.content || result.response || result.content || "";
  if (typeof content !== "string") content = JSON.stringify(content);
  content = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(content); } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemma Vision returned invalid region data.");
    parsed = JSON.parse(match[0]);
  }
  if (!parsed || parsed.found !== true) return { found: false, target: parsed?.target || "" };
  const clamp = (value) => Math.max(0, Math.min(1000, Number(value) || 0));
  const region = { found: true, target: String(parsed.target || "").trim(), x: clamp(parsed.x), y: clamp(parsed.y), width: clamp(parsed.width), height: clamp(parsed.height) };
  if (region.width <= 0 || region.height <= 0) return { found: false, target: region.target };
  return region;
}

async function createLocalizedInpaintMask(imageBuffer, region) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) throw new Error("Valid image buffer is required.");
  if (!region || region.found !== true) throw new Error("No valid edit region detected.");
  const metadata = await sharp(imageBuffer).metadata();
  const imageWidth = metadata.width;
  const imageHeight = metadata.height;
  if (!imageWidth || !imageHeight) throw new Error("Unable to determine image dimensions.");
  let left = Math.round((region.x / 1000) * imageWidth);
  let top = Math.round((region.y / 1000) * imageHeight);
  let width = Math.round((region.width / 1000) * imageWidth);
  let height = Math.round((region.height / 1000) * imageHeight);
  const padX = Math.max(2, Math.round(width * 0.01));
  const padY = Math.max(2, Math.round(height * 0.01));
  left = Math.max(0, left - padX);
  top = Math.max(0, top - padY);
  width = Math.min(imageWidth - left, width + padX * 2);
  height = Math.min(imageHeight - top, height + padY * 2);
  const svg = `<svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="black"/><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white"/></svg>`;
  const mask = await sharp({ create: { width: imageWidth, height: imageHeight, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .grayscale()
    .png()
    .toBuffer();
  return { buffer: mask, width: imageWidth, height: imageHeight, region: { left, top, width, height } };
}

async function generateGaveAILocalizedEdit({ imageBuffer, prompt, region }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("Cloudflare AI credentials are missing.");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Edit prompt is required.");
  const image = await sharp(imageBuffer).jpeg({ quality: 92 }).toBuffer();
  const maskResult = await createLocalizedInpaintMask(image, region);
  const payload = {
    image_b64: image.toString("base64"),
    mask: Array.from(maskResult.buffer),
    prompt: cleanPrompt,
    width: maskResult.width,
    height: maskResult.height,
    num_steps: 24,
    guidance: 6.0,
    strength: 0.35
  };
  const response = await axios.post(
    "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/ai/run/" + GAVEAI_IMAGE_INPAINT_MODEL,
    payload,
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 180000, maxContentLength: 50 * 1024 * 1024, maxBodyLength: 50 * 1024 * 1024 }
  );
  return { buffer: Buffer.from(response.data), mimeType: response.headers["content-type"] || "image/png", region: maskResult.region };
}

async function generateGaveAIImage({ prompt, imageUrl = null, width = 1024, height = 1024, seed = -1 }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("IMAGE_PROMPT_REQUIRED");
  const numericWidth = Math.min(1920, Math.max(256, Number(width) || 1024));
  const numericHeight = Math.min(1920, Math.max(256, Number(height) || 1024));
  const numericSeed = Number.isFinite(Number(seed)) ? Number(seed) : -1;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${GAVEAI_IMAGE_MODEL}`;
  const form = new FormData();
  const reference = await prepareFluxReferenceImage(imageUrl);
  if (reference) {
    /* [FIXED] Blob only takes 2 arguments. fileName goes in form.append() */
    form.append("input_image_0", new Blob([reference.buffer], { type: reference.mimeType }), reference.fileName);
  }
  form.append("prompt", cleanPrompt);
  form.append("width", String(Math.round(numericWidth)));
  form.append("height", String(Math.round(numericHeight)));
  if (Number.isFinite(numericSeed) && numericSeed >= 0) form.append("seed", String(Math.round(numericSeed)));
  try {
    const response = await axios.post(endpoint, form, {
      headers: { Authorization: `Bearer ${apiToken}` },
      responseType: "arraybuffer", timeout: 180000,
      maxContentLength: 50 * 1024 * 1024, maxBodyLength: 50 * 1024 * 1024,
      validateStatus: () => true
    });
    const contentType = String(response.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    const rawBuffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || "");
    if (response.status < 200 || response.status >= 300) {
      let providerMessage = "";
      try {
        const errorText = rawBuffer.toString("utf8");
        const errorJson = JSON.parse(errorText);
        providerMessage = String(errorJson?.errors?.[0]?.message || errorJson?.result?.error || errorJson?.error || "");
      } catch (_) {}
      console.error("Cloudflare FLUX.2 image error:", { status: response.status, providerMessage });
      throw new Error(`IMAGE_PROVIDER_FAILED_${response.status}`);
    }
    if (contentType.startsWith("image/")) {
      if (!rawBuffer.length) throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
      return { buffer: rawBuffer, mimeType: contentType };
    }
    let data;
    try { data = JSON.parse(rawBuffer.toString("utf8")); } catch (parseError) {
      console.error("Unable to parse FLUX.2 response:", parseError);
      throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
    }
    let base64Image = data?.result?.image || data?.result?.image_base64 || data?.result?.base64 || data?.image || data?.image_base64 || null;
    if (typeof base64Image !== "string" || !base64Image.trim()) {
      console.error("FLUX.2 response did not contain an image:", data);
      throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
    }
    base64Image = base64Image.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, "");
    const imageBuffer = Buffer.from(base64Image, "base64");
    if (!imageBuffer.length) throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
    return { buffer: imageBuffer, mimeType: "image/jpeg" };
  } catch (error) {
    if (String(error?.message || "").startsWith("IMAGE_PROVIDER_")) throw error;
    console.error("Cloudflare FLUX.2 image generation error:", error);
    throw new Error("IMAGE_PROVIDER_FAILED");
  }
}

async function uploadGeneratedImageToImageKit(buffer, userId, mimeType = "image/jpeg") {
  if (!buffer || !buffer.length) throw new Error("IMAGE_GENERATION_FAILED");
  const extension = String(mimeType).toLowerCase().includes("png") ? "png" : String(mimeType).toLowerCase().includes("webp") ? "webp" : "jpg";
  return await imagekit.upload({
    file: buffer,
    fileName: `gaveai-image-${userId}-${Date.now()}.${extension}`,
    folder: "gavemoneytips/generated-images",
    useUniqueFileName: true,
    tags: ["gave-money-tips", "gaveai", "generated-image", String(userId)]
  });
}

app.get("/api/image-generation-status", requireAuthenticatedUser, (req, res) => {
  const configured = !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
  res.json({
    success: true, provider: "GaveAI", configured, model: GAVEAI_IMAGE_MODEL,
    imageKitConfigured: !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT)
  });
});

/* =========================================================
GENERATE / EDIT IMAGE - [CHANGED] Wrap prompt with strict rules
========================================================= */
app.post("/generate-image", requireAuthenticatedUser, async (req, res) => {
  try {
    const rawPrompt = String(req.body?.prompt || req.body?.description || req.body?.message || req.body?.text || "").trim();
    if (!rawPrompt) return res.status(400).json({ success: false, provider: "GaveAI", error: "Image prompt is required." });
    const imageUrl = String(req.body?.imageUrl || req.body?.referenceImageUrl || req.body?.inputImage || "").trim() || null;
    const width = Math.min(1920, Math.max(256, Number(req.body?.width) || 1024));
    const height = Math.min(1920, Math.max(256, Number(req.body?.height) || 1024));
    const seed = Number.isFinite(Number(req.body?.seed)) ? Number(req.body.seed) : -1;
    /* [CHANGED] Wrap prompt with strict rules */
    const isEdit = !!imageUrl;
    const strictPrompt = wrapStrictPrompt(rawPrompt, isEdit);
    let generated;
    if (imageUrl) {
      console.log("GAVEAI IMAGE EDIT: direct FLUX reference-image editing");
      generated = await generateGaveAIImage({ prompt: strictPrompt, imageUrl, width, height, seed });
      generated = { ...generated, edited: true };
      console.log("GAVEAI IMAGE EDIT: direct reference editing completed");
    } else {
      console.log("GAVEAI IMAGE GENERATION: FLUX.2");
      generated = await generateGaveAIImage({ prompt: strictPrompt, imageUrl: null, width, height, seed });
    }
    const uploaded = await uploadGeneratedImageToImageKit(generated.buffer, req.userUid, generated.mimeType);
    res.json({
      success: true, provider: "GaveAI", type: "image",
      message: imageUrl ? "Image edited successfully!" : "Image generated successfully!",
      imageUrl: uploaded.url, url: uploaded.url, fileId: uploaded.fileId, fileName: uploaded.name,
      generatedMedia: { type: "image", url: uploaded.url, provider: "GaveAI" },
      prompt: rawPrompt, model: GAVEAI_IMAGE_MODEL, edited: !!imageUrl, width, height, seed
    });
  } catch (error) {
    console.error("========== GAVEAI IMAGE EDIT ERROR ==========");
    console.error("ERROR MESSAGE:", error?.message || error);
    console.error("============================================");
    let status = 500;
    let friendlyError = "GaveAI image generation failed. Please try again.";
    const message = String(error?.message || "");
    if (message === "IMAGE_PROVIDER_NOT_CONFIGURED") friendlyError = "GaveAI image generation is not configured.";
    else if (message === "IMAGE_PROMPT_REQUIRED") { status = 400; friendlyError = "Image prompt is required."; }
    else if (message === "IMAGE_REFERENCE_INVALID") { status = 400; friendlyError = "The reference image URL is invalid."; }
    else if (message === "IMAGE_REFERENCE_DOWNLOAD_FAILED") { status = 400; friendlyError = "GaveAI could not access the reference image."; }
    else if (message === "IMAGE_REFERENCE_EMPTY") { status = 400; friendlyError = "The reference image is empty."; }
    else if (message === "IMAGE_REFERENCE_SIZE_INVALID" || message === "IMAGE_REFERENCE_PROCESSING_FAILED") { status = 400; friendlyError = "GaveAI could not prepare the reference image for editing."; }
    else if (message === "IMAGE_PROVIDER_EMPTY_RESULT") friendlyError = "GaveAI image generation returned no image.";
    else if (message.startsWith("IMAGE_PROVIDER_FAILED_")) friendlyError = "GaveAI image generation provider rejected the request. Please try again.";
    return res.status(status).json({ success: false, provider: "GaveAI", error: friendlyError });
  }
});

/* =========================================================
UPLOADS
========================================================= */
app.post("/upload-profile-photo", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Profile photo is required." });
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "profile-photo", "gavemoneytips/profile-photos");
    await db.collection("users").doc(req.userUid).set({ profilePhotoUrl: result.url, profilePhotoFileId: result.fileId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true, url: result.url, fileId: result.fileId, fileName: result.name });
  } catch (error) {
    console.error("Profile photo upload error:", error);
    res.status(500).json({ success: false, error: "Profile photo upload failed." });
  }
});

app.post("/upload-certificate", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Certificate file is required." });
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "certificate", "certificates");
    res.json({ success: true, url: result.url, fileId: result.fileId, fileName: result.name });
  } catch (error) {
    console.error("Certificate upload error:", error);
    res.status(500).json({ success: false, error: "Certificate upload failed." });
  }
});

app.post("/upload-media", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "File is required." });
    const requestedFolder = String(req.body?.folder || "").trim();
    const folder = requestedFolder || "gavemoneytips/chat-media";
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "media", folder);
    res.json({ success: true, url: result.url, fileId: result.fileId, fileName: result.name, folder });
  } catch (error) {
    console.error("Generic media upload error:", error);
    res.status(500).json({ success: false, error: "Media upload failed." });
  }
});

app.post("/upload-resume", requireAuthenticatedUser, upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Resume file is required." });
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "resume", "resumes");
    await db.collection("users").doc(req.userUid).set({ resumeUrl: result.url, resumeFileId: result.fileId, resumeFileName: result.name, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true, url: result.url, resumeUrl: result.url, fileId: result.fileId, fileName: result.name });
  } catch (error) {
    console.error("Resume upload error:", error);
    res.status(500).json({ success: false, error: "Resume upload failed." });
  }
});

/* =========================================================
PAYMENT HELPERS
========================================================= */
function normalizePaymentStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["pending", "approved", "rejected", "trash"].includes(status)) return status;
  return "pending";
}
function paymentStatusIsActive(status) { return status !== "trash"; }
function paymentToClient(id, data = {}) {
  const plan = normalizePlan(data.plan || data.subscriptionPlan);
  const status = normalizePaymentStatus(data.status);
  return {
    id, uid: data.uid || data.userId || null, userId: data.userId || data.uid || null,
    email: data.email || null, name: data.name || data.displayName || null, plan,
    price: safeNumber(data.amount ?? data.price ?? getPlanPrice(plan), 0),
    amount: safeNumber(data.amount ?? data.price ?? getPlanPrice(plan), 0),
    credits: safeNumber(data.credits ?? getPlanCredits(plan), 0),
    durationDays: safeNumber(data.durationDays ?? PLANS[plan]?.durationDays ?? 30, 30),
    status, reference: data.reference || data.transactionId || data.paymentReference || null,
    receiptUrl: data.receiptUrl || data.proofUrl || data.imageUrl || null,
    bankName: data.bankName || BANK_INFO.bankName, accountHolder: data.accountHolder || BANK_INFO.accountHolder,
    createdAt: timestampToISO(data.createdAt), submittedAt: timestampToISO(data.submittedAt),
    reviewedAt: timestampToISO(data.reviewedAt), approvedAt: timestampToISO(data.approvedAt),
    rejectedAt: timestampToISO(data.rejectedAt), deleted: data.deleted === true
  };
}

app.post("/api/payment-request", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const requestedPlan = normalizePlan(req.body?.plan);
    if (!requestedPlan) return res.status(400).json({ success: false, error: "A valid plan is required." });
    const planInfo = PLANS[requestedPlan];
    const reference = String(req.body?.reference || req.body?.transactionId || "").trim();
    const receiptUrl = String(req.body?.receiptUrl || req.body?.proofUrl || "").trim();
    const now = admin.firestore.Timestamp.now();
    const paymentData = {
      uid: userId, userId, plan: requestedPlan, subscriptionPlan: requestedPlan,
      amount: planInfo.price, price: planInfo.price, credits: planInfo.credits, durationDays: planInfo.durationDays,
      status: "pending", reference: reference || null, transactionId: reference || null, receiptUrl: receiptUrl || null,
      deleted: false, createdAt: now, submittedAt: now, updatedAt: now
    };
    const paymentRef = await db.collection("paymentRequests").add(paymentData);
    res.status(201).json({ success: true, message: "Payment request submitted successfully.", payment: paymentToClient(paymentRef.id, paymentData) });
  } catch (error) {
    console.error("Create payment request error:", error);
    res.status(500).json({ success: false, error: "Unable to submit payment request." });
  }
});

app.get("/api/payment-history", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const snapshot = await db.collection("paymentRequests").where("uid", "==", userId).get();
    const payments = snapshot.docs.map((doc) => paymentToClient(doc.id, doc.data())).sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, payments });
  } catch (error) {
    console.error("Payment history error:", error);
    res.status(500).json({ success: false, error: "Unable to load payment history." });
  }
});

/* =========================================================
ADMIN ROUTES
========================================================= */
app.get("/api/admin/payment-requests", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const statusFilter = String(req.query?.status || "all").trim().toLowerCase();
    const snapshot = await db.collection("paymentRequests").get();
    let payments = snapshot.docs.map((doc) => paymentToClient(doc.id, doc.data()));
    if (statusFilter !== "all") payments = payments.filter((payment) => payment.status === statusFilter);
    payments.sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, payments, total: payments.length });
  } catch (error) {
    console.error("Admin payment requests error:", error);
    res.status(500).json({ success: false, error: "Unable to load payment requests." });
  }
});

app.get("/api/admin/payments", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("paymentRequests").get();
    const payments = snapshot.docs.map((doc) => paymentToClient(doc.id, doc.data())).sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, payments, total: payments.length });
  } catch (error) {
    console.error("Admin payments error:", error);
    res.status(500).json({ success: false, error: "Unable to load payments." });
  }
});

/* [CHANGED] Customer payment approval uses credits from the global pool */
app.post("/api/admin/payment-requests/:paymentId/approve", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;

    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const poolRef = db.collection("creditPool").doc("inventory");

    const entitlementRef = db.collection("creditEntitlements").doc();
    const poolTransactionRef = db.collection("creditPoolTransactions").doc();
    const grantLedgerRef = db.collection("creditPoolTransactions").doc();

    const result = await db.runTransaction(async (transaction) => {
      const paymentSnapshot = await transaction.get(paymentRef);

      if (!paymentSnapshot.exists) {
        throw new Error("PAYMENT_NOT_FOUND");
      }

      const payment = paymentSnapshot.data() || {};
      const currentStatus = normalizePaymentStatus(payment.status);

      if (currentStatus === "approved") {
        return {
          alreadyApproved: true,
          payment
        };
      }

      if (currentStatus === "trash") {
        throw new Error("PAYMENT_IN_TRASH");
      }

      if (currentStatus === "rejected") {
        throw new Error("PAYMENT_ALREADY_REJECTED");
      }

      const userId = payment.uid || payment.userId;

      if (!userId) {
        throw new Error("PAYMENT_USER_MISSING");
      }

      const plan = normalizePlan(
        payment.plan || payment.subscriptionPlan
      );

      if (!plan) {
        throw new Error("PAYMENT_PLAN_INVALID");
      }

      const planInfo = PLANS[plan];

      if (!planInfo || planInfo.credits <= 0) {
        throw new Error("PAYMENT_PLAN_INVALID");
      }

      const userRef = db.collection("users").doc(userId);

      const userSnapshot = await transaction.get(userRef);
      const poolSnapshot = await transaction.get(poolRef);

      const userData = userSnapshot.exists
        ? userSnapshot.data() || {}
        : {};

      const poolData = poolSnapshot.exists
        ? poolSnapshot.data() || {}
        : {};

      const existingCredits = Math.max(
        0,
        safeNumber(userData.credits, 0)
      );

      const availableCredits = Math.max(
        0,
        safeNumber(poolData.availableCredits, 0)
      );

      const totalReturnedCredits = Math.max(
        0,
        safeNumber(poolData.totalReturnedCredits, 0)
      );

      const totalResoldCredits = Math.max(
        0,
        safeNumber(poolData.totalResoldCredits, 0)
      );

      const creditsToSell = Math.max(
        0,
        safeNumber(planInfo.credits, 0)
      );

      if (availableCredits < creditsToSell) {
        throw new Error("INSUFFICIENT_POOL_CREDITS");
      }

      const now = admin.firestore.Timestamp.now();

      const currentExpiry = timestampToMillis(
        userData.subscriptionExpiresAt
      );

      const baseDate =
        currentExpiry > Date.now()
          ? new Date(currentExpiry)
          : new Date();

      baseDate.setDate(
        baseDate.getDate() + planInfo.durationDays
      );

      const newExpiry =
        admin.firestore.Timestamp.fromDate(baseDate);

      /* Credit expiration is separate from subscription expiration. */
      const creditExpiration = getCreditEntitlementExpiration(now.toDate());

      const newCredits =
        existingCredits + creditsToSell;

      const newAvailableCredits =
        availableCredits - creditsToSell;

      const newTotalResoldCredits =
        totalResoldCredits + creditsToSell;

      transaction.set(
        userRef,
        {
          uid: userId,
          credits: newCredits,
          plan,
          subscriptionPlan: plan,
          subscriptionExpiresAt: newExpiry,
          updatedAt: now
        },
        { merge: true }
      );

      transaction.set(
        entitlementRef,
        {
          userId,
          plan,
          creditsGranted: creditsToSell,
          creditsUsed: 0,
          creditsRemaining: creditsToSell,
          createdAt: now,
          expiresAt: creditExpiration,
          status: "active",
          paymentReference: paymentId,
          source: "credit_pool_sale",
          updatedAt: now
        }
      );

      transaction.set(
        poolRef,
        {
          availableCredits: newAvailableCredits,
          totalReturnedCredits,
          totalResoldCredits: newTotalResoldCredits,
          updatedAt: now
        },
        { merge: true }
      );

      transaction.set(
        grantLedgerRef,
        {
          type: "GRANTED",
          userId,
          paymentId,
          plan,
          credits: creditsToSell,
          source: "credit_pool",
          destination: "user_credit_entitlement",
          reason: "credit_pool_sale",
          entitlementId: entitlementRef.id,
          createdAt: now,
          approvedBy: req.userUid
        }
      );

      transaction.set(
        poolTransactionRef,
        {
          type: "RESOLD",
          paymentId,
          userId,
          plan,
          credits: creditsToSell,
          reason: "pool_credit_sale",
          createdAt: now,
          approvedBy: req.userUid
        }
      );

      transaction.update(
        paymentRef,
        {
          status: "approved",
          approvedAt: now,
          reviewedAt: now,
          reviewedBy: req.userUid,
          updatedAt: now,
          deleted: false
        }
      );

      return {
        alreadyApproved: false,
        payment: {
          ...payment,
          status: "approved",
          creditsAdded: creditsToSell,
          totalCredits: newCredits,
          userId,
          plan
        },
        newExpiry,
        poolCreditsRemaining: newAvailableCredits,
        entitlementId: entitlementRef.id
      };
    });

    res.json({
      success: true,
      message: result.alreadyApproved
        ? "Payment was already approved."
        : "Payment approved successfully. Credits were transferred from the Credit Pool.",
      payment: paymentToClient(
        paymentId,
        result.payment
      ),
      creditPool: result.alreadyApproved
        ? undefined
        : {
            creditsResold: result.payment.creditsAdded,
            availableCredits: result.poolCreditsRemaining
          },
      entitlementId: result.entitlementId || null
    });
  } catch (error) {
    console.error("Approve payment error:", error);

    const message = String(
      error?.message || ""
    );

    if (message === "PAYMENT_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: "Payment request not found."
      });
    }

    if (message === "PAYMENT_IN_TRASH") {
      return res.status(400).json({
        success: false,
        error: "Payment is in trash and cannot be approved."
      });
    }

    if (message === "PAYMENT_ALREADY_REJECTED") {
      return res.status(400).json({
        success: false,
        error: "This payment has already been rejected."
      });
    }

    if (message === "PAYMENT_USER_MISSING") {
      return res.status(400).json({
        success: false,
        error: "Payment user information is missing."
      });
    }

    if (message === "PAYMENT_PLAN_INVALID") {
      return res.status(400).json({
        success: false,
        error: "Payment plan is invalid."
      });
    }

    if (message === "INSUFFICIENT_POOL_CREDITS") {
      return res.status(409).json({
        success: false,
        error: "The Credit Pool does not have enough credits to approve this purchase."
      });
    }

    return res.status(500).json({
      success: false,
      error: "Unable to approve payment."
    });
  }
});app.post("/api/admin/payment-requests/:paymentId/reject", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const snapshot = await paymentRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Payment request not found." });
    const payment = snapshot.data() || {};
    const status = normalizePaymentStatus(payment.status);
    if (status === "approved") return res.status(400).json({ success: false, error: "An approved payment cannot be rejected." });
    if (status === "trash") return res.status(400).json({ success: false, error: "Payment is already in trash." });
    const now = admin.firestore.Timestamp.now();
    await paymentRef.update({ status: "rejected", rejectedAt: now, reviewedAt: now, reviewedBy: req.userUid, updatedAt: now });
    res.json({ success: true, message: "Payment rejected successfully." });
  } catch (error) {
    console.error("Reject payment error:", error);
    res.status(500).json({ success: false, error: "Unable to reject payment." });
  }
});

app.post("/api/admin/payment-requests/:paymentId/trash", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const snapshot = await paymentRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Payment request not found." });
    const now = admin.firestore.Timestamp.now();
    await paymentRef.update({ status: "trash", deleted: true, deletedAt: now, deletedBy: req.userUid, updatedAt: now });
    res.json({ success: true, message: "Payment moved to trash successfully." });
  } catch (error) {
    console.error("Trash payment error:", error);
    res.status(500).json({ success: false, error: "Unable to move payment to trash." });
  }
});

app.post("/api/admin/payment-requests/:paymentId/restore", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const snapshot = await paymentRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Payment request not found." });
    const payment = snapshot.data() || {};
    const currentStatus = normalizePaymentStatus(payment.status);
    const restoredStatus = payment.previousStatus && ["pending", "approved", "rejected"].includes(payment.previousStatus) ? payment.previousStatus : "pending";
    const now = admin.firestore.Timestamp.now();
    await paymentRef.update({
      status: currentStatus === "trash" ? restoredStatus : currentStatus, deleted: false,
      deletedAt: admin.firestore.FieldValue.delete(), deletedBy: admin.firestore.FieldValue.delete(),
      previousStatus: admin.firestore.FieldValue.delete(), updatedAt: now, restoredAt: now, restoredBy: req.userUid
    });
    res.json({ success: true, message: "Payment restored successfully." });
  } catch (error) {
    console.error("Restore payment error:", error);
    res.status(500).json({ success: false, error: "Unable to restore payment." });
  }
});

app.delete("/api/admin/payment-requests/:paymentId", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const snapshot = await paymentRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Payment request not found." });
    await paymentRef.delete();
    res.json({ success: true, message: "Payment permanently deleted." });
  } catch (error) {
    console.error("Delete payment error:", error);
    res.status(500).json({ success: false, error: "Unable to delete payment." });
  }
});

app.post("/api/admin/users/:uid/add-credits", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const amount = safeNumber(req.body?.credits, 0);

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Credits amount must be greater than zero."
      });
    }

    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found."
      });
    }

    const userData = snapshot.data() || {};
    const oldCredits = Math.max(
      0,
      safeNumber(userData.credits, 0)
    );

    const newCredits = oldCredits + amount;
    const now = admin.firestore.Timestamp.now();

    const creditExpiration = getCreditEntitlementExpiration(
      now.toDate()
    );

    const entitlementRef =
      db.collection("creditEntitlements").doc();

    const ledgerRef = createCreditLedgerRef();

    await db.runTransaction(async (transaction) => {
      transaction.set(
        userRef,
        {
          credits: newCredits,
          updatedAt: now
        },
        { merge: true }
      );

      transaction.set(entitlementRef, {
        userId: targetUid,
        plan: userData.plan || userData.subscriptionPlan || null,
        creditsGranted: amount,
        creditsUsed: 0,
        creditsRemaining: amount,
        createdAt: now,
        expiresAt: creditExpiration,
        status: "active",
        paymentReference: null,
        source: "admin_credit_adjustment",
        updatedAt: now
      });

      transaction.set(ledgerRef, {
        type: "GRANTED",
        userId: targetUid,
        credits: amount,
        source: "admin_credit_adjustment",
        destination: "user_credit_entitlement",
        reason: "admin_manual_credit_add",
        entitlementId: entitlementRef.id,
        createdAt: now,
        approvedBy: req.userUid
      });
    });

    res.json({
      success: true,
      message: "Credits added successfully.",
      uid: targetUid,
      previousCredits: oldCredits,
      addedCredits: amount,
      credits: newCredits,
      entitlementId: entitlementRef.id,
      expiresAt: creditExpiration.toDate().toISOString()
    });
  } catch (error) {
    console.error("Admin add credits error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to add credits."
    });
  }
});
app.post("/api/admin/users/:uid/remove-credits", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const amount = safeNumber(req.body?.credits, 0);

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Credits amount must be greater than zero."
      });
    }

    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found."
      });
    }

    const userData = snapshot.data() || {};
    const oldCredits = Math.max(
      0,
      safeNumber(userData.credits, 0)
    );

    const removedCredits = Math.min(
      amount,
      oldCredits
    );

    const newCredits = Math.max(
      0,
      oldCredits - removedCredits
    );

    const now = admin.firestore.Timestamp.now();

    const activeEntitlements = await getActiveCreditEntitlements(
      targetUid
    );

    const entitlementSnapshots = [];

    await db.runTransaction(async (transaction) => {
      for (const item of activeEntitlements) {
        const entitlementSnapshot = await transaction.get(item.ref);

        if (entitlementSnapshot.exists) {
          entitlementSnapshots.push({
            ref: item.ref,
            snapshot: entitlementSnapshot
          });
        }
      }

      let remainingToRemove = removedCredits;

      for (const item of entitlementSnapshots) {
        if (remainingToRemove <= 0) {
          break;
        }

        const entitlement = item.snapshot.data() || {};

        const granted = Math.max(
          0,
          safeNumber(entitlement.creditsGranted, 0)
        );

        const used = Math.max(
          0,
          safeNumber(entitlement.creditsUsed, 0)
        );

        const storedRemaining = safeNumber(
          entitlement.creditsRemaining,
          granted - used
        );

        const currentRemaining = Math.max(
          0,
          Math.min(
            storedRemaining,
            Math.max(0, granted - used)
          )
        );

        if (currentRemaining <= 0) {
          continue;
        }

        const amountToRemove = Math.min(
          remainingToRemove,
          currentRemaining
        );

        const newRemaining = Math.max(
          0,
          currentRemaining - amountToRemove
        );

        transaction.update(item.ref, {
          creditsRemaining: newRemaining,
          updatedAt: now
        });

        remainingToRemove -= amountToRemove;
      }

      transaction.set(
        userRef,
        {
          credits: newCredits,
          updatedAt: now
        },
        { merge: true }
      );

      const ledgerRef = createCreditLedgerRef();

      transaction.set(ledgerRef, {
        type: "REMOVED",
        userId: targetUid,
        credits: removedCredits,
        source: "user_credit_entitlement",
        destination: "credit_adjustment",
        reason: "admin_manual_credit_remove",
        createdAt: now,
        approvedBy: req.userUid
      });
    });

    res.json({
      success: true,
      message: "Credits removed successfully.",
      uid: targetUid,
      previousCredits: oldCredits,
      requestedRemoval: amount,
      removedCredits,
      credits: newCredits
    });
  } catch (error) {
    console.error("Admin remove credits error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to remove credits."
    });
  }
});
app.post("/api/admin/users/:uid/reset-free-video", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    await userRef.update({ freeVideoUsed: false, freeVideoRemaining: FREE_VIDEO_COUNT, freeVideoAvailable: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, message: "Lifetime free video has been reset." });
  } catch (error) {
    console.error("Reset free video error:", error);
    res.status(500).json({ success: false, error: "Unable to reset free video." });
  }
});

/* [FIXED] Removed duplicate /activate-subscription and /cancel-subscription routes that were at the end of the file */
app.post("/api/admin/users/:uid/activate-subscription", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const plan = normalizePlan(req.body?.plan);

    if (!plan) {
      return res.status(400).json({
        success: false,
        error: "A valid plan is required."
      });
    }

    const planInfo = PLANS[plan];
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found."
      });
    }

    const userData = snapshot.data() || {};

    const oldCredits = Math.max(
      0,
      safeNumber(userData.credits, 0)
    );

    const currentExpiry = timestampToMillis(
      userData.subscriptionExpiresAt
    );

    const baseDate =
      currentExpiry > Date.now()
        ? new Date(currentExpiry)
        : new Date();

    baseDate.setDate(
      baseDate.getDate() + planInfo.durationDays
    );

    const subscriptionExpiration =
      admin.firestore.Timestamp.fromDate(baseDate);

    const now = admin.firestore.Timestamp.now();

    const creditExpiration =
      getCreditEntitlementExpiration(now.toDate());

    const newCredits =
      oldCredits + planInfo.credits;

    const entitlementRef =
      db.collection("creditEntitlements").doc();

    const ledgerRef =
      createCreditLedgerRef();

    await db.runTransaction(async (transaction) => {
      transaction.set(
        userRef,
        {
          credits: newCredits,
          plan,
          subscriptionPlan: plan,
          subscriptionExpiresAt: subscriptionExpiration,
          updatedAt: now
        },
        { merge: true }
      );

      transaction.set(
        entitlementRef,
        {
          userId: targetUid,
          plan,
          creditsGranted: planInfo.credits,
          creditsUsed: 0,
          creditsRemaining: planInfo.credits,
          createdAt: now,
          expiresAt: creditExpiration,
          status: "active",
          paymentReference: `admin-${Date.now()}`,
          source: "admin_activation",
          updatedAt: now
        }
      );

      transaction.set(
        ledgerRef,
        {
          type: "GRANTED",
          userId: targetUid,
          plan,
          credits: planInfo.credits,
          source: "admin_activation",
          destination: "user_credit_entitlement",
          reason: "admin_subscription_activation",
          entitlementId: entitlementRef.id,
          createdAt: now,
          approvedBy: req.userUid
        }
      );
    });

    res.json({
      success: true,
      message: "Subscription activated successfully.",
      plan,
      credits: newCredits,
      subscriptionExpiresAt:
        subscriptionExpiration.toDate().toISOString(),
      creditEntitlementId: entitlementRef.id,
      creditExpiresAt:
        creditExpiration.toDate().toISOString()
    });
  } catch (error) {
    console.error("Activate subscription error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to activate subscription."
    });
  }
});
app.post("/api/admin/users/:uid/cancel-subscription", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    await userRef.update({ plan: null, subscriptionPlan: null, subscriptionExpiresAt: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, message: "Subscription cancelled successfully." });
  } catch (error) {
    console.error("Cancel subscription error:", error);
    res.status(500).json({ success: false, error: "Unable to cancel subscription." });
  }
});

app.get("/api/admin/status", requireAuthenticatedUser, async (req, res) => {
  try {
    const adminUser = isAdmin(req.userUid);
    res.json({ success: true, isAdmin: adminUser, uid: req.userUid });
  } catch (error) {
    console.error("Admin status error:", error);
    res.status(500).json({ success: false, error: "Unable to check admin status." });
  }
});

/* =========================================================
STORYBOARD HELPERS
========================================================= */
function normalizeStoryboardScenes(scenes) {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((scene, index) => {
    const current = scene || {};
    const duration = Number(current.duration) === 8 ? 8 : 5;
    const voiceText = String(current.voiceText || current.voice?.text || current.dialogue || current.narration || current.voicePrompt || "").trim();
    const voiceLanguage = String(current.voiceLanguage || current.voice_language || current.language || current.voice?.language || "").trim();
    const voiceId = String(current.voiceId || current.voice_id || current.voiceName || current.voice?.name || (typeof current.voice === "string" ? current.voice : "") || "").trim();
    const voiceEmotion = String(current.voiceEmotion || current.emotion || current.voice?.emotion || "").trim();
    const voiceSpeed = current.voiceSpeed ?? current.speed ?? current.voice?.speed ?? null;
    const voicePitch = current.voicePitch ?? current.pitch ?? current.voice?.pitch ?? null;
    const languageBoost = String(current.languageBoost || current.language_boost || "").trim();
    const musicPrompt = String(current.musicPrompt || current.music || "").trim();
    const musicVolume = current.musicVolume ?? 0.7;
    const sfxPrompt = String(current.sfxPrompt || current.sfx || "").trim();
    const sfxVolume = current.sfxVolume ?? 0.7;
    const ambiencePrompt = String(current.ambiencePrompt || current.ambience || "").trim();
    const ambienceVolume = current.ambienceVolume ?? 0.5;
    return {
      id: current.id || `scene-${index+1}`, index, prompt: String(current.prompt || "").trim(), duration,
      voice: String(current.voice || "").trim(), voiceText, voiceLanguage, voiceId, voiceEmotion, voiceSpeed, voicePitch, languageBoost,
      dialogue: String(current.dialogue || "").trim(), narration: String(current.narration || "").trim(),
      music: String(current.music || "").trim(), musicPrompt, musicVolume, sfx: String(current.sfx || "").trim(), sfxPrompt, sfxVolume,
      ambience: String(current.ambience || "").trim(), ambiencePrompt, ambienceVolume,
      imageUrl: current.imageUrl || current.image || null, videoUrl: current.videoUrl || current.video || null,
      firstFrameImage: current.firstFrameImage || null, lastFrameImage: current.lastFrameImage || null,
      continuityContext: String(current.continuityContext || "").trim()
    };
  }).filter(scene => scene.prompt || scene.imageUrl || scene.videoUrl || scene.dialogue || scene.narration || scene.voiceText || scene.musicPrompt || scene.sfxPrompt || scene.ambiencePrompt);
}

function calculateStoryboardCredits(scenes) {
  const normalized = normalizeStoryboardScenes(scenes);
  return normalized.reduce((total, scene) => total + getVideoCreditCost(scene.duration), 0);
}

function buildStoryboardContinuity(scenes) {
  const normalized = normalizeStoryboardScenes(scenes);
  let continuity = "";
  normalized.forEach((scene, index) => {
    const sceneNumber = index + 1;
    const details = [
      `Scene ${sceneNumber}`,
      scene.prompt ? `Visual: ${scene.prompt}` : "",
      scene.voice ? `Voice: ${scene.voice}` : "",
      scene.dialogue ? `Dialogue: ${scene.dialogue}` : "",
      scene.narration ? `Narration: ${scene.narration}` : "",
      scene.music ? `Music: ${scene.music}` : "",
      scene.sfx ? `SFX: ${scene.sfx}` : "",
      scene.ambience ? `Ambience: ${scene.ambience}` : ""
    ].filter(Boolean).join("\n");
    continuity += details + "\n";
  });
  return continuity.trim();
}

async function renderStoryboardAudio(scenes, options = {}) {
  const normalized = normalizeStoryboardScenes(scenes);
  if (!normalized.length) return { scenes: [], audioFiles: [], cleanupFiles: [] };
  try {
    const rendered = await renderGaveAIAudioForScenes(normalized, { ...options });
    return rendered || { scenes: normalized, audioFiles: [], cleanupFiles: [] };
  } catch (error) {
    console.error("Storyboard audio rendering error:", error);
    throw new Error("GaveAI storyboard audio generation failed.");
  }
}

/* =========================================================
VIDEO JOB HELPERS
========================================================= */
function getVideoJobCollection() { return db.collection("videoJobs"); }
function getVideoProductionCollection() { return db.collection("videoProductions"); }
function normalizeVideoStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["queued", "generating", "completed", "failed"].includes(status)) return status;
  return "queued";
}
function videoJobToClient(id, data = {}) {
  return {
    id, userId: data.userId || null, status: normalizeVideoStatus(data.status),
    prompt: data.prompt || "", duration: Number(data.duration) === 8 ? 8 : 5,
    credits: safeNumber(data.credits, 0), provider: "GaveAI",
    videoUrl: data.videoUrl || data.url || null, thumbnailUrl: data.thumbnailUrl || null, error: data.error || null,
    createdAt: timestampToISO(data.createdAt), startedAt: timestampToISO(data.startedAt),
    completedAt: timestampToISO(data.completedAt), failedAt: timestampToISO(data.failedAt)
  };
}

/* =========================================================
VIDEO CREDIT / FREE VIDEO STATE - [CHANGED] Process expired entitlements first
========================================================= */
async function getActiveCreditEntitlements(userId) {
  const snapshot = await db.collection("creditEntitlements")
    .where("userId", "==", userId)
    .where("status", "==", "active")
    .get();

  return snapshot.docs
    .map((doc) => ({
      ref: doc.ref,
      data: doc.data() || {}
    }))
    .sort((a, b) => {
      const aExpires = timestampToMillis(a.data.expiresAt);
      const bExpires = timestampToMillis(b.data.expiresAt);

      const aTime = aExpires || Number.MAX_SAFE_INTEGER;
      const bTime = bExpires || Number.MAX_SAFE_INTEGER;

      return aTime - bTime;
    });
}

async function consumeCreditEntitlements(transaction, entitlementRefs, amount, ledgerContext = {}) {
  let remainingToAllocate = Math.max(
    0,
    safeNumber(amount, 0)
  );

  let allocatedCredits = 0;

  if (remainingToAllocate <= 0) {
    return {
      allocatedCredits: 0,
      unallocatedCredits: 0
    };
  }

  const entitlementSnapshots = [];

  for (const item of entitlementRefs) {
    const snapshot = await transaction.get(item.ref);

    entitlementSnapshots.push({
      ref: item.ref,
      snapshot
    });
  }

  for (const item of entitlementSnapshots) {
    if (remainingToAllocate <= 0) {
      break;
    }

    if (!item.snapshot.exists) {
      continue;
    }

    const entitlement = item.snapshot.data() || {};

    if (
      String(entitlement.status || "").toLowerCase() !==
      "active"
    ) {
      continue;
    }

    const granted = Math.max(
      0,
      safeNumber(entitlement.creditsGranted, 0)
    );

    const used = Math.max(
      0,
      safeNumber(entitlement.creditsUsed, 0)
    );

    const storedRemaining = safeNumber(
      entitlement.creditsRemaining,
      granted - used
    );

    const currentRemaining = Math.max(
      0,
      Math.min(
        storedRemaining,
        Math.max(0, granted - used)
      )
    );

    if (currentRemaining <= 0) {
      continue;
    }

    const amountToUse = Math.min(
      remainingToAllocate,
      currentRemaining
    );

    const newUsed = used + amountToUse;
    const newRemaining = Math.max(
      0,
      currentRemaining - amountToUse
    );

    transaction.update(item.ref, {
      creditsUsed: newUsed,
      creditsRemaining: newRemaining,
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    const ledgerRef = createCreditLedgerRef();

    transaction.set(ledgerRef, {
      type: "USED",
      userId: ledgerContext.userId || null,
      credits: amountToUse,
      source: "user_credit_entitlement",
      destination:
        ledgerContext.destination || "video_generation",
      reason:
        ledgerContext.reason || "video_credit_usage",
      feature: ledgerContext.feature || null,
      entitlementId: item.ref.id,
      paymentId: ledgerContext.paymentId || null,
      jobId: ledgerContext.jobId || null,
      createdAt: admin.firestore.Timestamp.now()
    });

    allocatedCredits += amountToUse;
    remainingToAllocate -= amountToUse;
  }

  /*
   * Legacy credit fallback.
   *
   * Some existing users may still have credits in users/{uid}.credits
   * that were created before creditEntitlements existed.
   *
   * Do not lose those credits and do not decrement the aggregate balance
   * without recording where the used credits came from.
   *
   * Convert only the missing portion into a new entitlement and consume
   * it immediately. The entitlement receives the standard 2-calendar-month
   * expiration policy.
   */
  if (remainingToAllocate > 0) {
    const userId = ledgerContext.userId || null;

    if (!userId) {
      throw new Error(
        "CREDIT_ENTITLEMENT_ALLOCATION_FAILED"
      );
    }

    const now = admin.firestore.Timestamp.now();

    const legacyEntitlementRef =
      db.collection("creditEntitlements").doc();

    const legacyCredits = remainingToAllocate;

    const legacyCreditExpiration =
      getCreditEntitlementExpiration(now.toDate());

    transaction.set(
      legacyEntitlementRef,
      {
        userId,
        plan: ledgerContext.plan || null,
        creditsGranted: legacyCredits,
        creditsUsed: legacyCredits,
        creditsRemaining: 0,
        createdAt: now,
        expiresAt: legacyCreditExpiration,
        status: "active",
        paymentReference: null,
        source: "legacy_user_credit_balance",
        updatedAt: now
      }
    );

    const allocationLedgerRef =
      createCreditLedgerRef();

    transaction.set(
      allocationLedgerRef,
      {
        type: "ALLOCATED",
        userId,
        credits: legacyCredits,
        source: "user_credit_balance",
        destination: "user_credit_entitlement",
        reason: "legacy_credit_entitlement_migration",
        entitlementId: legacyEntitlementRef.id,
        createdAt: now
      }
    );

    const usageLedgerRef =
      createCreditLedgerRef();

    transaction.set(
      usageLedgerRef,
      {
        type: "USED",
        userId,
        credits: legacyCredits,
        source: "user_credit_entitlement",
        destination:
          ledgerContext.destination || "video_generation",
        reason:
          ledgerContext.reason || "video_credit_usage",
        feature: ledgerContext.feature || null,
        entitlementId: legacyEntitlementRef.id,
        paymentId: ledgerContext.paymentId || null,
        jobId: ledgerContext.jobId || null,
        createdAt: now
      }
    );

    allocatedCredits += legacyCredits;
    remainingToAllocate = 0;
  }

  return {
    allocatedCredits,
    unallocatedCredits: remainingToAllocate
  };
}
async function reserveVideoCredits(userId, duration) {
  const cost = getVideoCreditCost(duration);
  const userRef = db.collection("users").doc(userId);

  /* Process expired entitlements before checking credits */
  await processExpiredEntitlements(userId);

  const activeEntitlements = isAdmin(userId)
    ? []
    : await getActiveCreditEntitlements(userId);

  return await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const userData = snapshot.exists ? snapshot.data() || {} : {};
    const adminUser = isAdmin(userId);
    const freeState = normalizeFreeVideoState(userData);
    const credits = Math.max(
      0,
      safeNumber(userData.credits, 0)
    );

    if (adminUser) {
      return {
        chargedCredits: 0,
        usedFreeVideo: false,
        remainingCredits: credits,
        freeVideoRemaining: freeState.freeVideoRemaining,
        isAdmin: true
      };
    }

    if (freeState.freeVideoAvailable) {
      transaction.set(
        userRef,
        {
          freeVideoUsed: true,
          freeVideoRemaining: 0,
          freeVideoAvailable: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return {
        chargedCredits: 0,
        usedFreeVideo: true,
        remainingCredits: credits,
        freeVideoRemaining: 0,
        isAdmin: false
      };
    }

    if (credits < cost) {
      throw new Error("INSUFFICIENT_CREDITS");
    }

    const consumptionResult = await consumeCreditEntitlements(
      transaction,
      activeEntitlements,
      cost,
      {
        userId,
        destination: "video_generation",
        reason: "video_credit_usage",
        feature: "video_generation"
      }
    );

    const allocatedCredits = Math.max(
      0,
      safeNumber(consumptionResult?.allocatedCredits, 0)
    );

    const unallocatedCredits = Math.max(
      0,
      safeNumber(consumptionResult?.unallocatedCredits, 0)
    );

    if (
      allocatedCredits + unallocatedCredits !== cost
    ) {
      throw new Error("CREDIT_LEDGER_ALLOCATION_MISMATCH");
    }

    const remainingCredits = credits - cost;


    transaction.set(
      userRef,
      {
        credits: remainingCredits,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      chargedCredits: cost,
      usedFreeVideo: false,
      remainingCredits,
      freeVideoRemaining: freeState.freeVideoRemaining,
      isAdmin: false
    };
  });
}/* [CHANGED] NO-REFUND POLICY: Credits and free-video are NOT restored on failure */
async function refundVideoCredits(userId, amount, usedFreeVideo) {
  console.log(`NO-REFUND: Video failed for user ${userId}. Credits (${amount}) and freeVideo (${usedFreeVideo}) NOT restored per policy.`);
}

/* =========================================================
VIDEO QUEUE
========================================================= */
function canAcceptVideoJob() { return queuedVideoGenerations < MAX_VIDEO_QUEUE; }
function incrementVideoQueue() { queuedVideoGenerations += 1; }
function decrementVideoQueue() { queuedVideoGenerations = Math.max(0, queuedVideoGenerations - 1); }
function startVideoGenerationSlot() { activeVideoGenerations += 1; }
function finishVideoGenerationSlot() { activeVideoGenerations = Math.max(0, activeVideoGenerations - 1); }

async function generateVideoWithProvider(options) {
  try {
    const result = await generateWithGaveAIVideoProvider(options);
    if (!result) throw new Error("VIDEO_PROVIDER_EMPTY_RESULT");
    return result;
  } catch (error) {
    console.error("GaveAI video provider error:", error);
    throw error;
  }
}

/* =========================================================
VIDEO JOB PROCESSOR - [FIXED] Added decrementVideoQueue() in finally, wrap prompt
========================================================= */
async function processVideoJob(jobId) {
  const jobRef = getVideoJobCollection().doc(jobId);
  let jobData = null;
  try {
    const snapshot = await jobRef.get();
    if (!snapshot.exists) return;
    jobData = snapshot.data() || {};
    const userId = jobData.userId;
    const duration = Number(jobData.duration) === 8 ? 8 : 5;
    await jobRef.set({ status: "generating", startedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    startVideoGenerationSlot();
    /* [CHANGED] Wrap prompt with strict rules */
    const providerResult = await generateVideoWithProvider({
      prompt: wrapStrictPrompt(jobData.prompt),
      width: safeNumber(jobData.width, 832), height: safeNumber(jobData.height, 480),
      duration, seed: safeNumber(jobData.seed, -1),
      firstFrameImage: jobData.firstFrameImage || null, userId, jobId, providerName: "GAVEAIproduction"
    });
    const providerVideoUrl = providerResult?.videoUrl || providerResult?.url || providerResult?.outputUrl || providerResult?.output?.url || null;
    if (!providerVideoUrl) throw new Error("VIDEO_PROVIDER_EMPTY_RESULT");
    const audioRequested = Boolean(String(jobData.voiceText || "").trim() || String(jobData.dialogue || "").trim() || String(jobData.narration || "").trim() || String(jobData.musicPrompt || "").trim() || String(jobData.sfxPrompt || "").trim() || String(jobData.ambiencePrompt || "").trim());
    let finalVideoUrl = providerVideoUrl;
    let audioAdded = false;
    let temporaryVideoFile = null;
    let renderedAudioVideoFile = null;
    let cleanupAudioPaths = [];
    try {
      if (audioRequested) {
        const os = require("os");
        const crypto = require("crypto");
        const tempId = crypto.randomBytes(12).toString("hex");
        temporaryVideoFile = path.join(os.tmpdir(), `gaveai-video-${jobId}-${tempId}.mp4`);
        const videoResponse = await axios.get(providerVideoUrl, { responseType: "arraybuffer", timeout: 180000, maxContentLength: 100 * 1024 * 1024, maxBodyLength: 100 * 1024 * 1024 });
        fs.writeFileSync(temporaryVideoFile, Buffer.from(videoResponse.data));
        const directAudioScene = {
          videoFile: temporaryVideoFile, duration,
          voiceText: String(jobData.voiceText || "").trim(), dialogue: String(jobData.dialogue || "").trim(), narration: String(jobData.narration || "").trim(),
          voiceLanguage: jobData.voiceLanguage || null, voiceId: jobData.voiceId || null, voiceEmotion: jobData.voiceEmotion || null,
          voiceSpeed: safeNumber(jobData.voiceSpeed, 1), voicePitch: safeNumber(jobData.voicePitch, 0), languageBoost: jobData.languageBoost || null,
          musicPrompt: String(jobData.musicPrompt || "").trim(), musicVolume: safeNumber(jobData.musicVolume, 0.7),
          sfxPrompt: String(jobData.sfxPrompt || "").trim(), sfxVolume: safeNumber(jobData.sfxVolume, 0.7),
          ambiencePrompt: String(jobData.ambiencePrompt || "").trim(), ambienceVolume: safeNumber(jobData.ambienceVolume, 0.5)
        };
        const audioResult = await renderGaveAIAudioForScenes([directAudioScene], { userId, jobId, duration });
        if (!audioResult?.success || !audioResult?.videoFile) throw new Error("GAVEAI_AUDIO_RENDER_FAILED");
        renderedAudioVideoFile = audioResult.videoFile;
        if (Array.isArray(audioResult.cleanupFiles)) cleanupAudioPaths = audioResult.cleanupFiles;
        const finalBuffer = fs.readFileSync(renderedAudioVideoFile);
        const uploadedFinalVideo = await uploadBufferToImageKit(finalBuffer, `gaveai-video-${jobId}-${Date.now()}.mp4`, "gavemoneytips/generated-videos");
        if (!uploadedFinalVideo?.url) throw new Error("GAVEAI_FINAL_VIDEO_UPLOAD_FAILED");
        finalVideoUrl = uploadedFinalVideo.url;
        audioAdded = true;
      }
    } finally {
      try { if (Array.isArray(cleanupAudioPaths) && cleanupAudioPaths.length) await cleanupAudioFiles(cleanupAudioPaths); } catch (e) { console.error("VIDEO AUDIO CLEANUP ERROR:", e); }
      try { if (temporaryVideoFile && fs.existsSync(temporaryVideoFile)) fs.unlinkSync(temporaryVideoFile); } catch (e) { console.error("TEMP VIDEO CLEANUP ERROR:", e); }
      try { if (renderedAudioVideoFile && fs.existsSync(renderedAudioVideoFile) && renderedAudioVideoFile !== temporaryVideoFile) fs.unlinkSync(renderedAudioVideoFile); } catch (e) { console.error("RENDERED VIDEO CLEANUP ERROR:", e); }
    }
    await jobRef.set({ status: "completed", provider: "GaveAI", providerName: "GAVEAIproduction", videoUrl: finalVideoUrl, audioAdded, completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await getVideoProductionCollection().doc(jobId).set({ ...jobData, status: "completed", provider: "GaveAI", providerName: "GAVEAIproduction", videoUrl: finalVideoUrl, audioAdded, completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (error) {
    console.error("VIDEO JOB FAILED:", jobId, error);
    /* [CHANGED] NO REFUND - credits and free-video are NOT restored */
    const errorMessage = genericVideoError(error, jobData?.userId);
    try {
      await jobRef.set({ status: "failed", error: errorMessage, failedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await getVideoProductionCollection().doc(jobId).set({ ...(jobData || {}), status: "failed", error: errorMessage, failedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (saveError) { console.error("VIDEO FAILURE SAVE ERROR:", saveError); }
  } finally {
    finishVideoGenerationSlot();
    /* [FIXED] Added decrementVideoQueue() so queue counter goes down */
    decrementVideoQueue();
  }
}

/* =========================================================
VIDEO QUEUE WORKER - [FIXED] Skip storyboard jobs
========================================================= */
async function processQueuedVideoJobs() {
  if (activeVideoGenerations >= MAX_CONCURRENT_VIDEOS) return;
  try {
    const snapshot = await getVideoJobCollection().where("status", "==", "queued").limit(Math.max(1, MAX_CONCURRENT_VIDEOS - activeVideoGenerations)).get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      if (activeVideoGenerations >= MAX_CONCURRENT_VIDEOS) break;
      /* [FIXED] Skip storyboard jobs - they have their own processor */
      const jobData = doc.data() || {};
      if (jobData.storyboard === true || jobData.type === "storyboard") continue;
      const claimed = await db.runTransaction(async (transaction) => {
        const ref = getVideoJobCollection().doc(doc.id);
        const current = await transaction.get(ref);
        if (!current.exists) return false;
        const data = current.data() || {};
        if (normalizeVideoStatus(data.status) !== "queued") return false;
        transaction.set(ref, { status: "generating", claimedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return true;
      });
      if (claimed) processVideoJob(doc.id).catch((error) => { console.error("Unhandled video worker error:", error); });
    }
  } catch (error) { console.error("Video queue worker error:", error); }
}
setInterval(processQueuedVideoJobs, 2000);

/* =========================================================
GENERATE VIDEO - [CHANGED] NO REFUND on failure
========================================================= */
app.post("/generate-video", requireAuthenticatedUser, async (req, res) => {
  let reservation = null;
  try {
    if (!canAcceptVideoJob()) return res.status(429).json({ success: false, error: "GaveAI video generation queue is full. Please try again shortly." });
    const userId = req.userUid;
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ success: false, error: "Video prompt is required." });
    const duration = Number(req.body?.duration) === 8 ? 8 : 5;
    const creditsRequired = getVideoCreditCost(duration);
    reservation = await reserveVideoCredits(userId, duration);
    incrementVideoQueue();
    const now = admin.firestore.Timestamp.now();
    const jobRef = getVideoJobCollection().doc();
    const jobData = {
      userId, prompt, width: safeNumber(req.body?.width, 832), height: safeNumber(req.body?.height, 480), duration, seed: safeNumber(req.body?.seed, -1),
      firstFrameImage: req.body?.firstFrameImage || null, voiceText: String(req.body?.voiceText || req.body?.voice || "").trim(), dialogue: String(req.body?.dialogue || "").trim(),
      narration: String(req.body?.narration || "").trim(), voiceLanguage: req.body?.voiceLanguage || req.body?.voice_language || null, voiceId: req.body?.voiceId || req.body?.voice_id || null,
      voiceEmotion: req.body?.voiceEmotion || req.body?.emotion || null, voiceSpeed: safeNumber(req.body?.voiceSpeed, 1), voicePitch: safeNumber(req.body?.voicePitch, 0),
      languageBoost: req.body?.languageBoost || req.body?.language_boost || null, musicPrompt: String(req.body?.musicPrompt || req.body?.music || "").trim(),
      musicVolume: safeNumber(req.body?.musicVolume, 0.7), sfxPrompt: String(req.body?.sfxPrompt || req.body?.sfx || "").trim(), sfxVolume: safeNumber(req.body?.sfxVolume, 0.7),
      ambiencePrompt: String(req.body?.ambiencePrompt || req.body?.ambience || "").trim(), ambienceVolume: safeNumber(req.body?.ambienceVolume, 0.5),
      credits: creditsRequired, chargedCredits: reservation.chargedCredits, usedFreeVideo: reservation.usedFreeVideo, provider: "GaveAI", providerName: "GAVEAIproduction",
      status: "queued", createdAt: now, updatedAt: now
    };
    await jobRef.set(jobData);
    res.status(202).json({
      success: true, queued: true, jobId: jobRef.id, videoJobId: jobRef.id, status: "queued", provider: "GaveAI", message: "Your GaveAI video is being generated.",
      credits: reservation.remainingCredits, chargedCredits: reservation.chargedCredits, usedFreeVideo: reservation.usedFreeVideo, freeVideoRemaining: reservation.freeVideoRemaining
    });
  } catch (error) {
    console.error("Generate video request error:", error);
    /* [CHANGED] NO REFUND on request failure */
    res.status(String(error?.message || "") === "INSUFFICIENT_CREDITS" ? 402 : 500).json({ success: false, error: genericVideoError(error, req.userUid) });
  }
});

app.get("/api/video-productions/:id", requireAuthenticatedUser, async (req, res) => {
  try {
    const productionId = req.params.id;
    const jobRef = getVideoJobCollection().doc(productionId);
    const snapshot = await jobRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Video production not found." });
    const data = snapshot.data() || {};
    if (data.userId !== req.userUid && !isAdmin(req.userUid)) return res.status(403).json({ success: false, error: "You do not have access to this video production." });
    res.json({ success: true, production: videoJobToClient(snapshot.id, data) });
  } catch (error) {
    console.error("Video production status error:", error);
    res.status(500).json({ success: false, error: "Unable to load video production." });
  }
});

app.get("/api/video-productions", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const snapshot = await getVideoJobCollection().where("userId", "==", userId).limit(100).get();
    const productions = snapshot.docs.map((doc) => videoJobToClient(doc.id, doc.data())).sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, productions });
  } catch (error) {
    console.error("User video productions error:", error);
    res.status(500).json({ success: false, error: "Unable to load your video productions." });
  }
});

app.get("/api/admin/video-productions", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const statusFilter = String(req.query?.status || "all").trim().toLowerCase();
    const snapshot = await getVideoProductionCollection().limit(500).get();
    let productions = snapshot.docs.map((doc) => videoJobToClient(doc.id, doc.data()));
    if (statusFilter !== "all") productions = productions.filter((item) => item.status === statusFilter);
    productions.sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, productions, total: productions.length });
  } catch (error) {
    console.error("Admin video productions error:", error);
    res.status(500).json({ success: false, error: "Unable to load video productions." });
  }
});

/* =========================================================
STORYBOARD GENERATE - [CHANGED] NO REFUND on failure
========================================================= */
app.post("/api/storyboard/generate", requireAuthenticatedUser, async (req, res) => {
  let reservation = null;
  let createdJobId = null;
  try {
    if (!canAcceptVideoJob()) return res.status(429).json({ success: false, error: "GaveAI video generation queue is full. Please try again shortly." });
    const userId = req.userUid;
    const storyOverview = String(req.body?.storyOverview || req.body?.story || "").trim();
    const mainCharacter = String(req.body?.mainCharacter || "").trim();
    const supportingCharacters = String(req.body?.supportingCharacters || "").trim();
    const visualStyle = String(req.body?.visualStyle || "").trim();
    const environment = String(req.body?.environment || "").trim();
    const cameraStyle = String(req.body?.cameraStyle || "").trim();
    const globalAudioDirection = String(req.body?.globalAudioDirection || "").trim();
    const scenes = normalizeStoryboardScenes(req.body?.scenes);
    if (!scenes.length) return res.status(400).json({ success: false, error: "At least one storyboard scene is required." });
    const totalCredits = calculateStoryboardCredits(scenes);
    const totalDuration = scenes.reduce((total, scene) => total + scene.duration, 0);
    if (scenes.length === 1) {
      reservation = await reserveVideoCredits(userId, scenes[0].duration);
    } else {
      /* [CHANGED] Process expired entitlements before storyboard credit check */
      await processExpiredEntitlements(userId);

      const activeEntitlements = isAdmin(userId)
        ? []
        : await getActiveCreditEntitlements(userId);

      const userRef = db.collection("users").doc(userId);

      reservation = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(userRef);
        const userData = snapshot.exists ? snapshot.data() || {} : {};
        const adminUser = isAdmin(userId);

        const credits = Math.max(
          0,
          safeNumber(userData.credits, 0)
        );

        if (adminUser) {
          return {
            chargedCredits: 0,
            usedFreeVideo: false,
            remainingCredits: credits,
            freeVideoRemaining:
              normalizeFreeVideoState(userData).freeVideoRemaining,
            isAdmin: true
          };
        }

        if (credits < totalCredits) {
          throw new Error("INSUFFICIENT_CREDITS");
        }


        const consumptionResult = await consumeCreditEntitlements(
          transaction,
          activeEntitlements,
          totalCredits,
          {
            userId,
            destination: "video_generation",
            reason: "storyboard_credit_usage",
            feature: "storyboard"
          }
        );

        const allocatedCredits = Math.max(
          0,
          safeNumber(consumptionResult?.allocatedCredits, 0)
        );

        const unallocatedCredits = Math.max(
          0,
          safeNumber(consumptionResult?.unallocatedCredits, 0)
        );

        if (
          allocatedCredits + unallocatedCredits !== totalCredits
        ) {
          throw new Error("CREDIT_LEDGER_ALLOCATION_MISMATCH");
        }

        const remainingCredits = credits - totalCredits;

        transaction.set(
          userRef,
          {
            credits: remainingCredits,
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        return {
          chargedCredits: totalCredits,
          usedFreeVideo: false,
          remainingCredits,
          freeVideoRemaining:
            normalizeFreeVideoState(userData).freeVideoRemaining,
          isAdmin: false
        };
      });
    }
    incrementVideoQueue();
    const now = admin.firestore.Timestamp.now();
    const storyboardId = `storyboard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const productionRef = getVideoProductionCollection().doc(storyboardId);
    const productionData = {
      userId, type: "storyboard", storyboardId, storyOverview, mainCharacter, supportingCharacters, visualStyle, environment, cameraStyle, globalAudioDirection,
      scenes, totalScenes: scenes.length, totalDuration, totalCredits,
      chargedCredits: reservation.chargedCredits, usedFreeVideo: reservation.usedFreeVideo, provider: "GaveAI", status: "queued", createdAt: now, updatedAt: now
    };
    await productionRef.set(productionData);
    const jobRef = getVideoJobCollection().doc(storyboardId);
    await jobRef.set({
      ...productionData, prompt: storyOverview || scenes.map((scene) => scene.prompt).filter(Boolean).join("\n"),
      duration: totalDuration, credits: totalCredits, storyboard: true, status: "queued",
      audioRequested: scenes.some((scene) => scene.voice || scene.dialogue || scene.narration || scene.music || scene.sfx || scene.ambience)
    });
    createdJobId = storyboardId;
    res.status(202).json({
      success: true, queued: true, storyboardId, jobId: storyboardId, videoJobId: storyboardId, status: "queued", provider: "GaveAI",
      totalScenes: scenes.length, totalDuration, totalCredits, chargedCredits: reservation.chargedCredits,
      usedFreeVideo: reservation.usedFreeVideo, credits: reservation.remainingCredits, freeVideoRemaining: reservation.freeVideoRemaining,
      continuity: buildStoryboardContinuity(scenes)
    });
    processStoryboardJob(storyboardId).catch((error) => { console.error("Storyboard worker error:", error); });
  } catch (error) {
    console.error("Storyboard generate error:", error);
    /* [CHANGED] NO REFUND on storyboard failure */
    if (createdJobId) {
      try { await getVideoJobCollection().doc(createdJobId).set({ status: "failed", error: genericVideoError(error, req.userUid), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch (saveError) { console.error("Storyboard failure save error:", saveError); }
    }
    res.status(String(error?.message || "") === "INSUFFICIENT_CREDITS" ? 402 : 500).json({ success: false, error: genericVideoError(error, req.userUid) });
  }
});

/* =========================================================
STORYBOARD JOB PROCESSOR - [CHANGED] NO REFUND, wrap prompts
========================================================= */
async function processStoryboardJob(storyboardId) {
  const jobRef = getVideoJobCollection().doc(storyboardId);
  let jobData = null;
  let audioResult = null;
  let cleanupPaths = [];
  try {
    const snapshot = await jobRef.get();
    if (!snapshot.exists) { decrementVideoQueue(); return; }
    jobData = snapshot.data() || {};
    await jobRef.set({ status: "generating", startedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await getVideoProductionCollection().doc(storyboardId).set({ status: "generating", startedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const scenes = normalizeStoryboardScenes(jobData.scenes);
    if (!scenes.length) throw new Error("STORYBOARD_SCENES_EMPTY");
    const audioRequested = scenes.some((scene) => scene.voice || scene.voiceText || scene.dialogue || scene.narration || scene.music || scene.sfx || scene.ambience);
    const generatedScenes = [];
    let previousSceneContext = "";
    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index];
      const continuity = [
        jobData.storyOverview ? `Story: ${jobData.storyOverview}` : "",
        jobData.mainCharacter ? `Main character: ${jobData.mainCharacter}` : "",
        jobData.supportingCharacters ? `Supporting characters: ${jobData.supportingCharacters}` : "",
        jobData.visualStyle ? `Visual style: ${jobData.visualStyle}` : "",
        jobData.environment ? `Environment: ${jobData.environment}` : "",
        jobData.cameraStyle ? `Camera style: ${jobData.cameraStyle}` : "",
        previousSceneContext ? `Previous scene continuity:\n${previousSceneContext}` : "",
        scene.continuityContext ? `Scene continuity:\n${scene.continuityContext}` : ""
      ].filter(Boolean).join("\n");
      /* [CHANGED] Wrap scene prompt with strict rules */
      const scenePrompt = wrapStrictPrompt([scene.prompt, continuity ? `Maintain this continuity:\n${continuity}` : ""].filter(Boolean).join("\n"));
      const sceneResult = await generateVideoWithProvider({
        prompt: scenePrompt, width: safeNumber(jobData.width, 832), height: safeNumber(jobData.height, 480),
        duration: scene.duration, seed: safeNumber(jobData.seed, -1),
        firstFrameImage: scene.firstFrameImage || scene.imageUrl || null,
        userId: jobData.userId, jobId: storyboardId, sceneId: scene.id, sceneIndex: index, providerName: "GAVEAIproduction"
      });
      const sceneVideoUrl = sceneResult?.videoUrl || sceneResult?.url || sceneResult?.outputUrl || sceneResult?.output?.url || null;
      if (!sceneVideoUrl) throw new Error("STORYBOARD_SCENE_VIDEO_EMPTY");
      const os = require("os");
      const crypto = require("crypto");
      const temporarySceneVideoFile = path.join(os.tmpdir(), `gaveai-storyboard-${storyboardId}-scene-${index}-${crypto.randomBytes(12).toString("hex")}.mp4`);
      const sceneVideoResponse = await axios.get(sceneVideoUrl, { responseType: "arraybuffer", timeout: 180000, maxContentLength: 100 * 1024 * 1024, maxBodyLength: 100 * 1024 * 1024 });
      fs.writeFileSync(temporarySceneVideoFile, Buffer.from(sceneVideoResponse.data));
      if (!fs.existsSync(temporarySceneVideoFile)) throw new Error(`STORYBOARD_SCENE_VIDEO_DOWNLOAD_FAILED_${index + 1}`);
      cleanupPaths.push(temporarySceneVideoFile);
      generatedScenes.push({ ...scene, sceneIndex: index, videoUrl: sceneVideoUrl, videoFile: temporarySceneVideoFile });
      previousSceneContext = [scene.prompt, scene.dialogue, scene.narration].filter(Boolean).join(" ");
    }
    audioResult = await renderStoryboardAudio(generatedScenes, {
      userId: jobData.userId, storyboardId, storyOverview: jobData.storyOverview,
      globalAudioDirection: jobData.globalAudioDirection, mainCharacter: jobData.mainCharacter, visualStyle: jobData.visualStyle
    });
    if (!audioResult?.success || !audioResult?.videoFile) throw new Error("GAVEAI_FINAL_VIDEO_RENDER_FAILED");
    const audioCleanupPaths = Array.isArray(audioResult?.cleanupFiles) ? audioResult.cleanupFiles : [];
    cleanupPaths = Array.from(new Set([...cleanupPaths, ...audioCleanupPaths].filter(Boolean)));
    const finalBuffer = fs.readFileSync(audioResult.videoFile);
    if (!Buffer.isBuffer(finalBuffer) || finalBuffer.length <= 0) throw new Error("GAVEAI_FINAL_VIDEO_FILE_EMPTY");
    const uploadedFinalVideo = await uploadBufferToImageKit(finalBuffer, `gaveai-storyboard-${storyboardId}-${Date.now()}.mp4`, "gavemoneytips/generated-videos");
    if (!uploadedFinalVideo?.url) throw new Error("GAVEAI_FINAL_VIDEO_UPLOAD_FAILED");
    const finalVideoUrl = uploadedFinalVideo.url;
    const persistedScenes = generatedScenes.map((scene) => { const { videoFile, ...safeScene } = scene; return { ...safeScene, videoUrl: scene.videoUrl }; });
    const persistedAudio = {
      success: Boolean(audioResult.success), audioAdded: Boolean(audioResult.audioAdded),
      sceneCount: audioResult.sceneCount || generatedScenes.length,
      embedded: Boolean(audioResult.audio?.embedded), format: audioResult.audio?.format || "AAC",
      synchronized: Boolean(audioResult.audio?.synchronized)
    };
    const completedData = {
      status: "completed", provider: "GaveAI", scenes: persistedScenes, audio: persistedAudio, audioRequested,
      finalVideoUrl, videoUrl: finalVideoUrl, generatedMedia: { type: "video", url: finalVideoUrl },
      continuity: buildStoryboardContinuity(persistedScenes),
      completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await jobRef.set(completedData, { merge: true });
    await getVideoProductionCollection().doc(storyboardId).set(completedData, { merge: true });
  } catch (error) {
    console.error("Storyboard job failed:", storyboardId, error);
    /* [CHANGED] NO REFUND on storyboard failure */
    const errorMessage = genericVideoError(error, jobData?.userId);
    try {
      await jobRef.set({ status: "failed", error: errorMessage, failedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await getVideoProductionCollection().doc(storyboardId).set({ status: "failed", error: errorMessage, failedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (saveError) { console.error("Storyboard failed-state save error:", saveError); }
  } finally {
    if (cleanupPaths.length) { try { await cleanupAudioFiles(cleanupPaths); } catch (cleanupError) { console.error("Storyboard audio cleanup error:", cleanupError); } }
    decrementVideoQueue();
  }
}

/* =========================================================
ADMIN OVERVIEW
========================================================= */
app.get("/api/admin/overview", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const filter = String(req.query?.filter || "all").trim().toLowerCase();
    const validFilters = ["all", "admin", "pro", "premium", "active", "free"];
    const normalizedFilter = validFilters.includes(filter) ? filter : "all";
    const [usersSnapshot, paymentsSnapshot, productionsSnapshot] = await Promise.all([
      db.collection("users").get(),
      db.collection("paymentRequests").get(),
      db.collection("videoProductions").get()
    ]);
    const allUsers = usersSnapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
    const allPayments = paymentsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const allProductions = productionsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    let users = [...allUsers];
    if (normalizedFilter === "admin") users = users.filter((user) => isAdmin(user.uid));
    if (normalizedFilter === "pro") users = users.filter((user) => normalizePlan(user.subscriptionPlan || user.plan) === "pro");
    if (normalizedFilter === "premium") users = users.filter((user) => normalizePlan(user.subscriptionPlan || user.plan) === "premium");
    if (normalizedFilter === "active") users = users.filter((user) => isSubscriptionActive(user));
    if (normalizedFilter === "free") users = users.filter((user) => !isSubscriptionActive(user));
    users.sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    const activePayments = allPayments.filter((payment) => payment.deleted !== true);
    const pendingPayments = activePayments.filter((payment) => normalizePaymentStatus(payment.status) === "pending");
    const approvedPayments = activePayments.filter((payment) => normalizePaymentStatus(payment.status) === "approved");
    const rejectedPayments = activePayments.filter((payment) => normalizePaymentStatus(payment.status) === "rejected");
    const trashPayments = allPayments.filter((payment) => payment.deleted === true);
    const approvedRevenue = approvedPayments.reduce((total, payment) => total + safeNumber(payment.amount ?? payment.price, 0), 0);
    const pendingRevenue = pendingPayments.reduce((total, payment) => total + safeNumber(payment.amount ?? payment.price, 0), 0);
    const totalCredits = allUsers.reduce((total, user) => total + Math.max(0, safeNumber(user.credits, 0)), 0);
    const proUsers = allUsers.filter((user) => normalizePlan(user.subscriptionPlan || user.plan) === "pro").length;
    const premiumUsers = allUsers.filter((user) => normalizePlan(user.subscriptionPlan || user.plan) === "premium").length;
    const activeSubscriptions = allUsers.filter((user) => isSubscriptionActive(user)).length;
    const adminUsers = allUsers.filter((user) => isAdmin(user.uid)).length;
    const freeVideosUsed = allUsers.filter((user) => user.freeVideoUsed === true).length;
    const queuedVideos = allProductions.filter((production) => normalizeVideoStatus(production.status) === "queued").length;
    const generatingVideos = allProductions.filter((production) => normalizeVideoStatus(production.status) === "generating").length;
    const completedVideos = allProductions.filter((production) => normalizeVideoStatus(production.status) === "completed").length;
    const failedVideos = allProductions.filter((production) => normalizeVideoStatus(production.status) === "failed").length;
    const totalVideoScenes = allProductions.reduce((total, production) => total + safeNumber(production.sceneCount, Array.isArray(production.scenes) ? production.scenes.length : 0), 0);
    const totalCreditsUsedForVideos = allProductions.reduce((total, production) => total + safeNumber(production.creditsUsed, 0), 0);
    res.json({
      success: true, filter: normalizedFilter,
      overview: {
        totalUsers: allUsers.length, adminUsers, activeSubscriptions, proUsers, premiumUsers, totalCredits,
        totalPayments: allPayments.length, pendingPayments: pendingPayments.length, approvedPayments: approvedPayments.length,
        rejectedPayments: rejectedPayments.length, trashPayments: trashPayments.length,
        approvedRevenue, pendingRevenue, totalVideoProductions: allProductions.length, totalVideoScenes,
        totalCreditsUsedForVideos, freeVideosUsed, queuedVideos, generatingVideos, completedVideos, failedVideos
      },
      payments: activePayments.map((payment) => paymentToClient(payment.id, payment)).sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)).slice(0, 100),
      users: users.map((user) => ({
        uid: user.uid, email: user.email || null, displayName: user.displayName || user.name || null,
        credits: Math.max(0, safeNumber(user.credits, 0)), plan: getUserPlan(user), subscriptionPlan: getUserPlan(user),
        subscriptionExpiresAt: timestampToISO(user.subscriptionExpiresAt), freeVideoUsed: user.freeVideoUsed === true,
        freeVideoRemaining: normalizeFreeVideoState(user).freeVideoRemaining, isAdmin: isAdmin(user.uid), createdAt: timestampToISO(user.createdAt)
      })),
      videoProductions: allProductions.sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)).slice(0, 100).map((production) => ({
        id: production.id, userId: production.userId || null, status: normalizeVideoStatus(production.status), provider: "GaveAI",
        sceneCount: safeNumber(production.sceneCount, Array.isArray(production.scenes) ? production.scenes.length : 0),
        creditsUsed: safeNumber(production.creditsUsed, 0), videoUrl: production.videoUrl || null,
        createdAt: timestampToISO(production.createdAt), completedAt: timestampToISO(production.completedAt)
      }))
    });
  } catch (error) {
    console.error("Admin overview error:", error);
    res.status(500).json({ success: false, error: "Unable to load admin overview." });
  }
});

/*
=========================================================
CREDIT POOL ADMIN
=========================================================
*/
app.get("/api/admin/credit-pool", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const poolRef = db.collection("creditPool").doc("inventory");

    const [poolSnapshot, transactionsSnapshot, entitlementsSnapshot] =
      await Promise.all([
        poolRef.get(),
        db.collection("creditPoolTransactions")
          .orderBy("createdAt", "desc")
          .limit(200)
          .get(),
        db.collection("creditEntitlements")
          .orderBy("createdAt", "desc")
          .limit(500)
          .get()
      ]);

    const poolData = poolSnapshot.exists
      ? poolSnapshot.data() || {}
      : {};

    const availableCredits = Math.max(
      0,
      safeNumber(poolData.availableCredits, 0)
    );

    const totalReturnedCredits = Math.max(
      0,
      safeNumber(poolData.totalReturnedCredits, 0)
    );

    const totalResoldCredits = Math.max(
      0,
      safeNumber(poolData.totalResoldCredits, 0)
    );

    const transactions = transactionsSnapshot.docs.map((doc) => {
      const data = doc.data() || {};

      return {
        id: doc.id,
        type: String(data.type || "").toUpperCase(),
        userId: data.userId || null,
        paymentId: data.paymentId || null,
        plan: data.plan || null,
        credits: Math.max(0, safeNumber(data.credits, 0)),
        reason: data.reason || null,
        approvedBy: data.approvedBy || null,
        createdAt: timestampToISO(data.createdAt),
        expiredAt: timestampToISO(data.expiredAt)
      };
    });

    const entitlements = entitlementsSnapshot.docs.map((doc) => {
      const data = doc.data() || {};

      const granted = Math.max(
        0,
        safeNumber(data.creditsGranted, 0)
      );

      const used = Math.max(
        0,
        safeNumber(data.creditsUsed, 0)
      );

      const remaining = Math.max(
        0,
        safeNumber(
          data.creditsRemaining,
          Math.max(0, granted - used)
        )
      );

      return {
        id: doc.id,
        userId: data.userId || null,
        plan: data.plan || null,
        source: data.source || "legacy",
        paymentReference: data.paymentReference || null,
        creditsGranted: granted,
        creditsUsed: used,
        creditsRemaining: remaining,
        expiredCredits: Math.max(0, safeNumber(data.expiredCredits, 0)),
        status: data.status || null,
        createdAt: timestampToISO(data.createdAt),
        expiresAt: timestampToISO(data.expiresAt),
        expiredAt: timestampToISO(data.expiredAt)
      };
    });

    const activeEntitlements = entitlements.filter(
      (item) => String(item.status || "").toLowerCase() === "active"
    );

    const expiredEntitlements = entitlements.filter(
      (item) => String(item.status || "").toLowerCase() === "expired"
    );

    const activeGrantedCredits = activeEntitlements.reduce(
      (total, item) => total + item.creditsGranted,
      0
    );

    const activeUsedCredits = activeEntitlements.reduce(
      (total, item) => total + item.creditsUsed,
      0
    );

    const activeRemainingCredits = activeEntitlements.reduce(
      (total, item) => total + item.creditsRemaining,
      0
    );

    const expiredReturnedCredits = expiredEntitlements.reduce(
      (total, item) =>
        total + Math.max(0, safeNumber(item.expiredCredits, 0)),
      0
    );

    res.json({
      success: true,

      pool: {
        availableCredits,
        totalReturnedCredits,
        totalResoldCredits,
        updatedAt: timestampToISO(poolData.updatedAt)
      },

      summary: {
        availableToResell: availableCredits,
        totalReturned: totalReturnedCredits,
        totalResold: totalResoldCredits,
        activeGrantedCredits,
        activeUsedCredits,
        activeRemainingCredits,
        expiredReturnedCredits
      },

      transactions,
      entitlements
    });
  } catch (error) {
    console.error("Admin credit pool error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load credit pool."
    });
  }
});

/* =========================================================
ADMIN - UNIFIED CREDIT TRANSACTION LEDGER
Source of truth for all credit movements.
Supports monthly calendar/ledger queries.
========================================================= */

app.get("/api/admin/credit-ledger", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const requestedMonth = String(req.query?.month || "").trim();

    if (!/^(\d{4})-(\d{2})$/.test(requestedMonth)) {
      return res.status(400).json({
        success: false,
        error: "A valid month is required in YYYY-MM format."
      });
    }

    const year = Number(requestedMonth.slice(0, 4));
    const month = Number(requestedMonth.slice(5, 7));

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({
        success: false,
        error: "A valid month is required in YYYY-MM format."
      });
    }

    const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, month, 1, 0, 0, 0, 0);

    const startTimestamp = admin.firestore.Timestamp.fromDate(monthStart);
    const endTimestamp = admin.firestore.Timestamp.fromDate(monthEnd);

    const snapshot = await db.collection("creditPoolTransactions")
      .where("createdAt", ">=", startTimestamp)
      .where("createdAt", "<", endTimestamp)
      .orderBy("createdAt", "desc")
      .limit(5000)
      .get();

    const transactions = snapshot.docs.map((doc) => {
      const data = doc.data() || {};

      return {
        id: doc.id,
        type: String(data.type || "").toUpperCase(),
        userId: data.userId || null,
        paymentId: data.paymentId || null,
        entitlementId: data.entitlementId || null,
        jobId: data.jobId || null,
        plan: data.plan || null,
        credits: Math.max(0, safeNumber(data.credits, 0)),
        source: data.source || null,
        destination: data.destination || null,
        reason: data.reason || null,
        feature: data.feature || null,
        approvedBy: data.approvedBy || null,
        createdAt: timestampToISO(data.createdAt),
        expiredAt: timestampToISO(data.expiredAt)
      };
    });

    const summary = {
      totalCredits: 0,
      transactionCount: transactions.length,
      granted: 0,
      used: 0,
      returned: 0,
      resold: 0,
      reserved: 0,
      released: 0,
      allocated: 0,
      referralReward: 0,
      promotionReward: 0,
      purchased: 0,
      removed: 0
    };

    for (const transaction of transactions) {
      const credits = Math.max(0, safeNumber(transaction.credits, 0));
      const type = transaction.type;

      summary.totalCredits += credits;

      if (type === "GRANTED") summary.granted += credits;
      if (type === "USED") summary.used += credits;
      if (type === "RETURNED") summary.returned += credits;
      if (type === "RESOLD") summary.resold += credits;
      if (type === "RESERVED") summary.reserved += credits;
      if (type === "RELEASED") summary.released += credits;
      if (type === "ALLOCATED") summary.allocated += credits;
      if (type === "REFERRAL_REWARD") summary.referralReward += credits;
      if (type === "PROMOTION_REWARD") summary.promotionReward += credits;
      if (type === "PURCHASED") summary.purchased += credits;
      if (type === "REMOVED") summary.removed += credits;
    }

    res.json({
      success: true,
      month: requestedMonth,
      period: {
        start: monthStart.toISOString(),
        end: monthEnd.toISOString()
      },
      summary,
      transactions
    });
  } catch (error) {
    console.error("Admin credit ledger error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load credit ledger."
    });
  }
});

/* =========================================================
ADMIN - CREDIT PURCHASED CALCULATOR
Tracks credits purchased from WaveSpeedAI separately from
the existing creditPool/inventory system.
========================================================= */

app.get("/api/admin/credit-purchases", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("creditPurchases")
      .orderBy("purchasedAt", "desc")
      .limit(500)
      .get();

    const purchases = snapshot.docs.map((doc) => {
      const data = doc.data() || {};

      const creditsPurchased = Math.max(
        0,
        safeNumber(data.creditsPurchased, 0)
      );

      const storedRemaining = safeNumber(
        data.creditsRemaining,
        creditsPurchased
      );

      const creditsRemaining = Math.max(
        0,
        Math.min(
          creditsPurchased,
          storedRemaining
        )
      );

      const creditsAllocated = Math.max(
        0,
        Math.min(
          creditsPurchased,
          safeNumber(
            data.creditsAllocated,
            Math.max(
              0,
              creditsPurchased - creditsRemaining
            )
          )
        )
      );

      return {
        id: doc.id,
        provider: data.provider || "WaveSpeedAI",
        creditsPurchased,
        creditsAllocated,
        creditsRemaining,
        creditsSold: Math.max(
          0,
          safeNumber(data.creditsSold, 0)
        ),
        cost: Math.max(
          0,
          safeNumber(data.cost, 0)
        ),
        currency: data.currency || "USD",
        reference: data.reference || null,
        note: data.note || null,
        purchasedAt: timestampToISO(data.purchasedAt),
        createdAt: timestampToISO(data.createdAt),
        updatedAt: timestampToISO(data.updatedAt),
        createdBy: data.createdBy || null
      };
    });

    const summarySnapshot = await db.collection("creditPurchases")
      .get();

    let totalPurchased = 0;
    let totalAllocated = 0;
    let availableToAllocate = 0;

    summarySnapshot.forEach((doc) => {
      const data = doc.data() || {};

      const creditsPurchased = Math.max(
        0,
        safeNumber(data.creditsPurchased, 0)
      );

      const storedRemaining = safeNumber(
        data.creditsRemaining,
        creditsPurchased
      );

      const creditsRemaining = Math.max(
        0,
        Math.min(
          creditsPurchased,
          storedRemaining
        )
      );

      const creditsAllocated = Math.max(
        0,
        Math.min(
          creditsPurchased,
          safeNumber(
            data.creditsAllocated,
            Math.max(
              0,
              creditsPurchased - creditsRemaining
            )
          )
        )
      );

      totalPurchased += creditsPurchased;
      totalAllocated += creditsAllocated;
      availableToAllocate += creditsRemaining;
    });

    res.json({
      success: true,
      summary: {
        totalPurchased,
        totalAllocated,
        availableToAllocate,
        totalSold: totalAllocated,
        availableToSell: availableToAllocate
      },
      purchases
    });
  } catch (error) {
    console.error("Admin credit purchases error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load purchased credits."
    });
  }
});

app.post("/api/admin/credit-purchases", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const creditsPurchased = Math.floor(
      safeNumber(req.body?.creditsPurchased, 0)
    );

    const cost = Math.max(
      0,
      safeNumber(req.body?.cost, 0)
    );

    const provider = String(
      req.body?.provider || "WaveSpeedAI"
    ).trim();

    const currency = String(
      req.body?.currency || "USD"
    ).trim().toUpperCase();

    const reference = String(
      req.body?.reference || ""
    ).trim();

    const note = String(
      req.body?.note || ""
    ).trim();

    if (!Number.isFinite(creditsPurchased) || creditsPurchased <= 0) {
      return res.status(400).json({
        success: false,
        error: "Credits purchased must be greater than zero."
      });
    }

    const now = admin.firestore.Timestamp.now();

    const purchaseRef = db.collection("creditPurchases").doc();

    const purchaseLedgerRef = createCreditLedgerRef();

    await purchaseRef.set({
      provider: provider || "WaveSpeedAI",
      creditsPurchased,
      creditsAllocated: 0,
      creditsSold: 0,
      creditsRemaining: creditsPurchased,
      cost,
      currency: currency || "USD",
      reference: reference || null,
      note: note || null,
      purchasedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: req.userUid
    });

    await purchaseLedgerRef.set({
      type: "PURCHASED",
      purchaseId: purchaseRef.id,
      credits: creditsPurchased,
      source: provider || "WaveSpeedAI",
      destination: "purchased_credit_inventory",
      reason: "admin_credit_purchase",
      cost,
      currency: currency || "USD",
      reference: reference || null,
      createdAt: now,
      approvedBy: req.userUid
    });

    res.json({
      success: true,
      purchase: {
        id: purchaseRef.id,
        provider: provider || "WaveSpeedAI",
        creditsPurchased,
        creditsAllocated: 0,
        creditsSold: 0,
        creditsRemaining: creditsPurchased,
        cost,
        currency: currency || "USD",
        reference: reference || null,
        note: note || null,
        purchasedAt: now.toDate().toISOString(),
        createdBy: req.userUid
      }
    });
  } catch (error) {
    console.error("Admin add credit purchase error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to add purchased credits."
    });
  }
});

/* =========================================================
ADMIN - ALLOCATE PURCHASED CREDITS TO CREDIT POOL
Moves credits from Purchased Calculator into the existing
creditPool/inventory without creating duplicate credits.
========================================================= */

app.post("/api/admin/credit-purchases/:purchaseId/allocate", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const purchaseId = String(
      req.params.purchaseId || ""
    ).trim();

    const creditsToAllocate = Math.floor(
      safeNumber(req.body?.credits, 0)
    );

    if (!purchaseId) {
      return res.status(400).json({
        success: false,
        error: "Purchase ID is required."
      });
    }

    if (
      !Number.isFinite(creditsToAllocate) ||
      creditsToAllocate <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Credits to allocate must be greater than zero."
      });
    }

    const purchaseRef = db
      .collection("creditPurchases")
      .doc(purchaseId);

    const poolRef = db
      .collection("creditPool")
      .doc("inventory");

    const result = await db.runTransaction(async (transaction) => {
      const purchaseSnapshot = await transaction.get(
        purchaseRef
      );

      if (!purchaseSnapshot.exists) {
        throw new Error("PURCHASE_NOT_FOUND");
      }

      const poolSnapshot = await transaction.get(
        poolRef
      );

      const purchaseData =
        purchaseSnapshot.data() || {};

      const poolData = poolSnapshot.exists
        ? poolSnapshot.data() || {}
        : {};

      const creditsPurchased = Math.max(
        0,
        safeNumber(
          purchaseData.creditsPurchased,
          0
        )
      );

      const currentRemaining = Math.max(
        0,
        Math.min(
          creditsPurchased,
          safeNumber(
            purchaseData.creditsRemaining,
            creditsPurchased
          )
        )
      );

      const currentAllocated = Math.max(
        0,
        Math.min(
          creditsPurchased,
          safeNumber(
            purchaseData.creditsAllocated,
            Math.max(
              0,
              creditsPurchased - currentRemaining
            )
          )
        )
      );

      if (
        currentRemaining <
        creditsToAllocate
      ) {
        throw new Error(
          "INSUFFICIENT_PURCHASED_CREDITS"
        );
      }

      const currentPoolCredits = Math.max(
        0,
        safeNumber(
          poolData.availableCredits,
          0
        )
      );

      const totalReturnedCredits = Math.max(
        0,
        safeNumber(
          poolData.totalReturnedCredits,
          0
        )
      );

      const totalResoldCredits = Math.max(
        0,
        safeNumber(
          poolData.totalResoldCredits,
          0
        )
      );

      const newRemaining =
        currentRemaining -
        creditsToAllocate;

      const newAllocated =
        currentAllocated +
        creditsToAllocate;

      const newPoolCredits =
        currentPoolCredits +
        creditsToAllocate;

      const now =
        admin.firestore.Timestamp.now();

      const allocationLedgerRef =
        createCreditLedgerRef();

      transaction.set(
        purchaseRef,
        {
          creditsAllocated: newAllocated,
          creditsRemaining: newRemaining,
          updatedAt: now
        },
        {
          merge: true
        }
      );

      transaction.set(
        poolRef,
        {
          availableCredits: newPoolCredits,
          totalReturnedCredits,
          totalResoldCredits,
          updatedAt: now
        },
        {
          merge: true
        }
      );

      transaction.set(
        allocationLedgerRef,
        {
          type: "ALLOCATED",
          purchaseId,
          credits: creditsToAllocate,
          source: "purchased_credit_inventory",
          destination: "credit_pool",
          reason: "purchased_credit_allocation",
          createdAt: now,
          approvedBy: req.userUid
        }
      );

      return {
        purchaseId,
        creditsAllocated: creditsToAllocate,
        purchaseCreditsRemaining: newRemaining,
        purchaseCreditsAllocated: newAllocated,
        poolCreditsAvailable: newPoolCredits
      };
    });

    res.json({
      success: true,
      message: "Purchased credits allocated to the Credit Pool successfully.",
      allocation: result
    });
  } catch (error) {
    console.error(
      "Allocate purchased credits error:",
      error
    );

    const message = String(
      error?.message || ""
    );

    if (message === "PURCHASE_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: "Purchased credit record not found."
      });
    }

    if (
      message ===
      "INSUFFICIENT_PURCHASED_CREDITS"
    ) {
      return res.status(400).json({
        success: false,
        error: "There are not enough remaining purchased credits for this allocation."
      });
    }

    res.status(500).json({
      success: false,
      error: "Unable to allocate purchased credits."
    });
  }
});
app.get("/api/admin/users", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const filter = String(req.query?.filter || "all").trim().toLowerCase();
    const validFilters = ["all", "admin", "pro", "premium", "active", "free"];
    const normalizedFilter = validFilters.includes(filter) ? filter : "all";
    const snapshot = await db.collection("users").get();
    let users = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        uid: doc.id, email: data.email || null, displayName: data.displayName || data.name || null,
        photoURL: data.photoURL || data.profilePhotoUrl || null, credits: Math.max(0, safeNumber(data.credits, 0)),
        plan: getUserPlan(data), subscriptionPlan: getUserPlan(data), subscriptionExpiresAt: timestampToISO(data.subscriptionExpiresAt),
        freeVideoUsed: data.freeVideoUsed === true, freeVideoRemaining: normalizeFreeVideoState(data).freeVideoRemaining,
        freeVideoAvailable: normalizeFreeVideoState(data).freeVideoAvailable, isAdmin: isAdmin(doc.id),
        createdAt: timestampToISO(data.createdAt), updatedAt: timestampToISO(data.updatedAt)
      };
    });
    if (normalizedFilter === "admin") users = users.filter((user) => user.isAdmin);
    if (normalizedFilter === "pro") users = users.filter((user) => user.plan === "pro");
    if (normalizedFilter === "premium") users = users.filter((user) => user.plan === "premium");
    if (normalizedFilter === "active") users = users.filter((user) => !!user.plan);
    if (normalizedFilter === "free") users = users.filter((user) => !user.plan);
    users.sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, filter: normalizedFilter, total: users.length, users });
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({ success: false, error: "Unable to load admin users." });
  }
});

/* =========================================================
VOICE MESSAGE
========================================================= */
app.post("/api/voice/tts", requireAuthenticatedUser, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const language = normalizeLanguageCode(req.body?.language || "en");
    if (!text) return res.status(400).json({ success: false, error: "Text is required." });
    console.log("GAVEAI TTS REQUEST:", language, text.slice(0, 120));
    const audioUrl = await getAudioUrl(text, language);
    if (!audioUrl) return res.status(502).json({ success: false, stage: "tts", error: "GaveAI voice audio could not be generated." });
    return res.json({ success: true, audioUrl, language });
  } catch (error) {
    console.error("GaveAI TTS route error:", error);
    return res.status(500).json({ success: false, stage: "tts", error: "GaveAI voice audio could not be generated." });
  }
});

app.post("/api/voice/message", requireAuthenticatedUser, upload.single("audio"), async (req, res) => {
  try {
    const userId = req.userUid;
    const imageUrl = req.body?.imageUrl || null;
    if (!req.file) return res.status(400).json({ success: false, error: "Audio file is required." });
    const audioBuffer = req.file.buffer;
    if (!audioBuffer || !audioBuffer.length) throw new Error("Audio buffer is empty.");
    const sttResult = await transcribeAudio(audioBuffer, req.file.mimetype, "voice-input.webm");
    const transcript = String(sttResult?.transcript || "").trim();
    const detectedLanguage = sttResult?.language || "en";
    if (!transcript) return res.status(400).json({ success: false, error: "No speech was detected." });
    const aiResult = await generateAIResponse(transcript, { userId, imageUrl, conversation: [], language: detectedLanguage, detectedLanguage });
    const reply = typeof aiResult === "string" ? aiResult : aiResult?.reply || aiResult?.response || aiResult?.content || aiResult?.message || "";
    if (!reply) throw new Error("AI did not generate a response.");
    let audioUrl = null;
    try {
      const normalizedLanguage = normalizeLanguageCode(detectedLanguage);
      audioUrl = await getAudioUrl(reply, normalizedLanguage);
    } catch (ttsError) {
      console.error("GaveAI backend TTS generation failed:", ttsError);
      return res.status(502).json({ success: false, stage: "tts", language: detectedLanguage, error: "GaveAI voice audio could not be generated. Please try again." });
    }
    if (!audioUrl) return res.status(502).json({ success: false, stage: "tts", language: detectedLanguage, error: "GaveAI voice audio could not be generated. Please try again." });
    const userData = await getUserDocument(userId);
    const freeState = normalizeFreeVideoState(userData || {});
    res.json({
      success: true, transcript, reply, response: reply, audioUrl, audio: audioUrl, language: detectedLanguage, detectedLanguage,
      freeVideoRemaining: freeState.freeVideoRemaining, freeVideoAvailable: freeState.freeVideoAvailable
    });
  } catch (error) {
    console.error("Voice message error:", error);
    res.status(500).json({ success: false, error: "GaveAI voice processing failed. Please try again." });
  }
});

/* =========================================================
404 HANDLER
========================================================= */
app.use((req, res) => {
  res.status(404).json({ success: false, error: "404 Not Found", path: req.originalUrl, method: req.method, message: `The requested route ${req.method} ${req.originalUrl} does not exist.` });
});

/* =========================================================
GLOBAL ERROR HANDLER
========================================================= */
app.use((error, req, res, next) => {
  console.error("GLOBAL ERROR:", error);
  if (res.headersSent) return next(error);
  if (error?.message === "CORS origin not allowed.") return res.status(403).json({ success: false, error: "Request origin is not allowed." });
  if (error?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "File is too large. Maximum size is 50 MB." });
  res.status(500).json({ success: false, error: "Gave Money Tips AI backend encountered an error." });
});

/* =========================================================
START SERVER
========================================================= */
app.listen(PORT, () => {
  console.log("============================================================");
  console.log("GAVEAI FINAL VIDEO + IMAGE + PAYMENT SYSTEM LOADED");
  console.log("VIDEO PROVIDER: GaveAI");
  console.log("IMAGE PROVIDER: GaveAI");
  console.log(`IMAGE MODEL: ${GAVEAI_IMAGE_MODEL}`);
  console.log(`ADMIN USER ID: ${ADMIN_USER_ID}`);
  console.log("FREE: 1 lifetime video");
  console.log("PRO: $9.99 / 1,000 credits / 30 days");
  console.log("PREMIUM: $19.99 / 1,500 credits / 30 days");
  console.log("5 seconds: 15 credits");
  console.log("8 seconds: 24 credits");
  console.log("NO DAILY CREDITS | NO ROLLOVER");
  console.log("TOP-UP: ADD PLAN CREDITS + NEW 30 DAYS");
  console.log("ADMIN VIDEO GENERATION: UNLIMITED");
  console.log("NO-REFUND POLICY: Failed videos do NOT refund credits");
  console.log("------------------------------------------------------------");
  console.log(`Image generation configured: ${!!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)}`);
  console.log(`ImageKit configured: ${!!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT)}`);
  console.log("============================================================");
  console.log(`Gave Money Tips AI running on port ${PORT}`);
  console.log(`Video Queue: ${MAX_CONCURRENT_VIDEOS} concurrent / ${MAX_VIDEO_QUEUE} queued`);
});
