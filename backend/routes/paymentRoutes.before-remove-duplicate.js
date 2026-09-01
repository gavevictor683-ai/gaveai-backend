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
      paymentInfo: PAYMENT_CONFIG
    });
  }
);

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
        error
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
GET PAYMENT
========================================================

Authenticated users can retrieve a payment only
if the payment belongs to their own Firebase UID.

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
          error: "Payment not found."
        });
      }

      /*
      ----------------------------------------------
      USER CAN ONLY SEE THEIR OWN PAYMENT
      ----------------------------------------------
      */

      if (
        !req.isAdmin &&
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
        error
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

Only the authenticated Admin can approve a payment.

Payment approval activates the user's subscription
and adds the appropriate plan credits.
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
        error
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

Only the authenticated Admin can reject a payment.
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
        error
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

