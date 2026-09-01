const { db } = require("../firebaseAdmin");

/*
========================================================
GAVEAI PAYMENT SERVICE
========================================================

PLANS

PRO
- $9.99 USD
- 30 days
- 1,200 credits
- 15 credits per video
- 80 videos equivalent

PREMIUM
- $19.99 USD
- 30 days
- 3,000 credits
- 15 credits per video
- 200 videos equivalent

PAYMENT FLOW

1. Customer selects Pro or Premium
2. Payment request is created
3. Customer makes bank transfer
4. Customer submits transaction reference
5. Admin verifies payment manually
6. Admin approves payment
7. Subscription becomes active
8. Credits are added to creditBalance
9. Subscription expires after 30 days

IMPORTANT

creditService.js uses:

    creditBalance

Therefore this service also uses:

    creditBalance

Do NOT use a separate "credits" field for video credits.
========================================================
*/


/*
========================================================
PLAN CONFIGURATION
========================================================
*/

const PLANS = {
  pro: {
    name: "Pro",
    price: 9.99,
    currency: "USD",
    credits: 1200,
    durationDays: 30
  },

  premium: {
    name: "Premium",
    price: 19.99,
    currency: "USD",
    credits: 3000,
    durationDays: 30
  }
};


/*
========================================================
NORMALIZE PLAN
========================================================
*/

function normalizePlan(plan) {
  return String(plan || "")
    .trim()
    .toLowerCase();
}


/*
========================================================
GET PLAN
========================================================
*/

function getPlan(plan) {
  const normalizedPlan =
    normalizePlan(plan);

  return PLANS[normalizedPlan] || null;
}


/*
========================================================
CREATE PAYMENT REQUEST
========================================================

Authenticated user creates a payment request.

The actual payment is verified manually by Admin.

Initial status:

    pending

========================================================
*/

async function createPaymentRequest(
  userId,
  userData = {},
  plan
) {
  if (!userId) {
    throw new Error(
      "User ID is required."
    );
  }

  const normalizedPlan =
    normalizePlan(plan);

  const selectedPlan =
    getPlan(normalizedPlan);

  if (!selectedPlan) {
    throw new Error(
      "Invalid payment plan. Choose Pro or Premium."
    );
  }

  const paymentRef =
    db.collection("payments").doc();

  const now =
    new Date();

  const payment = {
    /*
    ----------------------------------------------------
    CUSTOMER
    ----------------------------------------------------
    */

    userId,

    userEmail:
      String(userData.email || "")
        .trim(),

    userName:
      String(userData.name || "")
        .trim(),

    /*
    ----------------------------------------------------
    PLAN
    ----------------------------------------------------
    */

    plan:
      normalizedPlan,

    planName:
      selectedPlan.name,

    amount:
      selectedPlan.price,

    currency:
      selectedPlan.currency,

    credits:
      selectedPlan.credits,

    durationDays:
      selectedPlan.durationDays,

    /*
    ----------------------------------------------------
    BANK TRANSFER
    ----------------------------------------------------
    */

    transactionReference:
      null,

    /*
    ----------------------------------------------------
    PAYMENT STATUS
    ----------------------------------------------------
    */

    status:
      "pending",

    /*
    ----------------------------------------------------
    TIMESTAMPS
    ----------------------------------------------------
    */

    createdAt:
      now,

    updatedAt:
      now,

    approvedAt:
      null,

    approvedBy:
      null,

    rejectedAt:
      null,

    rejectedBy:
      null,

    rejectionReason:
      null
  };

  await paymentRef.set(
    payment
  );

  return {
    id:
      paymentRef.id,

    ...payment
  };
}


/*
========================================================
UPDATE TRANSACTION REFERENCE
========================================================

Customer submits the bank transaction/reference
number after making the transfer.

Only the owner of the payment can update it.

Approved or rejected payments cannot be modified.

========================================================
*/

async function updateTransactionReference(
  paymentId,
  userId,
  transactionReference
) {
  if (!paymentId) {
    throw new Error(
      "Payment ID is required."
    );
  }

  if (!userId) {
    throw new Error(
      "User ID is required."
    );
  }

  const reference =
    String(
      transactionReference || ""
    ).trim();

  if (!reference) {
    throw new Error(
      "Transaction/reference number is required."
    );
  }

  if (reference.length > 200) {
    throw new Error(
      "Transaction/reference number is too long."
    );
  }

  const paymentRef =
    db.collection("payments")
      .doc(paymentId);

  const snapshot =
    await paymentRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Payment not found."
    );
  }

  const payment =
    snapshot.data() || {};

  /*
  ----------------------------------------------------
  SECURITY
  ----------------------------------------------------
  */

  if (
    payment.userId !==
    userId
  ) {
    throw new Error(
      "You are not allowed to update this payment."
    );
  }

  /*
  ----------------------------------------------------
  PREVENT MODIFICATION AFTER FINAL DECISION
  ----------------------------------------------------
  */

  if (
    payment.status ===
    "approved"
  ) {
    throw new Error(
      "An approved payment cannot be modified."
    );
  }

  if (
    payment.status ===
    "rejected"
  ) {
    throw new Error(
      "A rejected payment cannot be modified."
    );
  }

  const now =
    new Date();

  await paymentRef.update({
    transactionReference:
      reference,

    updatedAt:
      now
  });

  return {
    success:
      true,

    paymentId,

    transactionReference:
      reference,

    status:
      payment.status || "pending",

    updatedAt:
      now
  };
}


/*
========================================================
GET PAYMENT
========================================================
*/

async function getPayment(
  paymentId
) {
  if (!paymentId) {
    return null;
  }

  const paymentRef =
    db.collection("payments")
      .doc(paymentId);

  const snapshot =
    await paymentRef.get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id:
      snapshot.id,

    ...snapshot.data()
  };
}


/*
========================================================
APPROVE PAYMENT
========================================================

IMPORTANT:

Payment approval and subscription activation happen
inside ONE Firestore transaction.

This protects against duplicate approval.

A payment can only be approved once.

The user's video credits are stored in:

    creditBalance

NOT:

    credits

========================================================
*/

async function approvePayment(
  paymentId,
  adminUserId
) {
  if (!paymentId) {
    throw new Error(
      "Payment ID is required."
    );
  }

  if (!adminUserId) {
    throw new Error(
      "Admin user ID is required."
    );
  }

  const paymentRef =
    db.collection("payments")
      .doc(paymentId);

  return db.runTransaction(
    async (transaction) => {
      /*
      --------------------------------------------------
      GET PAYMENT
      --------------------------------------------------
      */

      const paymentSnap =
        await transaction.get(
          paymentRef
        );

      if (!paymentSnap.exists) {
        throw new Error(
          "Payment not found."
        );
      }

      const payment =
        paymentSnap.data() || {};

      /*
      --------------------------------------------------
      PREVENT DOUBLE APPROVAL
      --------------------------------------------------
      */

      if (
        payment.status ===
        "approved"
      ) {
        throw new Error(
          "This payment has already been approved."
        );
      }

      if (
        payment.status ===
        "rejected"
      ) {
        throw new Error(
          "A rejected payment cannot be approved."
        );
      }

      /*
      --------------------------------------------------
      REQUIRE TRANSACTION REFERENCE
      --------------------------------------------------
      */

      const transactionReference =
        String(
          payment.transactionReference || ""
        ).trim();

      if (!transactionReference) {
        throw new Error(
          "Payment cannot be approved without a transaction/reference number."
        );
      }

      /*
      --------------------------------------------------
      GET PLAN
      --------------------------------------------------
      */

      const normalizedPlan =
        normalizePlan(
          payment.plan
        );

      const selectedPlan =
        getPlan(normalizedPlan);

      if (!selectedPlan) {
        throw new Error(
          "Payment contains an invalid plan."
        );
      }

      /*
      --------------------------------------------------
      GET USER
      --------------------------------------------------
      */

      const userId =
        payment.userId;

      if (!userId) {
        throw new Error(
          "Payment does not contain a user ID."
        );
      }

      const userRef =
        db.collection("users")
          .doc(userId);

      const userSnap =
        await transaction.get(
          userRef
        );

      if (!userSnap.exists) {
        throw new Error(
          "User account not found."
        );
      }

      const userData =
        userSnap.data() || {};

      /*
      --------------------------------------------------
      CURRENT TIME
      --------------------------------------------------
      */

      const now =
        new Date();

      /*
      --------------------------------------------------
      SUBSCRIPTION EXPIRATION
      --------------------------------------------------
      */

      const expiresAt =
        new Date(
          now.getTime() +
          selectedPlan.durationDays *
            24 *
            60 *
            60 *
            1000
        );

      /*
      --------------------------------------------------
      CURRENT CREDIT BALANCE
      --------------------------------------------------

      creditService.js uses creditBalance.

      If the user already has a valid numeric balance,
      preserve it and add the purchased credits.

      --------------------------------------------------
      */

      const currentBalance =
        Number(
          userData.creditBalance
        );

      const safeCurrentBalance =
        Number.isFinite(
          currentBalance
        )
          ? Math.max(
              currentBalance,
              0
            )
          : 0;

      const newBalance =
        safeCurrentBalance +
        selectedPlan.credits;

      /*
      --------------------------------------------------
      RESET FREE VIDEO USAGE
      --------------------------------------------------

      Once the user purchases a paid plan,
      free-video usage should not interfere with the
      paid subscription.

      We reset the daily free-video counter here.
      --------------------------------------------------
      */

      /*
      --------------------------------------------------
      UPDATE USER
      --------------------------------------------------
      */

      transaction.set(
        userRef,
        {
          /*
          Subscription
          */

          plan:
            normalizedPlan,

          subscriptionPlan:
            normalizedPlan,

          subscriptionStatus:
            "active",

          subscriptionStartedAt:
            now,

          subscriptionExpiresAt:
            expiresAt,

          /*
          Video credits

          IMPORTANT:
          This must remain creditBalance because
          creditService.js reads this field.
          */

          creditBalance:
            newBalance,

          /*
          Keep credit information explicit.
          */

          lastPaymentId:
            paymentId,

          lastCreditSource:
            "subscription",

          lastCreditAdded:
            selectedPlan.credits,

          lastCreditUsageDate:
            null,

          /*
          Free video state
          */

          freeVideosUsedToday:
            0,

          freeVideoDate:
            null,

          updatedAt:
            now
        },
        {
          merge:
            true
        }
      );

      /*
      --------------------------------------------------
      UPDATE PAYMENT
      --------------------------------------------------
      */

      transaction.set(
        paymentRef,
        {
          status:
            "approved",

          approvedAt:
            now,

          approvedBy:
            adminUserId,

          updatedAt:
            now
        },
        {
          merge:
            true
        }
      );

      /*
      --------------------------------------------------
      RETURN RESULT
      --------------------------------------------------
      */

      return {
        success:
          true,

        paymentId,

        userId,

        plan:
          normalizedPlan,

        planName:
          selectedPlan.name,

        transactionReference,

        amount:
          selectedPlan.price,

        currency:
          selectedPlan.currency,

        creditsAdded:
          selectedPlan.credits,

        previousCreditBalance:
          safeCurrentBalance,

        newCreditBalance:
          newBalance,

        subscriptionStatus:
          "active",

        subscriptionStartedAt:
          now,

        subscriptionExpiresAt:
          expiresAt,

        approvedBy:
          adminUserId
      };
    }
  );
}


/*
========================================================
REJECT PAYMENT
========================================================

Only pending payments can be rejected.

========================================================
*/

async function rejectPayment(
  paymentId,
  adminUserId,
  reason = ""
) {
  if (!paymentId) {
    throw new Error(
      "Payment ID is required."
    );
  }

  if (!adminUserId) {
    throw new Error(
      "Admin user ID is required."
    );
  }

  const paymentRef =
    db.collection("payments")
      .doc(paymentId);

  const snapshot =
    await paymentRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Payment not found."
    );
  }

  const payment =
    snapshot.data() || {};

  /*
  ----------------------------------------------------
  PREVENT INVALID STATUS CHANGES
  ----------------------------------------------------
  */

  if (
    payment.status ===
    "approved"
  ) {
    throw new Error(
      "An approved payment cannot be rejected."
    );
  }

  if (
    payment.status ===
    "rejected"
  ) {
    throw new Error(
      "This payment has already been rejected."
    );
  }

  /*
  ----------------------------------------------------
  REASON
  ----------------------------------------------------
  */

  const rejectionReason =
    String(reason || "")
      .trim();

  if (
    rejectionReason.length > 500
  ) {
    throw new Error(
      "Rejection reason is too long."
    );
  }

  const now =
    new Date();

  await paymentRef.update({
    status:
      "rejected",

    rejectedAt:
      now,

    rejectedBy:
      adminUserId,

    rejectionReason,

    updatedAt:
      now
  });

  return {
    success:
      true,

    paymentId,

    status:
      "rejected",

    rejectedBy:
      adminUserId,

    rejectionReason,

    updatedAt:
      now
  };
}


/*
========================================================
EXPORT
========================================================
*/

module.exports = {
  PLANS,

  createPaymentRequest,

  updateTransactionReference,

  getPayment,

  approvePayment,

  rejectPayment
};

