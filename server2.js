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

async function processExpiredEntitlements(userId) {
  if (isAdmin(userId)) return 0;

  try {
    const userRef = db.collection("users").doc(userId);
    const poolRef = db.collection("creditPool").doc("inventory");
    const entitlementCollection = db.collection("creditEntitlements");

    const activeQuery = entitlementCollection
      .where("userId", "==", userId)
      .where("status", "==", "active");

    const pendingQuery = entitlementCollection
      .where("userId", "==", userId)
      .where("status", "==", "expired_pending_return");

    const legacyQuery = entitlementCollection
      .where("userId", "==", userId)
      .where("status", "==", "expired");

    return await db.runTransaction(async (transaction) => {
      const nowMillis = Date.now();
      const nowTimestamp = admin.firestore.Timestamp.now();

      const [userSnap, poolSnap, activeSnapshot, pendingSnapshot, legacySnapshot] =
        await Promise.all([
          transaction.get(userRef),
          transaction.get(poolRef),
          transaction.get(activeQuery),
          transaction.get(pendingQuery),
          transaction.get(legacyQuery)
        ]);

      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const poolData = poolSnap.exists ? poolSnap.data() || {} : {};

      const currentCredits = safeNumber(userData.credits, 0);
      const availableCredits = Math.max(0, safeNumber(poolData.availableCredits, 0));
      const totalReturnedCredits = Math.max(0, safeNumber(poolData.totalReturnedCredits, 0));
      const totalResoldCredits = Math.max(0, safeNumber(poolData.totalResoldCredits, 0));

      if (currentCredits < 0) {
        return 0;
      }

      const candidatesById = new Map();
      const zeroRemainingExpired = [];
      const invalidExpiryRecords = [];
      let unexpiredRemainingTotal = 0;

      for (const doc of activeSnapshot.docs) {
        const ent = doc.data() || {};
        const granted = Math.max(0, safeNumber(ent.creditsGranted, 0));
        const used = Math.max(0, safeNumber(ent.creditsUsed, 0));
        const calculatedRemaining = Math.max(0, granted - used);
        const recordedRemaining = safeNumber(ent.creditsRemaining, calculatedRemaining);
        const remaining = Math.max(0, Math.min(recordedRemaining, calculatedRemaining));
        const expiresAt = timestampToMillis(ent.expiresAt);

        if (expiresAt > 0 && expiresAt <= nowMillis) {
          const alreadyReturned = Math.max(0, safeNumber(ent.returnedToPoolCredits, 0));
          const amountToResolve = Math.max(0, remaining - alreadyReturned);

          if (amountToResolve > 0) {
            candidatesById.set(doc.id, {
              ref: doc.ref,
              source: ent.source || "unknown",
              expiresAt,
              amountToResolve,
              originalExpiredCredits: Math.max(remaining, amountToResolve + alreadyReturned),
              alreadyReturned,
              priorExpiredCredits: Math.max(0, safeNumber(ent.expiredCredits, 0))
            });
          } else {
            zeroRemainingExpired.push({ ref: doc.ref });
          }
        } else {
          unexpiredRemainingTotal += remaining;
        }
      }

      for (const snapshot of [pendingSnapshot, legacySnapshot]) {
        for (const doc of snapshot.docs) {
          if (candidatesById.has(doc.id)) continue;

          const ent = doc.data() || {};
          const source = ent.source || "unknown";
          const expiresAt = timestampToMillis(ent.expiresAt);

          const alreadyReturned = Math.max(0, safeNumber(ent.returnedToPoolCredits, 0));
          const recordedExpired = Math.max(0, safeNumber(ent.expiredCredits, 0));
          const fallbackUnreturned = Math.max(0, recordedExpired - alreadyReturned);
          const amountToResolve = Math.max(
            0,
            safeNumber(ent.unreturnedExpiredCredits, fallbackUnreturned)
          );

          if (amountToResolve <= 0) continue;

          if (!expiresAt || expiresAt > nowMillis) {
            invalidExpiryRecords.push({
              ref: doc.ref,
              entitlementId: doc.id,
              reason: expiresAt
                ? "pending_expiry_not_elapsed"
                : "pending_expiry_missing_or_invalid"
            });
            continue;
          }

          candidatesById.set(doc.id, {
            ref: doc.ref,
            source,
            expiresAt,
            amountToResolve,
            originalExpiredCredits: Math.max(
              recordedExpired,
              amountToResolve + alreadyReturned
            ),
            alreadyReturned,
            priorExpiredCredits: recordedExpired
          });
        }
      }

      const candidates = Array.from(candidatesById.values())
        .filter((item) => item.amountToResolve > 0)
        .sort((a, b) => a.expiresAt - b.expiresAt);

      if (candidates.length === 0) {
        for (const item of invalidExpiryRecords) {
          transaction.update(item.ref, {
            expirationReconciliationRequired: true,
            expirationReconciliationAt: nowTimestamp,
            expirationReconciliationReason: item.reason,
            updatedAt: nowTimestamp
          });
        }

        for (const item of zeroRemainingExpired) {
          transaction.update(item.ref, {
            status: "expired",
            creditsRemaining: 0,
            expiredAt: nowTimestamp,
            updatedAt: nowTimestamp
          });
        }

        return 0;
      }

      const poolSaleCandidates = candidates.filter(
        (item) => item.source === "credit_pool_sale"
      );

      const returnLedgerChecks = await Promise.all(
        poolSaleCandidates.map(async (item) => {
          const snapshot = await transaction.get(
            db.collection("creditPoolTransactions")
              .where("entitlementId", "==", item.ref.id)
          );

          const existingReturns = snapshot.docs.filter((doc) => {
            const row = doc.data() || {};
            return row.type === "RETURNED" &&
              row.destination === "credit_pool" &&
              row.entitlementId === item.ref.id;
          });

          return {
            entitlementId: item.ref.id,
            ledgerIds: existingReturns.map((doc) => doc.id)
          };
        })
      );

      if (invalidExpiryRecords.length > 0) {
        for (const item of invalidExpiryRecords) {
          transaction.update(item.ref, {
            expirationReconciliationRequired: true,
            expirationReconciliationAt: nowTimestamp,
            expirationReconciliationReason: item.reason,
            updatedAt: nowTimestamp
          });
        }

        for (const item of candidates) {
          transaction.update(item.ref, {
            expirationReconciliationRequired: true,
            expirationReconciliationAt: nowTimestamp,
            expirationReconciliationReason: "blocked_by_invalid_pending_expiry_record",
            updatedAt: nowTimestamp
          });
        }

        return 0;
      }

      for (const item of zeroRemainingExpired) {
        transaction.update(item.ref, {
          status: "expired",
          creditsRemaining: 0,
          expiredAt: nowTimestamp,
          updatedAt: nowTimestamp
        });
      }

      const duplicateReturns = returnLedgerChecks.filter(
        (item) => item.ledgerIds.length > 0
      );

      if (duplicateReturns.length > 0) {
        for (const item of duplicateReturns) {
          const candidate = candidatesById.get(item.entitlementId);
          if (!candidate) continue;

          transaction.update(candidate.ref, {
            expirationReconciliationRequired: true,
            expirationReconciliationAt: nowTimestamp,
            expirationReconciliationReason: "existing_pool_return_ledger_detected",
            existingPoolReturnLedgerIds: item.ledgerIds,
            updatedAt: nowTimestamp
          });
        }

        return 0;
      }

      const totalExpiredToResolve = candidates.reduce(
        (sum, item) => sum + item.amountToResolve,
        0
      );

      const balanceAvailableAfterProtectingActive = currentCredits - unexpiredRemainingTotal;

      if (
        balanceAvailableAfterProtectingActive < 0 ||
        balanceAvailableAfterProtectingActive < totalExpiredToResolve
      ) {
        for (const item of candidates) {
          transaction.update(item.ref, {
            expirationReconciliationRequired: true,
            expirationReconciliationAt: nowTimestamp,
            updatedAt: nowTimestamp
          });
        }

        return 0;
      }

      let totalPoolCredits = 0;
      let totalExpiredCreditsRemoved = 0;

      for (const item of candidates) {
        const isPoolSale = item.source === "credit_pool_sale";
        const poolReturnAmount = isPoolSale ? item.amountToResolve : 0;

        totalPoolCredits += poolReturnAmount;
        totalExpiredCreditsRemoved += item.amountToResolve;

        transaction.update(item.ref, {
          status: "expired",
          creditsRemaining: 0,
          expiredCredits: Math.max(
            item.originalExpiredCredits,
            item.priorExpiredCredits
          ),
          returnedToPoolCredits: item.alreadyReturned + poolReturnAmount,
          unreturnedExpiredCredits: 0,
          expiredAt: nowTimestamp,
          updatedAt: nowTimestamp,
          expirationReconciliationRequired: false,
          expirationResolvedSource: item.source,
          expirationPoolReturnCredits: poolReturnAmount
        });

        if (poolReturnAmount > 0) {
          const ledgerRef = createCreditLedgerRef();
          transaction.set(ledgerRef, {
            type: "RETURNED",
            userId,
            credits: poolReturnAmount,
            source: "credit_entitlement",
            destination: "credit_pool",
            reason: "credit_entitlement_expired",
            entitlementId: item.ref.id,
            createdAt: nowTimestamp
          });
        }
      }

      transaction.set(
        userRef,
        {
          credits: currentCredits - totalExpiredCreditsRemoved,
          updatedAt: nowTimestamp
        },
        { merge: true }
      );

      if (totalPoolCredits > 0) {
        transaction.set(
          poolRef,
          {
            availableCredits: availableCredits + totalPoolCredits,
            totalReturnedCredits: totalReturnedCredits + totalPoolCredits,
            totalResoldCredits,
            updatedAt: nowTimestamp
          },
          { merge: true }
        );
      }

      return totalPoolCredits;
    });
  } catch (error) {
    console.error("EXPIRED ENTITLEMENTS ERROR:", error);
    return 0;
  }
}

function getCreditEntitlementExpiration(createdAt = new Date()) {
  const startDate = new Date(createdAt);
  if (Number.isNaN(startDate.getTime())) {
    throw new Error("Invalid credit entitlement creation date.");
  }
  return admin.firestore.Timestamp.fromDate(
    new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000)
  );
}

function getCreditBonusExpiration(createdAt = new Date()) {
  const startDate = new Date(createdAt);
  if (Number.isNaN(startDate.getTime())) {
    throw new Error("Invalid credit bonus creation date.");
  }
  return admin.firestore.Timestamp.fromDate(
    new Date(startDate.getTime() + 3 * 24 * 60 * 60 * 1000)
  );
}

function createCreditLedgerRef() {
  return db.collection("creditPoolTransactions").doc();
}

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
ROOT & HEALTH
========================================================= */
app.get("/", (req, res) => {
  res.send("Gave Money Tips AI Backend is running");
});

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

/* =========================================================
REFERRAL SYSTEM
========================================================= */
function normalizeReferralCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

function generateReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return "GAVE-" + code;
}

function normalizeCompetitionStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (status === "DRAFT") return "DRAFT";
  if (status === "OPEN") return "OPEN";
  if (status === "CLOSED") return "CLOSED";
  if (status === "ARCHIVED") return "ARCHIVED";
  return null;
}

function timestampFromInput(value, errorCode) {
  if (value === null || value === undefined || value === "") {
    throw new Error(errorCode + "_REQUIRED");
  }
  if (value instanceof admin.firestore.Timestamp) {
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error(errorCode + "_INVALID");
    }
    return admin.firestore.Timestamp.fromDate(value);
  }
  if (typeof value === "number") {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new Error(errorCode + "_INVALID");
    }
    return admin.firestore.Timestamp.fromDate(date);
  }
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(errorCode + "_INVALID");
  }
  return admin.firestore.Timestamp.fromDate(parsed);
}

function competitionToClient(competitionId, data = {}) {
  return {
    competitionId,
    title: String(data.title || ""),
    status: normalizeCompetitionStatus(data.status) || "DRAFT",
    rewardCredits: Math.max(0, safeNumber(data.rewardCredits, 0)),
    rewardDurationMonths: Math.max(0, safeNumber(data.rewardDurationMonths, 0)),
    requiredReferrals: Math.max(1, Math.floor(safeNumber(data.requiredReferrals, 1))),
    startAt: timestampToISO(data.startAt),
    endAt: timestampToISO(data.endAt),
    createdAt: timestampToISO(data.createdAt),
    updatedAt: timestampToISO(data.updatedAt),
    winnerUid: String(data.winnerUid || "").trim(),
    winnerReferralCount: Math.max(0, Math.floor(safeNumber(data.winnerReferralCount, 0))),
    rewardAwarded: data.rewardAwarded === true
  };
}

function getReferralCompetitionRef(competitionId) {
  const id = String(competitionId || "").trim();
  if (!id) {
    throw new Error("COMPETITION_ID_REQUIRED");
  }
  return db.collection("referralCompetitions").doc(id);
}

function getReferralQualificationRef(paymentId) {
  const id = String(paymentId || "").trim();
  if (!id) {
    throw new Error("PAYMENT_ID_REQUIRED");
  }
  return db.collection("referralQualifications").doc(id);
}

async function getActiveReferralCompetition() {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db.collection("referralCompetitions").where("status", "==", "OPEN").limit(100).get();
  const activeCompetitions = snapshot.docs
    .map((doc) => ({
      id: doc.id,
      data: doc.data() || {}
    }))
    .filter((item) => {
      const startAt = timestampToMillis(item.data.startAt);
      const endAt = timestampToMillis(item.data.endAt);
      const nowMillis = now.toMillis();
      if (!startAt || !endAt) return false;
      return startAt <= nowMillis && nowMillis < endAt;
    })
    .sort((a, b) => timestampToMillis(b.data.startAt) - timestampToMillis(a.data.startAt));

  if (!activeCompetitions.length) return null;
  const selected = activeCompetitions[0];
  return {
    competitionId: selected.id,
    ...competitionToClient(selected.id, selected.data)
  };
}

async function countQualifiedReferrals(competitionId, referrerUid) {
  const normalizedCompetitionId = String(competitionId || "").trim();
  const normalizedReferrerUid = String(referrerUid || "").trim();
  if (!normalizedCompetitionId || !normalizedReferrerUid) return 0;
  const snapshot = await db.collection("referralQualifications")
    .where("competitionId", "==", normalizedCompetitionId)
    .where("referrerUid", "==", normalizedReferrerUid)
    .get();
  return snapshot.size;
}

async function applyReferralQualificationInTransaction(
  transaction,
  paymentId,
  referredUserId,
  referredUserData,
  now,
  approvedBy,
  poolData
) {
  const referrerUid = String(referredUserData?.referrerUid || "").trim();
  if (!referrerUid) {
    return {
      qualified: false,
      rewarded: false,
      winner: false,
      qualificationId: null,
      competitionId: null,
      referralCount: 0,
      rewardCredits: 0,
      rewardEntitlementId: null
    };
  }

  const competitionQuery = db.collection("referralCompetitions").where("status", "==", "OPEN").limit(100);
  const qualificationRef = getReferralQualificationRef(paymentId);
  const referrerRef = db.collection("users").doc(referrerUid);
  const qualificationsQuery = db.collection("referralQualifications");

  const [competitionSnapshot, qualificationSnapshot, referrerSnapshot, allQualificationsSnapshot] = await Promise.all([
    transaction.get(competitionQuery),
    transaction.get(qualificationRef),
    transaction.get(referrerRef),
    transaction.get(qualificationsQuery)
  ]);

  if (qualificationSnapshot.exists) {
    const existingQualification = qualificationSnapshot.data() || {};
    return {
      qualified: true,
      rewarded: existingQualification.rewarded === true,
      winner: existingQualification.winner === true,
      qualificationId: qualificationRef.id,
      competitionId: existingQualification.competitionId || null,
      referralCount: Math.max(0, safeNumber(existingQualification.referralCount, 0)),
      rewardCredits: Math.max(0, safeNumber(existingQualification.rewardCredits, 0)),
      rewardEntitlementId: existingQualification.rewardEntitlementId || null
    };
  }

  if (!referrerSnapshot.exists) {
    return {
      qualified: false,
      rewarded: false,
      winner: false,
      qualificationId: null,
      competitionId: null,
      referralCount: 0,
      rewardCredits: 0,
      rewardEntitlementId: null
    };
  }

  const nowMillis = now.toMillis();
  const activeCompetitions = competitionSnapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() || {} }))
    .filter((item) => {
      const startAt = timestampToMillis(item.data.startAt);
      const endAt = timestampToMillis(item.data.endAt);
      return startAt > 0 && endAt > 0 && startAt <= nowMillis && nowMillis < endAt;
    })
    .sort((a, b) => timestampToMillis(b.data.startAt) - timestampToMillis(a.data.startAt));

  if (!activeCompetitions.length) {
    return {
      qualified: false,
      rewarded: false,
      winner: false,
      qualificationId: null,
      competitionId: null,
      referralCount: 0,
      rewardCredits: 0,
      rewardEntitlementId: null
    };
  }

  const selectedCompetition = activeCompetitions[0];
  const competitionId = selectedCompetition.id;
  const competitionData = selectedCompetition.data;

  const requiredReferrals = Math.max(1, Math.floor(safeNumber(competitionData.requiredReferrals, 1)));
  const rewardCredits = Math.max(0, Math.floor(safeNumber(competitionData.rewardCredits, 0)));
  const rewardDurationMonths = Math.max(0, Math.floor(safeNumber(competitionData.rewardDurationMonths, 0)));
  const rewardDurationValue = Math.max(0, Math.floor(safeNumber(competitionData.rewardDurationValue, rewardDurationMonths)));
  const rewardDurationUnit = String(competitionData.rewardDurationUnit || "months").trim().toLowerCase();

  const calculatedDurationDays = rewardDurationValue * (
    rewardDurationUnit === "days" ? 1 :
    rewardDurationUnit === "weeks" ? 7 :
    rewardDurationUnit === "months" ? 30 : 0
  );

  const rewardDurationDays = Math.max(0, Math.floor(safeNumber(competitionData.rewardDurationDays, calculatedDurationDays)));

  if (rewardCredits <= 0 || rewardDurationValue <= 0 || rewardDurationDays <= 0) {
    throw new Error("REFERRAL_REWARD_CONFIGURATION_INVALID");
  }

  const existingQualifications = allQualificationsSnapshot.docs.filter((doc) => {
    const data = doc.data() || {};
    return String(data.competitionId || "").trim() === competitionId && String(data.referrerUid || "").trim() === referrerUid;
  });

  const existingReferredQualification = existingQualifications.find((doc) => {
    const data = doc.data() || {};
    return String(data.referredUid || "").trim() === String(referredUserId || "").trim();
  });

  if (existingReferredQualification) {
    const existingData = existingReferredQualification.data() || {};
    return {
      qualified: true,
      rewarded: existingData.rewarded === true,
      winner: existingData.winner === true,
      qualificationId: existingReferredQualification.id,
      competitionId: existingData.competitionId || competitionId,
      referralCount: Math.max(0, safeNumber(existingData.referralCount, 0)),
      rewardCredits: Math.max(0, safeNumber(existingData.rewardCredits, 0)),
      rewardEntitlementId: existingData.rewardEntitlementId || null
    };
  }

  const referralCount = existingQualifications.length + 1;
  const competitionRef = getReferralCompetitionRef(competitionId);

  const qualificationData = {
    competitionId,
    referrerUid,
    referredUid: referredUserId,
    paymentId,
    referralCode: String(referredUserData?.referralCodeUsed || "").trim() || null,
    qualifiedAt: now,
    referralCount,
    requiredReferrals,
    rewarded: false,
    winner: false,
    createdAt: now
  };

  const competitionWinnerUid = String(competitionData.winnerUid || "").trim();
  const winnerAlreadySelected = !!competitionWinnerUid;
  const reachesThreshold = referralCount >= requiredReferrals;

  let rewardEntitlementId = null;
  let rewardPoolTransactionId = null;
  let winner = false;
  let rewarded = false;

  if (reachesThreshold && !winnerAlreadySelected) {
    const availableCredits = Math.max(0, safeNumber(poolData.availableCredits, 0));
    if (availableCredits < rewardCredits) {
      throw new Error("INSUFFICIENT_REFERRAL_REWARD_POOL");
    }

    const rewardEntitlementRef = db.collection("creditEntitlements").doc();
    const rewardPoolTransactionRef = db.collection("creditPoolTransactions").doc();
    const referrerData = referrerSnapshot.data() || {};
    const referrerCurrentCredits = Math.max(0, safeNumber(referrerData.credits, 0));
    const newReferrerCredits = referrerCurrentCredits + rewardCredits;
    const newAvailableCredits = availableCredits - rewardCredits;

    const totalReturnedCredits = Math.max(0, safeNumber(poolData.totalReturnedCredits, 0));
    const totalResoldCredits = Math.max(0, safeNumber(poolData.totalResoldCredits, 0));

    const rewardExpirationDate = now.toDate();
    const rewardDayOfMonth = rewardExpirationDate.getUTCDate();
    rewardExpirationDate.setUTCDate(1);
    rewardExpirationDate.setUTCMonth(rewardExpirationDate.getUTCMonth() + rewardDurationMonths);
    const rewardTargetMonthDays = new Date(Date.UTC(
      rewardExpirationDate.getUTCFullYear(),
      rewardExpirationDate.getUTCMonth() + 1,
      0
    )).getUTCDate();
    rewardExpirationDate.setUTCDate(Math.min(rewardDayOfMonth, rewardTargetMonthDays));
    const rewardExpiration = admin.firestore.Timestamp.fromDate(rewardExpirationDate);

    transaction.set(
      referrerRef,
      { uid: referrerUid, credits: newReferrerCredits, updatedAt: now },
      { merge: true }
    );

    transaction.set(rewardEntitlementRef, {
      userId: referrerUid,
      plan: "referral_reward",
      creditsGranted: rewardCredits,
      creditsUsed: 0,
      creditsRemaining: rewardCredits,
      createdAt: now,
      expiresAt: rewardExpiration,
      status: "active",
      paymentReference: paymentId,
      competitionId,
      source: "referral_reward",
      rewardDurationMonths,
      requiredReferrals,
      referralCount,
      updatedAt: now
    });

    transaction.set(rewardPoolTransactionRef, {
      type: "REFERRAL_REWARD",
      userId: referrerUid,
      referredUserId: referredUserId,
      paymentId,
      competitionId,
      credits: rewardCredits,
      source: "credit_pool",
      destination: "user_credit_entitlement",
      reason: "referral_competition_reward",
      entitlementId: rewardEntitlementRef.id,
      createdAt: now,
      approvedBy
    });

    transaction.set(
      competitionRef,
      {
        winnerUid: referrerUid,
        winnerPaymentId: paymentId,
        winnerReferralCount: referralCount,
        winnerQualifiedAt: now,
        rewardAwarded: true,
        rewardEntitlementId: rewardEntitlementRef.id,
        updatedAt: now
      },
      { merge: true }
    );

    qualificationData.rewarded = true;
    qualificationData.winner = true;
    qualificationData.rewardCredits = rewardCredits;
    qualificationData.rewardDurationMonths = rewardDurationMonths;
    qualificationData.rewardEntitlementId = rewardEntitlementRef.id;

    rewardEntitlementId = rewardEntitlementRef.id;
    rewardPoolTransactionId = rewardPoolTransactionRef.id;
    winner = true;
    rewarded = true;
  }

  transaction.set(qualificationRef, qualificationData);

  return {
    qualified: true,
    rewarded,
    winner,
    qualificationId: qualificationRef.id,
    competitionId,
    referralCount,
    rewardCredits: rewarded ? rewardCredits : 0,
    rewardEntitlementId,
    rewardPoolTransactionId
  };
}

async function ensurePermanentReferralCode(userId) {
  if (!userId) throw new Error("USER_NOT_FOUND");
  const userRef = db.collection("users").doc(userId);

  for (let attempt = 0; attempt < 10; attempt++) {
    const snapshot = await userRef.get();
    if (!snapshot.exists) throw new Error("USER_NOT_FOUND");
    const existingCode = normalizeReferralCode(snapshot.data()?.referralCode);
    if (existingCode) return existingCode;

    const candidate = generateReferralCode();
    const codeRef = db.collection("referralCodes").doc(candidate);

    try {
      await db.runTransaction(async (transaction) => {
        const userSnapshot = await transaction.get(userRef);
        const codeSnapshot = await transaction.get(codeRef);
        if (!userSnapshot.exists) throw new Error("USER_NOT_FOUND");
        const currentCode = normalizeReferralCode(userSnapshot.data()?.referralCode);
        if (currentCode) return;
        if (codeSnapshot.exists) throw new Error("REFERRAL_CODE_COLLISION");

        const now = admin.firestore.Timestamp.now();
        transaction.set(codeRef, { referralCode: candidate, userId, createdAt: now });
        transaction.set(userRef, { referralCode: candidate, updatedAt: now }, { merge: true });
      });

      const refreshed = await userRef.get();
      const finalCode = normalizeReferralCode(refreshed.data()?.referralCode);
      if (finalCode) return finalCode;
    } catch (error) {
      if (String(error?.message || "") === "REFERRAL_CODE_COLLISION") continue;
      throw error;
    }
  }
  throw new Error("REFERRAL_CODE_GENERATION_FAILED");
}

async function initializeUserReferral(userId, incomingReferralCode = "") {
  const userRef = db.collection("users").doc(userId);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) throw new Error("USER_NOT_FOUND");
  const userData = userSnapshot.data() || {};
  const permanentReferralCode = await ensurePermanentReferralCode(userId);

  const existingReferrerUid = String(userData.referrerUid || "").trim();
  if (existingReferrerUid) {
    return { referralCode: permanentReferralCode, referrerUid: existingReferrerUid, referralApplied: false };
  }

  const normalizedIncomingCode = normalizeReferralCode(incomingReferralCode);
  if (!normalizedIncomingCode) {
    return { referralCode: permanentReferralCode, referrerUid: null, referralApplied: false };
  }

  const codeRef = db.collection("referralCodes").doc(normalizedIncomingCode);
  const codeSnapshot = await codeRef.get();
  if (!codeSnapshot.exists) {
    return { referralCode: permanentReferralCode, referrerUid: null, referralApplied: false };
  }

  const referrerUid = String(codeSnapshot.data()?.userId || "").trim();
  if (!referrerUid || referrerUid === userId) {
    return { referralCode: permanentReferralCode, referrerUid: null, referralApplied: false };
  }

  const now = admin.firestore.Timestamp.now();
  await db.runTransaction(async (transaction) => {
    const currentUserSnapshot = await transaction.get(userRef);
    if (!currentUserSnapshot.exists) throw new Error("USER_NOT_FOUND");
    const currentData = currentUserSnapshot.data() || {};
    if (currentData.referrerUid) return;

    transaction.set(
      userRef,
      {
        referrerUid,
        referralCodeUsed: normalizedIncomingCode,
        referralLinkedAt: now,
        updatedAt: now
      },
      { merge: true }
    );
  });

  return { referralCode: permanentReferralCode, referrerUid, referralApplied: true };
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
SITE ANNOUNCEMENT
========================================================= */
app.get("/api/site-announcement", async (req, res) => {
  try {
    const snapshot = await db.collection("siteConfig").doc("announcement").get();
    if (!snapshot.exists) {
      return res.json({
        success: true,
        announcement: { enabled: false, type: "info", title: "", message: "", service: "" }
      });
    }
    const data = snapshot.data() || {};
    res.json({
      success: true,
      announcement: {
        enabled: data.enabled === true,
        type: String(data.type || "info").trim(),
        title: String(data.title || "").trim(),
        message: String(data.message || "").trim(),
        service: String(data.service || "").trim()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load site announcement." });
  }
});

app.put("/api/admin/site-announcement", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    const allowedTypes = ["info", "warning", "maintenance", "success"];
    const typeInput = String(req.body?.type || "info").trim().toLowerCase();
    const type = allowedTypes.includes(typeInput) ? typeInput : "info";
    const title = String(req.body?.title || "").trim();
    const message = String(req.body?.message || "").trim();
    const service = String(req.body?.service || "").trim();
    if (enabled && (!title || !message)) {
      return res.status(400).json({ success: false, error: "Title and message are required when enabled." });
    }
    const now = admin.firestore.Timestamp.now();
    await db.collection("siteConfig").doc("announcement").set(
      { enabled, type, title, message, service, updatedAt: now, updatedBy: req.userUid },
      { merge: true }
    );
    res.json({
      success: true,
      announcement: { enabled, type, title, message, service, updatedAt: now.toDate().toISOString() }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to update site announcement." });
  }
});

/* =========================================================
ACCOUNT BOOTSTRAP
========================================================= */
app.post("/api/account/bootstrap", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const requestedName = String(req.body?.fullName || "").trim();
    const requestedEmail = String(req.body?.email || req.userToken?.email || "").trim();
    const requestedRole = String(req.body?.role || "worker").trim().toLowerCase();
    const safeRole = requestedRole === "recruiter" ? "recruiter" : "worker";
    if (!requestedName || !requestedEmail) {
      return res.status(400).json({ success: false, error: "Name and email are required." });
    }
    const userRef = db.collection("users").doc(userId);
    const existingSnapshot = await userRef.get();
    const now = admin.firestore.Timestamp.now();
    const existingData = existingSnapshot.exists ? existingSnapshot.data() || {} : {};
    const bootstrapData = {
      uid: userId,
      fullName: requestedName,
      email: requestedEmail,
      role: safeRole,
      profileCreated: existingSnapshot.exists ? Boolean(existingData.profileCreated) : false,
      skills: existingSnapshot.exists && Array.isArray(existingData.skills) ? existingData.skills : [],
      certificates: existingSnapshot.exists && Array.isArray(existingData.certificates) ? existingData.certificates : [],
      online: true,
      updatedAt: now
    };
    if (!existingSnapshot.exists) {
      bootstrapData.createdAt = now;
      bootstrapData.credits = 0;
      bootstrapData.plan = null;
      bootstrapData.subscriptionPlan = null;
      bootstrapData.subscriptionExpiresAt = null;
      bootstrapData.freeVideoUsed = false;
      bootstrapData.freeVideoRemaining = FREE_VIDEO_COUNT;
      bootstrapData.freeVideoAvailable = true;
    }
    await userRef.set(bootstrapData, { merge: true });
    const incomingReferralCode = String(req.body?.referralCode || "").trim();
    const referral = await initializeUserReferral(userId, incomingReferralCode);
    const finalSnapshot = await userRef.get();
    const finalData = finalSnapshot.exists ? finalSnapshot.data() || {} : {};
    return res.json({ success: true, user: { ...finalData, uid: userId }, referral });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Unable to create your account profile." });
  }
});

/* =========================================================
ACCOUNT
=========================================================
Returns everything CareerHub, the Homepage and the Account
page actually read: full entitlement history, achievements,
creditLimit, subscription status and ISO date aliases.
========================================================= */
app.get("/api/account", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    await processExpiredEntitlements(userId);
    const userData = await getUserDocument(userId);
    if (!userData) {
      return res.json({
        success: true,
        user: {
          uid: userId,
          credits: 0,
          creditLimit: 0,
          plan: null,
          subscriptionPlan: null,
          subscriptionStatus: "inactive",
          subscriptionStartedAt: null,
          subscriptionStartedAtISO: null,
          subscriptionExpiresAt: null,
          subscriptionExpiresAtISO: null,
          achievements: [],
          activeCreditEntitlements: [],
          creditEntitlementHistory: [],
          isAdmin: isAdmin(userId),
          ...normalizeFreeVideoState({})
        }
      });
    }
    const freeState = normalizeFreeVideoState(userData);
    const activePlan = getUserPlan(userData);
    const creditEntitlementHistory = await getAllCreditEntitlements(userId);
    const activeCreditEntitlements = creditEntitlementHistory.filter(
      (item) => item.status === "active" && item.creditsRemaining > 0
    );
    const planCreditLimit = activeCreditEntitlements
      .filter((item) =>
        ["pro", "premium", "admin"].includes(String(item.plan || "").toLowerCase()) ||
        /credit_pool_sale|admin_activation|subscription|purchase|plan/.test(String(item.source || "").toLowerCase())
      )
      .reduce((total, item) => total + item.creditsGranted, 0);
    const subscriptionExpiresAt = timestampToISO(userData.subscriptionExpiresAt);
    const subscriptionStartedAt = timestampToISO(userData.subscriptionStartedAt || userData.lastPaymentDate);

    res.json({
      success: true,
      user: {
        ...userData,
        uid: userId,
        emailVerified: userData.emailVerified === true || req.userToken?.email_verified === true,
        credits: Math.max(0, safeNumber(userData.credits, 0)),
        creditLimit: planCreditLimit,
        plan: activePlan,
        subscriptionPlan: activePlan,
        subscriptionStatus: activePlan
          ? "active"
          : (timestampToMillis(userData.subscriptionExpiresAt) > 0 ? "expired" : "inactive"),
        subscriptionStartedAt,
        subscriptionStartedAtISO: subscriptionStartedAt,
        subscriptionExpiresAt,
        subscriptionExpiresAtISO: subscriptionExpiresAt,
        adminTrackedCreditBaseline: Math.max(0, safeNumber(userData.adminTrackedCreditBaseline, 0)),
        achievements: Array.isArray(userData.achievements) ? userData.achievements : [],
        activeCreditEntitlements,
        creditEntitlementHistory,
        freeVideoUsed: freeState.freeVideoUsed,
        freeVideoRemaining: freeState.freeVideoRemaining,
        freeVideoAvailable: freeState.freeVideoAvailable,
        isAdmin: isAdmin(userId)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load account." });
  }
});

app.get("/api/imagekit-auth", requireAuthenticatedUser, (req, res) => {
  try {
    if (!process.env.IMAGEKIT_PRIVATE_KEY) {
      return res.status(500).json({ success: false, error: "ImageKit is not configured." });
    }
    const authenticationParameters = imagekit.getAuthenticationParameters();
    res.json({ success: true, ...authenticationParameters });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to create ImageKit authentication parameters." });
  }
});

/* =========================================================
CHAT  (GLOBAL MEMORY + VISION)
=========================================================
imageUrl is forwarded as options.attachment so the vision
model actually receives it. projectId connects the chat to
project memory + character bible. Memory is loaded BEFORE
the answer and saved AFTER it by groqService.
========================================================= */
app.post("/chat", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const message = String(req.body?.message || req.body?.prompt || "").trim();
    const imageUrl = String(req.body?.imageUrl || req.body?.attachmentUrl || "").trim() || null;
    if (!message && !imageUrl) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }
    const conversation = Array.isArray(req.body?.conversation) ? req.body.conversation : [];
    const projectId = String(req.body?.projectId || "").trim();
    const aiResult = await generateAIResponse(message, {
      userId,
      imageUrl,
      attachment: imageUrl ? { url: imageUrl, type: "image" } : null,
      conversation,
      projectId,
      projectTitle: String(req.body?.projectTitle || "").trim(),
      language: req.body?.language || null,
      knowledge: req.body?.knowledge || null
    });
    const reply = typeof aiResult === "string"
      ? aiResult
      : aiResult?.reply || aiResult?.response || aiResult?.content || aiResult?.message || "";
    if (!reply) throw new Error("AI did not generate a response.");
    res.json({
      success: true,
      reply,
      response: reply,
      message: reply,
      replyComplete: typeof aiResult === "object" ? aiResult.replyComplete !== false : true,
      webSearchUsed: typeof aiResult === "object" ? aiResult.webSearchUsed === true : false,
      currentSearchAttempted: typeof aiResult === "object" ? aiResult.currentSearchAttempted === true : false,
      sources: typeof aiResult === "object" ? aiResult.sources || {} : {},
      memoryUsed: typeof aiResult === "object" ? aiResult.memoryUsed === true : false,
      historyRestored: typeof aiResult === "object" ? aiResult.historyRestored === true : false,
      projectId: projectId || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "GaveAI could not generate a response. Please try again." });
  }
});

/* =========================================================
GAVEAI MEDIA HELPERS
=========================================================
REQUIRED by processVideoJob (Moso 3) and
processStoryboardJob (Moso 4).
========================================================= */
async function uploadVideoFileToImageKit(filePath, userId, label = "video") {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("VIDEO_FILE_MISSING");
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length) throw new Error("VIDEO_FILE_EMPTY");
  const result = await imagekit.upload({
    file: buffer,
    fileName: `gaveai-${label}-${userId}-${Date.now()}.mp4`,
    folder: "gavemoneytips/generated-videos",
    useUniqueFileName: true,
    tags: ["gaveai", "generated-video", String(userId)]
  });
  return { url: result.url, fileId: result.fileId || null, name: result.name || null };
}

async function extractLastFrameImage(videoFile, userId, sceneNumber) {
  if (!videoFile || !fs.existsSync(videoFile) || !ffmpegPath) return null;
  const directory = ensureDirectory(path.join(process.cwd(), "tmp", "gaveai-frames"));
  const outputPath = path.join(directory, `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpegPath,
        ["-y", "-sseof", "-0.2", "-i", videoFile, "-vframes", "1", "-q:v", "2", outputPath],
        { windowsHide: true }
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`FFmpeg frame extraction failed: ${stderr.slice(-500)}`)));
    });
    if (!fs.existsSync(outputPath)) return null;
    const uploaded = await uploadBufferToImageKit(
      fs.readFileSync(outputPath),
      `scene-${sceneNumber}-last-frame.jpg`,
      "gavemoneytips/storyboard-frames"
    );
    return uploaded.url;
  } catch (error) {
    console.error("GAVEAI CONTINUITY FRAME ERROR:", error.message);
    return null;
  } finally {
    removeFile(outputPath);
  }
}

async function concatSceneVideos(files, withAudio) {
  if (!Array.isArray(files) || !files.length) throw new Error("STORYBOARD_SCENES_MISSING");
  if (!ffmpegPath) throw new Error("FFmpeg is not configured.");
  const directory = ensureDirectory(path.join(process.cwd(), "tmp", "gaveai-videos"));
  const outputFile = path.join(
    directory,
    `gaveai-final-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
  );
  const runFFmpeg = (args) => new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`FFmpeg concat failed: ${stderr.slice(-800)}`)));
  });

  if (files.length === 1) {
    await runFFmpeg([
      "-y", "-i", files[0],
      "-c:v", "copy",
      ...(withAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags", "+faststart",
      outputFile
    ]);
    return outputFile;
  }

  const listFile = path.join(directory, `concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const listContent = files
    .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
    .join(NL);
  await fs.promises.writeFile(listFile, listContent, "utf8");
  try {
    await runFFmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      ...(withAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags", "+faststart",
      outputFile
    ]);
  } finally {
    removeFile(listFile);
  }
  if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size <= 0) {
    throw new Error("FINAL_VIDEO_EMPTY");
  }
  return outputFile;
}

async function loadGaveAIMediaContext(userId, source = {}, queryText = "") {
  const projectId = String(source.projectId || "").trim();
  let bible = mergeCharacterBible({}, source.characterBible || {});
  let project = null;
  if (projectId) {
    const stored = await getStoredCharacterBible(userId, projectId).catch(() => null);
    bible = mergeCharacterBible(stored || {}, bible);
    project = await getProjectMemory(userId, projectId).catch(() => null);
  }
  const memory = await getMemory(
    userId,
    queryText || String(source.storyOverview || source.prompt || "")
  ).catch(() => ({ relevant: [], recent: [], summaries: [] }));

  const memorySummary = [
    project?.summary ? "PROJECT MEMORY: " + project.summary : "",
    ...(memory.summaries || []),
    ...(memory.relevant || []).slice(0, 3).map((item) => `${item.role}: ${item.content}`)
  ].filter(Boolean).join(NL).slice(0, 2500);

  return { projectId, bible, project, memory, memorySummary };
}

function buildStoryboardScenePrompt(production, scenes, index, previousScene, memorySummary) {
  const scene = scenes[index];
  const blocks = [];
  if (production.storyOverview) blocks.push("STORY OVERVIEW:" + NL + production.storyOverview);
  if (memorySummary) blocks.push("LONG TERM MEMORY:" + NL + memorySummary);
  const previousScenes = scenes
    .slice(0, index)
    .map((item, position) => `Scene ${position + 1}: ${item.prompt}`)
    .filter(Boolean);
  if (previousScenes.length) {
    blocks.push("SCENES ALREADY FILMED (keep exact continuity):" + NL + previousScenes.join(NL));
  }
  if (previousScene?.continuityDescription) {
    blocks.push("PREVIOUS SCENE END STATE:" + NL + previousScene.continuityDescription);
  }
  blocks.push(`CURRENT SCENE ${index + 1} OF ${scenes.length}:` + NL + scene.prompt);
  blocks.push(GAVEAI_VIDEO_CONSISTENCY_RULES);
  return wrapStrictPrompt(blocks.join(NL + NL));
}

/* =========================================================
IMAGE GENERATION / EDITING
========================================================= */
async function prepareFluxReferenceImage(imageUrl) {
  const source = String(imageUrl || "").trim();
  if (!source) return null;
  try {
    let inputBuffer;
    if (source.startsWith("data:image/")) {
      const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      if (!match) throw new Error("IMAGE_REFERENCE_INVALID");
      inputBuffer = Buffer.from(match[2], "base64");
    } else if (source.startsWith("http://") || source.startsWith("https://")) {
      const response = await axios.get(source, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxContentLength: 25 * 1024 * 1024,
        maxBodyLength: 25 * 1024 * 1024,
        validateStatus: () => true
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error("IMAGE_REFERENCE_DOWNLOAD_FAILED");
      }
      inputBuffer = Buffer.from(response.data);
    } else {
      throw new Error("IMAGE_REFERENCE_INVALID");
    }
    if (!inputBuffer || !inputBuffer.length) throw new Error("IMAGE_REFERENCE_EMPTY");
    const resizedBuffer = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 511, height: 511, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    const metadata = await sharp(resizedBuffer).metadata();
    if (!metadata.width || !metadata.height || metadata.width >= 512 || metadata.height >= 512) {
      throw new Error("IMAGE_REFERENCE_SIZE_INVALID");
    }
    return { buffer: resizedBuffer, mimeType: "image/jpeg", fileName: "reference-image.jpg" };
  } catch (error) {
    if (String(error?.message || "").startsWith("IMAGE_REFERENCE_")) throw error;
    throw new Error("IMAGE_REFERENCE_PROCESSING_FAILED");
  }
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
    form.append("input_image_0", new Blob([reference.buffer], { type: reference.mimeType }), reference.fileName);
  }
  form.append("prompt", cleanPrompt);
  form.append("width", String(Math.round(numericWidth)));
  form.append("height", String(Math.round(numericHeight)));
  if (Number.isFinite(numericSeed) && numericSeed >= 0) {
    form.append("seed", String(Math.round(numericSeed)));
  }
  const response = await axios.post(endpoint, form, {
    headers: { Authorization: `Bearer ${apiToken}` },
    responseType: "arraybuffer",
    timeout: 180000,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    validateStatus: () => true
  });
  const contentType = String(response.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  const rawBuffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || "");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`IMAGE_PROVIDER_FAILED_${response.status}`);
  }
  if (contentType.startsWith("image/")) {
    if (!rawBuffer.length) throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
    return { buffer: rawBuffer, mimeType: contentType };
  }
  let data;
  try {
    data = JSON.parse(rawBuffer.toString("utf8"));
  } catch (parseError) {
    throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
  }
  let base64Image = data?.result?.image || data?.result?.image_base64 ||
    data?.result?.base64 || data?.image || data?.image_base64 || null;
  if (typeof base64Image !== "string" || !base64Image.trim()) {
    throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
  }
  base64Image = base64Image.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, "");
  const imageBuffer = Buffer.from(base64Image, "base64");
  if (!imageBuffer.length) throw new Error("IMAGE_PROVIDER_EMPTY_RESULT");
  return { buffer: imageBuffer, mimeType: "image/jpeg" };
}

async function uploadGeneratedImageToImageKit(buffer, userId, mimeType = "image/jpeg") {
  if (!buffer || !buffer.length) throw new Error("IMAGE_GENERATION_FAILED");
  const extension = String(mimeType).toLowerCase().includes("png")
    ? "png"
    : String(mimeType).toLowerCase().includes("webp") ? "webp" : "jpg";
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
    success: true,
    provider: "GaveAI",
    configured,
    model: GAVEAI_IMAGE_MODEL,
    imageKitConfigured: !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT)
  });
});

/* =========================================================
GENERATE / EDIT IMAGE
=========================================================
Identity persistence: the project's stored reference image
is reused so the same person keeps the same face, clothing,
age and style across every generation.
========================================================= */
app.post("/generate-image", requireAuthenticatedUser, async (req, res) => {
  try {
    const rawPrompt = String(req.body?.prompt || req.body?.description || req.body?.message || req.body?.text || "").trim();
    if (!rawPrompt) {
      return res.status(400).json({ success: false, provider: "GaveAI", error: "Image prompt is required." });
    }
    const userId = req.userUid;
    const imageUrl = String(req.body?.imageUrl || req.body?.referenceImageUrl || req.body?.inputImage || "").trim() || null;
    const width = Math.min(1920, Math.max(256, Number(req.body?.width) || 1024));
    const height = Math.min(1920, Math.max(256, Number(req.body?.height) || 1024));
    const seed = Number.isFinite(Number(req.body?.seed)) ? Number(req.body.seed) : -1;
    const isEdit = !!imageUrl;

    const context = await loadGaveAIMediaContext(
      userId,
      { projectId: req.body?.projectId, characterBible: req.body?.characterBible || {} },
      rawPrompt
    );

    let referenceUrl = imageUrl;
    if (!isEdit && context.bible.referenceImageUrl) referenceUrl = context.bible.referenceImageUrl;

    const identityText = buildCharacterBible(context.bible);
    const contextBlocks = [
      identityText ? "PERSISTENT CHARACTER IDENTITY (must stay identical):" + NL + identityText : "",
      context.memorySummary ? "LONG TERM MEMORY:" + NL + context.memorySummary : ""
    ].filter(Boolean).join(NL + NL);

    const strictPrompt = [
      wrapStrictPrompt(rawPrompt, isEdit),
      isEdit ? "" : GAVEAI_IMAGE_CONSISTENCY_RULES,
      contextBlocks
    ].filter(Boolean).join(NL + NL);

    let generated = await generateGaveAIImage({ prompt: strictPrompt, imageUrl: referenceUrl, width, height, seed });
    if (isEdit) generated = { ...generated, edited: true };
    const uploaded = await uploadGeneratedImageToImageKit(generated.buffer, userId, generated.mimeType);

    if (context.projectId) {
      try {
        await saveCharacterBible({
          userId,
          projectId: context.projectId,
          ...context.bible,
          referenceImageUrl: (isEdit || !context.bible.referenceImageUrl)
            ? uploaded.url
            : context.bible.referenceImageUrl,
          lastImageUrl: uploaded.url
        });
        await saveProjectMemory(userId, context.projectId, {
          title: String(req.body?.projectTitle || "GaveAI media project"),
          context: ["IMAGE " + (isEdit ? "EDIT" : "GENERATION") + ": " + rawPrompt, "RESULT: " + uploaded.url].join(NL)
        });
      } catch (memoryError) {
        console.error("GAVEAI IMAGE MEMORY SAVE FAILED:", memoryError.message);
      }
    }

    res.json({
      success: true,
      provider: "GaveAI",
      type: "image",
      message: isEdit ? "Image edited successfully!" : "Image generated successfully!",
      imageUrl: uploaded.url,
      url: uploaded.url,
      fileId: uploaded.fileId,
      fileName: uploaded.name,
      generatedMedia: { type: "image", url: uploaded.url, provider: "GaveAI" },
      prompt: rawPrompt,
      model: GAVEAI_IMAGE_MODEL,
      edited: isEdit,
      width,
      height,
      seed,
      projectId: context.projectId || null,
      identityPreserved: !!referenceUrl
    });
  } catch (error) {
    let status = 500;
    let friendlyError = "GaveAI image generation failed. Please try again.";
    const message = String(error?.message || "");
    if (message === "IMAGE_PROVIDER_NOT_CONFIGURED") {
      friendlyError = "GaveAI image generation is not configured.";
    } else if (message === "IMAGE_PROMPT_REQUIRED") {
      status = 400;
      friendlyError = "Image prompt is required.";
    }
    return res.status(status).json({ success: false, provider: "GaveAI", error: friendlyError });
  }
});

/* =========================================================
UPLOADS
========================================================= */
app.post("/upload-profile-photo", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Profile photo is required." });
    const result = await uploadBufferToImageKit(
      req.file.buffer,
      req.file.originalname || "profile-photo",
      "gavemoneytips/profile-photos"
    );
    await db.collection("users").doc(req.userUid).set({
      profilePhotoUrl: result.url,
      profilePhoto: result.url,
      profilePhotoFileId: result.fileId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true, url: result.url, photoUrl: result.url, fileId: result.fileId, fileName: result.name });
  } catch (error) {
    res.status(500).json({ success: false, error: "Profile photo upload failed." });
  }
});

app.post("/upload-certificate", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Certificate file is required." });
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "certificate", "certificates");
    res.json({ success: true, url: result.url, fileId: result.fileId, fileName: result.name });
  } catch (error) {
    res.status(500).json({ success: false, error: "Certificate upload failed." });
  }
});

app.post("/upload-media", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "File is required." });
    const requestedFolder = String(req.body?.folder || "").trim();
    const folder = requestedFolder || "gavemoneytips/chat-media";
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "media", folder);
    res.json({
      success: true,
      url: result.url,
      photoUrl: result.url,
      fileUrl: result.url,
      fileId: result.fileId,
      fileName: result.name,
      folder
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Media upload failed." });
  }
});

app.post("/upload-resume", requireAuthenticatedUser, upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Resume file is required." });
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "resume", "resumes");
    await db.collection("users").doc(req.userUid).set({
      resumeUrl: result.url,
      resumeURL: result.url,
      resumeFileId: result.fileId,
      resumeFileName: result.name,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({
      success: true,
      url: result.url,
      resumeUrl: result.url,
      resumeURL: result.url,
      fileId: result.fileId,
      fileName: result.name
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Resume upload failed." });
  }
});

app.post("/upload-cover-letter", requireAuthenticatedUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Cover letter file is required." });
    const result = await uploadBufferToImageKit(req.file.buffer, req.file.originalname || "cover-letter", "cover-letters");
    await db.collection("users").doc(req.userUid).set({
      coverLetterUrl: result.url,
      coverLetterURL: result.url,
      cover_letter_url: result.url,
      coverLetterFileId: result.fileId,
      coverLetterFileName: result.name,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({
      success: true,
      url: result.url,
      coverLetterUrl: result.url,
      coverLetterURL: result.url,
      fileId: result.fileId,
      fileName: result.name
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Cover letter upload failed." });
  }
});

app.post("/delete-resume", requireAuthenticatedUser, async (req, res) => {
  try {
    const userRef = db.collection("users").doc(req.userUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User profile not found." });
    const userData = snapshot.data() || {};
    const storedFileId = String(userData.resumeFileId || "").trim();
    if (storedFileId) {
      try { await imagekit.deleteFile(storedFileId); }
      catch (deleteError) { console.warn("Resume ImageKit delete warning:", deleteError.message); }
    }
    await userRef.set({
      resumeURL: admin.firestore.FieldValue.delete(),
      resumeUrl: admin.firestore.FieldValue.delete(),
      resumeFileId: admin.firestore.FieldValue.delete(),
      resumeFileName: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true, message: "Resume deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Resume deletion failed." });
  }
});

app.post("/delete-cover-letter", requireAuthenticatedUser, async (req, res) => {
  try {
    const userRef = db.collection("users").doc(req.userUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User profile not found." });
    const userData = snapshot.data() || {};
    const storedFileId = String(userData.coverLetterFileId || "").trim();
    if (storedFileId) {
      try { await imagekit.deleteFile(storedFileId); }
      catch (deleteError) { console.warn("Cover letter ImageKit delete warning:", deleteError.message); }
    }
    await userRef.set({
      coverLetterURL: admin.firestore.FieldValue.delete(),
      coverLetterUrl: admin.firestore.FieldValue.delete(),
      cover_letter_url: admin.firestore.FieldValue.delete(),
      coverLetterFileId: admin.firestore.FieldValue.delete(),
      coverLetterFileName: admin.firestore.FieldValue.delete(),
      coverLetter: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true, message: "Cover letter deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Cover letter deletion failed." });
  }
});

app.post("/delete-certificate", requireAuthenticatedUser, async (req, res) => {
  try {
    const userRef = db.collection("users").doc(req.userUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User profile not found." });
    const userData = snapshot.data() || {};
    const certificates = Array.isArray(userData.certificates) ? [...userData.certificates] : [];
    const requestedFileId = String(req.body?.fileId || "").trim();
    const requestedIndex = Number(req.body?.index);
    let targetIndex = -1;
    if (requestedFileId) {
      targetIndex = certificates.findIndex((c) => String(c?.fileId || "").trim() === requestedFileId);
    }
    if (targetIndex < 0 && Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < certificates.length) {
      targetIndex = requestedIndex;
    }
    if (targetIndex < 0) return res.status(404).json({ success: false, error: "Certificate not found." });
    const certificate = certificates[targetIndex] || {};
    const storedFileId = String(certificate.fileId || "").trim();
    if (storedFileId) {
      try { await imagekit.deleteFile(storedFileId); }
      catch (deleteError) { console.warn("Certificate ImageKit delete warning:", deleteError.message); }
    }
    certificates.splice(targetIndex, 1);
    await userRef.set({ certificates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true, message: "Certificate deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Certificate deletion failed." });
  }
});

/* =========================================================
REFERRAL ROUTES
========================================================= */
app.post("/api/referral/initialize", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const incomingReferralCode = String(req.body?.referralCode || req.body?.ref || "").trim();
    const result = await initializeUserReferral(userId, incomingReferralCode);
    res.json({
      success: true,
      referralCode: result.referralCode,
      referrerUid: result.referrerUid,
      referralApplied: result.referralApplied
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to initialize referral information." });
  }
});

async function getReferralCompetitionLeaderboard(competitionId) {
  const id = String(competitionId || "").trim();
  if (!id) return [];
  const snapshot = await db.collection("referralQualifications").where("competitionId", "==", id).get();
  const counts = new Map();
  snapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    const referrerUid = String(data.referrerUid || "").trim();
    if (!referrerUid) return;
    counts.set(referrerUid, (counts.get(referrerUid) || 0) + 1);
  });
  const rows = Array.from(counts.entries())
    .map(([referrerUid, referralCount]) => ({ referrerUid, referralCount }))
    .sort((a, b) => {
      if (b.referralCount !== a.referralCount) return b.referralCount - a.referralCount;
      return a.referrerUid.localeCompare(b.referrerUid);
    });
  const leaderboard = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let displayName = "";
    try {
      const userSnapshot = await db.collection("users").doc(row.referrerUid).get();
      if (userSnapshot.exists) {
        const userData = userSnapshot.data() || {};
        displayName = String(userData.fullName || userData.displayName || userData.name || "").trim();
      }
    } catch (userError) {}
    leaderboard.push({
      placement: index + 1,
      referralCount: row.referralCount,
      displayName: displayName || `Participant ${index + 1}`
    });
  }
  return leaderboard;
}

async function getReferralCompetitionWinnerDisplayName(winnerUid) {
  const uid = String(winnerUid || "").trim();
  if (!uid) return "";
  try {
    const userSnapshot = await db.collection("users").doc(uid).get();
    if (!userSnapshot.exists) return "";
    const userData = userSnapshot.data() || {};
    return String(userData.fullName || userData.displayName || userData.name || "").trim();
  } catch (error) {
    return "";
  }
}

async function buildReferralCompetitionPublicData(competition) {
  if (!competition) return null;
  const result = { ...competition, leaderboard: [], winner: null, resultVisible: false };
  const competitionId = String(competition.competitionId || "").trim();
  if (!competitionId) return result;
  result.leaderboard = await getReferralCompetitionLeaderboard(competitionId);
  const winnerUid = String(competition.winnerUid || "").trim();
  if (winnerUid) {
    const winnerName = await getReferralCompetitionWinnerDisplayName(winnerUid);
    result.winner = {
      displayName: winnerName || "Contest Winner",
      referralCount: Math.max(0, Math.floor(Number(competition.winnerReferralCount) || 0))
    };
    result.resultVisible = true;
  }
  return result;
}

app.get("/api/referral/active", async (req, res) => {
  try {
    const competition = await getActiveReferralCompetition();
    if (!competition) return res.json({ success: true, competition: null });
    const publicCompetition = await buildReferralCompetitionPublicData(competition);
    res.json({ success: true, competition: publicCompetition });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load active referral competition." });
  }
});

/* =========================================================
REFERRAL LATEST
=========================================================
Now returns archivedCompetitions / activeCompetition /
upcomingCompetition, which the Homepage actually reads.
========================================================= */
app.get("/api/referral/latest", async (req, res) => {
  try {
    const nowMillis = Date.now();
    const twoDaysMillis = 2 * 24 * 60 * 60 * 1000;
    const snapshot = await db.collection("referralCompetitions").limit(200).get();
    const rows = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));

    const closedRows = rows
      .filter((item) => normalizeCompetitionStatus(item.data.status) === "CLOSED")
      .filter((item) => {
        const closedAt = timestampToMillis(
          item.data.winnerQualifiedAt || item.data.closedAt || item.data.updatedAt || item.data.endAt
        );
        return closedAt > 0 && nowMillis >= closedAt && nowMillis - closedAt <= twoDaysMillis;
      })
      .sort((a, b) => timestampToMillis(
        b.data.winnerQualifiedAt || b.data.closedAt || b.data.updatedAt || b.data.endAt
      ) - timestampToMillis(
        a.data.winnerQualifiedAt || a.data.closedAt || a.data.updatedAt || a.data.endAt
      ));

    const competition = closedRows.length
      ? await buildReferralCompetitionPublicData(competitionToClient(closedRows[0].id, closedRows[0].data))
      : null;

    const activeCompetition = await getActiveReferralCompetition();

    const upcomingRow = rows
      .filter((item) => normalizeCompetitionStatus(item.data.status) === "DRAFT")
      .filter((item) => timestampToMillis(item.data.startAt) > nowMillis)
      .sort((a, b) => timestampToMillis(a.data.startAt) - timestampToMillis(b.data.startAt))[0];
    const upcomingCompetition = upcomingRow
      ? await buildReferralCompetitionPublicData(competitionToClient(upcomingRow.id, upcomingRow.data))
      : null;

    const archivedRows = rows
      .filter((item) => normalizeCompetitionStatus(item.data.status) === "ARCHIVED")
      .sort((a, b) => timestampToMillis(b.data.archivedAt || b.data.updatedAt) -
        timestampToMillis(a.data.archivedAt || a.data.updatedAt))
      .slice(0, 50);
    const archivedCompetitions = [];
    for (const row of archivedRows) {
      archivedCompetitions.push(
        await buildReferralCompetitionPublicData(competitionToClient(row.id, row.data))
      );
    }

    res.json({ success: true, competition, activeCompetition, upcomingCompetition, archivedCompetitions });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load latest referral competition." });
  }
});

/* =========================================================
ADMIN - REFERRAL COMPETITIONS
=========================================================
endAt is now OPTIONAL: CareerHub only sends startAt.
========================================================= */
app.post("/api/admin/referral-competitions", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const rewardCredits = Math.floor(safeNumber(req.body?.rewardCredits, 0));
    const legacyDurationMonths = Math.floor(safeNumber(req.body?.rewardDurationMonths, 0));
    const rewardDurationValue = Math.floor(safeNumber(req.body?.rewardDurationValue, legacyDurationMonths));
    const rewardDurationUnit = normalizeDurationUnit(req.body?.rewardDurationUnit) ||
      (legacyDurationMonths > 0 ? "months" : "");
    const rewardDurationDays = resolveDurationDays(rewardDurationValue, rewardDurationUnit);
    const rewardDurationMonths = rewardDurationUnit === "months" ? rewardDurationValue : 0;
    const requiredReferrals = Math.floor(safeNumber(req.body?.requiredReferrals, 0));

    if (!title) return res.status(400).json({ success: false, error: "Competition title is required." });
    if (!Number.isFinite(rewardCredits) || rewardCredits <= 0) {
      return res.status(400).json({ success: false, error: "Reward credits must be greater than zero." });
    }
    if (!Number.isFinite(rewardDurationValue) || rewardDurationValue <= 0 || rewardDurationDays <= 0) {
      return res.status(400).json({ success: false, error: "Reward duration must be greater than zero." });
    }
    if (!Number.isFinite(requiredReferrals) || requiredReferrals <= 0) {
      return res.status(400).json({ success: false, error: "Required referrals must be greater than zero." });
    }

    const startAt = timestampFromInput(req.body?.startAt, "START_AT");
    let endAt;
    if (req.body?.endAt === null || req.body?.endAt === undefined || req.body?.endAt === "") {
      endAt = admin.firestore.Timestamp.fromDate(new Date(startAt.toMillis() + 30 * 24 * 60 * 60 * 1000));
    } else {
      endAt = timestampFromInput(req.body?.endAt, "END_AT");
    }
    if (endAt.toMillis() <= startAt.toMillis()) {
      return res.status(400).json({ success: false, error: "Competition end date must be after the start date." });
    }

    const now = admin.firestore.Timestamp.now();
    const competitionRef = db.collection("referralCompetitions").doc();
    const competitionData = {
      competitionId: competitionRef.id,
      title,
      status: "DRAFT",
      rewardCredits,
      rewardDurationMonths,
      rewardDurationValue,
      rewardDurationUnit,
      rewardDurationDays,
      requiredReferrals,
      startAt,
      endAt,
      createdAt: now,
      updatedAt: now,
      createdBy: req.userUid
    };
    await competitionRef.set(competitionData);
    res.status(201).json({ success: true, competition: competitionToClient(competitionRef.id, competitionData) });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to create referral competition." });
  }
});

app.get("/api/admin/referral-competitions", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("referralCompetitions").orderBy("createdAt", "desc").limit(200).get();
    const competitions = snapshot.docs.map((doc) => competitionToClient(doc.id, doc.data() || {}));
    res.json({ success: true, competitions });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load referral competitions." });
  }
});

app.post("/api/admin/referral-competitions/:competitionId/open", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const competitionId = String(req.params.competitionId || "").trim();
    if (!competitionId) return res.status(400).json({ success: false, error: "Competition ID is required." });
    const competitionRef = getReferralCompetitionRef(competitionId);
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(competitionRef);
      if (!snapshot.exists) throw new Error("COMPETITION_NOT_FOUND");
      const data = snapshot.data() || {};
      const currentStatus = normalizeCompetitionStatus(data.status) || "DRAFT";
      if (currentStatus !== "DRAFT") throw new Error("COMPETITION_CANNOT_OPEN");
      const startAtMillis = timestampToMillis(data.startAt);
      const endAtMillis = timestampToMillis(data.endAt);
      if (!startAtMillis || !endAtMillis || endAtMillis <= startAtMillis) {
        throw new Error("COMPETITION_DATES_INVALID");
      }
      const now = admin.firestore.Timestamp.now();
      transaction.update(competitionRef, {
        status: "OPEN", updatedAt: now, openedAt: now, openedBy: req.userUid
      });
      return {
        competitionId,
        data: { ...data, status: "OPEN", updatedAt: now, openedAt: now, openedBy: req.userUid }
      };
    });
    res.json({ success: true, competition: competitionToClient(result.competitionId, result.data) });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "COMPETITION_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Referral competition was not found." });
    }
    if (message === "COMPETITION_CANNOT_OPEN") {
      return res.status(400).json({ success: false, error: "Only a draft competition can be opened." });
    }
    res.status(500).json({ success: false, error: "Unable to open referral competition." });
  }
});

app.post("/api/admin/referral-competitions/:competitionId/close", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const competitionId = String(req.params.competitionId || "").trim();
    if (!competitionId) return res.status(400).json({ success: false, error: "Competition ID is required." });
    const competitionRef = getReferralCompetitionRef(competitionId);
    const now = admin.firestore.Timestamp.now();
    const snapshot = await competitionRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ success: false, error: "Referral competition was not found." });
    }
    const data = snapshot.data() || {};
    if ((normalizeCompetitionStatus(data.status) || "DRAFT") !== "OPEN") {
      return res.status(400).json({ success: false, error: "Only an open competition can be closed." });
    }
    await competitionRef.update({
      status: "CLOSED", closedAt: now, closedBy: req.userUid, updatedAt: now
    });
    res.json({
      success: true,
      competition: competitionToClient(competitionId, {
        ...data, status: "CLOSED", closedAt: now, closedBy: req.userUid, updatedAt: now
      })
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to close referral competition." });
  }
});

app.post("/api/admin/referral-competitions/:competitionId/archive", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const competitionId = String(req.params.competitionId || "").trim();
    if (!competitionId) return res.status(400).json({ success: false, error: "Competition ID is required." });
    const competitionRef = getReferralCompetitionRef(competitionId);
    const snapshot = await competitionRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ success: false, error: "Referral competition was not found." });
    }
    const data = snapshot.data() || {};
    if ((normalizeCompetitionStatus(data.status) || "DRAFT") !== "CLOSED") {
      return res.status(400).json({ success: false, error: "Only a closed competition can be archived." });
    }
    const now = admin.firestore.Timestamp.now();
    await competitionRef.update({
      status: "ARCHIVED", archivedAt: now, archivedBy: req.userUid, updatedAt: now
    });
    res.json({
      success: true,
      competition: competitionToClient(competitionId, {
        ...data, status: "ARCHIVED", archivedAt: now, archivedBy: req.userUid, updatedAt: now
      })
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to archive referral competition." });
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

function paymentStatusIsActive(status) {
  return status !== "trash";
}

function paymentToClient(id, data = {}) {
  const plan = normalizePlan(data.plan || data.subscriptionPlan);
  const status = normalizePaymentStatus(data.status);
  const reference = data.reference || data.transactionId || data.paymentReference || null;
  const referenceParts = String(reference || "").split("|").map((p) => String(p || "").trim());
  const parsedBankName = referenceParts[0] || null;
  const parsedAccountHolder = referenceParts[1] || null;
  const parsedTransactionDate = referenceParts[2] || null;
  const parsedTransactionTime = referenceParts[3] || null;
  const parsedDescription = referenceParts.length > 4 ? referenceParts.slice(4).join(" | ") : null;
  const receiptUrl = data.receiptUrl || data.proofUrl || data.imageUrl || data.proofImageUrl || null;
  const email = data.email || data.userEmail || null;
  const fullName = data.fullName || data.name || data.displayName || null;
  const accountHolder = data.accountHolder || data.accountHolderFullName ||
    parsedAccountHolder || BANK_INFO.accountHolder;

  return {
    id,
    uid: data.uid || data.userId || null,
    userId: data.userId || data.uid || null,
    email,
    userEmail: email,
    name: fullName,
    fullName,
    plan,
    subscriptionPlan: plan,
    price: safeNumber(data.amount ?? data.price ?? getPlanPrice(plan), 0),
    amount: safeNumber(data.amount ?? data.price ?? getPlanPrice(plan), 0),
    credits: safeNumber(data.credits ?? getPlanCredits(plan), 0),
    durationDays: safeNumber(data.durationDays ?? PLANS[plan]?.durationDays ?? 30, 30),
    status,
    reference,
    bankName: data.bankName || parsedBankName || BANK_INFO.bankName,
    accountHolder,
    accountHolderFullName: data.accountHolderFullName || accountHolder,
    transactionDate: data.transactionDate || parsedTransactionDate || null,
    transactionTime: data.transactionTime || parsedTransactionTime || null,
    description: data.description || parsedDescription || null,
    receiptUrl,
    proofImageUrl: receiptUrl,
    createdAt: timestampToISO(data.createdAt),
    submittedAt: timestampToISO(data.submittedAt),
    reviewedAt: timestampToISO(data.reviewedAt),
    approvedAt: timestampToISO(data.approvedAt),
    rejectedAt: timestampToISO(data.rejectedAt),
    rejectionReason: data.rejectionReason || data.reason || null,
    currency: data.currency || "USD",
    revenueCalendarDeleted: data.revenueCalendarDeleted === true,
    deleted: data.deleted === true
  };
}

/* =========================================================
PAYMENT REQUEST
=========================================================
Accepts accountHolderFullName (Account page) as well as
accountHolder (CareerHub).
========================================================= */
app.post("/api/payment-request", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const requestedPlan = normalizePlan(req.body?.plan);
    if (!requestedPlan) return res.status(400).json({ success: false, error: "A valid plan is required." });
    const planInfo = PLANS[requestedPlan];
    const reference = String(req.body?.reference || req.body?.transactionId || "").trim();
    const receiptUrl = String(req.body?.receiptUrl || req.body?.proofUrl || req.body?.proofImageUrl || "").trim();
    const bankName = String(req.body?.bankName || "").trim();
    const accountHolder = String(req.body?.accountHolder || req.body?.accountHolderFullName || "").trim();
    const transactionDate = String(req.body?.transactionDate || "").trim();
    const transactionTime = String(req.body?.transactionTime || "").trim();
    const description = String(req.body?.description || "").trim();

    const userSnapshot = await db.collection("users").doc(userId).get();
    const userData = userSnapshot.exists ? (userSnapshot.data() || {}) : {};
    const now = admin.firestore.Timestamp.now();
    const paymentData = {
      uid: userId,
      userId: userId,
      email: userData.email || req.userToken?.email || null,
      name: userData.fullName || userData.displayName || userData.name || req.userToken?.name || null,
      plan: requestedPlan,
      subscriptionPlan: requestedPlan,
      amount: planInfo.price,
      price: planInfo.price,
      currency: String(req.body?.currency || "USD").trim().toUpperCase(),
      credits: planInfo.credits,
      durationDays: planInfo.durationDays,
      status: "pending",
      reference: reference || null,
      transactionId: reference || null,
      bankName: bankName || null,
      accountHolder: accountHolder || null,
      accountHolderFullName: accountHolder || null,
      transactionDate: transactionDate || null,
      transactionTime: transactionTime || null,
      description: description || null,
      receiptUrl: receiptUrl || null,
      proofImageUrl: receiptUrl || null,
      deleted: false,
      createdAt: now,
      submittedAt: now,
      updatedAt: now
    };
    const paymentRef = await db.collection("paymentRequests").add(paymentData);
    res.status(201).json({
      success: true,
      message: "Payment request submitted successfully.",
      payment: paymentToClient(paymentRef.id, paymentData)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to submit payment request." });
  }
});

app.get("/api/payment-history", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const snapshot = await db.collection("paymentRequests").where("uid", "==", userId).get();
    const payments = snapshot.docs
      .map((doc) => paymentToClient(doc.id, doc.data()))
      .sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, payments });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load payment history." });
  }
});/* =========================================================
ADMIN ROUTES
========================================================= */
app.get("/api/admin/payment-requests", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const statusFilter = String(req.query?.status || "all").trim().toLowerCase();
    const snapshot = await db.collection("paymentRequests").get();
    let payments = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const payment = paymentToClient(doc.id, doc.data());
        const uid = payment.uid || payment.userId;
        if (!uid) return payment;
        try {
          const authUser = await admin.auth().getUser(uid);
          payment.email = payment.email || authUser.email || null;
          payment.userEmail = payment.userEmail || payment.email || null;
          payment.name = payment.name || authUser.displayName || null;
          payment.fullName = payment.fullName || payment.name || authUser.displayName || null;
        } catch (authError) {}
        return payment;
      })
    );
    if (statusFilter !== "all") {
      payments = payments.filter((payment) => payment.status === statusFilter);
    }
    payments.sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, payments, total: payments.length });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load payment requests." });
  }
});

app.get("/api/admin/payments", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("paymentRequests").get();
    const payments = snapshot.docs
      .map((doc) => paymentToClient(doc.id, doc.data()))
      .sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, payments, total: payments.length });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load payments." });
  }
});

/* =========================================================
APPROVE PAYMENT
=========================================================
Sells credits from the pool, creates a 30-day entitlement,
records the subscription start date, and applies referral
qualification. NO automatic refunds anywhere.
========================================================= */
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
      if (!paymentSnapshot.exists) throw new Error("PAYMENT_NOT_FOUND");
      const payment = paymentSnapshot.data() || {};
      const currentStatus = normalizePaymentStatus(payment.status);
      if (currentStatus === "approved") return { alreadyApproved: true, payment };
      if (currentStatus === "trash") throw new Error("PAYMENT_IN_TRASH");
      if (currentStatus === "rejected") throw new Error("PAYMENT_ALREADY_REJECTED");

      const userId = payment.uid || payment.userId;
      if (!userId) throw new Error("PAYMENT_USER_MISSING");
      const plan = normalizePlan(payment.plan || payment.subscriptionPlan);
      if (!plan) throw new Error("PAYMENT_PLAN_INVALID");
      const planInfo = PLANS[plan];
      if (!planInfo || planInfo.credits <= 0) throw new Error("PAYMENT_PLAN_INVALID");

      const userRef = db.collection("users").doc(userId);
      const [userSnapshot, poolSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(poolRef)
      ]);
      const userData = userSnapshot.exists ? userSnapshot.data() || {} : {};
      const poolData = poolSnapshot.exists ? poolSnapshot.data() || {} : {};
      const existingCredits = Math.max(0, safeNumber(userData.credits, 0));
      const availableCredits = Math.max(0, safeNumber(poolData.availableCredits, 0));
      const totalReturnedCredits = Math.max(0, safeNumber(poolData.totalReturnedCredits, 0));
      const totalResoldCredits = Math.max(0, safeNumber(poolData.totalResoldCredits, 0));
      const creditsToSell = Math.max(0, safeNumber(planInfo.credits, 0));
      if (availableCredits < creditsToSell) throw new Error("INSUFFICIENT_POOL_CREDITS");

      const now = admin.firestore.Timestamp.now();
      const currentExpiry = timestampToMillis(userData.subscriptionExpiresAt);
      const baseDate = currentExpiry > Date.now() ? new Date(currentExpiry) : new Date();
      baseDate.setDate(baseDate.getDate() + planInfo.durationDays);
      const newExpiry = admin.firestore.Timestamp.fromDate(baseDate);
      const creditExpiration = getCreditEntitlementExpiration(now.toDate());
      const newCredits = existingCredits + creditsToSell;
      const newAvailableCredits = availableCredits - creditsToSell;
      const newTotalResoldCredits = totalResoldCredits + creditsToSell;

      const referralResult = await applyReferralQualificationInTransaction(
        transaction,
        paymentId,
        userId,
        userData,
        now,
        req.userUid,
        {
          ...poolData,
          availableCredits: newAvailableCredits,
          totalReturnedCredits,
          totalResoldCredits: newTotalResoldCredits
        }
      );

      transaction.set(userRef, {
        uid: userId,
        credits: newCredits,
        plan,
        subscriptionPlan: plan,
        subscriptionStartedAt: currentExpiry > Date.now() ? (userData.subscriptionStartedAt || now) : now,
        lastPaymentDate: now,
        subscriptionExpiresAt: newExpiry,
        ...(isAdmin(userId)
          ? { adminTrackedCreditBaseline: Math.max(safeNumber(userData.adminTrackedCreditBaseline, 0), newCredits) }
          : {}),
        updatedAt: now
      }, { merge: true });

      transaction.set(entitlementRef, {
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
      });

      const finalAvailableCredits = referralResult.rewarded === true
        ? newAvailableCredits - Math.max(0, safeNumber(referralResult.rewardCredits, 0))
        : newAvailableCredits;

      transaction.set(poolRef, {
        availableCredits: finalAvailableCredits,
        totalReturnedCredits,
        totalResoldCredits: newTotalResoldCredits,
        updatedAt: now
      }, { merge: true });

      transaction.set(grantLedgerRef, {
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
      });

      transaction.set(poolTransactionRef, {
        type: "RESOLD",
        paymentId,
        userId,
        plan,
        credits: creditsToSell,
        reason: "pool_credit_sale",
        createdAt: now,
        approvedBy: req.userUid
      });

      transaction.update(paymentRef, {
        status: "approved",
        approvedAt: now,
        reviewedAt: now,
        reviewedBy: req.userUid,
        updatedAt: now,
        deleted: false
      });

      return {
        alreadyApproved: false,
        payment: { ...payment, status: "approved", creditsAdded: creditsToSell, totalCredits: newCredits, userId, plan },
        newExpiry,
        poolCreditsRemaining: finalAvailableCredits,
        entitlementId: entitlementRef.id,
        referral: referralResult
      };
    });

    res.json({
      success: true,
      message: result.alreadyApproved ? "Payment was already approved." : "Payment approved successfully.",
      payment: paymentToClient(paymentId, result.payment),
      creditPool: result.alreadyApproved
        ? undefined
        : { creditsResold: result.payment.creditsAdded, availableCredits: result.poolCreditsRemaining },
      entitlementId: result.entitlementId || null,
      referral: result.referral || null
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "PAYMENT_NOT_FOUND") return res.status(404).json({ success: false, error: "Payment request not found." });
    if (message === "INSUFFICIENT_POOL_CREDITS") {
      return res.status(409).json({ success: false, error: "The Credit Pool does not have enough credits to approve this purchase." });
    }
    res.status(500).json({ success: false, error: "Unable to approve payment." });
  }
});

app.post("/api/admin/payment-requests/:paymentId/reject", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const reason = String(req.body?.reason || "").trim();
    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const snapshot = await paymentRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Payment request not found." });
    const payment = snapshot.data() || {};
    const status = normalizePaymentStatus(payment.status);
    if (status === "approved") {
      return res.status(400).json({ success: false, error: "An approved payment cannot be rejected." });
    }
    const now = admin.firestore.Timestamp.now();
    await paymentRef.update({
      status: "rejected",
      rejectionReason: reason || null,
      rejectedAt: now,
      reviewedAt: now,
      reviewedBy: req.userUid,
      updatedAt: now
    });
    res.json({ success: true, message: "Payment rejected successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to reject payment." });
  }
});

app.post("/api/admin/payment-requests/:paymentId/trash", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentRef = db.collection("paymentRequests").doc(paymentId);
    const snapshot = await paymentRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Payment request not found." });
    const payment = snapshot.data() || {};
    const currentStatus = normalizePaymentStatus(payment.status);
    const now = admin.firestore.Timestamp.now();
    await paymentRef.update({
      status: "trash",
      previousStatus: currentStatus === "trash" ? (payment.previousStatus || "pending") : currentStatus,
      deleted: true,
      deletedAt: now,
      deletedBy: req.userUid,
      updatedAt: now
    });
    res.json({ success: true, message: "Payment moved to trash successfully." });
  } catch (error) {
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
    const restoredStatus = payment.previousStatus && ["pending", "approved", "rejected"].includes(payment.previousStatus)
      ? payment.previousStatus
      : "pending";
    const now = admin.firestore.Timestamp.now();
    await paymentRef.update({
      status: currentStatus === "trash" ? restoredStatus : currentStatus,
      deleted: false,
      deletedAt: admin.firestore.FieldValue.delete(),
      deletedBy: admin.firestore.FieldValue.delete(),
      previousStatus: admin.firestore.FieldValue.delete(),
      updatedAt: now,
      restoredAt: now,
      restoredBy: req.userUid
    });
    res.json({ success: true, message: "Payment restored successfully." });
  } catch (error) {
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
    res.status(500).json({ success: false, error: "Unable to delete payment." });
  }
});

/* =========================================================
ADMIN - ADD CREDITS (CUSTOM DURATION)
=========================================================
Admin chooses days / weeks / months. No fixed expiration.
========================================================= */
app.post("/api/admin/users/:uid/add-credits", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const amount = Math.floor(safeNumber(req.body?.credits, 0));
    if (amount <= 0) {
      return res.status(400).json({ success: false, error: "Credits amount must be greater than zero." });
    }
    const bonusDurationValue = Math.floor(safeNumber(req.body?.durationValue, 3));
    const bonusDurationUnit = normalizeDurationUnit(req.body?.durationUnit) || "days";
    if (bonusDurationValue <= 0) {
      return res.status(400).json({ success: false, error: "Duration value must be greater than zero." });
    }
    const reason = String(req.body?.reason || "admin_manual_credit_add").trim();
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    const userData = snapshot.data() || {};
    const oldCredits = Math.max(0, safeNumber(userData.credits, 0));
    const newCredits = oldCredits + amount;
    const now = admin.firestore.Timestamp.now();
    const targetIsAdmin = isAdmin(targetUid);
    const creditExpiration = targetIsAdmin
      ? null
      : getCustomCreditExpiration(now.toDate(), bonusDurationValue, bonusDurationUnit);
    const entitlementRef = db.collection("creditEntitlements").doc();
    const ledgerRef = createCreditLedgerRef();

    await db.runTransaction(async (transaction) => {
      transaction.set(userRef, {
        credits: newCredits,
        ...(targetIsAdmin
          ? { adminTrackedCreditBaseline: Math.max(safeNumber(userData.adminTrackedCreditBaseline, 0), newCredits) }
          : {}),
        updatedAt: now
      }, { merge: true });
      transaction.set(entitlementRef, {
        userId: targetUid,
        plan: userData.plan || userData.subscriptionPlan || null,
        grantType: "BONUS_CREDIT",
        reason,
        creditsGranted: amount,
        creditsUsed: 0,
        creditsRemaining: amount,
        createdAt: now,
        expiresAt: creditExpiration,
        durationValue: bonusDurationValue,
        durationUnit: bonusDurationUnit,
        durationDays: resolveDurationDays(bonusDurationValue, bonusDurationUnit),
        status: "active",
        paymentReference: null,
        source: "admin_credit_adjustment",
        updatedAt: now
      });
      transaction.set(ledgerRef, {
        type: "GRANTED",
        userId: targetUid,
        credits: amount,
        grantType: "BONUS_CREDIT",
        source: "admin_credit_adjustment",
        destination: "user_credit_entitlement",
        reason,
        entitlementId: entitlementRef.id,
        createdAt: now,
        approvedBy: req.userUid
      });
    });

    res.json({ success: true, message: "Credits added successfully.", credits: newCredits });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to add credits." });
  }
});

app.post("/api/admin/users/:uid/remove-credits", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const amount = Math.floor(safeNumber(req.body?.credits, 0));
    if (amount <= 0) {
      return res.status(400).json({ success: false, error: "Credits amount must be greater than zero." });
    }
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    const userData = snapshot.data() || {};
    const oldCredits = Math.max(0, safeNumber(userData.credits, 0));
    const removedCredits = Math.min(amount, oldCredits);
    const newCredits = Math.max(0, oldCredits - removedCredits);
    const now = admin.firestore.Timestamp.now();
    const activeEntitlements = await getActiveCreditEntitlements(targetUid);

    await db.runTransaction(async (transaction) => {
      let remainingToRemove = removedCredits;
      for (const item of activeEntitlements) {
        if (remainingToRemove <= 0) break;
        const entitlementSnapshot = await transaction.get(item.ref);
        if (!entitlementSnapshot.exists) continue;
        const entitlement = entitlementSnapshot.data() || {};
        const granted = Math.max(0, safeNumber(entitlement.creditsGranted, 0));
        const used = Math.max(0, safeNumber(entitlement.creditsUsed, 0));
        const currentRemaining = Math.max(0, Math.min(safeNumber(entitlement.creditsRemaining, granted - used), granted - used));
        if (currentRemaining <= 0) continue;
        const amountToRemove = Math.min(remainingToRemove, currentRemaining);
        transaction.update(item.ref, { creditsRemaining: currentRemaining - amountToRemove, updatedAt: now });
        remainingToRemove -= amountToRemove;
      }
      transaction.set(userRef, { credits: newCredits, updatedAt: now }, { merge: true });
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

    res.json({ success: true, message: "Credits removed successfully.", credits: newCredits });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to remove credits." });
  }
});

app.post("/api/admin/users/:uid/reset-free-video", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    await userRef.update({
      freeVideoUsed: false,
      freeVideoRemaining: FREE_VIDEO_COUNT,
      freeVideoAvailable: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: "Lifetime free video has been reset." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to reset free video." });
  }
});

app.post("/api/admin/users/:uid/activate-subscription", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const plan = normalizePlan(req.body?.plan);
    if (!plan) return res.status(400).json({ success: false, error: "A valid plan is required." });
    const planInfo = PLANS[plan];
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    const userData = snapshot.data() || {};
    const oldCredits = Math.max(0, safeNumber(userData.credits, 0));
    const currentExpiry = timestampToMillis(userData.subscriptionExpiresAt);
    const baseDate = currentExpiry > Date.now() ? new Date(currentExpiry) : new Date();
    baseDate.setDate(baseDate.getDate() + planInfo.durationDays);
    const subscriptionExpiration = isAdmin(targetUid) ? null : admin.firestore.Timestamp.fromDate(baseDate);
    const now = admin.firestore.Timestamp.now();
    const creditExpiration = isAdmin(targetUid) ? null : getCreditEntitlementExpiration(now.toDate());
    const newCredits = oldCredits + planInfo.credits;
    const entitlementRef = db.collection("creditEntitlements").doc();
    const ledgerRef = createCreditLedgerRef();

    await db.runTransaction(async (transaction) => {
      transaction.set(userRef, {
        credits: newCredits,
        plan,
        subscriptionPlan: plan,
        subscriptionStartedAt: currentExpiry > Date.now() ? (userData.subscriptionStartedAt || now) : now,
        subscriptionExpiresAt: subscriptionExpiration,
        ...(isAdmin(targetUid)
          ? { adminTrackedCreditBaseline: Math.max(safeNumber(userData.adminTrackedCreditBaseline, 0), newCredits) }
          : {}),
        updatedAt: now
      }, { merge: true });
      transaction.set(entitlementRef, {
        userId: targetUid,
        plan,
        creditsGranted: planInfo.credits,
        creditsUsed: 0,
        creditsRemaining: planInfo.credits,
        createdAt: now,
        expiresAt: creditExpiration,
        status: "active",
        paymentReference: "admin-" + Date.now(),
        source: "admin_activation",
        updatedAt: now
      });
      transaction.set(ledgerRef, {
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
      });
    });

    res.json({ success: true, message: "Subscription activated successfully.", plan, credits: newCredits });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to activate subscription." });
  }
});

app.post("/api/admin/users/:uid/cancel-subscription", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    const userRef = db.collection("users").doc(targetUid);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "User not found." });
    await userRef.update({
      plan: null,
      subscriptionPlan: null,
      subscriptionExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: "Subscription cancelled successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to cancel subscription." });
  }
});

app.get("/api/admin/status", requireAuthenticatedUser, async (req, res) => {
  try {
    const adminUser = isAdmin(req.userUid);
    res.json({ success: true, isAdmin: adminUser, uid: req.userUid });
  } catch (error) {
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
    const voiceId = String(current.voiceId || current.voice_id || current.voiceName || current.voice?.name || "").trim();
    const voiceEmotion = String(current.voiceEmotion || current.emotion || "").trim();
    const voiceSpeed = current.voiceSpeed ?? current.speed ?? null;
    const voicePitch = current.voicePitch ?? current.pitch ?? null;
    const languageBoost = String(current.languageBoost || current.language_boost || "").trim();
    const musicPrompt = String(current.musicPrompt || current.music || "").trim();
    const musicVolume = current.musicVolume ?? 0.7;
    const sfxPrompt = String(current.sfxPrompt || current.sfx || "").trim();
    const sfxVolume = current.sfxVolume ?? 0.7;
    const ambiencePrompt = String(current.ambiencePrompt || current.ambience || "").trim();
    const ambienceVolume = current.ambienceVolume ?? 0.5;
    return {
      id: current.id || ("scene-" + (index + 1)),
      index,
      prompt: String(current.prompt || "").trim(),
      duration,
      voice: String(current.voice || "").trim(),
      voiceText, voiceLanguage, voiceId, voiceEmotion, voiceSpeed, voicePitch, languageBoost,
      dialogue: String(current.dialogue || "").trim(),
      narration: String(current.narration || "").trim(),
      music: String(current.music || "").trim(), musicPrompt, musicVolume,
      sfx: String(current.sfx || "").trim(), sfxPrompt, sfxVolume,
      ambience: String(current.ambience || "").trim(), ambiencePrompt, ambienceVolume,
      audioDirection: String(current.audioDirection || "").trim(),
      imageUrl: current.imageUrl || current.image || null,
      videoUrl: current.videoUrl || current.video || null,
      firstFrameImage: current.firstFrameImage || null,
      lastFrameImage: current.lastFrameImage || null,
      frameWidth: Math.max(35, Math.min(100, safeNumber(current.frameWidth, 80))),
      frameHeight: Math.max(35, Math.min(100, safeNumber(current.frameHeight, 80))),
      continuityContext: String(current.continuityContext || "").trim()
    };
  }).filter((scene) =>
    scene.prompt || scene.imageUrl || scene.videoUrl || scene.dialogue ||
    scene.narration || scene.voiceText || scene.musicPrompt || scene.sfxPrompt || scene.ambiencePrompt
  );
}

function calculateStoryboardCredits(scenes) {
  const normalized = normalizeStoryboardScenes(scenes);
  return normalized.reduce((total, scene) => total + getVideoCreditCost(scene.duration), 0);
}

function buildStoryboardContinuity(scenes) {
  const normalized = normalizeStoryboardScenes(scenes);
  const blocks = [];
  normalized.forEach((scene, index) => {
    const details = [
      "Scene " + (index + 1),
      scene.prompt ? "Visual: " + scene.prompt : "",
      scene.voice ? "Voice: " + scene.voice : "",
      scene.dialogue ? "Dialogue: " + scene.dialogue : "",
      scene.narration ? "Narration: " + scene.narration : ""
    ].filter(Boolean).join(NL);
    blocks.push(details);
  });
  return blocks.join(NL).trim();
}

async function renderStoryboardAudio(scenes, options = {}) {
  const normalized = normalizeStoryboardScenes(scenes);
  if (!normalized.length) return { scenes: [], audioFiles: [], cleanupFiles: [] };
  try {
    const rendered = await renderGaveAIAudioForScenes(normalized, { ...options });
    return rendered || { scenes: normalized, audioFiles: [], cleanupFiles: [] };
  } catch (error) {
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
    id,
    userId: data.userId || null,
    status: normalizeVideoStatus(data.status),
    prompt: data.prompt || "",
    duration: Number(data.duration) === 8 ? 8 : 5,
    credits: safeNumber(data.credits, 0),
    provider: "GaveAI",
    type: data.type || (data.storyboard === true ? "storyboard" : "video"),
    storyboard: data.storyboard === true,
    projectId: data.projectId || null,
    totalScenes: Math.max(0, safeNumber(data.totalScenes, 0)),
    scenesCompleted: Math.max(0, safeNumber(data.scenesCompleted, 0)),
    scenes: Array.isArray(data.scenes) ? data.scenes.map((scene) => ({
      id: scene.id || null,
      index: safeNumber(scene.index, 0),
      prompt: scene.prompt || "",
      duration: Number(scene.duration) === 8 ? 8 : 5,
      imageUrl: scene.imageUrl || null,
      videoUrl: scene.videoUrl || null,
      audioAdded: scene.audioAdded === true
    })) : [],
    audioAdded: data.audioAdded === true,
    videoUrl: data.videoUrl || data.url || null,
    thumbnailUrl: data.thumbnailUrl || null,
    error: data.error || null,
    createdAt: timestampToISO(data.createdAt),
    startedAt: timestampToISO(data.startedAt),
    completedAt: timestampToISO(data.completedAt),
    failedAt: timestampToISO(data.failedAt)
  };
}

async function getActiveCreditEntitlements(userId) {
  const snapshot = await db.collection("creditEntitlements")
    .where("userId", "==", userId)
    .where("status", "==", "active")
    .get();
  return snapshot.docs
    .map((doc) => ({ ref: doc.ref, data: doc.data() || {} }))
    .sort((a, b) => {
      const aExpires = timestampToMillis(a.data.expiresAt);
      const bExpires = timestampToMillis(b.data.expiresAt);
      return (aExpires || Number.MAX_SAFE_INTEGER) - (bExpires || Number.MAX_SAFE_INTEGER);
    });
}

async function consumeCreditEntitlements(transaction, entitlementRefs, amount, ledgerContext = {}) {
  let remainingToAllocate = Math.max(0, safeNumber(amount, 0));
  let allocatedCredits = 0;
  if (remainingToAllocate <= 0) return { allocatedCredits: 0, unallocatedCredits: 0 };

  const entitlementSnapshots = [];
  for (const item of entitlementRefs) {
    const snapshot = await transaction.get(item.ref);
    entitlementSnapshots.push({ ref: item.ref, snapshot });
  }

  for (const item of entitlementSnapshots) {
    if (remainingToAllocate <= 0) break;
    if (!item.snapshot.exists) continue;
    const entitlement = item.snapshot.data() || {};
    if (String(entitlement.status || "").toLowerCase() !== "active") continue;
    const granted = Math.max(0, safeNumber(entitlement.creditsGranted, 0));
    const used = Math.max(0, safeNumber(entitlement.creditsUsed, 0));
    const currentRemaining = Math.max(0, Math.min(safeNumber(entitlement.creditsRemaining, granted - used), granted - used));
    if (currentRemaining <= 0) continue;
    const amountToUse = Math.min(remainingToAllocate, currentRemaining);
    transaction.update(item.ref, {
      creditsUsed: used + amountToUse,
      creditsRemaining: currentRemaining - amountToUse,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    const ledgerRef = createCreditLedgerRef();
    transaction.set(ledgerRef, {
      type: "USED",
      userId: ledgerContext.userId || null,
      credits: amountToUse,
      source: "user_credit_entitlement",
      destination: ledgerContext.destination || "video_generation",
      reason: ledgerContext.reason || "video_credit_usage",
      feature: ledgerContext.feature || null,
      entitlementId: item.ref.id,
      paymentId: ledgerContext.paymentId || null,
      jobId: ledgerContext.jobId || null,
      createdAt: admin.firestore.Timestamp.now()
    });
    allocatedCredits += amountToUse;
    remainingToAllocate -= amountToUse;
  }

  if (remainingToAllocate > 0) {
    const userId = ledgerContext.userId || null;
    if (!userId) throw new Error("CREDIT_ENTITLEMENT_ALLOCATION_FAILED");
    const now = admin.firestore.Timestamp.now();
    const legacyEntitlementRef = db.collection("creditEntitlements").doc();
    const legacyCredits = remainingToAllocate;
    const legacyCreditExpiration = getCreditEntitlementExpiration(now.toDate());
    transaction.set(legacyEntitlementRef, {
      userId,
      plan: ledgerContext.plan || null,
      creditsGranted: legacyCredits,
      creditsUsed: legacyCredits,
      creditsRemaining: 0,
      createdAt: now,
      expiresAt: legacyCreditExpiration,
      status: "active",
      source: "legacy_user_credit_balance",
      updatedAt: now
    });
    allocatedCredits += legacyCredits;
    remainingToAllocate = 0;
  }

  return { allocatedCredits, unallocatedCredits: remainingToAllocate };
}

async function reserveVideoCredits(userId, duration) {
  const cost = getVideoCreditCost(duration);
  const userRef = db.collection("users").doc(userId);
  await processExpiredEntitlements(userId);
  const activeEntitlements = isAdmin(userId) ? [] : await getActiveCreditEntitlements(userId);

  return await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const userData = snapshot.exists ? snapshot.data() || {} : {};
    const adminUser = isAdmin(userId);
    const freeState = normalizeFreeVideoState(userData);
    const credits = Math.max(0, safeNumber(userData.credits, 0));

    if (adminUser) {
      return {
        chargedCredits: 0, usedFreeVideo: false, remainingCredits: credits,
        freeVideoRemaining: freeState.freeVideoRemaining, isAdmin: true
      };
    }

    if (freeState.freeVideoAvailable) {
      transaction.set(userRef, {
        freeVideoUsed: true,
        freeVideoRemaining: 0,
        freeVideoAvailable: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return {
        chargedCredits: 0, usedFreeVideo: true, remainingCredits: credits,
        freeVideoRemaining: 0, isAdmin: false
      };
    }

    if (credits < cost) throw new Error("INSUFFICIENT_CREDITS");

    await consumeCreditEntitlements(transaction, activeEntitlements, cost, {
      userId,
      destination: "video_generation",
      reason: "video_credit_usage",
      feature: "video_generation"
    });

    const remainingCredits = credits - cost;
    transaction.set(userRef, {
      credits: remainingCredits,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      chargedCredits: cost, usedFreeVideo: false, remainingCredits,
      freeVideoRemaining: freeState.freeVideoRemaining, isAdmin: false
    };
  });
}

/*
=========================================================
BUSINESS RULE: NO AUTOMATIC REFUNDS
=========================================================
Once a video is successfully generated the transaction is
complete. This function is intentionally a no-op and must
stay that way.
=========================================================
*/
async function refundVideoCredits(userId, amount, usedFreeVideo) {}

/* =========================================================
VIDEO QUEUE & WORKERS
========================================================= */
function canAcceptVideoJob() { return queuedVideoGenerations < MAX_VIDEO_QUEUE; }
function incrementVideoQueue() { queuedVideoGenerations += 1; }
function decrementVideoQueue() { queuedVideoGenerations = Math.max(0, queuedVideoGenerations - 1); }
function startVideoGenerationSlot() { activeVideoGenerations += 1; }
function finishVideoGenerationSlot() { activeVideoGenerations = Math.max(0, activeVideoGenerations - 1); }

async function generateVideoWithProvider(options) {
  const result = await generateWithGaveAIVideoProvider(options);
  if (!result) throw new Error("VIDEO_PROVIDER_EMPTY_RESULT");
  return result;
}

/* =========================================================
SINGLE VIDEO WORKER
=========================================================
1. Load Character Bible + memory BEFORE generation
2. Generate video (WaveSpeed â†’ local MP4)
3. Mux voice / music / SFX / ambience with FFmpeg
4. Upload the final MP4 to ImageKit (permanent URL)
5. Save identity + project memory AFTER generation
6. Clean every temporary file
NO automatic refunds.
========================================================= */
async function processVideoJob(jobId) {
  const jobRef = getVideoJobCollection().doc(jobId);
  const productionRef = getVideoProductionCollection().doc(jobId);
  let jobData = null;
  let heartbeat = null;
  const cleanupFiles = [];
  try {
    const snapshot = await jobRef.get();
    if (!snapshot.exists) return;
    jobData = snapshot.data() || {};
    const userId = jobData.userId;
    const duration = Number(jobData.duration) === 8 ? 8 : 5;

    await jobRef.set({
      status: "generating",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      heartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    startVideoGenerationSlot();
    heartbeat = setInterval(() => {
      jobRef.set({ heartbeatAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }, 30000);

    const context = await loadGaveAIMediaContext(userId, jobData, jobData.prompt);
    const promptBlocks = [wrapStrictPrompt(jobData.prompt), GAVEAI_VIDEO_CONSISTENCY_RULES];
    if (context.memorySummary) promptBlocks.push("LONG TERM MEMORY:" + NL + context.memorySummary);

    const providerResult = await generateVideoWithProvider({
      prompt: promptBlocks.join(NL + NL),
      width: safeNumber(jobData.width, 832),
      height: safeNumber(jobData.height, 480),
      duration,
      seed: safeNumber(jobData.seed, -1),
      firstFrameImage: jobData.firstFrameImage || null,
      characterBible: context.bible,
      userId,
      jobId,
      providerName: "GAVEAIproduction"
    });

    let videoFile = providerResult?.videoFile || null;
    let finalUrl = providerResult?.videoUrl || providerResult?.url ||
      providerResult?.outputUrl || providerResult?.output?.url || null;
    if (!videoFile && !finalUrl) throw new Error("VIDEO_PROVIDER_EMPTY_RESULT");

    let audioAdded = false;
    let videoFileId = null;

    if (videoFile) {
      cleanupFiles.push(videoFile);
      try {
        const sceneAudio = await createSceneAudio(
          { ...jobData, duration },
          { audioDirection: jobData.audioDirection || context.bible.audioDirection }
        );
        (sceneAudio?.audioTracks || []).forEach((track) => {
          if (track?.filePath) cleanupFiles.push(track.filePath);
        });
        if (sceneAudio?.audioFile) {
          cleanupFiles.push(sceneAudio.audioFile);
          const merged = await mergeVideoAndVoice({ videoFile, audioFile: sceneAudio.audioFile });
          videoFile = merged.filePath;
          cleanupFiles.push(videoFile);
          audioAdded = true;
        }
      } catch (audioError) {
        console.error("GAVEAI VIDEO AUDIO ERROR:", audioError.message);
      }
      const uploaded = await uploadVideoFileToImageKit(videoFile, userId, "video");
      finalUrl = uploaded.url;
      videoFileId = uploaded.fileId;
    }

    if (!finalUrl) throw new Error("VIDEO_PROVIDER_EMPTY_RESULT");

    const completed = {
      status: "completed",
      provider: "GaveAI",
      providerName: "GAVEAIproduction",
      videoUrl: finalUrl,
      videoFileId,
      audioAdded,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await jobRef.set(completed, { merge: true });
    await productionRef.set({ ...jobData, ...completed }, { merge: true });

    if (context.projectId) {
      try {
        await saveCharacterBible({
          userId,
          projectId: context.projectId,
          ...context.bible,
          lastVideoUrl: finalUrl
        });
        await saveProjectMemory(userId, context.projectId, {
          title: "GaveAI video project",
          context: ["VIDEO: " + jobData.prompt, "RESULT: " + finalUrl].join(NL)
        });
      } catch (memoryError) {
        console.error("GAVEAI VIDEO MEMORY SAVE FAILED:", memoryError.message);
      }
    }
  } catch (error) {
    const errorMessage = genericVideoError(error, jobData?.userId);
    try {
      await jobRef.set({
        status: "failed",
        error: errorMessage,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await productionRef.set({
        ...(jobData || {}),
        status: "failed",
        error: errorMessage,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (saveError) {}
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    cleanupAudioFiles(cleanupFiles);
    finishVideoGenerationSlot();
    decrementVideoQueue();
  }
}

/* =========================================================
QUEUE PROCESSOR
=========================================================
Storyboard jobs are NO LONGER skipped. They are dispatched
to processStoryboardJob (defined in Moso 4).
========================================================= */
async function processQueuedVideoJobs() {
  if (activeVideoGenerations >= MAX_CONCURRENT_VIDEOS) return;
  try {
    const snapshot = await getVideoJobCollection()
      .where("status", "==", "queued")
      .limit(Math.max(1, MAX_CONCURRENT_VIDEOS - activeVideoGenerations))
      .get();
    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      if (activeVideoGenerations >= MAX_CONCURRENT_VIDEOS) break;
      const claimed = await db.runTransaction(async (transaction) => {
        const ref = getVideoJobCollection().doc(doc.id);
        const current = await transaction.get(ref);
        if (!current.exists) return false;
        const data = current.data() || {};
        if (normalizeVideoStatus(data.status) !== "queued") return false;
        transaction.set(ref, {
          status: "generating",
          claimedAt: admin.firestore.FieldValue.serverTimestamp(),
          heartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
      });

      if (claimed) {
        const claimedData = doc.data() || {};
        const worker = (claimedData.storyboard === true || claimedData.type === "storyboard")
          ? processStoryboardJob
          : processVideoJob;
        worker(doc.id).catch((error) => {
          console.error("GAVEAI VIDEO WORKER ERROR:", error?.message || error);
        });
      }
    }
  } catch (error) {}
}

setInterval(processQueuedVideoJobs, 2000);

/* =========================================================
GENERATE VIDEO
=========================================================
Voice / music / SFX / ambience / volumes / projectId are now
persisted on the job so the worker can actually use them.
========================================================= */
app.post("/generate-video", requireAuthenticatedUser, async (req, res) => {
  let reservation = null;
  try {
    if (!canAcceptVideoJob()) {
      return res.status(429).json({ success: false, error: "GaveAI video generation queue is full. Please try again shortly." });
    }
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
      userId,
      prompt,
      width: safeNumber(req.body?.width, 832),
      height: safeNumber(req.body?.height, 480),
      duration,
      seed: safeNumber(req.body?.seed, -1),
      firstFrameImage: req.body?.firstFrameImage || null,
      projectId: String(req.body?.projectId || "").trim() || null,
      characterBible: req.body?.characterBible || {},
      audioDirection: String(req.body?.audioDirection || "").trim(),
      voiceText: String(req.body?.voiceText || req.body?.dialogue || req.body?.narration || "").trim(),
      dialogue: String(req.body?.dialogue || "").trim(),
      narration: String(req.body?.narration || "").trim(),
      voiceLanguage: String(req.body?.voiceLanguage || "").trim(),
      voiceId: String(req.body?.voiceId || "").trim(),
      voiceEmotion: String(req.body?.voiceEmotion || "").trim(),
      voiceSpeed: req.body?.voiceSpeed ?? 1.0,
      voicePitch: req.body?.voicePitch ?? 0,
      languageBoost: String(req.body?.languageBoost || "").trim(),
      musicPrompt: String(req.body?.musicPrompt || "").trim(),
      musicVolume: req.body?.musicVolume ?? 0.7,
      sfxPrompt: String(req.body?.sfxPrompt || "").trim(),
      sfxVolume: req.body?.sfxVolume ?? 0.7,
      ambiencePrompt: String(req.body?.ambiencePrompt || "").trim(),
      ambienceVolume: req.body?.ambienceVolume ?? 0.5,
      credits: creditsRequired,
      chargedCredits: reservation.chargedCredits,
      usedFreeVideo: reservation.usedFreeVideo,
      provider: "GaveAI",
      providerName: "GAVEAIproduction",
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    await jobRef.set(jobData);
    res.status(202).json({
      success: true,
      queued: true,
      jobId: jobRef.id,
      videoJobId: jobRef.id,
      status: "queued",
      provider: "GaveAI",
      message: "Your GaveAI video is being generated.",
      credits: reservation.remainingCredits,
      chargedCredits: reservation.chargedCredits,
      usedFreeVideo: reservation.usedFreeVideo,
      freeVideoRemaining: reservation.freeVideoRemaining
    });
  } catch (error) {
    res.status(String(error?.message || "") === "INSUFFICIENT_CREDITS" ? 402 : 500)
      .json({ success: false, error: genericVideoError(error, req.userUid) });
  }
});

app.get("/api/video-productions/:id", requireAuthenticatedUser, async (req, res) => {
  try {
    const productionId = req.params.id;
    const jobRef = getVideoJobCollection().doc(productionId);
    const snapshot = await jobRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Video production not found." });
    const data = snapshot.data() || {};
    if (data.userId !== req.userUid && !isAdmin(req.userUid)) {
      return res.status(403).json({ success: false, error: "You do not have access to this video production." });
    }
    res.json({ success: true, production: videoJobToClient(snapshot.id, data) });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load video production." });
  }
});

app.get("/api/video-productions", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const snapshot = await getVideoJobCollection().where("userId", "==", userId).limit(100).get();
    const productions = snapshot.docs
      .map((doc) => videoJobToClient(doc.id, doc.data()))
      .sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    res.json({ success: true, productions });
  } catch (error) {
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
    res.status(500).json({ success: false, error: "Unable to load video productions." });
  }
});

/* =========================================================
STORYBOARD GENERATE
=========================================================
Character Bible + Project Memory + Long Term Memory +
Semantic Memory are loaded and saved BEFORE credits are
reserved, so a memory failure can never charge the user.
========================================================= */
app.post("/api/storyboard/generate", requireAuthenticatedUser, async (req, res) => {
  let createdJobId = null;
  try {
    if (!canAcceptVideoJob()) {
      return res.status(429).json({ success: false, error: "GaveAI video generation queue is full. Please try again shortly." });
    }
    const userId = req.userUid;
    const storyOverview = String(req.body?.storyOverview || req.body?.story || "").trim();
    const scenes = normalizeStoryboardScenes(req.body?.scenes);
    if (!scenes.length) {
      return res.status(400).json({ success: false, error: "At least one storyboard scene is required." });
    }
    const totalCredits = calculateStoryboardCredits(scenes);
    const totalDuration = scenes.reduce((total, scene) => total + scene.duration, 0);
    const storyboardId = "storyboard-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    const projectId = String(req.body?.projectId || "").trim() || storyboardId;

    /* CHARACTER BIBLE (persistent identity) */
    const incomingBible = {
      mainCharacter: String(req.body?.mainCharacter || "").trim(),
      supportingCharacters: String(req.body?.supportingCharacters || "").trim(),
      visualStyle: String(req.body?.visualStyle || "").trim(),
      environment: String(req.body?.environment || "").trim(),
      cameraStyle: String(req.body?.cameraStyle || "").trim(),
      audioDirection: String(req.body?.globalAudioDirection || req.body?.audioDirection || "").trim(),
      ...(req.body?.characterBible || {})
    };
    const storedBible = await getStoredCharacterBible(userId, projectId).catch(() => null);
    const characterBible = mergeCharacterBible(storedBible || {}, incomingBible);
    await saveCharacterBible({ userId, projectId, ...characterBible }).catch((error) => {
      console.error("GAVEAI CHARACTER BIBLE SAVE FAILED:", error.message);
    });

    /* PROJECT + LONG TERM + SEMANTIC MEMORY */
    const storyboardContext = await loadGaveAIMediaContext(
      userId,
      { projectId, characterBible, storyOverview },
      storyOverview
    );

    /* CREDITS */
    let reservation;
    if (scenes.length === 1) {
      reservation = await reserveVideoCredits(userId, scenes[0].duration);
    } else {
      await processExpiredEntitlements(userId);
      const activeEntitlements = isAdmin(userId) ? [] : await getActiveCreditEntitlements(userId);
      const userRef = db.collection("users").doc(userId);
      reservation = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(userRef);
        const userData = snapshot.exists ? snapshot.data() || {} : {};
        const credits = Math.max(0, safeNumber(userData.credits, 0));
        if (isAdmin(userId)) {
          return {
            chargedCredits: 0, usedFreeVideo: false, remainingCredits: credits,
            freeVideoRemaining: normalizeFreeVideoState(userData).freeVideoRemaining, isAdmin: true
          };
        }
        if (credits < totalCredits) throw new Error("INSUFFICIENT_CREDITS");
        await consumeCreditEntitlements(transaction, activeEntitlements, totalCredits, {
          userId,
          destination: "video_generation",
          reason: "storyboard_credit_usage",
          feature: "storyboard"
        });
        const remainingCredits = credits - totalCredits;
        transaction.set(userRef, {
          credits: remainingCredits,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
          chargedCredits: totalCredits, usedFreeVideo: false, remainingCredits,
          freeVideoRemaining: normalizeFreeVideoState(userData).freeVideoRemaining, isAdmin: false
        };
      });
    }

    incrementVideoQueue();
    const now = admin.firestore.Timestamp.now();
    const productionRef = getVideoProductionCollection().doc(storyboardId);
    const productionData = {
      userId,
      type: "storyboard",
      storyboardId,
      storyOverview,
      scenes,
      totalScenes: scenes.length,
      totalDuration,
      totalCredits,
      projectId,
      characterBible,
      mainCharacter: characterBible.mainCharacter || "",
      supportingCharacters: characterBible.supportingCharacters || "",
      visualStyle: characterBible.visualStyle || "",
      environment: characterBible.environment || "",
      cameraStyle: characterBible.cameraStyle || "",
      globalAudioDirection: characterBible.audioDirection || "",
      memorySummary: storyboardContext.memorySummary || "",
      width: safeNumber(req.body?.width, 832),
      height: safeNumber(req.body?.height, 480),
      seed: safeNumber(req.body?.seed, -1),
      chargedCredits: reservation.chargedCredits,
      usedFreeVideo: reservation.usedFreeVideo,
      provider: "GaveAI",
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    await productionRef.set(productionData);

    const jobRef = getVideoJobCollection().doc(storyboardId);
    await jobRef.set({
      ...productionData,
      prompt: storyOverview || scenes.map((s) => s.prompt).filter(Boolean).join(NL),
      duration: totalDuration,
      credits: totalCredits,
      storyboard: true,
      status: "queued"
    });
    createdJobId = storyboardId;

    res.status(202).json({
      success: true,
      queued: true,
      storyboardId,
      jobId: storyboardId,
      videoJobId: storyboardId,
      status: "queued",
      provider: "GaveAI",
      projectId,
      totalScenes: scenes.length,
      totalDuration,
      totalCredits,
      chargedCredits: reservation.chargedCredits,
      usedFreeVideo: reservation.usedFreeVideo,
      credits: reservation.remainingCredits,
      freeVideoRemaining: reservation.freeVideoRemaining
    });
  } catch (error) {
    if (createdJobId) {
      try {
        await getVideoJobCollection().doc(createdJobId).set({
          status: "failed",
          error: genericVideoError(error, req.userUid),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) {}
    }
    res.status(String(error?.message || "") === "INSUFFICIENT_CREDITS" ? 402 : 500)
      .json({ success: false, error: genericVideoError(error, req.userUid) });
  }
});

/* =========================================================
ADMIN OVERVIEW & CREDIT POOL
========================================================= */
app.get("/api/admin/overview", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const [usersSnapshot, paymentsSnapshot, productionsSnapshot] = await Promise.all([
      db.collection("users").get(),
      db.collection("paymentRequests").get(),
      db.collection("videoProductions").get()
    ]);
    const allUsers = usersSnapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
    const allPayments = paymentsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const allProductions = productionsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const activePayments = allPayments.filter((p) => p.deleted !== true);
    const pendingPayments = activePayments.filter((p) => normalizePaymentStatus(p.status) === "pending");
    const approvedPayments = activePayments.filter((p) => normalizePaymentStatus(p.status) === "approved");
    const approvedRevenue = approvedPayments
      .filter((p) => p.revenueCalendarDeleted !== true)
      .reduce((total, p) => total + safeNumber(p.amount ?? p.price, 0), 0);

    res.json({
      success: true,
      overview: {
        totalUsers: allUsers.length,
        proUsers: allUsers.filter((u) => getUserPlan(u) === "pro").length,
        premiumUsers: allUsers.filter((u) => getUserPlan(u) === "premium").length,
        activeSubscriptions: allUsers.filter((u) => !!getUserPlan(u)).length,
        totalPayments: allPayments.length,
        pendingPayments: pendingPayments.length,
        approvedPayments: approvedPayments.length,
        rejectedPayments: activePayments.filter((p) => normalizePaymentStatus(p.status) === "rejected").length,
        approvedRevenue,
        totalVideoProductions: allProductions.length
      },
      payments: activePayments.map((p) => paymentToClient(p.id, p)).slice(0, 100),
      users: allUsers.map((u) => ({
        uid: u.uid,
        email: u.email || null,
        fullName: u.fullName || u.name || null,
        credits: safeNumber(u.credits, 0)
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load admin overview." });
  }
});

app.get("/api/admin/credit-pool", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const poolRef = db.collection("creditPool").doc("inventory");
    const [poolSnapshot, transactionSnapshot, entitlementSnapshot] = await Promise.all([
      poolRef.get(),
      db.collection("creditPoolTransactions").orderBy("createdAt", "desc").limit(200).get(),
      db.collection("creditEntitlements").get()
    ]);
    const poolData = poolSnapshot.exists ? poolSnapshot.data() || {} : {};
    const entitlements = entitlementSnapshot.docs.map((doc) => creditEntitlementToClient(doc.id, doc.data() || {}));
    const active = entitlements.filter((item) => item.status === "active");
    const transactions = transactionSnapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        type: String(data.type || "").toUpperCase(),
        credits: Math.max(0, safeNumber(data.credits, 0)),
        userId: data.userId || "",
        plan: data.plan || "",
        grantType: data.grantType || "",
        paymentId: data.paymentId || "",
        reason: data.reason || "",
        source: data.source || "",
        destination: data.destination || "",
        createdAt: timestampToISO(data.createdAt)
      };
    });
    const ledgerAllocated = transactions
      .filter((tx) => ["GRANTED", "RESOLD", "ALLOCATED", "REFERRAL_REWARD", "PROMOTION_REWARD"].includes(tx.type))
      .reduce((total, tx) => total + tx.credits, 0);

    res.json({
      success: true,
      pool: {
        availableCredits: Math.max(0, safeNumber(poolData.availableCredits, 0)),
        eligibleReturnedCredits: Math.max(0, safeNumber(poolData.eligibleReturnedCredits, 0)),
        totalReturnedCredits: Math.max(0, safeNumber(poolData.totalReturnedCredits, 0)),
        totalResoldCredits: Math.max(0, safeNumber(poolData.totalResoldCredits, 0)),
        totalGrantedCredits: Math.max(0, safeNumber(poolData.totalGrantedCredits, 0)),
        updatedAt: timestampToISO(poolData.updatedAt)
      },
      summary: {
        availableToResell: Math.max(0, safeNumber(poolData.availableCredits, 0)),
        totalReturned: Math.max(0, safeNumber(poolData.eligibleReturnedCredits, 0)),
        totalResold: Math.max(0, safeNumber(poolData.totalResoldCredits, 0)),
        activeGrantedCredits: active.reduce((total, item) => total + item.creditsGranted, 0),
        activeUsedCredits: active.reduce((total, item) => total + item.creditsUsed, 0),
        activeRemainingCredits: active.reduce((total, item) => total + item.creditsRemaining, 0),
        expiredCredits: entitlements.reduce((total, item) => total + item.expiredCredits, 0),
        ledgerAllocated
      },
      transactions,
      entitlements
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load credit pool." });
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
    const audioUrl = await getAudioUrl(text, language);
    if (!audioUrl) {
      return res.status(502).json({ success: false, stage: "tts", error: "GaveAI voice audio could not be generated." });
    }
    return res.json({ success: true, audioUrl, language });
  } catch (error) {
    return res.status(500).json({ success: false, stage: "tts", error: "GaveAI voice audio could not be generated." });
  }
});

app.post("/api/voice/message", requireAuthenticatedUser, upload.single("audio"), async (req, res) => {
  try {
    const userId = req.userUid;
    const imageUrl = String(req.body?.imageUrl || "").trim() || null;
    const projectId = String(req.body?.projectId || "").trim();
    if (!req.file) return res.status(400).json({ success: false, error: "Audio file is required." });
    const audioBuffer = req.file.buffer;
    if (!audioBuffer || !audioBuffer.length) throw new Error("Audio buffer is empty.");

    const sttResult = await transcribeAudio(audioBuffer, req.file.mimetype, "voice-input.webm");
    const transcript = String(sttResult?.transcript || "").trim();
    const detectedLanguage = sttResult?.language || "en";
    if (!transcript) return res.status(400).json({ success: false, error: "No speech was detected." });

    const aiResult = await generateAIResponse(transcript, {
      userId,
      imageUrl,
      attachment: imageUrl ? { url: imageUrl, type: "image" } : null,
      conversation: [],
      projectId,
      language: detectedLanguage,
      detectedLanguage
    });
    const reply = typeof aiResult === "string"
      ? aiResult
      : aiResult?.reply || aiResult?.response || aiResult?.content || aiResult?.message || "";
    if (!reply) throw new Error("AI did not generate a response.");

    let audioUrl = null;
    try {
      const normalizedLanguage = normalizeLanguageCode(detectedLanguage);
      audioUrl = await getAudioUrl(reply, normalizedLanguage);
    } catch (ttsError) {
      return res.status(502).json({
        success: false,
        stage: "tts",
        language: detectedLanguage,
        error: "GaveAI voice audio could not be generated. Please try again."
      });
    }

    const userData = await getUserDocument(userId);
    const freeState = normalizeFreeVideoState(userData || {});
    res.json({
      success: true,
      transcript,
      reply,
      response: reply,
      audioUrl,
      audio: audioUrl,
      language: detectedLanguage,
      detectedLanguage,
      freeVideoRemaining: freeState.freeVideoRemaining,
      freeVideoAvailable: freeState.freeVideoAvailable
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "GaveAI voice processing failed. Please try again." });
  }
});/* =========================================================
STORYBOARD WORKER
=========================================================
1. Load Character Bible + Project/Long Term/Semantic Memory
2. Generate every scene with continuity from the previous one
   (last frame of previous scene becomes first frame of next)
3. Mux voice / music / SFX / ambience per scene
4. Upload each scene + the final connected MP4 to ImageKit
5. Save identity + project memory AFTER generation
6. Clean every temporary file
NO automatic refunds.
========================================================= */
async function processStoryboardJob(jobId) {
  const jobRef = getVideoJobCollection().doc(jobId);
  const productionRef = getVideoProductionCollection().doc(jobId);
  let jobData = null;
  let heartbeat = null;
  const cleanupFiles = [];
  try {
    const snapshot = await jobRef.get();
    if (!snapshot.exists) return;
    jobData = snapshot.data() || {};
    const userId = jobData.userId;
    const scenes = normalizeStoryboardScenes(jobData.scenes);
    if (!scenes.length) throw new Error("STORYBOARD_SCENES_MISSING");

    await jobRef.set({
      status: "generating",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      heartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await productionRef.set({
      status: "generating",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    startVideoGenerationSlot();
    heartbeat = setInterval(() => {
      jobRef.set({ heartbeatAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }, 30000);

    const context = await loadGaveAIMediaContext(userId, jobData, jobData.storyOverview);
    const bible = context.bible;
    const memorySummary = jobData.memorySummary || context.memorySummary;
    const rendered = [];
    let previousScene = null;

    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];

      /* CONTINUITY: same face, clothes, environment as previous scene */
      let firstFrame = scene.firstFrameImage || scene.imageUrl || null;
      if (!firstFrame && previousScene?.videoFile) {
        firstFrame = await extractLastFrameImage(previousScene.videoFile, userId, index);
      }
      if (!firstFrame && bible.referenceImageUrl) firstFrame = bible.referenceImageUrl;

      const providerResult = await generateVideoWithProvider({
        prompt: buildStoryboardScenePrompt(jobData, scenes, index, previousScene, memorySummary),
        width: safeNumber(jobData.width, 832),
        height: safeNumber(jobData.height, 480),
        duration: scene.duration,
        seed: safeNumber(jobData.seed, -1),
        firstFrameImage: firstFrame,
        lastImage: scene.lastFrameImage || null,
        characterBible: bible,
        userId,
        jobId,
        providerName: "GAVEAIproduction"
      });

      let videoFile = providerResult?.videoFile || null;
      if (!videoFile) throw new Error("VIDEO_PROVIDER_EMPTY_RESULT");
      cleanupFiles.push(videoFile);

      let audioAdded = false;
      try {
        const sceneAudio = await createSceneAudio(
          { ...scene, duration: scene.duration },
          { audioDirection: jobData.globalAudioDirection || bible.audioDirection }
        );
        (sceneAudio?.audioTracks || []).forEach((track) => {
          if (track?.filePath) cleanupFiles.push(track.filePath);
        });
        if (sceneAudio?.audioFile) {
          cleanupFiles.push(sceneAudio.audioFile);
          const merged = await mergeVideoAndVoice({ videoFile, audioFile: sceneAudio.audioFile });
          videoFile = merged.filePath;
          cleanupFiles.push(videoFile);
          audioAdded = true;
        }
      } catch (audioError) {
        console.error("GAVEAI STORYBOARD SCENE AUDIO ERROR:", audioError.message);
      }

      const uploadedScene = await uploadVideoFileToImageKit(videoFile, userId, `storyboard-scene-${index + 1}`);
      const sceneRecord = {
        ...scene,
        index,
        videoFile,
        videoUrl: uploadedScene.url,
        imageUrl: firstFrame || scene.imageUrl || null,
        firstFrameImage: firstFrame || null,
        audioAdded,
        continuityDescription: scene.prompt
      };
      rendered.push(sceneRecord);
      previousScene = sceneRecord;

      await jobRef.set({
        scenesCompleted: index + 1,
        totalScenes: scenes.length,
        heartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    /* CONCAT: every input must have the same stream layout */
    const anyAudio = rendered.some((scene) => scene.audioAdded);
    const concatInputs = [];
    for (const scene of rendered) {
      if (!anyAudio || scene.audioAdded) {
        concatInputs.push(scene.videoFile);
        continue;
      }
      const silence = await createSilence(scene.duration);
      cleanupFiles.push(silence);
      const merged = await mergeVideoAndVoice({ videoFile: scene.videoFile, audioFile: silence });
      cleanupFiles.push(merged.filePath);
      concatInputs.push(merged.filePath);
    }

    const finalFile = await concatSceneVideos(concatInputs, anyAudio);
    cleanupFiles.push(finalFile);
    const uploadedFinal = await uploadVideoFileToImageKit(finalFile, userId, "storyboard-final");

    const clientScenes = rendered.map((scene) => {
      const { videoFile, audioFile, audio, ...rest } = scene;
      return rest;
    });

    const completed = {
      status: "completed",
      provider: "GaveAI",
      providerName: "GAVEAIproduction",
      videoUrl: uploadedFinal.url,
      videoFileId: uploadedFinal.fileId,
      audioAdded: anyAudio,
      scenes: clientScenes,
      totalScenes: clientScenes.length,
      scenesCompleted: clientScenes.length,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await jobRef.set(completed, { merge: true });
    await productionRef.set({ ...jobData, ...completed, scenes: clientScenes }, { merge: true });

    if (jobData.projectId) {
      try {
        await saveCharacterBible({
          userId,
          projectId: jobData.projectId,
          ...bible,
          lastVideoUrl: uploadedFinal.url
        });
        await saveProjectMemory(userId, jobData.projectId, {
          title: String(jobData.storyOverview || "GaveAI storyboard").slice(0, 120),
          context: [
            "STORYBOARD (" + clientScenes.length + " scenes): " + jobData.storyOverview,
            "FINAL VIDEO: " + uploadedFinal.url
          ].join(NL)
        });
      } catch (memoryError) {
        console.error("GAVEAI STORYBOARD MEMORY SAVE FAILED:", memoryError.message);
      }
    }
  } catch (error) {
    const errorMessage = genericVideoError(error, jobData?.userId);
    try {
      await jobRef.set({
        status: "failed",
        error: errorMessage,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await productionRef.set({
        ...(jobData || {}),
        status: "failed",
        error: errorMessage,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (saveError) {}
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    cleanupAudioFiles(cleanupFiles);
    finishVideoGenerationSlot();
    decrementVideoQueue();
  }
}

/* =========================================================
STALE JOB RECOVERY
=========================================================
If Render restarts mid-generation the job stays "generating"
forever. A live worker writes heartbeatAt every 30s, so only
truly dead jobs are closed here. NO automatic refunds.
========================================================= */
async function recoverStaleGaveAIVideoJobs() {
  try {
    const snapshot = await getVideoJobCollection().where("status", "==", "generating").get();
    const nowMillis = Date.now();
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const lastSignal = timestampToMillis(data.heartbeatAt) ||
        timestampToMillis(data.claimedAt) ||
        timestampToMillis(data.startedAt);
      if (!lastSignal || nowMillis - lastSignal < 6 * 60 * 1000) continue;
      const message = "GaveAI video generation stopped responding and was closed. Please try again.";
      await doc.ref.set({
        status: "failed",
        error: message,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await getVideoProductionCollection().doc(doc.id).set({
        status: "failed",
        error: message,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (error) {
    console.error("GAVEAI STALE JOB RECOVERY ERROR:", error?.message || error);
  }
}
setInterval(recoverStaleGaveAIVideoJobs, 60000);

/* =========================================================
AI MEMORY / CHARACTER BIBLE ROUTES
========================================================= */
app.get("/api/ai/history", requireAuthenticatedUser, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 40));
    const messages = await getConversationHistory(req.userUid, limit);
    res.json({ success: true, messages, total: messages.length });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load conversation history." });
  }
});

app.get("/api/character-bible", requireAuthenticatedUser, async (req, res) => {
  try {
    const projectId = String(req.query?.projectId || "").trim();
    if (!projectId) return res.status(400).json({ success: false, error: "projectId is required." });
    const bible = await getStoredCharacterBible(req.userUid, projectId);
    res.json({ success: true, characterBible: bible || null });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load the character bible." });
  }
});

app.post("/api/character-bible", requireAuthenticatedUser, async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || "").trim();
    if (!projectId) return res.status(400).json({ success: false, error: "projectId is required." });
    const stored = await getStoredCharacterBible(req.userUid, projectId);
    const merged = mergeCharacterBible(stored || {}, req.body || {});
    const saved = await saveCharacterBible({ userId: req.userUid, projectId, ...merged });
    res.json({ success: true, characterBible: saved });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to save the character bible." });
  }
});

/* =========================================================
ADMIN - USERS & SUBSCRIPTIONS
========================================================= */
app.get("/api/admin/users", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const [usersSnapshot, entitlementsSnapshot] = await Promise.all([
      db.collection("users").get(),
      db.collection("creditEntitlements").get()
    ]);
    const historyByUser = new Map();
    entitlementsSnapshot.docs.forEach((doc) => {
      const data = doc.data() || {};
      const uid = String(data.userId || "").trim();
      if (!uid) return;
      if (!historyByUser.has(uid)) historyByUser.set(uid, []);
      historyByUser.get(uid).push(creditEntitlementToClient(doc.id, data));
    });

    const users = await Promise.all(usersSnapshot.docs.map(async (doc) => {
      const data = doc.data() || {};
      let email = data.email || null;
      let emailVerified = data.emailVerified === true;
      try {
        const authUser = await admin.auth().getUser(doc.id);
        email = email || authUser.email || null;
        emailVerified = emailVerified || authUser.emailVerified === true;
      } catch (authError) {}
      const history = (historyByUser.get(doc.id) || [])
        .sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
      const activePlan = getUserPlan(data);
      const freeState = normalizeFreeVideoState(data);
      return {
        ...data,
        id: doc.id,
        uid: doc.id,
        email,
        emailVerified,
        isAdmin: isAdmin(doc.id),
        credits: Math.max(0, safeNumber(data.credits, 0)),
        adminTrackedCreditBaseline: Math.max(0, safeNumber(data.adminTrackedCreditBaseline, 0)),
        plan: activePlan,
        subscriptionPlan: activePlan,
        subscriptionStartedAt: timestampToISO(data.subscriptionStartedAt || data.lastPaymentDate),
        subscriptionExpiresAt: timestampToISO(data.subscriptionExpiresAt),
        activeCreditEntitlements: history.filter((item) => item.status === "active"),
        creditEntitlementHistory: history,
        freeVideoUsed: freeState.freeVideoUsed,
        freeVideoRemaining: freeState.freeVideoRemaining,
        freeVideoAvailable: freeState.freeVideoAvailable
      };
    }));

    users.sort((a, b) => String(a.fullName || a.email || "").localeCompare(String(b.fullName || b.email || "")));
    res.json({ success: true, users, total: users.length });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load users." });
  }
});

/* =========================================================
ADMIN - IDEMPOTENT ACTION REQUESTS
========================================================= */
async function readAdminActionRequest(requestId) {
  const id = String(requestId || "").trim();
  if (!id) return null;
  const snapshot = await db.collection("adminActionRequests").doc(id).get();
  return snapshot.exists ? { id, ...(snapshot.data() || {}) } : null;
}

/* =========================================================
ADMIN - GRANT CREDITS (CUSTOM DURATION)
=========================================================
Admin chooses Days / Weeks / Months. No fixed expiration.
========================================================= */
app.post("/api/admin/credit-pool/grant", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const targetUid = String(req.body?.userId || "").trim();
    const credits = Math.floor(safeNumber(req.body?.credits, 0));
    const reason = String(req.body?.reason || "").trim();
    const durationValue = Math.floor(safeNumber(req.body?.durationValue, 0));
    const durationUnit = normalizeDurationUnit(req.body?.durationUnit);
    const allowedTypes = ["BONUS_CREDIT", "CONTEST_REWARD", "REFERRAL_REWARD", "PROMOTION_REWARD", "OTHER"];
    const grantType = String(req.body?.grantType || "BONUS_CREDIT").trim().toUpperCase();
    const competitionId = String(req.body?.competitionId || "").trim();
    const requestId = String(req.body?.requestId || "").trim();

    if (!targetUid) return res.status(400).json({ success: false, error: "Please select a user." });
    if (!allowedTypes.includes(grantType)) return res.status(400).json({ success: false, error: "Invalid credit type." });
    if (credits <= 0) return res.status(400).json({ success: false, error: "Credits must be greater than zero." });
    if (!reason) return res.status(400).json({ success: false, error: "Reason or note is required." });
    if (durationValue <= 0 || !durationUnit) {
      return res.status(400).json({ success: false, error: "Select a duration value with Days, Weeks, or Months." });
    }

    const previous = await readAdminActionRequest(requestId);
    if (previous?.completed === true) {
      return res.json({ success: true, message: previous.message || "Credits were already granted.", pool: previous.pool || null });
    }

    const userRef = db.collection("users").doc(targetUid);
    const poolRef = db.collection("creditPool").doc("inventory");
    const entitlementRef = db.collection("creditEntitlements").doc();
    const ledgerRef = createCreditLedgerRef();
    const now = admin.firestore.Timestamp.now();
    const expiresAt = isAdmin(targetUid) ? null : getCustomCreditExpiration(now.toDate(), durationValue, durationUnit);

    const result = await db.runTransaction(async (transaction) => {
      const [userSnapshot, poolSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(poolRef)
      ]);
      if (!userSnapshot.exists) throw new Error("USER_NOT_FOUND");
      const userData = userSnapshot.data() || {};
      const poolData = poolSnapshot.exists ? poolSnapshot.data() || {} : {};
      const availableCredits = Math.max(0, safeNumber(poolData.availableCredits, 0));
      if (!isAdmin(targetUid) && availableCredits < credits) throw new Error("INSUFFICIENT_POOL_CREDITS");
      const newCredits = Math.max(0, safeNumber(userData.credits, 0)) + credits;
      const newAvailable = isAdmin(targetUid) ? availableCredits : availableCredits - credits;

      transaction.set(userRef, {
        uid: targetUid,
        credits: newCredits,
        ...(isAdmin(targetUid)
          ? { adminTrackedCreditBaseline: Math.max(safeNumber(userData.adminTrackedCreditBaseline, 0), newCredits) }
          : {}),
        updatedAt: now
      }, { merge: true });

      transaction.set(entitlementRef, {
        userId: targetUid,
        plan: "bonus",
        grantType,
        reason,
        creditsGranted: credits,
        creditsUsed: 0,
        creditsRemaining: credits,
        createdAt: now,
        expiresAt,
        durationValue,
        durationUnit,
        durationDays: resolveDurationDays(durationValue, durationUnit),
        status: "active",
        paymentReference: null,
        competitionId: competitionId || null,
        source: "admin_credit_grant",
        updatedAt: now
      });

      transaction.set(ledgerRef, {
        type: "GRANTED",
        userId: targetUid,
        credits,
        grantType,
        reason,
        competitionId: competitionId || null,
        source: "credit_pool",
        destination: "user_credit_entitlement",
        entitlementId: entitlementRef.id,
        createdAt: now,
        approvedBy: req.userUid
      });

      transaction.set(poolRef, {
        availableCredits: newAvailable,
        totalGrantedCredits: Math.max(0, safeNumber(poolData.totalGrantedCredits, 0)) + (isAdmin(targetUid) ? 0 : credits),
        updatedAt: now
      }, { merge: true });

      if (competitionId) {
        transaction.set(getReferralCompetitionRef(competitionId), {
          rewardAwarded: true,
          rewardEntitlementId: entitlementRef.id,
          rewardGrantedBy: req.userUid,
          rewardGrantedAt: now,
          updatedAt: now
        }, { merge: true });
      }

      return {
        availableCredits: newAvailable,
        eligibleReturnedCredits: Math.max(0, safeNumber(poolData.eligibleReturnedCredits, 0))
      };
    });

    const message = `${credits.toLocaleString()} credits granted successfully.`;
    if (requestId) {
      await db.collection("adminActionRequests").doc(requestId).set({
        completed: true, message, pool: result, action: "grant",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.json({ success: true, message, entitlementId: entitlementRef.id, pool: result });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "USER_NOT_FOUND") return res.status(404).json({ success: false, error: "User not found." });
    if (message === "INSUFFICIENT_POOL_CREDITS") {
      return res.status(409).json({ success: false, error: "The Credit Pool does not have enough available credits for this grant." });
    }
    res.status(500).json({ success: false, error: "Unable to grant credits." });
  }
});

/* =========================================================
ADMIN - ADD RETURNED CREDITS TO SELLABLE POOL
========================================================= */
app.post("/api/admin/credit-pool/add-returned", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const credits = Math.floor(safeNumber(req.body?.credits, 0));
    const reason = String(req.body?.reason || "").trim();
    const requestId = String(req.body?.requestId || "").trim();
    if (credits <= 0) return res.status(400).json({ success: false, error: "Credits must be greater than zero." });
    if (!reason) return res.status(400).json({ success: false, error: "Reason or note is required." });

    const previous = await readAdminActionRequest(requestId);
    if (previous?.completed === true) {
      return res.json({ success: true, message: previous.message || "Returned credits were already added.", pool: previous.pool || null });
    }

    const poolRef = db.collection("creditPool").doc("inventory");
    const ledgerRef = createCreditLedgerRef();
    const now = admin.firestore.Timestamp.now();

    const result = await db.runTransaction(async (transaction) => {
      const poolSnapshot = await transaction.get(poolRef);
      const poolData = poolSnapshot.exists ? poolSnapshot.data() || {} : {};
      const eligible = Math.max(0, safeNumber(poolData.eligibleReturnedCredits, 0));
      if (credits > eligible) throw new Error("INSUFFICIENT_RETURNED_CREDITS");
      const available = Math.max(0, safeNumber(poolData.availableCredits, 0)) + credits;
      transaction.set(poolRef, {
        availableCredits: available,
        eligibleReturnedCredits: eligible - credits,
        totalReturnedCredits: Math.max(0, safeNumber(poolData.totalReturnedCredits, 0)),
        updatedAt: now
      }, { merge: true });
      transaction.set(ledgerRef, {
        type: "RETURNED",
        credits,
        reason,
        source: "credit_pool_returned",
        destination: "credit_pool_available",
        createdAt: now,
        approvedBy: req.userUid
      });
      return { availableCredits: available, eligibleReturnedCredits: eligible - credits };
    });

    const message = `${credits.toLocaleString()} returned credits added to the sellable pool.`;
    if (requestId) {
      await db.collection("adminActionRequests").doc(requestId).set({
        completed: true, message, pool: result, action: "add-returned",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.json({ success: true, message, pool: result });
  } catch (error) {
    if (String(error?.message || "") === "INSUFFICIENT_RETURNED_CREDITS") {
      return res.status(409).json({ success: false, error: "Not enough returned credits are available to transfer." });
    }
    res.status(500).json({ success: false, error: "Unable to add returned credits." });
  }
});

/* =========================================================
ADMIN - RECONCILE EXPIRED CREDITS
========================================================= */
app.post("/api/admin/credit-pool/reconcile-expirations", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("creditEntitlements").get();
    const nowMillis = Date.now();
    const userIds = new Set();
    snapshot.docs.forEach((doc) => {
      const data = doc.data() || {};
      const status = String(data.status || "").toLowerCase();
      const expiresAt = timestampToMillis(data.expiresAt);
      const needsWork = status === "expired_pending_return" ||
        data.expirationReconciliationRequired === true ||
        (status === "active" && expiresAt > 0 && expiresAt <= nowMillis);
      if (needsWork && data.userId) userIds.add(String(data.userId));
    });
    let returnedCredits = 0;
    for (const uid of userIds) {
      returnedCredits += await processExpiredEntitlements(uid);
    }
    res.json({ success: true, processedUsers: userIds.size, returnedCredits });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to reconcile expired credits." });
  }
});

/* =========================================================
ADMIN - PURCHASED CREDITS & ALLOCATION
========================================================= */
app.get("/api/admin/credit-purchases", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("creditPurchases").get();
    const purchases = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      const purchased = Math.max(0, safeNumber(data.creditsPurchased, 0));
      const allocated = Math.max(0, safeNumber(data.creditsAllocated, 0));
      return {
        id: doc.id,
        provider: data.provider || "WaveSpeedAI",
        creditsPurchased: purchased,
        creditsAllocated: allocated,
        creditsRemaining: Math.max(0, purchased - allocated),
        cost: safeNumber(data.cost, 0),
        currency: data.currency || "USD",
        reference: data.reference || "",
        note: data.note || "",
        purchasedAt: timestampToISO(data.purchasedAt || data.createdAt)
      };
    }).sort((a, b) => timestampToMillis(b.purchasedAt) - timestampToMillis(a.purchasedAt));

    const summary = purchases.reduce((acc, item) => {
      acc.totalPurchased += item.creditsPurchased;
      acc.totalAllocated += item.creditsAllocated;
      acc.availableToAllocate += item.creditsRemaining;
      return acc;
    }, { totalPurchased: 0, totalAllocated: 0, availableToAllocate: 0 });

    res.json({ success: true, purchases, summary });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load purchased credits." });
  }
});

app.post("/api/admin/credit-purchases", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const creditsPurchased = Math.floor(safeNumber(req.body?.creditsPurchased, 0));
    if (creditsPurchased <= 0) {
      return res.status(400).json({ success: false, error: "Credits purchased must be a positive whole number." });
    }
    const requestId = String(req.body?.requestId || "").trim();
    const previous = await readAdminActionRequest(requestId);
    if (previous?.completed === true) {
      return res.json({ success: true, message: "This purchase was already recorded." });
    }
    const now = admin.firestore.Timestamp.now();
    const purchaseRef = db.collection("creditPurchases").doc();
    const ledgerRef = createCreditLedgerRef();
    const provider = String(req.body?.provider || "WaveSpeedAI").trim();

    await db.runTransaction(async (transaction) => {
      transaction.set(purchaseRef, {
        provider,
        creditsPurchased,
        creditsAllocated: 0,
        creditsRemaining: creditsPurchased,
        cost: Math.max(0, safeNumber(req.body?.cost, 0)),
        currency: String(req.body?.currency || "USD").trim().toUpperCase(),
        reference: String(req.body?.reference || "").trim(),
        note: String(req.body?.note || "").trim(),
        purchasedAt: now,
        createdAt: now,
        createdBy: req.userUid
      });
      transaction.set(ledgerRef, {
        type: "PURCHASED",
        credits: creditsPurchased,
        source: provider,
        destination: "credit_purchase_inventory",
        reason: "provider_credit_purchase",
        purchaseId: purchaseRef.id,
        createdAt: now,
        approvedBy: req.userUid
      });
    });

    if (requestId) {
      await db.collection("adminActionRequests").doc(requestId).set({
        completed: true, action: "credit-purchase", createdAt: now
      }, { merge: true });
    }
    res.status(201).json({ success: true, message: "Purchased credits added successfully.", purchaseId: purchaseRef.id });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to add purchased credits." });
  }
});

app.post("/api/admin/credit-purchases/:purchaseId/allocate", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const purchaseId = String(req.params.purchaseId || "").trim();
    const credits = Math.floor(safeNumber(req.body?.credits, 0));
    if (!purchaseId) return res.status(400).json({ success: false, error: "Purchase ID is required." });
    if (credits <= 0) return res.status(400).json({ success: false, error: "Credits to allocate must be greater than zero." });

    const purchaseRef = db.collection("creditPurchases").doc(purchaseId);
    const poolRef = db.collection("creditPool").doc("inventory");
    const ledgerRef = createCreditLedgerRef();
    const now = admin.firestore.Timestamp.now();

    const result = await db.runTransaction(async (transaction) => {
      const [purchaseSnapshot, poolSnapshot] = await Promise.all([
        transaction.get(purchaseRef),
        transaction.get(poolRef)
      ]);
      if (!purchaseSnapshot.exists) throw new Error("PURCHASE_NOT_FOUND");
      const purchase = purchaseSnapshot.data() || {};
      const purchased = Math.max(0, safeNumber(purchase.creditsPurchased, 0));
      const allocated = Math.max(0, safeNumber(purchase.creditsAllocated, 0));
      const remaining = Math.max(0, purchased - allocated);
      if (credits > remaining) throw new Error("INSUFFICIENT_PURCHASED_CREDITS");
      const poolData = poolSnapshot.exists ? poolSnapshot.data() || {} : {};
      const available = Math.max(0, safeNumber(poolData.availableCredits, 0)) + credits;
      transaction.update(purchaseRef, {
        creditsAllocated: allocated + credits,
        creditsRemaining: remaining - credits,
        updatedAt: now
      });
      transaction.set(poolRef, { availableCredits: available, updatedAt: now }, { merge: true });
      transaction.set(ledgerRef, {
        type: "ALLOCATED",
        credits,
        source: "credit_purchase_inventory",
        destination: "credit_pool",
        reason: "purchased_credit_allocation",
        purchaseId,
        createdAt: now,
        approvedBy: req.userUid
      });
      return { availableCredits: available, purchaseRemaining: remaining - credits };
    });

    res.json({ success: true, message: "Purchased credits allocated to the Credit Pool.", pool: result });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "PURCHASE_NOT_FOUND") return res.status(404).json({ success: false, error: "Credit purchase not found." });
    if (message === "INSUFFICIENT_PURCHASED_CREDITS") {
      return res.status(409).json({ success: false, error: "This purchase does not have that many credits left to allocate." });
    }
    res.status(500).json({ success: false, error: "Unable to allocate purchased credits." });
  }
});

/* =========================================================
ADMIN - CREDIT TRANSACTION LEDGER (BY MONTH)
========================================================= */
app.get("/api/admin/credit-ledger", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const month = String(req.query?.month || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: "A valid month (YYYY-MM) is required." });
    }
    const [year, monthIndex] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year, monthIndex - 1, 1));
    const end = new Date(Date.UTC(year, monthIndex, 1));
    const snapshot = await db.collection("creditPoolTransactions")
      .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(start))
      .where("createdAt", "<", admin.firestore.Timestamp.fromDate(end))
      .get();

    const transactions = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        type: String(data.type || "").toUpperCase(),
        credits: Math.max(0, safeNumber(data.credits, 0)),
        userId: data.userId || "",
        paymentId: data.paymentId || "",
        plan: data.plan || "",
        grantType: data.grantType || "",
        source: data.source || "",
        destination: data.destination || "",
        reason: data.reason || "",
        feature: data.feature || "",
        entitlementId: data.entitlementId || "",
        createdAt: timestampToISO(data.createdAt)
      };
    }).sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));

    const summary = {
      granted: 0, used: 0, returned: 0, resold: 0, reserved: 0, released: 0,
      allocated: 0, referralReward: 0, promotionReward: 0, purchased: 0,
      transactionCount: transactions.length, totalCredits: 0
    };
    transactions.forEach((tx) => {
      summary.totalCredits += tx.credits;
      if (tx.type === "GRANTED") summary.granted += tx.credits;
      else if (tx.type === "USED") summary.used += tx.credits;
      else if (tx.type === "RETURNED") summary.returned += tx.credits;
      else if (tx.type === "RESOLD") summary.resold += tx.credits;
      else if (tx.type === "RESERVED") summary.reserved += tx.credits;
      else if (tx.type === "RELEASED") summary.released += tx.credits;
      else if (tx.type === "ALLOCATED") summary.allocated += tx.credits;
      else if (tx.type === "REFERRAL_REWARD") summary.referralReward += tx.credits;
      else if (tx.type === "PROMOTION_REWARD") summary.promotionReward += tx.credits;
      else if (tx.type === "PURCHASED") summary.purchased += tx.credits;
    });

    res.json({ success: true, month, transactions, summary });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to load the credit ledger." });
  }
});

/* =========================================================
ADMIN - BATCH RESTORE PAYMENTS
========================================================= */
app.post("/api/admin/payment-requests/batch-restore", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const paymentIds = Array.isArray(req.body?.paymentIds)
      ? req.body.paymentIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (!paymentIds.length) {
      return res.status(400).json({ success: false, error: "Select at least one payment to restore." });
    }
    const now = admin.firestore.Timestamp.now();
    const batch = db.batch();
    let restored = 0;
    for (const paymentId of paymentIds.slice(0, 200)) {
      const paymentRef = db.collection("paymentRequests").doc(paymentId);
      const snapshot = await paymentRef.get();
      if (!snapshot.exists) continue;
      const payment = snapshot.data() || {};
      const restoredStatus = ["pending", "approved", "rejected"].includes(payment.previousStatus)
        ? payment.previousStatus
        : "pending";
      batch.update(paymentRef, {
        status: normalizePaymentStatus(payment.status) === "trash"
          ? restoredStatus
          : normalizePaymentStatus(payment.status),
        deleted: false,
        deletedAt: admin.firestore.FieldValue.delete(),
        deletedBy: admin.firestore.FieldValue.delete(),
        previousStatus: admin.firestore.FieldValue.delete(),
        restoredAt: now,
        restoredBy: req.userUid,
        updatedAt: now
      });
      restored += 1;
    }
    await batch.commit();
    res.json({ success: true, restored, message: `${restored} payment(s) restored successfully.` });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to restore the selected payments." });
  }
});

/* =========================================================
ADMIN - REVENUE CALENDAR TRASH / RESTORE
========================================================= */
async function updateRevenueTransactionVisibility(req, res, deleted) {
  const paymentId = String(req.params.paymentId || "").trim();
  if (!paymentId) return res.status(400).json({ success: false, error: "Transaction ID is required." });
  const paymentRef = db.collection("paymentRequests").doc(paymentId);
  const snapshot = await paymentRef.get();
  if (!snapshot.exists) return res.status(404).json({ success: false, error: "Transaction not found." });
  const now = admin.firestore.Timestamp.now();
  await paymentRef.update({
    revenueCalendarDeleted: deleted,
    revenueCalendarUpdatedAt: now,
    revenueCalendarUpdatedBy: req.userUid,
    updatedAt: now
  });
  return res.json({
    success: true,
    message: deleted
      ? "Transaction moved to Revenue Calendar Trash."
      : "Transaction restored to the Revenue Calendar."
  });
}

app.post("/api/admin/revenue-transactions/:paymentId/trash", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    await updateRevenueTransactionVisibility(req, res, true);
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to move the transaction to trash." });
  }
});

app.post("/api/admin/revenue-transactions/:paymentId/restore", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    await updateRevenueTransactionVisibility(req, res, false);
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to restore the transaction." });
  }
});

/* =========================================================
ADMIN - DELETE REFERRAL COMPETITION
========================================================= */
app.delete("/api/admin/referral-competitions/:competitionId", requireAuthenticatedUser, requireAdmin, async (req, res) => {
  try {
    const competitionId = String(req.params.competitionId || "").trim();
    if (!competitionId) return res.status(400).json({ success: false, error: "Competition ID is required." });
    const competitionRef = getReferralCompetitionRef(competitionId);
    const snapshot = await competitionRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Referral competition was not found." });
    const data = snapshot.data() || {};
    const status = normalizeCompetitionStatus(data.status) || "DRAFT";
    const deletable = ["CLOSED", "ARCHIVED"].includes(status) || !!String(data.winnerUid || "").trim();
    if (!deletable) {
      return res.status(400).json({ success: false, error: "Only a closed, archived, or completed contest can be deleted." });
    }
    await competitionRef.delete();
    res.json({ success: true, message: "Referral contest deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Unable to delete the referral contest." });
  }
});

/* =========================================================
CAREER HUB - DELETE IMAGE (OWNERSHIP VERIFIED)
========================================================= */
app.post("/delete-image", requireAuthenticatedUser, async (req, res) => {
  try {
    const userId = req.userUid;
    const requestedFileId = String(req.body?.fileId || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!requestedFileId && !imageUrl) {
      return res.status(400).json({ success: false, error: "fileId or imageUrl is required." });
    }

    let authorized = isAdmin(userId);

    if (!authorized) {
      const userSnapshot = await db.collection("users").doc(userId).get();
      const userData = userSnapshot.exists ? userSnapshot.data() || {} : {};
      const ownedFileIds = [
        userData.profilePhotoFileId,
        userData.resumeFileId,
        userData.coverLetterFileId,
        ...(Array.isArray(userData.certificates) ? userData.certificates.map((c) => c?.fileId) : [])
      ].filter(Boolean).map(String);
      const ownedUrls = [
        userData.profilePhoto,
        userData.profilePhotoUrl,
        userData.companyLogo,
        userData.resumeUrl,
        userData.resumeURL,
        userData.coverLetterUrl,
        userData.coverLetterURL,
        ...(Array.isArray(userData.certificates) ? userData.certificates.map((c) => c?.url) : [])
      ].filter(Boolean).map(String);
      if ((requestedFileId && ownedFileIds.includes(requestedFileId)) ||
          (imageUrl && ownedUrls.includes(imageUrl))) {
        authorized = true;
      }
    }

    if (!authorized && imageUrl) {
      const postsSnapshot = await db.collection("posts").where("authorUid", "==", userId).get();
      authorized = postsSnapshot.docs.some((doc) => {
        const data = doc.data() || {};
        return String(data.mediaUrl || data.imageUrl || "") === imageUrl;
      });
    }

    if (!authorized && imageUrl) {
      const commentsSnapshot = await db.collectionGroup("comments").where("uid", "==", userId).limit(500).get();
      authorized = commentsSnapshot.docs.some((doc) => String(doc.data()?.imageUrl || "") === imageUrl);
    }

    if (!authorized) {
      return res.status(403).json({ success: false, error: "You do not have permission to delete this image." });
    }

    let fileId = requestedFileId;
    if (!fileId && imageUrl) {
      const found = await imagekit.listFiles({ searchQuery: `url = "${imageUrl}"`, limit: 1 });
      fileId = Array.isArray(found) && found[0]?.fileId ? found[0].fileId : "";
    }
    if (!fileId) return res.status(404).json({ success: false, error: "Image file was not found in ImageKit." });

    await imagekit.deleteFile(fileId);
    res.json({ success: true, message: "Image deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Image deletion failed." });
  }
});

/* =========================================================
CAREER HUB - EDIT / DELETE OWN DIRECT MESSAGE
========================================================= */
async function loadOwnedConversationMessage(req) {
  const conversationId = String(req.params.conversationId || "").trim();
  const messageId = String(req.params.messageId || "").trim();
  if (!conversationId || !messageId) throw new Error("MESSAGE_ID_REQUIRED");
  const conversationRef = db.collection("conversations").doc(conversationId);
  const messageRef = conversationRef.collection("messages").doc(messageId);
  const [conversationSnapshot, messageSnapshot] = await Promise.all([
    conversationRef.get(),
    messageRef.get()
  ]);
  if (!conversationSnapshot.exists) throw new Error("CONVERSATION_NOT_FOUND");
  if (!messageSnapshot.exists) throw new Error("MESSAGE_NOT_FOUND");
  const participants = Array.isArray(conversationSnapshot.data()?.participants)
    ? conversationSnapshot.data().participants
    : [];
  if (!participants.includes(req.userUid) && !isAdmin(req.userUid)) throw new Error("MESSAGE_ACCESS_DENIED");
  const message = messageSnapshot.data() || {};
  const senderId = String(message.senderId || message.senderUid || "");
  if (senderId !== req.userUid) throw new Error("MESSAGE_ACCESS_DENIED");
  return { conversationRef, messageRef, message };
}

app.patch("/api/conversations/:conversationId/messages/:messageId", requireAuthenticatedUser, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, error: "Message text is required." });
    const { conversationRef, messageRef, message } = await loadOwnedConversationMessage(req);
    if (message.deleted === true) {
      return res.status(400).json({ success: false, error: "A deleted message cannot be edited." });
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    await messageRef.update({ text, edited: true, editedAt: now });
    await conversationRef.set({ lastMessage: text, updatedAt: now }, { merge: true });
    res.json({ success: true, message: "Message updated successfully." });
  } catch (error) {
    const code = String(error?.message || "");
    if (code === "CONVERSATION_NOT_FOUND" || code === "MESSAGE_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Message not found." });
    }
    if (code === "MESSAGE_ACCESS_DENIED") {
      return res.status(403).json({ success: false, error: "You can only edit your own messages." });
    }
    res.status(500).json({ success: false, error: "Unable to edit the message." });
  }
});

app.delete("/api/conversations/:conversationId/messages/:messageId", requireAuthenticatedUser, async (req, res) => {
  try {
    const { messageRef } = await loadOwnedConversationMessage(req);
    await messageRef.update({
      deleted: true,
      text: "",
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: "Message deleted successfully." });
  } catch (error) {
    const code = String(error?.message || "");
    if (code === "CONVERSATION_NOT_FOUND" || code === "MESSAGE_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Message not found." });
    }
    if (code === "MESSAGE_ACCESS_DENIED") {
      return res.status(403).json({ success: false, error: "You can only delete your own messages." });
    }
    res.status(500).json({ success: false, error: "Unable to delete the message." });
  }
});

/* =========================================================
404 & GLOBAL ERROR HANDLER
========================================================= */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "404 Not Found",
    path: req.originalUrl,
    method: req.method,
    message: "The requested route does not exist."
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.message === "CORS origin not allowed.") {
    return res.status(403).json({ success: false, error: "Request origin is not allowed." });
  }
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ success: false, error: "File is too large. Maximum size is 50 MB." });
  }
  res.status(500).json({ success: false, error: "Gave Money Tips AI backend encountered an error." });
});

/* =========================================================
START SERVER
========================================================= */
app.listen(PORT, () => {
  console.log(`Gave Money Tips AI running on port ${PORT}`);
});
