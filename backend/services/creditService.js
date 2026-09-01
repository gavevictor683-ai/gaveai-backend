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
- $9.99
- 1,200 credits
- 30-day entitlement
- 5 seconds = 15 credits
- 8 seconds = 24 credits
- Credits do NOT rollover after expiration

PREMIUM
--------------------------------------------------------
- $19.99
- 3,000 credits
- 30-day entitlement
- 5 seconds = 15 credits
- 8 seconds = 24 credits
- Credits do NOT rollover after expiration

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

const VIDEO_CREDIT_COST = 15;

const PRO_CREDITS = 1200;
const PREMIUM_CREDITS = 3000;

const PRO_PLAN = "pro";
const PREMIUM_PLAN = "premium";

const ADMIN_USER_ID =
  process.env.ADMIN_USER_ID
    ? process.env.ADMIN_USER_ID.trim()
    : "";

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
GET PLAN CREDIT ALLOCATION
========================================================
*/

function getPlanCredits(plan) {
  const normalizedPlan =
    String(plan || "")
      .trim()
      .toLowerCase();

  if (normalizedPlan === PRO_PLAN) {
    return PRO_CREDITS;
  }

  if (normalizedPlan === PREMIUM_PLAN) {
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

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
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
  const plan = normalizePlan(data);

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

IMPORTANT:

The official paid-credit field is:

    users/{userId}.credits

We do NOT use:

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

Signature preserved:

checkAndDeductCredits(userId, amount)

BEHAVIOR
--------------------------------------------------------

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

      creditSource: "admin",

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
          currentBalance - cost;


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

      if (freeVideoUsed) {

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
→ restore the ONE lifetime free video

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
      creditSource: "admin"
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

        /*
        Restore the lifetime free video.
        */

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

Useful for the frontend/dashboard.

Example FREE:

{
  plan: "free",
  credits: 0,
  freeVideoAvailable: true
}

After free video:

{
  plan: "free",
  credits: 0,
  freeVideoAvailable: false
}

PRO:

{
  plan: "pro",
  credits: 735,
  totalPlanCredits: 1200,
  subscriptionActive: true
}
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

      plan: "admin",

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

      plan: "free",

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
  checkAndDeductCredits,
  refundCredits,
  getCreditStatus,

  VIDEO_CREDIT_COST,

  FREE_VIDEO_COUNT,

  PRO_CREDITS,
  PREMIUM_CREDITS,

  PRO_PLAN,
  PREMIUM_PLAN,

  ADMIN_USER_ID,

  getPlanCredits,
  isSubscriptionActive
};