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

const router =
  express.Router();


/*
========================================================
GET AVAILABLE PLANS
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
that customers need before making a payment.

========================================================
*/

router.get(
  "/payment-info",
  (req, res) => {
    return res.json({
      success: true,
      paymentInfo:
        PAYMENT_CONFIG
    });
  }
);


/*
========================================================
CREATE PAYMENT REQUEST
========================================================

Authenticated users only.

The user ID ALWAYS comes from Firebase authentication.

We do NOT trust req.body.userId.

========================================================
*/

router.post(
  "/",
  requireAuth,
  async (req, res) => {
    try {

      const userId =
        req.user.uid;

      const plan =
        typeof req.body?.plan === "string"
          ? req.body.plan
              .trim()
              .toLowerCase()
          : "";

      if (!plan) {
        return res.status(400).json({
          success: false,
          error:
            "Payment plan is required."
        });
      }

      const user =
        await getUser(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          error:
            "User account not found."
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

Authenticated users can submit their bank transfer
transaction/reference number.

The payment must belong to the authenticated user.

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
        typeof req.body?.transactionReference ===
        "string"
          ? req.body.transactionReference.trim()
          : "";

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

Authenticated users can retrieve a payment only if
the payment belongs to their own Firebase UID.

Admin can retrieve any payment.

========================================================
*/

router.get(
  "/:paymentId",
  requireAuth,
  async (req, res) => {
    try {

      const payment =
        await getPayment(
          req.params.paymentId
        );

      if (!payment) {
        return res.status(404).json({
          success: false,
          error:
            "Payment not found."
        });
      }

      /*
      ----------------------------------------------
      USER CAN ONLY SEE THEIR OWN PAYMENT
      ----------------------------------------------
      */

      if (
        !req.isAdmin &&
        payment.userId !==
          req.user.uid
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

Approval will:

1. Verify the transaction reference.
2. Verify the plan.
3. Activate the subscription.
4. Add the plan credits to creditBalance.
5. Extend an existing active subscription.
6. Mark the payment as approved.

All operations happen inside the payment service
Firestore transaction.

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

Admin only.

Optional rejection reason can be supplied.

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
EXPORT
========================================================
*/

module.exports = router;

