require("dotenv").config();

const crypto = require("crypto");

const {
  db
} = require("../firebaseAdmin");

/*
========================================================
GAVEAI — VIDEO GENERATION QUEUE SERVICE
========================================================

ARCHITECTURE

Render
  ↓
Firestore
  ↓
videoJobs
  ↓
Queue / Worker
  ↓
Maximum concurrent generations
  ↓
Video Provider
  ↓
Voice / FFmpeg
  ↓
ImageKit
  ↓
Firestore

IMPORTANT

Firestore is the persistent source of truth.

The queue must NOT depend on a JavaScript array
stored only in Render RAM.

========================================================
FEATURES
========================================================

✓ Maximum concurrent videos
✓ Persistent Firestore queue
✓ Maximum queue size
✓ Duplicate active-job protection
✓ Per-user rate limiting
✓ Admin priority
✓ Job claiming
✓ Lease protection
✓ Retry
✓ Timeout recovery
✓ Queue position
✓ Estimated wait
✓ Completed / failed states
✓ Safe JSON-compatible job data
========================================================
*/


/*
========================================================
CONFIGURATION
========================================================
*/

const MAX_CONCURRENT_VIDEOS =
  Number(
    process.env.MAX_CONCURRENT_VIDEOS
  ) || 2;

const MAX_VIDEO_QUEUE =
  Number(
    process.env.MAX_VIDEO_QUEUE
  ) || 10;

const MAX_VIDEO_REQUESTS_PER_WINDOW =
  Number(
    process.env.MAX_VIDEO_REQUESTS_PER_WINDOW
  ) || 3;

const VIDEO_RATE_LIMIT_WINDOW_MS =
  Number(
    process.env.VIDEO_RATE_LIMIT_WINDOW_MS
  ) || 10 * 60 * 1000;

const VIDEO_JOB_TIMEOUT_MS =
  Number(
    process.env.VIDEO_JOB_TIMEOUT_MS
  ) || 20 * 60 * 1000;

const MAX_VIDEO_RETRIES =
  Number(
    process.env.MAX_VIDEO_RETRIES
  ) || 2;

/*
========================================================
LEASE CONFIGURATION
========================================================

A worker that claims a job receives a lease.

This helps prevent another worker from processing
the same Firestore job simultaneously.

========================================================
*/

const VIDEO_JOB_LEASE_MS =
  Number(
    process.env.VIDEO_JOB_LEASE_MS
  ) || 30 * 60 * 1000;


/*
========================================================
COLLECTION
========================================================
*/

const VIDEO_JOBS_COLLECTION =
  "videoJobs";


/*
========================================================
STATUS
========================================================
*/

const VIDEO_STATUS = {
  QUEUED:
    "queued",

  GENERATING:
    "generating",

  COMPLETED:
    "completed",

  FAILED:
    "failed",

  CANCELLED:
    "cancelled"
};


/*
========================================================
PRIORITY
========================================================
*/

const VIDEO_PRIORITY = {
  ADMIN:
    100,

  USER:
    10
};


/*
========================================================
HELPERS
========================================================
*/

function cleanString(value) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  return value.trim();
}


function createJobId() {
  return (
    `video_${Date.now()}_` +
    crypto
      .randomBytes(8)
      .toString("hex")
  );
}


function now() {
  return new Date();
}


function getJobRef(
  jobId
) {
  return db
    .collection(
      VIDEO_JOBS_COLLECTION
    )
    .doc(jobId);
}


function getTimestampMillis(
  value
) {
  if (
    value?.toMillis
  ) {
    return value.toMillis();
  }

  if (
    value instanceof Date
  ) {
    return value.getTime();
  }

  if (
    typeof value ===
    "string"
  ) {
    const parsed =
      new Date(value)
        .getTime();

    return Number.isFinite(
      parsed
    )
      ? parsed
      : 0;
  }

  if (
    typeof value ===
      "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  return 0;
}


/*
========================================================
ADMIN
========================================================
*/

function isAdminUser(
  userId
) {
  const adminUserId =
    cleanString(
      process.env.ADMIN_USER_ID
    );

  const currentUserId =
    cleanString(userId);

  if (
    !adminUserId ||
    !currentUserId
  ) {
    return false;
  }

  return (
    adminUserId ===
    currentUserId
  );
}


/*
========================================================
GET USER ACTIVE JOB
========================================================

Active:

queued
generating

Completed / failed jobs are ignored.

========================================================
*/

async function getUserActiveVideoJob(
  userId
) {
  const normalizedUserId =
    cleanString(userId);

  if (
    !normalizedUserId
  ) {
    return null;
  }

  const snapshot =
    await db
      .collection(
        VIDEO_JOBS_COLLECTION
      )
      .where(
        "userId",
        "==",
        normalizedUserId
      )
      .get();

  if (
    snapshot.empty
  ) {
    return null;
  }

  const activeStatuses = [
    VIDEO_STATUS.QUEUED,
    VIDEO_STATUS.GENERATING
  ];

  const jobs =
    snapshot.docs
      .map(
        (doc) => ({
          id:
            doc.id,

          ...doc.data()
        })
      )
      .filter(
        (job) =>
          activeStatuses.includes(
            job.status
          )
      )
      .sort(
        (a, b) =>
          getTimestampMillis(
            a.createdAt
          ) -
          getTimestampMillis(
            b.createdAt
          )
      );

  return (
    jobs[0] ||
    null
  );
}


/*
========================================================
RATE LIMIT
========================================================

Default:

3 video requests
per 10 minutes

========================================================
*/

async function checkVideoRateLimit(
  userId
) {
  const normalizedUserId =
    cleanString(userId);

  if (
    !normalizedUserId
  ) {
    return {
      allowed:
        false,

      reason:
        "User authentication is required."
    };
  }

  const cutoff =
    Date.now() -
    VIDEO_RATE_LIMIT_WINDOW_MS;

  const snapshot =
    await db
      .collection(
        VIDEO_JOBS_COLLECTION
      )
      .where(
        "userId",
        "==",
        normalizedUserId
      )
      .get();

  let recentRequests =
    0;

  let newestRequest =
    0;

  snapshot.forEach(
    (doc) => {
      const data =
        doc.data();

      const timestamp =
        getTimestampMillis(
          data.createdAt
        );

      if (
        timestamp >=
        cutoff
      ) {
        recentRequests++;

        if (
          timestamp >
          newestRequest
        ) {
          newestRequest =
            timestamp;
        }
      }
    }
  );

  if (
    recentRequests >=
    MAX_VIDEO_REQUESTS_PER_WINDOW
  ) {
    const retryAfterSeconds =
      newestRequest
        ? Math.max(
            1,
            Math.ceil(
              (
                newestRequest +
                VIDEO_RATE_LIMIT_WINDOW_MS -
                Date.now()
              ) / 1000
            )
          )
        : Math.ceil(
            VIDEO_RATE_LIMIT_WINDOW_MS /
              1000
          );

    return {
      allowed:
        false,

      reason:
        "Video request rate limit exceeded.",

      recentRequests,

      limit:
        MAX_VIDEO_REQUESTS_PER_WINDOW,

      retryAfterSeconds
    };
  }

  return {
    allowed:
      true,

    recentRequests,

    remaining:
      Math.max(
        0,
        MAX_VIDEO_REQUESTS_PER_WINDOW -
          recentRequests
      )
  };
}


/*
========================================================
COUNT GENERATING JOBS
========================================================
*/

async function countGeneratingVideos() {
  const snapshot =
    await db
      .collection(
        VIDEO_JOBS_COLLECTION
      )
      .where(
        "status",
        "==",
        VIDEO_STATUS.GENERATING
      )
      .get();

  return snapshot.size;
}


/*
========================================================
COUNT QUEUED JOBS
========================================================
*/

async function countQueuedVideos() {
  const snapshot =
    await db
      .collection(
        VIDEO_JOBS_COLLECTION
      )
      .where(
        "status",
        "==",
        VIDEO_STATUS.QUEUED
      )
      .get();

  return snapshot.size;
}


/*
========================================================
GET QUEUED JOBS
========================================================

One helper used internally to keep ordering
consistent.

========================================================
*/

async function getQueuedJobs() {
  const snapshot =
    await db
      .collection(
        VIDEO_JOBS_COLLECTION
      )
      .where(
        "status",
        "==",
        VIDEO_STATUS.QUEUED
      )
      .get();

  return snapshot.docs
    .map(
      (doc) => ({
        id:
          doc.id,

        ref:
          doc.ref,

        ...doc.data()
      })
    )
    .sort(
      (a, b) => {
        const priorityDifference =
          (
            Number(
              b.priority
            ) || 0
          ) -
          (
            Number(
              a.priority
            ) || 0
          );

        if (
          priorityDifference !==
          0
        ) {
          return priorityDifference;
        }

        return (
          getTimestampMillis(
            a.createdAt
          ) -
          getTimestampMillis(
            b.createdAt
          )
        );
      }
    );
}


/*
========================================================
QUEUE POSITION
========================================================

Priority first.

Older jobs first when priority is equal.

========================================================
*/

async function getQueuePosition(
  jobId
) {
  const normalizedJobId =
    cleanString(jobId);

  if (
    !normalizedJobId
  ) {
    return null;
  }

  const jobSnapshot =
    await getJobRef(
      normalizedJobId
    ).get();

  if (
    !jobSnapshot.exists
  ) {
    return null;
  }

  const job =
    jobSnapshot.data();

  if (
    job.status !==
    VIDEO_STATUS.QUEUED
  ) {
    return 0;
  }

  const priority =
    Number(
      job.priority
    ) ||
    VIDEO_PRIORITY.USER;

  const createdAt =
    getTimestampMillis(
      job.createdAt
    );

  const queuedJobs =
    await getQueuedJobs();

  let position =
    1;

  for (
    const other of queuedJobs
  ) {
    if (
      other.id ===
      normalizedJobId
    ) {
      continue;
    }

    const otherPriority =
      Number(
        other.priority
      ) ||
      VIDEO_PRIORITY.USER;

    const otherCreatedAt =
      getTimestampMillis(
        other.createdAt
      );

    if (
      otherPriority >
        priority ||
      (
        otherPriority ===
          priority &&
        otherCreatedAt <
          createdAt
      )
    ) {
      position++;
    }
  }

  return position;
}


/*
========================================================
ESTIMATED WAIT
========================================================
*/

function calculateEstimatedWait(
  position
) {
  if (
    !position ||
    position <= 0
  ) {
    return 0;
  }

  const averageMinutesPerBatch =
    Number(
      process.env.VIDEO_ESTIMATED_MINUTES
    ) || 4;

  const batch =
    Math.ceil(
      position /
        MAX_CONCURRENT_VIDEOS
    );

  return (
    batch *
    averageMinutesPerBatch
  );
}


/*
========================================================
CREATE VIDEO JOB
========================================================

This function:

1. Checks duplicate active job
2. Checks rate limit
3. Checks current capacity
4. Creates generating job if slot exists
5. Otherwise creates queued job
6. Rejects if queue is full

========================================================
*/

async function createVideoJob({
  userId,
  prompt,
  options = {}
}) {
  const normalizedUserId =
    cleanString(userId);

  const normalizedPrompt =
    cleanString(prompt);

  if (
    !normalizedUserId
  ) {
    throw new Error(
      "User authentication is required for video generation."
    );
  }

  if (
    !normalizedPrompt
  ) {
    throw new Error(
      "Video prompt is required."
    );
  }

  /*
  ======================================================
  DUPLICATE PROTECTION
  ======================================================
  */

  const existingJob =
    await getUserActiveVideoJob(
      normalizedUserId
    );

  if (
    existingJob
  ) {
    const position =
      await getQueuePosition(
        existingJob.id
      );

    return {
      success:
        true,

      duplicate:
        true,

      status:
        existingJob.status,

      jobId:
        existingJob.id,

      position,

      estimatedWaitMinutes:
        calculateEstimatedWait(
          position
        ),

      message:
        existingJob.status ===
        VIDEO_STATUS.GENERATING
          ? "Your video is already being generated."
          : "Your video is already in the generation queue.",

      shouldStartGeneration:
        false
    };
  }

  /*
  ======================================================
  RATE LIMIT
  ======================================================
  */

  const rateLimit =
    await checkVideoRateLimit(
      normalizedUserId
    );

  if (
    !rateLimit.allowed
  ) {
    return {
      success:
        false,

      status:
        "rate_limited",

      error:
        "VIDEO_RATE_LIMIT",

      message:
        rateLimit.reason,

      retryAfterSeconds:
        rateLimit.retryAfterSeconds ||
        600
    };
  }

  /*
  ======================================================
  CURRENT LOAD
  ======================================================
  */

  const [
    generatingCount,
    queuedCount
  ] =
    await Promise.all([
      countGeneratingVideos(),
      countQueuedVideos()
    ]);

  const admin =
    isAdminUser(
      normalizedUserId
    );

  /*
  ======================================================
  DIRECT GENERATION
  ======================================================
  */

  if (
    generatingCount <
    MAX_CONCURRENT_VIDEOS
  ) {
    const jobId =
      createJobId();

    const timestamp =
      now();

    const jobData = {
      jobId,

      userId:
        normalizedUserId,

      prompt:
        normalizedPrompt,

      options,

      status:
        VIDEO_STATUS.GENERATING,

      priority:
        admin
          ? VIDEO_PRIORITY.ADMIN
          : VIDEO_PRIORITY.USER,

      isAdmin:
        admin,

      createdAt:
        timestamp,

      startedAt:
        timestamp,

      updatedAt:
        timestamp,

      completedAt:
        null,

      failedAt:
        null,

      videoUrl:
        null,

      provider:
        null,

      model:
        null,

      predictionId:
        null,

      duration:
        null,

      resolution:
        null,

      aspectRatio:
        null,

      voiceAdded:
        false,

      voiceText:
        "",

      voiceLanguage:
        "",

      retryCount:
        0,

      maxRetries:
        MAX_VIDEO_RETRIES,

      error:
        null,

      workerId:
        null,

      leaseExpiresAt:
        null
    };

    await getJobRef(
      jobId
    ).set(
      jobData
    );

    return {
      success:
        true,

      status:
        VIDEO_STATUS.GENERATING,

      jobId,

      position:
        0,

      estimatedWaitMinutes:
        0,

      message:
        "Your video is being generated.",

      shouldStartGeneration:
        true
    };
  }

  /*
  ======================================================
  QUEUE FULL
  ======================================================
  */

  if (
    queuedCount >=
    MAX_VIDEO_QUEUE
  ) {
    return {
      success:
        false,

      status:
        "queue_full",

      error:
        "VIDEO_QUEUE_FULL",

      message:
        "Too many users are generating videos right now. Please try again later.",

      retryAfterSeconds:
        300,

      queueLimit:
        MAX_VIDEO_QUEUE,

      generating:
        generatingCount,

      queued:
        queuedCount
    };
  }

  /*
  ======================================================
  CREATE QUEUED JOB
  ======================================================
  */

  const jobId =
    createJobId();

  const timestamp =
    now();

  const jobData = {
    jobId,

    userId:
      normalizedUserId,

    prompt:
      normalizedPrompt,

    options,

    status:
      VIDEO_STATUS.QUEUED,

    priority:
      admin
        ? VIDEO_PRIORITY.ADMIN
        : VIDEO_PRIORITY.USER,

    isAdmin:
      admin,

    createdAt:
      timestamp,

    startedAt:
      null,

    updatedAt:
      timestamp,

    completedAt:
      null,

    failedAt:
      null,

    videoUrl:
      null,

    provider:
      null,

    model:
      null,

    predictionId:
      null,

    duration:
      null,

    resolution:
      null,

    aspectRatio:
      null,

    voiceAdded:
      false,

    voiceText:
      "",

    voiceLanguage:
      "",

    retryCount:
      0,

    maxRetries:
      MAX_VIDEO_RETRIES,

    error:
      null,

    workerId:
      null,

    leaseExpiresAt:
      null
  };

  await getJobRef(
    jobId
  ).set(
    jobData
  );

  const position =
    await getQueuePosition(
      jobId
    );

  return {
    success:
      true,

    status:
      VIDEO_STATUS.QUEUED,

    jobId,

    position,

    estimatedWaitMinutes:
      calculateEstimatedWait(
        position
      ),

    message:
      "Your video has been added to the generation queue.",

    shouldStartGeneration:
      false
  };
}


/*
========================================================
WORKER ID
========================================================
*/

function createWorkerId() {
  return (
    `worker_${Date.now()}_` +
    crypto
      .randomBytes(6)
      .toString("hex")
  );
}


/*
========================================================
CLAIM NEXT QUEUED JOB
========================================================

IMPORTANT:

This function uses a Firestore transaction.

The job is only claimed if it is still queued.

A worker gets:

workerId
leaseExpiresAt

This protects against duplicate processing.

========================================================
*/

async function claimNextQueuedJob() {
  const queuedJobs =
    await getQueuedJobs();

  if (
    queuedJobs.length ===
    0
  ) {
    return null;
  }

  const workerId =
    createWorkerId();

  const candidate =
    queuedJobs[0];

  if (!candidate) {
    return null;
  }

  const claimedAt =
    now();

  const leaseExpiresAt =
    new Date(
      Date.now() +
        VIDEO_JOB_LEASE_MS
    );

  let claimedJob =
    null;

  await db.runTransaction(
    async (
      transaction
    ) => {
      const freshSnapshot =
        await transaction.get(
          candidate.ref
        );

      if (
        !freshSnapshot.exists
      ) {
        return;
      }

      const freshData =
        freshSnapshot.data();

      if (
        freshData.status !==
        VIDEO_STATUS.QUEUED
      ) {
        return;
      }

      /*
      ----------------------------------------------
      Re-check generating count.

      This protects against stale queue information.
      ----------------------------------------------
      */

      const generatingSnapshot =
        await db
          .collection(
            VIDEO_JOBS_COLLECTION
          )
          .where(
            "status",
            "==",
            VIDEO_STATUS.GENERATING
          )
          .get();

      if (
        generatingSnapshot.size >=
        MAX_CONCURRENT_VIDEOS
      ) {
        return;
      }

      transaction.update(
        candidate.ref,
        {
          status:
            VIDEO_STATUS.GENERATING,

          startedAt:
            claimedAt,

          updatedAt:
            claimedAt,

          workerId,

          leaseExpiresAt
        }
      );

      claimedJob = {
        id:
          candidate.id,

        ...freshData,

        status:
          VIDEO_STATUS.GENERATING,

        startedAt:
          claimedAt,

        updatedAt:
          claimedAt,

        workerId,

        leaseExpiresAt
      };
    }
  );

  return claimedJob;
}


/*
========================================================
MARK JOB GENERATING
========================================================
*/

async function markJobGenerating(
  jobId,
  workerId = null
) {
  const ref =
    getJobRef(
      jobId
    );

  const updates = {
    status:
      VIDEO_STATUS.GENERATING,

    startedAt:
      now(),

    updatedAt:
      now()
  };

  if (
    workerId
  ) {
    updates.workerId =
      workerId;
  }

  updates.leaseExpiresAt =
    new Date(
      Date.now() +
        VIDEO_JOB_LEASE_MS
    );

  await ref.update(
    updates
  );

  return true;
}


/*
========================================================
RENEW JOB LEASE
========================================================

Useful if video generation takes longer than the
initial lease duration.

========================================================
*/

async function renewVideoJobLease(
  jobId,
  workerId
) {
  const normalizedJobId =
    cleanString(jobId);

  const normalizedWorkerId =
    cleanString(workerId);

  if (
    !normalizedJobId ||
    !normalizedWorkerId
  ) {
    return false;
  }

  const ref =
    getJobRef(
      normalizedJobId
    );

  const snapshot =
    await ref.get();

  if (
    !snapshot.exists
  ) {
    return false;
  }

  const job =
    snapshot.data();

  if (
    job.status !==
    VIDEO_STATUS.GENERATING
  ) {
    return false;
  }

  if (
    job.workerId !==
    normalizedWorkerId
  ) {
    return false;
  }

  await ref.update({
    leaseExpiresAt:
      new Date(
        Date.now() +
          VIDEO_JOB_LEASE_MS
      ),

    updatedAt:
      now()
  });

  return true;
}


/*
========================================================
COMPLETE JOB
========================================================
*/

async function markJobCompleted(
  jobId,
  result = {}
) {
  const ref =
    getJobRef(
      jobId
    );

  await ref.update({
    status:
      VIDEO_STATUS.COMPLETED,

    videoUrl:
      result.videoUrl ||
      result.url ||
      null,

    provider:
      result.provider ||
      null,

    model:
      result.model ||
      null,

    predictionId:
      result.predictionId ||
      null,

    duration:
      result.duration ||
      null,

    resolution:
      result.resolution ||
      null,

    aspectRatio:
      result.aspectRatio ||
      null,

    voiceAdded:
      Boolean(
        result.voiceAdded
      ),

    voiceText:
      result.voiceText ||
      "",

    voiceLanguage:
      result.voiceLanguage ||
      result.language ||
      "",

    completedAt:
      now(),

    updatedAt:
      now(),

    leaseExpiresAt:
      null,

    workerId:
      null,

    error:
      null
  });

  return true;
}


/*
========================================================
FAIL JOB
========================================================
*/

async function markJobFailed(
  jobId,
  error
) {
  const ref =
    getJobRef(
      jobId
    );

  const message =
    error?.message ||
    String(error) ||
    "Video generation failed.";

  await ref.update({
    status:
      VIDEO_STATUS.FAILED,

    error:
      message,

    failedAt:
      now(),

    updatedAt:
      now(),

    leaseExpiresAt:
      null,

    workerId:
      null
  });

  return true;
}


/*
========================================================
RETRY VIDEO JOB
========================================================

Failed generation can return to queue.

========================================================
*/

async function retryVideoJob(
  jobId,
  error
) {
  const ref =
    getJobRef(
      jobId
    );

  const snapshot =
    await ref.get();

  if (
    !snapshot.exists
  ) {
    throw new Error(
      "Video job not found."
    );
  }

  const job =
    snapshot.data();

  const retryCount =
    Number(
      job.retryCount
    ) || 0;

  const maxRetries =
    Number(
      job.maxRetries
    ) || MAX_VIDEO_RETRIES;

  if (
    retryCount >=
    maxRetries
  ) {
    await markJobFailed(
      jobId,
      error
    );

    return {
      retried:
        false,

      permanentlyFailed:
        true,

      retryCount
    };
  }

  await ref.update({
    status:
      VIDEO_STATUS.QUEUED,

    retryCount:
      retryCount + 1,

    startedAt:
      null,

    updatedAt:
      now(),

    workerId:
      null,

    leaseExpiresAt:
      null,

    error:
      error?.message ||
      String(error) ||
      "Video generation failed. Retrying."
  });

  return {
    retried:
      true,

    permanentlyFailed:
      false,

    retryCount:
      retryCount + 1
  };
}


/*
========================================================
GET VIDEO JOB
========================================================
*/

async function getVideoJob(
  jobId
) {
  const normalizedJobId =
    cleanString(jobId);

  if (
    !normalizedJobId
  ) {
    return null;
  }

  const snapshot =
    await getJobRef(
      normalizedJobId
    ).get();

  if (
    !snapshot.exists
  ) {
    return null;
  }

  const job = {
    jobId:
      snapshot.id,

    ...snapshot.data()
  };

  if (
    job.status ===
    VIDEO_STATUS.QUEUED
  ) {
    job.position =
      await getQueuePosition(
        job.jobId
      );

    job.estimatedWaitMinutes =
      calculateEstimatedWait(
        job.position
      );
  } else {
    job.position =
      0;

    job.estimatedWaitMinutes =
      0;
  }

  return job;
}


/*
========================================================
RECOVER STALE VIDEO JOBS
========================================================

If Render crashes, a job can remain generating.

We detect:

1. timeout
2. expired lease

and return the job to the queue when retries remain.

========================================================
*/

async function recoverStaleVideoJobs() {
  const cutoff =
    Date.now() -
    VIDEO_JOB_TIMEOUT_MS;

  const snapshot =
    await db
      .collection(
        VIDEO_JOBS_COLLECTION
      )
      .where(
        "status",
        "==",
        VIDEO_STATUS.GENERATING
      )
      .get();

  let recovered =
    0;

  let permanentlyFailed =
    0;

  for (
    const doc of snapshot.docs
  ) {
    const job =
      doc.data();

    const startedTimestamp =
      getTimestampMillis(
        job.startedAt
      );

    const leaseTimestamp =
      getTimestampMillis(
        job.leaseExpiresAt
      );

    const isTimedOut =
      startedTimestamp &&
      startedTimestamp <
        cutoff;

    const isLeaseExpired =
      leaseTimestamp &&
      leaseTimestamp <
        Date.now();

    if (
      !isTimedOut &&
      !isLeaseExpired
    ) {
      continue;
    }

    const retryCount =
      Number(
        job.retryCount
      ) || 0;

    const maxRetries =
      Number(
        job.maxRetries
      ) || MAX_VIDEO_RETRIES;

    if (
      retryCount <
      maxRetries
    ) {
      await doc.ref.update({
        status:
          VIDEO_STATUS.QUEUED,

        retryCount:
          retryCount + 1,

        startedAt:
          null,

        updatedAt:
          now(),

        workerId:
          null,

        leaseExpiresAt:
          null,

        error:
          isTimedOut
            ? "Video generation timed out and was returned to the queue."
            : "Video worker lease expired and the job was returned to the queue."
      });

      recovered++;
    } else {
      await doc.ref.update({
        status:
          VIDEO_STATUS.FAILED,

        failedAt:
          now(),

        updatedAt:
          now(),

        workerId:
          null,

        leaseExpiresAt:
          null,

        error:
          isTimedOut
            ? "Video generation timed out after multiple attempts."
            : "Video worker lease expired after multiple attempts."
      });

      permanentlyFailed++;
    }
  }

  return {
    recovered,

    permanentlyFailed
  };
}


/*
========================================================
QUEUE STATUS
========================================================
*/

async function getVideoQueueStatus() {
  const [
    generating,
    queued
  ] =
    await Promise.all([
      countGeneratingVideos(),
      countQueuedVideos()
    ]);

  return {
    configured:
      true,

    maxConcurrentVideos:
      MAX_CONCURRENT_VIDEOS,

    maxVideoQueue:
      MAX_VIDEO_QUEUE,

    generating,

    queued,

    availableSlots:
      Math.max(
        0,
        MAX_CONCURRENT_VIDEOS -
          generating
      ),

    queueAvailable:
      Math.max(
        0,
        MAX_VIDEO_QUEUE -
          queued
      ),

    totalActive:
      generating +
      queued
  };
}


/*
========================================================
CANCEL VIDEO JOB
========================================================
*/

async function cancelVideoJob(
  jobId
) {
  const normalizedJobId =
    cleanString(jobId);

  if (
    !normalizedJobId
  ) {
    return false;
  }

  const ref =
    getJobRef(
      normalizedJobId
    );

  const snapshot =
    await ref.get();

  if (
    !snapshot.exists
  ) {
    return false;
  }

  const job =
    snapshot.data();

  if (
    job.status !==
      VIDEO_STATUS.QUEUED &&
    job.status !==
      VIDEO_STATUS.GENERATING
  ) {
    return false;
  }

  await ref.update({
    status:
      VIDEO_STATUS.CANCELLED,

    cancelledAt:
      now(),

    updatedAt:
      now(),

    workerId:
      null,

    leaseExpiresAt:
      null
  });

  return true;
}


/*
========================================================
EXPORTS
========================================================
*/

module.exports = {
  VIDEO_STATUS,

  VIDEO_PRIORITY,

  MAX_CONCURRENT_VIDEOS,

  MAX_VIDEO_QUEUE,

  MAX_VIDEO_REQUESTS_PER_WINDOW,

  VIDEO_RATE_LIMIT_WINDOW_MS,

  VIDEO_JOB_TIMEOUT_MS,

  MAX_VIDEO_RETRIES,

  VIDEO_JOB_LEASE_MS,

  isAdminUser,

  createVideoJob,

  getVideoJob,

  getUserActiveVideoJob,

  checkVideoRateLimit,

  countGeneratingVideos,

  countQueuedVideos,

  getQueuePosition,

  calculateEstimatedWait,

  claimNextQueuedJob,

  markJobGenerating,

  renewVideoJobLease,

  markJobCompleted,

  markJobFailed,

  retryVideoJob,

  recoverStaleVideoJobs,

  getVideoQueueStatus,

  cancelVideoJob
};