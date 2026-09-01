const { db } = require("../firebaseAdmin");

/*
========================================================
GAVEAI PAYMENT SERVICE
========================================================

PAYMENT METHOD:
    Manual bank transfer

PLANS:

FREE
    - 1 free video per Haiti day
    - No subscription credits

PRO
    - $9.99 USD / 30 days
    - 1,200 credits
    - 15 credits per video
    - 80 videos equivalent

PREMIUM
    - $19.99 USD / 30 days
    - 3,000 credits
    - 15 credits per video
    - 200 videos equivalent

ADMIN
    - Unlimited
    - No credits deducted

IMPORTANT:
    creditService.js uses "creditBalance"
    as the user's subscription credit balance.

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
CREATE PAYMENT REQUEST
========================================================

Authenticated user creates a payment request.

The Firebase UID is supplied by the authenticated
backend route.

The customer must later submit the bank transaction
reference before the Admin can approve the payment.

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
    String(plan || "")
      .trim()
      .toLowerCase();

  const selectedPlan =
    PLANS[normalizedPlan];

  if (!selectedPlan) {
    throw new Error(
      "Invalid payment plan. Choose Pro or Premium."
    );
  }

  const paymentRef =
    db
      .collection("payments")
      .doc();

  const now =
    new Date();

  const payment = {
    userId,

    userEmail:
      userData.email || "",

    userName:
      userData.name || "",

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
    BANK TRANSFER REFERENCE
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

The authenticated customer submits the bank transfer
reference number after making the payment.

Security:
    The payment must belong to the authenticated user.

A payment that is already approved or rejected
cannot be modified.

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
    db
      .collection("payments")
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
    db
      .collection("payments")
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

Payment approval + subscription activation happen
inside ONE Firestore transaction.

This prevents double approval and duplicate credits.

The user's subscription credit balance is stored in:

    creditBalance

NOT:

    credits

This matches creditService.js.

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
    db
      .collection("payments")
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
      VALIDATE PLAN
      --------------------------------------------------
      */

      const normalizedPlan =
        String(
          payment.plan || ""
        )
          .trim()
          .toLowerCase();

      const selectedPlan =
        PLANS[normalizedPlan];

      if (!selectedPlan) {
        throw new Error(
          "Payment contains an invalid plan."
        );
      }

      /*
      --------------------------------------------------
      VALIDATE USER
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
        db
          .collection("users")
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

      If the user already has an active subscription,
      extend from the existing expiration date.

      Otherwise start from now.

      This prevents an existing paid period from being
      unnecessarily lost when the customer renews.
      --------------------------------------------------
      */

      let subscriptionStart =
        now;

      let existingExpiration = null;

      if (
        userData.subscriptionExpiresAt
      ) {
        if (
          typeof userData
            .subscriptionExpiresAt
            .toDate ===
          "function"
        ) {
          existingExpiration =
            userData
              .subscriptionExpiresAt
              .toDate();
        } else {
          existingExpiration =
            new Date(
              userData.subscriptionExpiresAt
            );
        }

        if (
          Number.isNaN(
            existingExpiration.getTime()
          )
        ) {
          existingExpiration =
            null;
        }
      }

      if (
        existingExpiration &&
        existingExpiration.getTime() >
          now.getTime()
      ) {
        subscriptionStart =
          existingExpiration;
      }

      const expiresAt =
        new Date(
          subscriptionStart.getTime() +
          selectedPlan.durationDays *
            24 *
            60 *
            60 *
            1000
        );

      /*
      --------------------------------------------------
      EXISTING SUBSCRIPTION CREDITS
      --------------------------------------------------

      IMPORTANT:
      Use creditBalance because creditService.js
      reads and deducts from creditBalance.
      --------------------------------------------------
      */

      const currentCredits =
        Number(
          userData.creditBalance
        );

      const safeCurrentCredits =
        Number.isFinite(
          currentCredits
        )
          ? Math.max(
              currentCredits,
              0
            )
          : 0;

      /*
      --------------------------------------------------
      ADD NEW PLAN CREDITS
      --------------------------------------------------
      */

      const newCreditBalance =
        safeCurrentCredits +
        selectedPlan.credits;

      /*
      --------------------------------------------------
      UPDATE USER
      --------------------------------------------------
      */

      transaction.set(
        userRef,
        {
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
          IMPORTANT:
          This is the field used by creditService.js.
          */

          creditBalance:
            newCreditBalance,

          /*
          Keep a record of the latest payment allocation.
          */

          lastSubscriptionCreditsAdded:
            selectedPlan.credits,

          lastPaymentId:
            paymentId,

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

        amount:
          selectedPlan.price,

        currency:
          selectedPlan.currency,

        transactionReference,

        creditsAdded:
          selectedPlan.credits,

        previousCreditBalance:
          safeCurrentCredits,

        newCreditBalance,

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

Admin can reject a pending payment.

Rejected payments cannot later be approved.

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
    db
      .collection("payments")
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

  const rejectionReason =
    String(
      reason || ""
    ).trim();

  if (
    rejectionReason.length >
    500
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

