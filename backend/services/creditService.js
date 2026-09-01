const { db } = require("../firebaseAdmin");

/*
========================================================
GAVEAI CREDIT SERVICE
========================================================

FINAL GAVEAI VIDEO PLAN
========================================================

FREE
--------------------------------------------------------
- Free Video: 1 available
- One free video ONLY for the lifetime of the account
- After use:
    Free Video: 0 available
- NO daily free video
- NO daily credits
- NO 60 credits/day

PRO
--------------------------------------------------------
- $9.99 USD
- 1,000 credits
- 30-day entitlement
- 5 seconds = 15 credits
- 8 seconds = 24 credits
- Credits do NOT rollover after expiration

PREMIUM
--------------------------------------------------------
- $19.99 USD
- 1,500 credits
- 30-day entitlement
- 5 seconds = 15 credits
- 8 seconds = 24 credits
- Credits do NOT rollover after expiration

IMPORTANT
--------------------------------------------------------
PRO and PREMIUM use the SAME video credit pricing.

5-second video:
    15 credits

8-second video:
    24 credits

The difference between PRO and PREMIUM is the amount
of credits included in the plan:

PRO:
    1,000 credits

PREMIUM:
    1,500 credits

TOP UP
--------------------------------------------------------
When paid credits reach 0 before expiration:

User
  ↓
Top Up
  ↓
Manual bank payment
  ↓
Admin verification
  ↓
Payment approved
  ↓
+ plan credits
  ↓
NEW 30-day entitlement

IMPORTANT
--------------------------------------------------------
A top-up does NOT automatically happen monthly.

A new approved top-up creates a NEW 30-day
credit entitlement.

NO:
- dailyCredits
- 60 credits/day
- daily free-video reset
- automatic monthly recharge
- credit rollover after expiration
========================================================
*/


/*
========================================================
CONFIGURATION
========================================================
*/


/*
--------------------------------------------------------
VIDEO CREDIT COSTS
--------------------------------------------------------

5 seconds:
    15 credits

8 seconds:
    24 credits
--------------------------------------------------------
*/

const VIDEO_CREDIT_COST_5_SECONDS = 15;
const VIDEO_CREDIT_COST_8_SECONDS = 24;


/*
--------------------------------------------------------
DEFAULT VIDEO CREDIT COST
--------------------------------------------------------

Kept for backward compatibility with existing code that
imports VIDEO_CREDIT_COST.

IMPORTANT:
The default is 15 because the default video duration
is treated as 5 seconds.

For 8-second videos, use:

getVideoCreditCost(8)

--------------------------------------------------------
*/

const VIDEO_CREDIT_COST =
  VIDEO_CREDIT_COST_5_SECONDS;


/*
--------------------------------------------------------
PLAN CREDIT ALLOCATIONS
--------------------------------------------------------

PRO:
    1,000 credits

PREMIUM:
    1,500 credits
--------------------------------------------------------
*/

const PRO_CREDITS = 1000;

const PREMIUM_CREDITS = 1500;


/*
--------------------------------------------------------
PLAN NAMES
--------------------------------------------------------
*/

const PRO_PLAN = "pro";

const PREMIUM_PLAN = "premium";


/*
--------------------------------------------------------
ADMIN
--------------------------------------------------------
*/

const ADMIN_USER_ID =
  process.env.ADMIN_USER_ID
    ? process.env.ADMIN_USER_ID.trim()
    : "";


/*
--------------------------------------------------------
FREE VIDEO
--------------------------------------------------------
*/

const FREE_VIDEO_COUNT = 1;


/*
========================================================
NORMALIZE PLAN
========================================================
*/

function normalizePlan(data = {}) {
  return String(
    data.subscriptionPlan ||
    data.plan ||
    "free"
  )
    .trim()
    .toLowerCase();
}


/*
========================================================
NORMALIZE VIDEO DURATION
========================================================

Accepts:

5
"5"
"5s"
"5 sec"
"5 seconds"

8
"8"
"8s"
"8 sec"
"8 seconds"

Returns:

5
or
8

Throws an error for unsupported durations.
========================================================
*/

function normalizeVideoDuration(duration) {

  if (
    duration === null ||
    duration === undefined
  ) {
    return 5;
  }

  const normalized =
    String(duration)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  if (
    normalized === "5" ||
    normalized === "5s" ||
    normalized === "5 sec" ||
    normalized === "5 secs" ||
    normalized === "5 second" ||
    normalized === "5 seconds"
  ) {
    return 5;
  }

  if (
    normalized === "8" ||
    normalized === "8s" ||
    normalized === "8 sec" ||
    normalized === "8 secs" ||
    normalized === "8 second" ||
    normalized === "8 seconds"
  ) {
    return 8;
  }

  throw new Error(
    "Unsupported video duration. Only 5-second and 8-second videos are supported."
  );
}


/*
========================================================
GET VIDEO CREDIT COST
========================================================

5 seconds
    → 15 credits

8 seconds
    → 24 credits
========================================================
*/

function getVideoCreditCost(duration) {

  const normalizedDuration =
    normalizeVideoDuration(duration);

  if (
    normalizedDuration === 5
  ) {
    return VIDEO_CREDIT_COST_5_SECONDS;
  }

  if (
    normalizedDuration === 8
  ) {
    return VIDEO_CREDIT_COST_8_SECONDS;
  }

  throw new Error(
    "Unable to determine video credit cost."
  );
}


/*
========================================================
GET PLAN CREDIT ALLOCATION
========================================================
*/

function getPlanCredits(plan) {

  const normalizedPlan =
    String(plan || "")
      .trim()
      .toLowerCase();

  if (
    normalizedPlan === PRO_PLAN
  ) {
    return PRO_CREDITS;
  }

  if (
    normalizedPlan === PREMIUM_PLAN
  ) {
    return PREMIUM_CREDITS;
  }

  return 0;
}


/*
========================================================
CONVERT FIRESTORE DATE
========================================================
*/

function toDate(value) {

  if (!value) {
    return null;
  }

  if (
    typeof value === "object" &&
    typeof value.toDate === "function"
  ) {
    return value.toDate();
  }

  /*
  ------------------------------------------------------
  FIRESTORE TIMESTAMP-LIKE OBJECT
  ------------------------------------------------------
  */

  if (
    typeof value === "object" &&
    Number.isFinite(
      Number(value.seconds)
    )
  ) {
    return new Date(
      Number(value.seconds) * 1000
    );
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date;
}


/*
========================================================
GET SUBSCRIPTION EXPIRATION
========================================================
*/

function getSubscriptionExpiry(data = {}) {

  return (
    data.subscriptionExpiresAt ||
    data.subscriptionEndDate ||
    data.expiresAt ||
    null
  );
}


/*
========================================================
CHECK ACTIVE SUBSCRIPTION
========================================================
*/

function isSubscriptionActive(data = {}) {

  const plan =
    normalizePlan(data);

  if (
    plan !== PRO_PLAN &&
    plan !== PREMIUM_PLAN
  ) {
    return false;
  }

  const expiryValue =
    getSubscriptionExpiry(data);

  const expiryDate =
    toDate(expiryValue);

  if (!expiryDate) {
    return false;
  }

  return (
    expiryDate.getTime() >
    Date.now()
  );
}


/*
========================================================
GET CURRENT CREDIT BALANCE
========================================================

OFFICIAL FIELD:

users/{userId}.credits

DO NOT USE:

dailyCredits
creditBalance
========================================================
*/

function getCreditBalance(data = {}) {

  const credits =
    Number(data.credits);

  if (
    !Number.isFinite(credits) ||
    credits < 0
  ) {
    return 0;
  }

  return credits;
}


/*
========================================================
CHECK AND DEDUCT CREDITS
========================================================

SIGNATURE PRESERVED:

checkAndDeductCredits(userId, amount)

The caller should calculate the video cost first:

const cost =
  getVideoCreditCost(duration);

Then:

checkAndDeductCredits(
  userId,
  cost
);

--------------------------------------------------------

BEHAVIOR

ADMIN
→ unlimited
→ no deduction

ACTIVE PRO/PREMIUM
→ deduct from "credits"

FREE
→ consume ONE lifetime free video

NO DAILY RESET
========================================================
*/

async function checkAndDeductCredits(
  userId,
  amount
) {

  /*
  ======================================================
  VALIDATE USER
  ======================================================
  */

  if (!userId) {
    throw new Error(
      "User ID is required for credit usage."
    );
  }


  /*
  ======================================================
  VALIDATE COST
  ======================================================
  */

  const cost =
    Number(amount);

  if (
    !Number.isFinite(cost) ||
    cost <= 0
  ) {
    throw new Error(
      "Invalid credit amount."
    );
  }


  /*
  ======================================================
  ADMIN BYPASS
  ======================================================
  */

  if (
    ADMIN_USER_ID &&
    userId === ADMIN_USER_ID
  ) {

    return {
      success: true,

      isAdmin: true,

      unlimited: true,

      creditsDeducted: 0,

      previousCreditBalance: null,

      newCreditBalance: null,

      creditSource:
        "admin",

      freeVideoUsed: false
    };
  }


  /*
  ======================================================
  USER DOCUMENT
  ======================================================
  */

  const userRef =
    db
      .collection("users")
      .doc(userId);


  /*
  ======================================================
  FIRESTORE TRANSACTION
  ======================================================
  */

  return db.runTransaction(
    async (transaction) => {

      const snapshot =
        await transaction.get(
          userRef
        );


      /*
      ==================================================
      USER MUST EXIST
      ==================================================
      */

      if (!snapshot.exists) {

        throw new Error(
          "User account not found."
        );
      }


      const data =
        snapshot.data() || {};


      /*
      ==================================================
      CURRENT PLAN
      ==================================================
      */

      const plan =
        normalizePlan(data);


      /*
      ==================================================
      ACTIVE PAID SUBSCRIPTION
      ==================================================
      */

      const subscriptionActive =
        isSubscriptionActive(data);


      /*
      ==================================================
      PRO / PREMIUM
      ==================================================
      */

      if (
        subscriptionActive &&
        (
          plan === PRO_PLAN ||
          plan === PREMIUM_PLAN
        )
      ) {

        const currentBalance =
          getCreditBalance(data);


        /*
        ================================================
        INSUFFICIENT CREDITS
        ================================================
        */

        if (
          currentBalance <
          cost
        ) {

          const error =
            new Error(
              "INSUFFICIENT_VIDEO_CREDITS"
            );

          error.currentCredits =
            currentBalance;

          error.requiredCredits =
            cost;

          error.plan =
            plan;

          throw error;
        }


        /*
        ================================================
        DEDUCT
        ================================================
        */

        const newBalance =
          currentBalance -
          cost;


        transaction.set(
          userRef,
          {
            credits:
              newBalance,

            lastCreditSource:
              "subscription",

            lastCreditCost:
              cost,

            lastCreditUsageAt:
              new Date().toISOString(),

            updatedAt:
              new Date()
          },
          {
            merge: true
          }
        );


        return {
          success: true,

          isAdmin: false,

          unlimited: false,

          creditSource:
            "subscription",

          plan,

          creditsDeducted:
            cost,

          previousCreditBalance:
            currentBalance,

          newCreditBalance:
            newBalance,

          subscriptionActive:
            true,

          subscriptionExpiresAt:
            getSubscriptionExpiry(data),

          freeVideoUsed:
            Boolean(
              data.freeVideoUsed
            )
        };
      }


      /*
      ==================================================
      FREE USER
      ==================================================

      ONE FREE VIDEO FOR THE ACCOUNT.

      IMPORTANT:
      This is NOT daily.

      Once used, it stays used permanently.
      ==================================================
      */

      const freeVideoUsed =
        Boolean(
          data.freeVideoUsed
        );


      /*
      ==================================================
      FREE VIDEO ALREADY USED
      ==================================================
      */

      if (
        freeVideoUsed
      ) {

        const error =
          new Error(
            "FREE_VIDEO_ALREADY_USED"
          );

        error.currentPlan =
          "free";

        error.freeVideoAvailable =
          false;

        throw error;
      }


      /*
      ==================================================
      CONSUME LIFETIME FREE VIDEO
      ==================================================
      */

      transaction.set(
        userRef,
        {
          freeVideoUsed:
            true,

          freeVideoAvailable:
            false,

          lastCreditSource:
            "free_video",

          lastCreditCost:
            0,

          lastCreditUsageAt:
            new Date().toISOString(),

          updatedAt:
            new Date()
        },
        {
          merge: true
        }
      );


      return {
        success: true,

        isAdmin: false,

        unlimited: false,

        creditSource:
          "free_video",

        plan:
          "free",

        creditsDeducted:
          0,

        previousCreditBalance:
          getCreditBalance(data),

        newCreditBalance:
          getCreditBalance(data),

        freeVideoUsed:
          true,

        freeVideoAvailable:
          false
      };
    }
  );
}


/*
========================================================
REFUND CREDITS
========================================================

If generation fails:

ADMIN
→ nothing

PAID USER
→ restore paid credits

FREE USER
→ restore ONE lifetime free video
========================================================
*/

async function refundCredits(
  userId,
  amount
) {

  /*
  ======================================================
  VALIDATE USER
  ======================================================
  */

  if (!userId) {

    throw new Error(
      "User ID is required for credit refund."
    );
  }


  /*
  ======================================================
  ADMIN
  ======================================================
  */

  if (
    ADMIN_USER_ID &&
    userId === ADMIN_USER_ID
  ) {

    return {
      success: true,

      isAdmin: true,

      unlimited: true,

      refunded: 0,

      creditSource:
        "admin"
    };
  }


  /*
  ======================================================
  REFUND AMOUNT
  ======================================================
  */

  const refundAmount =
    Number(amount);

  if (
    !Number.isFinite(
      refundAmount
    ) ||
    refundAmount < 0
  ) {

    throw new Error(
      "Invalid refund amount."
    );
  }


  /*
  ======================================================
  USER DOCUMENT
  ======================================================
  */

  const userRef =
    db
      .collection("users")
      .doc(userId);


  /*
  ======================================================
  FIRESTORE TRANSACTION
  ======================================================
  */

  return db.runTransaction(
    async (transaction) => {

      const snapshot =
        await transaction.get(
          userRef
        );


      /*
      ==================================================
      USER MUST EXIST
      ==================================================
      */

      if (!snapshot.exists) {

        throw new Error(
          "User account not found."
        );
      }


      const data =
        snapshot.data() || {};


      /*
      ==================================================
      LAST CREDIT SOURCE
      ==================================================
      */

      const lastSource =
        String(
          data.lastCreditSource ||
          ""
        )
          .trim()
          .toLowerCase();


      /*
      ==================================================
      REFUND FREE VIDEO
      ==================================================
      */

      if (
        lastSource ===
        "free_video"
      ) {

        transaction.set(
          userRef,
          {
            freeVideoUsed:
              false,

            freeVideoAvailable:
              true,

            updatedAt:
              new Date()
          },
          {
            merge: true
          }
        );


        return {
          success: true,

          refunded: 0,

          creditSource:
            "free_video",

          freeVideoUsed:
            false,

          freeVideoAvailable:
            true,

          newCreditBalance:
            getCreditBalance(data)
        };
      }


      /*
      ==================================================
      REFUND SUBSCRIPTION CREDITS
      ==================================================
      */

      if (
        lastSource ===
        "subscription"
      ) {

        const currentBalance =
          getCreditBalance(data);


        const newBalance =
          currentBalance +
          refundAmount;


        transaction.set(
          userRef,
          {
            credits:
              newBalance,

            updatedAt:
              new Date()
          },
          {
            merge: true
          }
        );


        return {
          success: true,

          refunded:
            refundAmount,

          creditSource:
            "subscription",

          plan:
            normalizePlan(data),

          newCreditBalance:
            newBalance
        };
      }


      /*
      ==================================================
      BACKWARD-COMPATIBILITY REFUND
      ==================================================
      */

      if (
        refundAmount > 0
      ) {

        const currentBalance =
          getCreditBalance(data);


        const newBalance =
          currentBalance +
          refundAmount;


        transaction.set(
          userRef,
          {
            credits:
              newBalance,

            lastCreditSource:
              "subscription",

            updatedAt:
              new Date()
          },
          {
            merge: true
          }
        );


        return {
          success: true,

          refunded:
            refundAmount,

          creditSource:
            "subscription",

          newCreditBalance:
            newBalance
        };
      }


      /*
      ==================================================
      NOTHING TO REFUND
      ==================================================
      */

      return {
        success: true,

        refunded: 0,

        creditSource:
          "none",

        newCreditBalance:
          getCreditBalance(data),

        freeVideoUsed:
          Boolean(
            data.freeVideoUsed
          ),

        freeVideoAvailable:
          !Boolean(
            data.freeVideoUsed
          )
      };
    }
  );
}


/*
========================================================
GET USER CREDIT STATUS
========================================================
*/

async function getCreditStatus(
  userId
) {

  if (!userId) {

    throw new Error(
      "User ID is required."
    );
  }


  /*
  ======================================================
  ADMIN
  ======================================================
  */

  if (
    ADMIN_USER_ID &&
    userId === ADMIN_USER_ID
  ) {

    return {
      success: true,

      isAdmin: true,

      plan:
        "admin",

      unlimited: true,

      credits: null,

      totalPlanCredits: null,

      freeVideoAvailable: false,

      subscriptionActive:
        true,

      subscriptionExpiresAt:
        null
    };
  }


  /*
  ======================================================
  GET USER
  ======================================================
  */

  const snapshot =
    await db
      .collection("users")
      .doc(userId)
      .get();


  if (!snapshot.exists) {

    throw new Error(
      "User account not found."
    );
  }


  const data =
    snapshot.data() || {};


  const plan =
    normalizePlan(data);


  const active =
    isSubscriptionActive(data);


  /*
  ======================================================
  FREE
  ======================================================
  */

  if (
    !active ||
    (
      plan !== PRO_PLAN &&
      plan !== PREMIUM_PLAN
    )
  ) {

    return {
      success: true,

      isAdmin: false,

      plan:
        "free",

      unlimited: false,

      credits:
        getCreditBalance(data),

      totalPlanCredits:
        0,

      freeVideoAvailable:
        !Boolean(
          data.freeVideoUsed
        ),

      freeVideoUsed:
        Boolean(
          data.freeVideoUsed
        ),

      subscriptionActive:
        false,

      subscriptionExpiresAt:
        null
    };
  }


  /*
  ======================================================
  PAID
  ======================================================
  */

  const totalPlanCredits =
    getPlanCredits(plan);


  return {
    success: true,

    isAdmin: false,

    plan,

    unlimited: false,

    credits:
      getCreditBalance(data),

    totalPlanCredits,

    freeVideoAvailable:
      false,

    freeVideoUsed:
      Boolean(
        data.freeVideoUsed
      ),

    subscriptionActive:
      true,

    subscriptionExpiresAt:
      getSubscriptionExpiry(data)
  };
}


/*
========================================================
EXPORT
========================================================
*/

module.exports = {

  /*
  ------------------------------------------------------
  CREDIT FUNCTIONS
  ------------------------------------------------------
  */

  checkAndDeductCredits,

  refundCredits,

  getCreditStatus,


  /*
  ------------------------------------------------------
  VIDEO PRICING
  ------------------------------------------------------
  */

  VIDEO_CREDIT_COST,

  VIDEO_CREDIT_COST_5_SECONDS,

  VIDEO_CREDIT_COST_8_SECONDS,

  getVideoCreditCost,

  normalizeVideoDuration,


  /*
  ------------------------------------------------------
  FREE
  ------------------------------------------------------
  */

  FREE_VIDEO_COUNT,


  /*
  ------------------------------------------------------
  PLAN CREDITS
  ------------------------------------------------------
  */

  PRO_CREDITS,

  PREMIUM_CREDITS,


  /*
  ------------------------------------------------------
  PLAN NAMES
  ------------------------------------------------------
  */

  PRO_PLAN,

  PREMIUM_PLAN,


  /*
  ------------------------------------------------------
  ADMIN
  ------------------------------------------------------
  */

  ADMIN_USER_ID,


  /*
  ------------------------------------------------------
  HELPERS
  ------------------------------------------------------
  */

  getPlanCredits,

  isSubscriptionActive
};