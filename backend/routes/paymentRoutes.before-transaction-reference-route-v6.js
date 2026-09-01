const express = require("express");

const {
  requireAuth,
  requireAdmin
} = require("../middleware/authMiddleware");

const {
  PLANS,
  createPaymentRequest,
  updateTransactionReference,
  getPayment,
  approvePayment,
  rejectPayment
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

router.get(
  "/plans",
  (req, res) => {
    return res.json({
      success: true,
      plans: PLANS
    });
  }
);


/*
========================================================
GET PAYMENT INFORMATION
========================================================

Public endpoint.

Returns the bank information and payment instructions
customers need before making a payment.

========================================================
*/

router.get(
  "/payment-info",
  (req, res) => {
    return res.json({
      success: true,
      paymentInfo: PAYMENT_CONFIG
    });
  }
);


/*
========================================================
CREATE PAYMENT REQUEST
========================================================

Authenticated users only.

IMPORTANT:

The Firebase UID ALWAYS comes from req.user.uid.

We NEVER trust req.body.userId.

========================================================
*/

router.post(
  "/",
  requireAuth,
  async (req, res) => {
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

      const user =
        await getUser(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User account not found."
        });
      }

      const payment =
        await createPaymentRequest(
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
  }
);


/*
========================================================
UPDATE TRANSACTION REFERENCE
========================================================

Authenticated users only.

The customer submits the bank transaction/reference
number after completing the bank transfer.

The payment service verifies ownership.

========================================================
*/

router.patch(
  "/:paymentId/reference",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const transactionReference =
        typeof req.body?.transactionReference === "string"
          ? req.body.transactionReference.trim()
          : "";

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          error: "Payment ID is required."
        });
      }

      if (!transactionReference) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction/reference number is required."
        });
      }

      const result =
        await updateTransactionReference(
          paymentId,
          req.user.uid,
          transactionReference
        );

      return res.json({
        success: true,
        result
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

Authenticated users can retrieve only their own
payment.

The configured Admin can retrieve any payment.

========================================================
*/

router.get(
  "/:paymentId",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const payment =
        await getPayment(paymentId);

      if (!payment) {
        return res.status(404).json({
          success: false,
          error: "Payment not found."
        });
      }

      /*
      --------------------------------------------------
      CHECK ADMIN USING CONFIGURED ADMIN USER ID
      --------------------------------------------------
      */

      const adminUserId =
        String(
          process.env.ADMIN_USER_ID || ""
        ).trim();

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

Only the configured Admin can approve payments.

Approval:

1. Verifies the payment.
2. Requires a transaction reference.
3. Verifies the selected plan.
4. Activates the subscription.
5. Adds the plan credits.
6. Sets the 30-day expiration.
7. Marks the payment as approved.

========================================================
*/

router.post(
  "/:paymentId/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await approvePayment(
          req.params.paymentId,
          req.user.uid
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

Only the configured Admin can reject payments.

An optional rejection reason may be supplied.

========================================================
*/

router.post(
  "/:paymentId/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const reason =
        typeof req.body?.reason === "string"
          ? req.body.reason.trim()
          : "";

      const result =
        await rejectPayment(
          req.params.paymentId,
          req.user.uid,
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

