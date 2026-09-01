const express = require("express");

const {
  requireAuth,
  requireAdmin
} = require("../middleware/authMiddleware");

const {
  PLANS,
  createPaymentRequest,
  getPayment,
  approvePayment,
  rejectPayment,
  updateTransactionReference
} = require("../services/paymentService");

const {
  getUser
} = require("../services/userService");

const {
  PAYMENT_CONFIG
} = require("../config/paymentConfig");

const router = express.Router();

/*
========================================================
GET AVAILABLE PLANS
========================================================

Public endpoint.

Returns the available GaveAI subscription plans.
========================================================
*/

router.get("/plans", (req, res) => {
  return res.json({
    success: true,
    plans: PLANS
  });
});


/*
========================================================
GET PAYMENT INFORMATION
========================================================

Public endpoint.

Returns the bank information and payment instructions
customers need before making a payment.
========================================================
*/

router.get("/payment-info", (req, res) => {
  return res.json({
    success: true,
    paymentInfo: PAYMENT_CONFIG
  });
});


/*
========================================================
CREATE PAYMENT REQUEST
========================================================

Authenticated users only.

IMPORTANT:
The Firebase UID always comes from req.user.uid.

We NEVER trust req.body.userId.
========================================================
*/

router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    const plan =
      typeof req.body?.plan === "string"
        ? req.body.plan.trim().toLowerCase()
        : "";

    if (!plan) {
      return res.status(400).json({
        success: false,
        error: "Payment plan is required."
      });
    }

    const user = await getUser(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User account not found."
      });
    }

    const payment = await createPaymentRequest(
      userId,
      user,
      plan
    );

    return res.status(201).json({
      success: true,
      payment
    });

  } catch (error) {
    console.error(
      "CREATE PAYMENT ERROR:",
      error?.message || error
    );

    return res.status(400).json({
      success: false,
      error:
        error?.message ||
        "Unable to create payment request."
    });
  }
});


/*
========================================================
SUBMIT TRANSACTION REFERENCE
========================================================

Authenticated users only.

The customer submits the bank transaction/reference
number after completing the manual USD bank transfer.

The payment MUST belong to the authenticated user.

Users cannot modify approved or rejected payments.
========================================================
*/

router.patch(
  "/:paymentId/transaction-reference",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;

      const transactionReference =
        typeof req.body?.transactionReference === "string"
          ? req.body.transactionReference.trim()
          : "";

      if (!transactionReference) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction/reference number is required."
        });
      }

      const payment = await getPayment(paymentId);

      if (!payment) {
        return res.status(404).json({
          success: false,
          error: "Payment not found."
        });
      }

      /*
      --------------------------------------------------
      VERIFY PAYMENT OWNERSHIP
      --------------------------------------------------
      */

      if (payment.userId !== req.user.uid) {
        return res.status(403).json({
          success: false,
          error:
            "You are not allowed to update this payment."
        });
      }

      /*
      --------------------------------------------------
      APPROVED PAYMENT CANNOT BE MODIFIED
      --------------------------------------------------
      */

      if (payment.status === "approved") {
        return res.status(400).json({
          success: false,
          error:
            "An approved payment cannot be modified."
        });
      }

      /*
      --------------------------------------------------
      REJECTED PAYMENT CANNOT BE MODIFIED
      --------------------------------------------------
      */

      if (payment.status === "rejected") {
        return res.status(400).json({
          success: false,
          error:
            "A rejected payment cannot be modified."
        });
      }

      const updatedPayment =
        await updateTransactionReference(
          paymentId,
          req.user.uid,
          transactionReference
        );

      return res.json({
        success: true,
        payment: updatedPayment
      });

    } catch (error) {
      console.error(
        "UPDATE TRANSACTION REFERENCE ERROR:",
        error?.message || error
      );

      return res.status(400).json({
        success: false,
        error:
          error?.message ||
          "Unable to update transaction reference."
      });
    }
  }
);


/*
========================================================
GET PAYMENT
========================================================

Authenticated users can retrieve only their own payment.

The configured Admin can retrieve any payment.

IMPORTANT:
Admin access is verified using ADMIN_USER_ID.
========================================================
*/

router.get(
  "/:paymentId",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;

      const payment = await getPayment(paymentId);

      if (!payment) {
        return res.status(404).json({
          success: false,
          error: "Payment not found."
        });
      }

      /*
      --------------------------------------------------
      VERIFY ADMIN
      --------------------------------------------------
      */

      const adminUserId =
        typeof process.env.ADMIN_USER_ID === "string"
          ? process.env.ADMIN_USER_ID.trim()
          : "";

      const isAdmin =
        Boolean(
          adminUserId &&
          req.user?.uid === adminUserId
        );

      /*
      --------------------------------------------------
      NORMAL USER:
      ONLY THEIR OWN PAYMENT
      --------------------------------------------------
      */

      if (
        !isAdmin &&
        payment.userId !== req.user.uid
      ) {
        return res.status(403).json({
          success: false,
          error:
            "You are not allowed to access this payment."
        });
      }

      return res.json({
        success: true,
        payment
      });

    } catch (error) {
      console.error(
        "GET PAYMENT ERROR:",
        error?.message || error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Unable to retrieve payment."
      });
    }
  }
);


/*
========================================================
ADMIN: APPROVE PAYMENT
========================================================

Only the configured Admin can approve a payment.

The payment service is responsible for:

1. Validating the payment.
2. Validating the transaction reference.
3. Validating the selected plan.
4. Activating the subscription.
5. Adding the correct plan credits.
6. Setting the subscription expiration.
7. Marking the payment as approved.

Payment approval logic MUST remain inside
paymentService.js.
========================================================
*/

router.post(
  "/:paymentId/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;
      const adminUserId = req.user.uid;

      const result = await approvePayment(
        paymentId,
        adminUserId
      );

      return res.json({
        success: true,
        result
      });

    } catch (error) {
      console.error(
        "APPROVE PAYMENT ERROR:",
        error?.message || error
      );

      return res.status(400).json({
        success: false,
        error:
          error?.message ||
          "Unable to approve payment."
      });
    }
  }
);


/*
========================================================
ADMIN: REJECT PAYMENT
========================================================

Only the configured Admin can reject a payment.

A rejection reason is optional.
========================================================
*/

router.post(
  "/:paymentId/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;
      const adminUserId = req.user.uid;

      const reason =
        typeof req.body?.reason === "string"
          ? req.body.reason.trim()
          : "";

      const result = await rejectPayment(
        paymentId,
        adminUserId,
        reason
      );

      return res.json({
        success: true,
        result
      });

    } catch (error) {
      console.error(
        "REJECT PAYMENT ERROR:",
        error?.message || error
      );

      return res.status(400).json({
        success: false,
        error:
          error?.message ||
          "Unable to reject payment."
      });
    }
  }
);


/*
========================================================
EXPORT ROUTER
========================================================
*/

module.exports = router;

