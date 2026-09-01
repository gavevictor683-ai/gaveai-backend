// ============================================================
// GAVEAI PAYMENT & ADMIN DASHBOARD ROUTES
// FINAL GAVEAI VIDEO CREDIT SYSTEM
// ============================================================
//
// FINAL PLAN
//
// FREE
// ------------------------------------------------------------
// - 1 free video available
// - ONE free video ONLY for lifetime
// - After use: 0 free videos
// - NO daily free video
// - NO daily credits
// - NO 60 credits/day
//
// PRO
// ------------------------------------------------------------
// - $9.99 USD
// - 1,000 credits
// - 30-day entitlement
// - 5 seconds = 15 credits
// - 8 seconds = 24 credits
// - Credits do NOT rollover after expiration
//
// PREMIUM
// ------------------------------------------------------------
// - $19.99 USD
// - 1,500 credits
// - 30-day entitlement
// - 5 seconds = 15 credits
// - 8 seconds = 24 credits
// - Credits do NOT rollover after expiration
//
// VIDEO CREDIT PRICING
// ------------------------------------------------------------
// - 5-second video = 15 credits
// - 8-second video = 24 credits
//
// TOP UP
// ------------------------------------------------------------
// User
//   ↓
// Top Up
//   ↓
// Manual bank payment
//   ↓
// Admin verification
//   ↓
// Payment approved
//   ↓
// Plan credits assigned
//   ↓
// NEW 30-day entitlement
//
// IMPORTANT:
// This entire section must be placed AFTER:
//
// 1. Express app is initialized:
//    const app = express();
//
// 2. Firebase Admin is initialized
//
// 3. Firestore is initialized:
//    const db = admin.firestore();
//
// 4. Express middleware is initialized:
//
//    app.use(cors(...));
//    app.use(express.json(...));
//
// AND BEFORE:
//
//    app.listen(...);
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const ADMIN_USER_ID =
  process.env.ADMIN_USER_ID || "8eGkRNjIqycQa4ZIVwX8r6LVm4u1";


// ============================================================
// FINAL GAVEAI PLAN PRICING
// ============================================================

const PRO_PRICE = 9.99;
const PRO_CREDITS = 1000;

const PREMIUM_PRICE = 19.99;
const PREMIUM_CREDITS = 1500;

const SUBSCRIPTION_DAYS = 30;


// ============================================================
// FINAL VIDEO CREDIT PRICING
// ============================================================
//
// IMPORTANT:
// Both PRO and PREMIUM use the exact same video pricing.
//
// 5 seconds = 15 credits
// 8 seconds = 24 credits
//
// Do NOT change these values in payment routes.
// ============================================================

const VIDEO_CREDIT_COST_5_SECONDS = 15;
const VIDEO_CREDIT_COST_8_SECONDS = 24;


// ============================================================
// CURRENCY
// ============================================================

const GAVEAI_CURRENCY = "USD";


// ============================================================
// BANK TRANSFER INFORMATION
// ============================================================

const GAVEAI_BANK_INFO = {
  bankName: "SOGEBANK",
  accountHolder: "Gave Victor",
  accountNumber: "2611111879",
  swiftBic: "SOGHHTPP",
  currency: "USD"
};


// ============================================================
// PLAN CONFIGURATION HELPER
// ============================================================
//
// Centralized plan configuration prevents different parts of
// the backend from accidentally using different credit values.
//
// ============================================================

const getPlanConfig = (plan) => {

  const normalizedPlan =
    String(plan || "")
      .trim()
      .toLowerCase();

  if (normalizedPlan === "pro") {
    return {
      plan: "pro",
      price: PRO_PRICE,
      credits: PRO_CREDITS,
      durationDays: SUBSCRIPTION_DAYS
    };
  }

  if (normalizedPlan === "premium") {
    return {
      plan: "premium",
      price: PREMIUM_PRICE,
      credits: PREMIUM_CREDITS,
      durationDays: SUBSCRIPTION_DAYS
    };
  }

  return null;
};


// ============================================================
// DATE/TIMESTAMP HELPER
// ============================================================

const getTimestampMillis = (value) => {

  if (!value) {
    return null;
  }

  try {

    if (
      typeof value.toDate === "function"
    ) {
      return value.toDate().getTime();
    }

    if (
      value.seconds !== undefined &&
      value.seconds !== null
    ) {
      return Number(value.seconds) * 1000;
    }

    const parsed =
      new Date(value).getTime();

    if (
      Number.isNaN(parsed)
    ) {
      return null;
    }

    return parsed;

  } catch (error) {

    return null;
  }
};


// ============================================================
// PAYMENT ROUTES HEALTH CHECK
// ============================================================
//
// This route does NOT require authentication.
//
// Used to verify that Render loaded the payment/admin section.
// ============================================================

app.get(
  "/api/payment-routes-status",
  (req, res) => {

    return res.status(200).json({

      success: true,

      message:
        "GaveAI payment/admin routes are loaded",

      service:
        "GaveAI Payment System",

      creditSystem:
        "FINAL GAVEAI VIDEO CREDIT SYSTEM",

      plans: {

        free: {
          freeVideo:
            "1 lifetime video only",

          dailyCredits:
            false
        },

        pro: {
          price:
            PRO_PRICE,

          credits:
            PRO_CREDITS,

          durationDays:
            SUBSCRIPTION_DAYS
        },

        premium: {
          price:
            PREMIUM_PRICE,

          credits:
            PREMIUM_CREDITS,

          durationDays:
            SUBSCRIPTION_DAYS
        }
      },

      videoPricing: {

        fiveSeconds:
          VIDEO_CREDIT_COST_5_SECONDS,

        eightSeconds:
          VIDEO_CREDIT_COST_8_SECONDS
      },

      routes: {

        paymentSystemStatus:
          "GET /api/payment-system-status",

        paymentBankInfo:
          "GET /api/payment-bank-info",

        paymentRequests:
          "POST /api/payment-requests",

        adminOverview:
          "GET /api/admin/overview",

        adminPayments:
          "GET /api/admin/payments",

        adminUsers:
          "GET /api/admin/users",

        approvePayment:
          "POST /api/admin/payment-requests/:id/approve",

        rejectPayment:
          "POST /api/admin/payment-requests/:id/reject"
      },

      timestamp:
        new Date().toISOString()
    });
  }
);


// ============================================================
// ADMIN AUTHENTICATION MIDDLEWARE
// ============================================================

const requireAdmin = async (
  req,
  res,
  next
) => {

  try {

    const authHeader =
      req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ")
    ) {

      return res.status(401).json({

        success: false,

        error:
          "Unauthorized: No Firebase token provided"
      });
    }

    const token =
      authHeader
        .substring("Bearer ".length)
        .trim();

    if (!token) {

      return res.status(401).json({

        success: false,

        error:
          "Unauthorized: Empty Firebase token"
      });
    }

    const decodedToken =
      await admin
        .auth()
        .verifyIdToken(token);

    if (
      !decodedToken ||
      decodedToken.uid !== ADMIN_USER_ID
    ) {

      return res.status(403).json({

        success: false,

        error:
          "Forbidden: Admin access required"
      });
    }

    req.adminUid =
      decodedToken.uid;

    return next();

  } catch (error) {

    console.error(
      "Admin authentication error:",
      error
    );

    return res.status(401).json({

      success: false,

      error:
        "Invalid or expired Firebase token"
    });
  }
};


// ============================================================
// NORMAL USER AUTHENTICATION
// ============================================================

const requireAuthenticatedUser = async (
  req,
  res,
  next
) => {

  try {

    const authHeader =
      req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ")
    ) {

      return res.status(401).json({

        success: false,

        error:
          "Unauthorized: No Firebase token provided"
      });
    }

    const token =
      authHeader
        .substring("Bearer ".length)
        .trim();

    if (!token) {

      return res.status(401).json({

        success: false,

        error:
          "Unauthorized"
      });
    }

    const decodedToken =
      await admin
        .auth()
        .verifyIdToken(token);

    req.authenticatedUser =
      decodedToken;

    req.userUid =
      decodedToken.uid;

    return next();

  } catch (error) {

    console.error(
      "User authentication error:",
      error
    );

    return res.status(401).json({

      success: false,

      error:
        "Invalid or expired Firebase token"
    });
  }
};


// ============================================================
// PAYMENT SYSTEM STATUS
// ============================================================

app.get(
  "/api/payment-system-status",
  (req, res) => {

    return res.json({

      success: true,

      paymentSystem:
        "online",

      creditSystem:
        "final",

      bank:
        GAVEAI_BANK_INFO.bankName,

      currency:
        GAVEAI_CURRENCY,

      plans: {

        free: {

          name:
            "Free",

          price:
            0,

          credits:
            0,

          freeVideoAvailable:
            true,

          freeVideoType:
            "ONE lifetime video only",

          dailyCredits:
            false
        },

        pro: {

          name:
            "Pro",

          price:
            PRO_PRICE,

          credits:
            PRO_CREDITS,

          durationDays:
            SUBSCRIPTION_DAYS,

          videoPricing: {

            fiveSeconds:
              VIDEO_CREDIT_COST_5_SECONDS,

            eightSeconds:
              VIDEO_CREDIT_COST_8_SECONDS
          },

          rollover:
            false
        },

        premium: {

          name:
            "Premium",

          price:
            PREMIUM_PRICE,

          credits:
            PREMIUM_CREDITS,

          durationDays:
            SUBSCRIPTION_DAYS,

          videoPricing: {

            fiveSeconds:
              VIDEO_CREDIT_COST_5_SECONDS,

            eightSeconds:
              VIDEO_CREDIT_COST_8_SECONDS
          },

          rollover:
            false
        }
      }
    });
  }
);


// ============================================================
// GET BANK TRANSFER INFORMATION
// ============================================================

app.get(
  "/api/payment-bank-info",
  (req, res) => {

    return res.json({

      success: true,

      bank:
        GAVEAI_BANK_INFO
    });
  }
);


// ============================================================
// USER SUBMITS PAYMENT REQUEST
// ============================================================

app.post(
  "/api/payment-requests",
  requireAuthenticatedUser,
  async (req, res) => {

    try {

      const userId =
        req.userUid;

      const {
        plan,
        amount,
        currency,
        bankName,
        accountHolderFullName,
        transactionDate,
        transactionTime,
        description,
        proofImageUrl
      } = req.body || {};


      // --------------------------------------------------------
      // REQUIRED PLAN
      // --------------------------------------------------------

      if (!plan) {

        return res.status(400).json({

          success: false,

          error:
            "Selected plan is required"
        });
      }


      // --------------------------------------------------------
      // NORMALIZE PLAN
      // --------------------------------------------------------

      const planLower =
        String(plan)
          .trim()
          .toLowerCase();

      const planConfig =
        getPlanConfig(planLower);


      if (!planConfig) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid plan. Select Pro or Premium."
        });
      }


      // --------------------------------------------------------
      // REQUIRED AMOUNT
      // --------------------------------------------------------

      if (
        amount === undefined ||
        amount === null ||
        amount === "" ||
        Number.isNaN(Number(amount))
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Transaction amount is required"
        });
      }


      const numericAmount =
        Number(amount);


      // --------------------------------------------------------
      // REQUIRED CURRENCY
      // --------------------------------------------------------

      const normalizedCurrency =
        String(
          currency || GAVEAI_CURRENCY
        )
          .trim()
          .toUpperCase();


      if (
        normalizedCurrency !==
        GAVEAI_CURRENCY
      ) {

        return res.status(400).json({

          success: false,

          error:
            "GaveAI payments must be made in USD."
        });
      }


      // --------------------------------------------------------
      // REQUIRED BANK NAME
      // --------------------------------------------------------

      if (
        !bankName ||
        !String(bankName).trim()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Bank Name is required"
        });
      }


      // --------------------------------------------------------
      // REQUIRED ACCOUNT HOLDER
      // --------------------------------------------------------

      if (
        !accountHolderFullName ||
        !String(accountHolderFullName).trim()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Account Holder Full Name is required"
        });
      }


      // --------------------------------------------------------
      // REQUIRED TRANSACTION DATE
      // --------------------------------------------------------

      if (!transactionDate) {

        return res.status(400).json({

          success: false,

          error:
            "Transaction Date is required"
        });
      }


      // --------------------------------------------------------
      // REQUIRED TRANSACTION TIME
      // --------------------------------------------------------

      if (!transactionTime) {

        return res.status(400).json({

          success: false,

          error:
            "Transaction Time is required"
        });
      }


      // --------------------------------------------------------
      // REQUIRED PAYMENT PROOF
      // --------------------------------------------------------

      if (
        !proofImageUrl ||
        !String(proofImageUrl).trim()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Payment Proof / Screenshot is required"
        });
      }


      // --------------------------------------------------------
      // PLAN PRICE VALIDATION
      // --------------------------------------------------------

      if (
        Math.abs(
          numericAmount -
          planConfig.price
        ) > 0.01
      ) {

        return res.status(400).json({

          success: false,

          error:
            planLower === "pro"

              ? "Pro Plan requires a payment of $9.99 USD"

              : "Premium Plan requires a payment of $19.99 USD"
        });
      }


      // --------------------------------------------------------
      // GET USER PROFILE
      // --------------------------------------------------------

      const userRef =
        db
          .collection("users")
          .doc(userId);

      const userSnap =
        await userRef.get();


      if (!userSnap.exists) {

        return res.status(404).json({

          success: false,

          error:
            "User profile not found"
        });
      }


      const userData =
        userSnap.data() || {};


      // --------------------------------------------------------
      // CREATE PAYMENT REQUEST
      // --------------------------------------------------------

      const paymentRequest = {

        userId,

        userEmail:
          userData.email ||
          req.authenticatedUser.email ||
          "",

        userFullName:
          userData.fullName ||
          userData.displayName ||
          "",

        plan:
          planLower,

        amount:
          numericAmount,

        currency:
          normalizedCurrency,

        bankName:
          String(bankName).trim(),

        accountHolderFullName:
          String(
            accountHolderFullName
          ).trim(),

        transactionDate:
          String(
            transactionDate
          ).trim(),

        transactionTime:
          String(
            transactionTime
          ).trim(),

        description:
          description
            ? String(description).trim()
            : "",

        proofImageUrl:
          String(proofImageUrl).trim(),

        status:
          "pending",

        requestedCredits:
          planConfig.credits,

        requestedDurationDays:
          SUBSCRIPTION_DAYS,

        createdAt:
          admin.firestore
            .FieldValue
            .serverTimestamp()
      };


      const paymentRef =
        await db
          .collection("paymentRequests")
          .add(paymentRequest);


      console.log(
        `Payment request created: ${paymentRef.id} | User: ${userId} | Plan: ${planLower} | Amount: $${numericAmount} USD | Credits: ${planConfig.credits}`
      );


      return res.status(201).json({

        success: true,

        message:
          "Payment request submitted successfully. Admin will verify the payment.",

        id:
          paymentRef.id,

        plan:
          planLower,

        credits:
          planConfig.credits,

        amount:
          numericAmount,

        currency:
          GAVEAI_CURRENCY
      });


    } catch (error) {

      console.error(
        "Create payment request error:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          "Failed to create payment request"
      });
    }
  }
);


// ============================================================
// ADMIN OVERVIEW
// ============================================================

app.get(
  "/api/admin/overview",
  requireAdmin,
  async (req, res) => {

    try {

      const [
        usersSnap,
        paymentsSnap
      ] = await Promise.all([

        db
          .collection("users")
          .get(),

        db
          .collection("paymentRequests")
          .get()
      ]);


      let totalUsers = 0;

      let activePro = 0;

      let activePremium = 0;

      let expiredSubs = 0;

      let freeUsers = 0;

      let pendingPayments = 0;

      let approvedPayments = 0;

      let rejectedPayments = 0;

      let totalRevenue = 0;

      let totalPaidCreditsIssued = 0;


      const now =
        Date.now();


      // --------------------------------------------------------
      // USERS
      // --------------------------------------------------------

      usersSnap.forEach((doc) => {

        totalUsers++;

        const user =
          doc.data() || {};


        const plan =
          String(
            user.subscriptionPlan ||
            user.plan ||
            "free"
          )
            .trim()
            .toLowerCase();


        const expiresAt =
          getTimestampMillis(
            user.subscriptionExpiresAt
          );


        if (
          plan === "pro"
        ) {

          if (
            expiresAt &&
            expiresAt > now
          ) {

            activePro++;

          } else {

            expiredSubs++;
          }

        } else if (
          plan === "premium"
        ) {

          if (
            expiresAt &&
            expiresAt > now
          ) {

            activePremium++;

          } else {

            expiredSubs++;
          }

        } else {

          freeUsers++;
        }
      });


      // --------------------------------------------------------
      // PAYMENTS
      // --------------------------------------------------------

      paymentsSnap.forEach((doc) => {

        const payment =
          doc.data() || {};


        const status =
          String(
            payment.status ||
            "pending"
          )
            .trim()
            .toLowerCase();


        if (
          status === "pending"
        ) {

          pendingPayments++;
        }


        if (
          status === "approved"
        ) {

          approvedPayments++;


          const amount =
            Number(
              payment.amount || 0
            );


          if (
            !Number.isNaN(amount)
          ) {

            totalRevenue +=
              amount;
          }


          const credits =
            Number(
              payment.approvedCredits ||
              payment.requestedCredits ||
              0
            );


          if (
            !Number.isNaN(credits)
          ) {

            totalPaidCreditsIssued +=
              credits;
          }
        }


        if (
          status === "rejected"
        ) {

          rejectedPayments++;
        }
      });


      return res.json({

        success: true,

        totalUsers,

        freeUsers,

        activePro,

        activePremium,

        expiredSubs,

        pendingPayments,

        approvedPayments,

        rejectedPayments,

        totalRevenue:
          Number(
            totalRevenue.toFixed(2)
          ),

        totalPaidCreditsIssued,

        creditSystem:
          "FINAL",

        plans: {

          pro: {

            price:
              PRO_PRICE,

            credits:
              PRO_CREDITS,

            durationDays:
              SUBSCRIPTION_DAYS
          },

          premium: {

            price:
              PREMIUM_PRICE,

            credits:
              PREMIUM_CREDITS,

            durationDays:
              SUBSCRIPTION_DAYS
          }
        },

        videoPricing: {

          fiveSeconds:
            VIDEO_CREDIT_COST_5_SECONDS,

          eightSeconds:
            VIDEO_CREDIT_COST_8_SECONDS
        }
      });


    } catch (error) {

      console.error(
        "Admin overview error:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          "Failed to load overview"
      });
    }
  }
);


// ============================================================
// ADMIN PAYMENT REQUESTS
// ============================================================

app.get(
  "/api/admin/payments",
  requireAdmin,
  async (req, res) => {

    try {

      const filter =
        String(
          req.query.filter || "all"
        )
          .trim()
          .toLowerCase();


      const validFilters = [

        "all",

        "pending",

        "approved",

        "rejected"
      ];


      if (
        !validFilters.includes(filter)
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid payment filter"
        });
      }


      let snap;


      if (
        filter === "all"
      ) {

        snap =
          await db
            .collection("paymentRequests")
            .get();

      } else {

        snap =
          await db
            .collection("paymentRequests")
            .where(
              "status",
              "==",
              filter
            )
            .get();
      }


      const payments = [];

      const userIds =
        new Set();


      snap.forEach((doc) => {

        const data =
          doc.data() || {};


        payments.push({

          id:
            doc.id,

          ...data
        });


        if (
          data.userId
        ) {

          userIds.add(
            data.userId
          );
        }
      });


      // --------------------------------------------------------
      // SORT NEWEST FIRST
      // --------------------------------------------------------

      payments.sort((a, b) => {

        return (

          getTimestampMillis(
            b.createdAt
          ) || 0

        ) - (

          getTimestampMillis(
            a.createdAt
          ) || 0
        );
      });


      // --------------------------------------------------------
      // LOAD USER DATA
      // --------------------------------------------------------

      const userDataMap = {};


      await Promise.all(

        Array.from(userIds).map(
          async (uid) => {

            try {

              const userSnap =
                await db
                  .collection("users")
                  .doc(uid)
                  .get();


              if (
                userSnap.exists
              ) {

                userDataMap[uid] = {

                  id:
                    userSnap.id,

                  ...userSnap.data()
                };
              }

            } catch (userError) {

              console.error(
                `Could not load user ${uid}:`,
                userError
              );
            }
          }
        )
      );


      // --------------------------------------------------------
      // ENRICH PAYMENT DATA
      // --------------------------------------------------------

      const enrichedPayments =
        payments.map(
          (payment) => {

            const userData =
              userDataMap[
                payment.userId
              ] || {};


            const paymentPlan =
              getPlanConfig(
                payment.plan
              );


            return {

              ...payment,

              userData,

              userFullName:
                payment.userFullName ||
                userData.fullName ||
                userData.displayName ||
                "",

              userEmail:
                payment.userEmail ||
                userData.email ||
                "",

              userProfilePhoto:
                userData.profilePhoto ||
                userData.photoURL ||
                userData.avatar ||
                "",

              requestedCredits:
                payment.requestedCredits ||
                paymentPlan?.credits ||
                0,

              requestedDurationDays:
                payment.requestedDurationDays ||
                SUBSCRIPTION_DAYS,

              approvedCredits:
                payment.approvedCredits ||
                0
            };
          }
        );


      return res.json({

        success: true,

        payments:
          enrichedPayments,

        count:
          enrichedPayments.length
      });


    } catch (error) {

      console.error(
        "Admin payments error:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          "Failed to load payments"
      });
    }
  }
);


// ============================================================
// ADMIN USERS & SUBSCRIPTIONS
// ============================================================

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {

    try {

      const [
        usersSnap,
        paymentsSnap
      ] = await Promise.all([

        db
          .collection("users")
          .get(),

        db
          .collection("paymentRequests")
          .get()
      ]);


      const userPaymentStats = {};


      // --------------------------------------------------------
      // PAYMENT STATISTICS
      // --------------------------------------------------------

      paymentsSnap.forEach((doc) => {

        const payment =
          doc.data() || {};


        const uid =
          payment.userId;


        if (!uid) {
          return;
        }


        if (
          !userPaymentStats[uid]
        ) {

          userPaymentStats[uid] = {

            approved:
              0,

            total:
              0,

            lastAmount:
              0,

            lastDate:
              null,

            lastRequestId:
              "",

            totalCreditsIssued:
              0
          };
        }


        userPaymentStats[uid]
          .total++;


        if (
          String(
            payment.status || ""
          )
            .trim()
            .toLowerCase() ===
          "approved"
        ) {

          userPaymentStats[uid]
            .approved++;


          const credits =
            Number(
              payment.approvedCredits ||
              payment.requestedCredits ||
              0
            );


          if (
            !Number.isNaN(credits)
          ) {

            userPaymentStats[uid]
              .totalCreditsIssued +=
              credits;
          }


          const paymentTime =
            getTimestampMillis(
              payment.approvedAt ||
              payment.createdAt
            );


          if (
            paymentTime
          ) {

            const existing =
              userPaymentStats[uid]
                .lastDate;


            const existingTime =
              existing
                ? existing.getTime()
                : 0;


            if (
              !existing ||
              paymentTime >
                existingTime
            ) {

              userPaymentStats[uid]
                .lastDate =
                new Date(paymentTime);


              userPaymentStats[uid]
                .lastAmount =
                Number(
                  payment.amount ||
                  0
                );


              userPaymentStats[uid]
                .lastRequestId =
                doc.id;
            }
          }
        }
      });


      // --------------------------------------------------------
      // BUILD USERS
      // --------------------------------------------------------

      const users = [];

      const now =
        Date.now();


      usersSnap.forEach((doc) => {

        const data =
          doc.data() || {};


        const plan =
          String(
            data.subscriptionPlan ||
            data.plan ||
            "free"
          )
            .trim()
            .toLowerCase();


        const expiresAt =
          getTimestampMillis(
            data.subscriptionExpiresAt
          );


        let subscriptionStatus =
          "free";


        if (
          plan === "pro" ||
          plan === "premium"
        ) {

          if (
            expiresAt &&
            expiresAt > now
          ) {

            subscriptionStatus =
              "active";

          } else {

            subscriptionStatus =
              "expired";
          }
        }


        const stats =
          userPaymentStats[
            doc.id
          ] || {

            approved:
              0,

            total:
              0,

            lastAmount:
              0,

            lastDate:
              null,

            lastRequestId:
              "",

            totalCreditsIssued:
              0
          };


        // ------------------------------------------------------
        // REMAINING PAID CREDITS
        // ------------------------------------------------------

        const currentCredits =
          Number(
            data.credits || 0
          );


        // ------------------------------------------------------
        // FREE VIDEO STATUS
        // ------------------------------------------------------
        //
        // We intentionally do NOT modify this value when a
        // payment is approved.
        //
        // Free video is a separate lifetime entitlement.
        // ------------------------------------------------------

        const freeVideoAvailable =
          data.freeVideoAvailable === true;


        users.push({

          id:
            doc.id,

          ...data,

          plan,

          subscriptionPlan:
            plan,

          subscriptionStatus,

          subscriptionExpiresAt:
            data.subscriptionExpiresAt ||
            null,

          credits:
            Number.isNaN(
              currentCredits
            )
              ? 0
              : currentCredits,

          freeVideoAvailable,

          approvedPaymentsCount:
            stats.approved,

          totalPaymentRequests:
            stats.total,

          totalCreditsIssued:
            stats.totalCreditsIssued,

          lastPaymentAmount:
            stats.lastAmount,

          lastPaymentDate:
            stats.lastDate,

          lastPaymentRequestId:
            stats.lastRequestId
        });
      });


      // --------------------------------------------------------
      // SORT NEWEST USERS FIRST
      // --------------------------------------------------------

      users.sort((a, b) => {

        return (

          getTimestampMillis(
            b.createdAt
          ) || 0

        ) - (

          getTimestampMillis(
            a.createdAt
          ) || 0
        );
      });


      return res.json({

        success: true,

        users,

        count:
          users.length
      });


    } catch (error) {

      console.error(
        "Admin users error:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          "Failed to load users"
      });
    }
  }
);


// ============================================================
// ADMIN APPROVE PAYMENT
// ============================================================
//
// IMPORTANT:
//
// Every approved payment creates a NEW 30-day entitlement.
//
// Example:
//
// User has:
//   Pro
//   120 credits
//   10 days remaining
//
// User buys Pro again.
//
// After approval:
//   Pro
//   1,000 credits
//   NEW 30 days
//
// The old credits do NOT get added.
// The old expiration does NOT get extended.
//
// This implements the FINAL GAVEAI PLAN exactly.
//
// ============================================================

app.post(
  "/api/admin/payment-requests/:id/approve",
  requireAdmin,
  async (req, res) => {

    const paymentId =
      req.params.id;

    const adminUid =
      req.adminUid;


    try {

      await db.runTransaction(
        async (transaction) => {

          // ----------------------------------------------------
          // PAYMENT REFERENCE
          // ----------------------------------------------------

          const paymentRef =
            db
              .collection(
                "paymentRequests"
              )
              .doc(paymentId);


          // ----------------------------------------------------
          // GET PAYMENT
          // ----------------------------------------------------

          const paymentDoc =
            await transaction.get(
              paymentRef
            );


          if (
            !paymentDoc.exists
          ) {

            throw new Error(
              "PAYMENT_NOT_FOUND"
            );
          }


          const payment =
            paymentDoc.data() || {};


          // ----------------------------------------------------
          // CURRENT PAYMENT STATUS
          // ----------------------------------------------------

          const currentStatus =
            String(
              payment.status ||
              "pending"
            )
              .trim()
              .toLowerCase();


          if (
            currentStatus ===
            "approved"
          ) {

            throw new Error(
              "ALREADY_APPROVED"
            );
          }


          if (
            currentStatus ===
            "rejected"
          ) {

            throw new Error(
              "ALREADY_REJECTED"
            );
          }


          if (
            currentStatus !==
            "pending"
          ) {

            throw new Error(
              "INVALID_PAYMENT_STATUS"
            );
          }


          // ----------------------------------------------------
          // PLAN
          // ----------------------------------------------------

          const plan =
            String(
              payment.plan || ""
            )
              .trim()
              .toLowerCase();


          const planConfig =
            getPlanConfig(plan);


          if (!planConfig) {

            throw new Error(
              "INVALID_PLAN"
            );
          }


          const credits =
            planConfig.credits;


          const expectedAmount =
            planConfig.price;


          // ----------------------------------------------------
          // PAYMENT AMOUNT
          // ----------------------------------------------------

          const paymentAmount =
            Number(
              payment.amount
            );


          if (
            Number.isNaN(
              paymentAmount
            )
          ) {

            throw new Error(
              "INVALID_PAYMENT_AMOUNT"
            );
          }


          // ----------------------------------------------------
          // PAYMENT CURRENCY
          // ----------------------------------------------------

          const paymentCurrency =
            String(
              payment.currency ||
              GAVEAI_CURRENCY
            )
              .trim()
              .toUpperCase();


          if (
            paymentCurrency !==
            GAVEAI_CURRENCY
          ) {

            throw new Error(
              "INVALID_CURRENCY"
            );
          }


          // ----------------------------------------------------
          // AMOUNT MATCH
          // ----------------------------------------------------

          if (
            Math.abs(
              paymentAmount -
              expectedAmount
            ) > 0.01
          ) {

            throw new Error(
              "AMOUNT_MISMATCH"
            );
          }


          // ----------------------------------------------------
          // USER ID
          // ----------------------------------------------------

          if (
            !payment.userId
          ) {

            throw new Error(
              "USER_ID_MISSING"
            );
          }


          // ----------------------------------------------------
          // USER REFERENCE
          // ----------------------------------------------------

          const userRef =
            db
              .collection("users")
              .doc(payment.userId);


          const userDoc =
            await transaction.get(
              userRef
            );


          if (
            !userDoc.exists
          ) {

            throw new Error(
              "USER_NOT_FOUND"
            );
          }


          // ----------------------------------------------------
          // DUPLICATE TRANSACTION CHECK
          // ----------------------------------------------------
          //
          // Prevent the same bank transaction from being
          // approved more than once.
          //
          // ----------------------------------------------------

          const duplicateQuery =
            db
              .collection(
                "paymentRequests"
              )
              .where(
                "status",
                "==",
                "approved"
              )
              .where(
                "bankName",
                "==",
                payment.bankName
              )
              .where(
                "accountHolderFullName",
                "==",
                payment.accountHolderFullName
              )
              .where(
                "amount",
                "==",
                paymentAmount
              )
              .where(
                "transactionDate",
                "==",
                payment.transactionDate
              )
              .where(
                "transactionTime",
                "==",
                payment.transactionTime
              )
              .limit(10);


          const duplicateSnapshot =
            await transaction.get(
              duplicateQuery
            );


          let duplicateFound =
            false;


          duplicateSnapshot.forEach(
            (duplicateDoc) => {

              if (
                duplicateDoc.id !==
                paymentId
              ) {

                duplicateFound =
                  true;
              }
            }
          );


          if (
            duplicateFound
          ) {

            throw new Error(
              "DUPLICATE_TRANSACTION"
            );
          }


          // ----------------------------------------------------
          // NEW 30-DAY ENTITLEMENT
          // ----------------------------------------------------
          //
          // IMPORTANT:
          //
          // Always start from NOW.
          //
          // Do NOT add 30 days to the old expiration.
          //
          // Do NOT preserve old credits.
          //
          // This is a NEW entitlement.
          //
          // ----------------------------------------------------

          const approvalDate =
            new Date();


          const newExpiresAt =
            new Date(
              approvalDate.getTime() +
              SUBSCRIPTION_DAYS *
              24 *
              60 *
              60 *
              1000
            );


          // ----------------------------------------------------
          // UPDATE PAYMENT REQUEST
          // ----------------------------------------------------

          transaction.update(
            paymentRef,
            {

              status:
                "approved",

              approvedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              approvedBy:
                adminUid,

              approvedPlan:
                plan,

              approvedCredits:
                credits,

              approvedAmount:
                paymentAmount,

              approvedCurrency:
                GAVEAI_CURRENCY,

              entitlementDays:
                SUBSCRIPTION_DAYS,

              entitlementType:
                "new_30_day_entitlement"
            }
          );


          // ----------------------------------------------------
          // UPDATE USER
          // ----------------------------------------------------
          //
          // FINAL CREDIT SYSTEM:
          //
          // Pro:
          //   credits = 1000
          //
          // Premium:
          //   credits = 1500
          //
          // IMPORTANT:
          // Existing credits are NOT added.
          //
          // Example:
          //
          // Existing:
          //   200 credits
          //
          // New Pro payment:
          //   1000 credits
          //
          // Result:
          //   1000 credits
          //
          // ----------------------------------------------------

          transaction.set(
            userRef,
            {

              plan:
                plan,

              subscriptionPlan:
                plan,

              credits:
                credits,

              subscriptionStatus:
                "active",

              subscriptionStartedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              subscriptionExpiresAt:
                admin.firestore
                  .Timestamp
                  .fromDate(
                    newExpiresAt
                  ),

              // ------------------------------------------------
              // FINAL SYSTEM FLAGS
              // ------------------------------------------------
              //
              // No daily reset fields.
              // No 60 credits/day.
              // No free video manipulation.
              //
              // ------------------------------------------------

              creditSystem:
                "final",

              creditPlan:
                plan,

              creditEntitlement:
                credits,

              creditEntitlementStartedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              creditEntitlementExpiresAt:
                admin.firestore
                  .Timestamp
                  .fromDate(
                    newExpiresAt
                  ),

              creditsLastResetReason:
                "new_paid_entitlement",

              creditsLastResetAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp(),

              lastPaymentAmount:
                paymentAmount,

              lastPaymentRequestId:
                paymentId,

              lastPaymentPlan:
                plan,

              lastPaymentCredits:
                credits,

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()

            },
            {
              merge:
                true
            }
          );
        }
      );


      console.log(
        `============================================================`
      );

      console.log(
        `GAVEAI PAYMENT APPROVED`
      );

      console.log(
        `Payment ID: ${paymentId}`
      );

      console.log(
        `Admin: ${adminUid}`
      );

      console.log(
        `NEW PLAN: payment plan`
      );

      console.log(
        `NEW 30-DAY ENTITLEMENT CREATED`
      );

      console.log(
        `============================================================`
      );


      return res.json({

        success:
          true,

        message:
          "Payment approved. User received a new 30-day credit entitlement.",

        paymentId
      });


    } catch (error) {

      console.error(
        "Approve payment error:",
        error
      );


      let errorMsg =
        "Failed to approve payment";


      if (
        error.message ===
        "PAYMENT_NOT_FOUND"
      ) {

        errorMsg =
          "Payment request not found";


      } else if (
        error.message ===
        "ALREADY_APPROVED"
      ) {

        errorMsg =
          "This payment has already been approved";


      } else if (
        error.message ===
        "ALREADY_REJECTED"
      ) {

        errorMsg =
          "This payment was already rejected";


      } else if (
        error.message ===
        "INVALID_PAYMENT_STATUS"
      ) {

        errorMsg =
          "Payment is not pending";


      } else if (
        error.message ===
        "DUPLICATE_TRANSACTION"
      ) {

        errorMsg =
          "Duplicate transaction detected. This bank transaction was already approved.";


      } else if (
        error.message ===
        "INVALID_PLAN"
      ) {

        errorMsg =
          "Invalid plan specified. Only Pro and Premium are allowed.";


      } else if (
        error.message ===
        "INVALID_PAYMENT_AMOUNT"
      ) {

        errorMsg =
          "Invalid payment amount.";


      } else if (
        error.message ===
        "AMOUNT_MISMATCH"
      ) {

        errorMsg =
          "Payment amount does not match the selected plan.";


      } else if (
        error.message ===
        "INVALID_CURRENCY"
      ) {

        errorMsg =
          "Only USD payments are accepted.";


      } else if (
        error.message ===
        "USER_ID_MISSING"
      ) {

        errorMsg =
          "Payment request has no user ID.";


      } else if (
        error.message ===
        "USER_NOT_FOUND"
      ) {

        errorMsg =
          "User account associated with this payment was not found.";
      }


      return res.status(400).json({

        success:
          false,

        error:
          errorMsg
      });
    }
  }
);


// ============================================================
// ADMIN REJECT PAYMENT
// ============================================================

app.post(
  "/api/admin/payment-requests/:id/reject",
  requireAdmin,
  async (req, res) => {

    const paymentId =
      req.params.id;

    const adminUid =
      req.adminUid;


    const {
      reason
    } = req.body || {};


    if (
      !reason ||
      !String(reason).trim()
    ) {

      return res.status(400).json({

        success: false,

        error:
          "Rejection reason is required"
      });
    }


    try {

      const paymentRef =
        db
          .collection(
            "paymentRequests"
          )
          .doc(paymentId);


      const paymentDoc =
        await paymentRef.get();


      if (
        !paymentDoc.exists
      ) {

        return res.status(404).json({

          success: false,

          error:
            "Payment request not found"
        });
      }


      const payment =
        paymentDoc.data() || {};


      const status =
        String(
          payment.status ||
          "pending"
        )
          .trim()
          .toLowerCase();


      if (
        status === "approved"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "This payment has already been approved"
        });
      }


      if (
        status === "rejected"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "This payment has already been rejected"
        });
      }


      if (
        status !== "pending"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Payment is not pending"
        });
      }


      await paymentRef.update({

        status:
          "rejected",

        rejectedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),

        rejectedBy:
          adminUid,

        rejectionReason:
          String(reason).trim()
      });


      console.log(
        `Payment rejected: ${paymentId} by ${adminUid}`
      );


      return res.json({

        success:
          true,

        message:
          "Payment rejected successfully.",

        paymentId
      });


    } catch (error) {

      console.error(
        "Reject payment error:",
        error
      );


      return res.status(500).json({

        success:
          false,

        error:
          "Failed to reject payment"
      });
    }
  }
);


// ============================================================
// PAYMENT/ADMIN ROUTES LOADED CONFIRMATION
// ============================================================

console.log(
  "============================================================"
);

console.log(
  "GAVEAI PAYMENT & ADMIN ROUTES LOADED"
);

console.log(
  "CREDIT SYSTEM: FINAL"
);

console.log(
  "FREE: 1 lifetime free video"
);

console.log(
  "PRO: $9.99 = 1,000 credits / 30 days"
);

console.log(
  "PREMIUM: $19.99 = 1,500 credits / 30 days"
);

console.log(
  "5-second video = 15 credits"
);

console.log(
  "8-second video = 24 credits"
);

console.log(
  "NO daily credits"
);

console.log(
  "NO 60 credits/day"
);

console.log(
  "NO credit rollover"
);

console.log(
  "Every approved payment = NEW 30-day entitlement"
);

console.log(
  "GET  /api/payment-routes-status"
);

console.log(
  "GET  /api/payment-system-status"
);

console.log(
  "GET  /api/payment-bank-info"
);

console.log(
  "POST /api/payment-requests"
);

console.log(
  "GET  /api/admin/overview"
);

console.log(
  "GET  /api/admin/payments"
);

console.log(
  "GET  /api/admin/users"
);

console.log(
  "POST /api/admin/payment-requests/:id/approve"
);

console.log(
  "POST /api/admin/payment-requests/:id/reject"
);

console.log(
  "============================================================"
);


// ============================================================
// END OF GAVEAI PAYMENT & ADMIN DASHBOARD ROUTES
// ============================================================
//
// IMPORTANT:
// app.listen(...) MUST remain BELOW this entire section.
//
// Example:
//
// const PORT = process.env.PORT || 3000;
//
// app.listen(PORT, () => {
//   console.log(`GaveAI backend running on port ${PORT}`);
// });
//
// ============================================================