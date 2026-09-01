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

Example:
GET /api/payments/plans
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

Returns the bank/payment instructions that customers
need before making a manual USD bank transfer.

Example:
GET /api/payments/payment-info
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
- Firebase UID comes from req.user.uid.
- Never trust req.body.userId.
- The selected plan is validated by paymentService.js.
- Payment is created as pending until Admin approval.

Example:
POST /api/payments

Body:
{
  "plan": "pro"
}

or:

{
  "plan": "premium"
}
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
UPDATE TRANSACTION REFERENCE
========================================================

Authenticated users only.

The customer submits the bank transaction/reference
number after completing the USD bank transfer.

IMPORTANT:
- Payment must belong to authenticated user.
- User ID comes from Firebase authentication.
- User cannot update another user's payment.
- The actual ownership/status validation is handled
  by paymentService.js.

Example:
PATCH /api/payments/:paymentId/reference

Body:
{
  "transactionReference": "ABC123456"
}
========================================================
*/

router.patch(
  "/:paymentId/reference",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;

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

Authenticated users can retrieve only their own payment.

Admin can retrieve any payment.

IMPORTANT:
Admin access is determined by requireAuth/authMiddleware
and the configured ADMIN_USER_ID.

Example:
GET /api/payments/:paymentId
========================================================
*/

router.get(
  "/:paymentId",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          error: "Payment ID is required."
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
      ADMIN CHECK
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

Admin only.

Approval is handled by paymentService.js.

The service is responsible for:
1. Verifying the payment.
2. Verifying the transaction reference.
3. Verifying the selected plan.
4. Activating the subscription.
5. Adding the appropriate credits.
6. Setting the subscription expiration.
7. Marking the payment as approved.
8. Preventing duplicate approval.

Example:
POST /api/payments/:paymentId/approve
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

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          error: "Payment ID is required."
        });
      }

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

Admin only.

Optional rejection reason.

Example:
POST /api/payments/:paymentId/reject

Body:
{
  "reason": "Transaction could not be verified."
}
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

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          error: "Payment ID is required."
        });
      }

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

