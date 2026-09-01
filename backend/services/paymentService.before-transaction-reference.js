const { db } = require("../firebaseAdmin");

/*
========================================================
PAYMENT CONFIGURATION
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
    db.collection("payments").doc();

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

The payment approval and subscription activation
happen inside ONE Firestore transaction.

This prevents the same payment from being approved
twice and giving the user duplicate credits.
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
      ----------------------------------------------
      PREVENT DOUBLE APPROVAL
      ----------------------------------------------
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

      const normalizedPlan =
        String(
          payment.plan || ""
        )
          .trim()
          .toLowerCase();

      const selectedPlan =
        PLANS[
          normalizedPlan
        ];

      if (!selectedPlan) {
        throw new Error(
          "Payment contains an invalid plan."
        );
      }

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
      ----------------------------------------------
      SUBSCRIPTION DATES
      ----------------------------------------------
      */

      const now =
        new Date();

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
      ----------------------------------------------
      EXISTING CREDITS
      ----------------------------------------------
      */

      const currentCredits =
        Number(
          userData.credits
        ) || 0;

      const newCredits =
        currentCredits +
        selectedPlan.credits;

      /*
      ----------------------------------------------
      UPDATE USER
      ----------------------------------------------
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

          credits:
            newCredits,

          updatedAt:
            now
        },
        {
          merge:
            true
        }
      );

      /*
      ----------------------------------------------
      UPDATE PAYMENT
      ----------------------------------------------
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

      return {
        success:
          true,

        paymentId,

        userId,

        plan:
          normalizedPlan,

        creditsAdded:
          selectedPlan.credits,

        newCreditBalance:
          newCredits,

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

  const now =
    new Date();

  await paymentRef.update({
    status:
      "rejected",

    rejectedAt:
      now,

    rejectedBy:
      adminUserId,

    rejectionReason:
      String(reason || "")
        .trim(),

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

    rejectionReason:
      String(reason || "")
        .trim()
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
  getPayment,
  approvePayment,
  rejectPayment
};