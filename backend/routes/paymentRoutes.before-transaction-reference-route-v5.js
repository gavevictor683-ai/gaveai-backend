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

Returns bank information and payment instructions
needed by customers before making a payment.

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

The Firebase UID always comes from:

    req.user.uid

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
          ? req.body.plan
              .trim()
              .toLowerCase()
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

IMPORTANT:

The payment must belong to the authenticated user.

The user ID is NEVER taken from req.body.

========================================================
*/

router.patch(
  "/:paymentId/reference",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const userId =
        req.user.uid;

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
          userId,
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

Admin can retrieve any payment.

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
      CHECK ADMIN
      --------------------------------------------------
      */

      const adminUserId =
        process.env.ADMIN_USER_ID
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

Only the authenticated Admin can approve payments.

Approval will:

1. Verify the payment.
2. Verify the transaction reference.
3. Verify the selected plan.
4. Activate the subscription.
5. Add Pro/Premium credits to creditBalance.
6. Set the subscription expiration to 30 days.
7. Mark the payment as approved.

The payment service performs the user/payment updates
inside one Firestore transaction.

========================================================
*/

router.post(
  "/:paymentId/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const adminUserId =
        req.user.uid;

      const result =
        await approvePayment(
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

Only the authenticated Admin can reject payments.

Optional rejection reason can be supplied.

========================================================
*/

router.post(
  "/:paymentId/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        req.params.paymentId;

      const adminUserId =
        req.user.uid;

      const reason =
        typeof req.body?.reason === "string"
          ? req.body.reason.trim()
          : "";

      const result =
        await rejectPayment(
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

