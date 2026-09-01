// ============================================================
// GAVEAI PAYMENT & ADMIN DASHBOARD ROUTES
// ============================================================
//
// IMPORTANT:
// This entire section must be placed AFTER:
//
// 1. Express app is initialized:
//    const app = express();
//
// 2. Firebase Admin is initialized:
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

const PRO_PRICE = 9.99;
const PRO_CREDITS = 1200;

const PREMIUM_PRICE = 19.99;
const PREMIUM_CREDITS = 3000;

const SUBSCRIPTION_DAYS = 30;


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
// PAYMENT ROUTES HEALTH CHECK
// ============================================================
//
// This route does NOT require authentication.
//
// It is specifically here so we can verify that Render has
// actually loaded this payment/admin section.
//
// If this endpoint returns 200, these routes are registered.
// ============================================================

app.get("/api/payment-routes-status", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "GaveAI payment/admin routes are loaded",
    service: "GaveAI Payment System",
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
    timestamp: new Date().toISOString()
  });
});


// ============================================================
// ADMIN AUTHENTICATION MIDDLEWARE
// ============================================================

const requireAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: No Firebase token provided"
      });
    }

    const token =
      authHeader.substring("Bearer ".length).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Empty Firebase token"
      });
    }

    const decodedToken =
      await admin.auth().verifyIdToken(token);

    if (
      !decodedToken ||
      decodedToken.uid !== ADMIN_USER_ID
    ) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Admin access required"
      });
    }

    req.adminUid = decodedToken.uid;

    return next();

  } catch (error) {
    console.error(
      "Admin authentication error:",
      error
    );

    return res.status(401).json({
      success: false,
      error: "Invalid or expired Firebase token"
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
        error: "Unauthorized: No Firebase token provided"
      });
    }

    const token =
      authHeader.substring("Bearer ".length).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized"
      });
    }

    const decodedToken =
      await admin.auth().verifyIdToken(token);

    req.authenticatedUser = decodedToken;
    req.userUid = decodedToken.uid;

    return next();

  } catch (error) {
    console.error(
      "User authentication error:",
      error
    );

    return res.status(401).json({
      success: false,
      error: "Invalid or expired Firebase token"
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
      paymentSystem: "online",

      bank: GAVEAI_BANK_INFO.bankName,

      currency:
        GAVEAI_BANK_INFO.currency,

      plans: {
        pro: {
          price: PRO_PRICE,
          credits: PRO_CREDITS,
          durationDays:
            SUBSCRIPTION_DAYS
        },

        premium: {
          price: PREMIUM_PRICE,
          credits: PREMIUM_CREDITS,
          durationDays:
            SUBSCRIPTION_DAYS
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
      bank: GAVEAI_BANK_INFO
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
      const userId = req.userUid;

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
      // REQUIRED FIELD VALIDATION
      // --------------------------------------------------------

      if (!plan) {
        return res.status(400).json({
          success: false,
          error: "Selected plan is required"
        });
      }

      const planLower =
        String(plan)
          .trim()
          .toLowerCase();

      if (
        planLower !== "pro" &&
        planLower !== "premium"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid plan. Select Pro or Premium."
        });
      }

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

      if (
        !bankName ||
        !String(bankName).trim()
      ) {
        return res.status(400).json({
          success: false,
          error: "Bank Name is required"
        });
      }

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

      if (!transactionDate) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction Date is required"
        });
      }

      if (!transactionTime) {
        return res.status(400).json({
          success: false,
          error:
            "Transaction Time is required"
        });
      }

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

      const numericAmount =
        Number(amount);

      // --------------------------------------------------------
      // PLAN PRICE VALIDATION
      // --------------------------------------------------------

      const expectedAmount =
        planLower === "pro"
          ? PRO_PRICE
          : PREMIUM_PRICE;

      if (
        Math.abs(
          numericAmount -
            expectedAmount
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
        db.collection("users").doc(userId);

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

        plan: planLower,

        amount: numericAmount,

        currency:
          String(currency || "USD")
            .trim()
            .toUpperCase(),

        bankName:
          String(bankName).trim(),

        accountHolderFullName:
          String(
            accountHolderFullName
          ).trim(),

        transactionDate:
          String(transactionDate).trim(),

        transactionTime:
          String(transactionTime).trim(),

        description:
          description
            ? String(description).trim()
            : "",

        proofImageUrl:
          String(proofImageUrl).trim(),

        status: "pending",

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      };

      const paymentRef =
        await db
          .collection("paymentRequests")
          .add(paymentRequest);

      console.log(
        `Payment request created: ${paymentRef.id} | User: ${userId} | Plan: ${planLower}`
      );

      return res.status(201).json({
        success: true,

        message:
          "Payment request submitted successfully. Admin will verify the payment.",

        id: paymentRef.id
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
        db.collection("users").get(),
        db.collection("paymentRequests").get()
      ]);

      let totalUsers = 0;
      let activePro = 0;
      let activePremium = 0;
      let expiredSubs = 0;

      let pendingPayments = 0;
      let approvedPayments = 0;
      let rejectedPayments = 0;

      let totalRevenue = 0;

      const now = Date.now();

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

        let expiresAt = null;

        if (
          user.subscriptionExpiresAt
        ) {
          if (
            typeof user
              .subscriptionExpiresAt
              .toDate === "function"
          ) {
            expiresAt =
              user.subscriptionExpiresAt
                .toDate()
                .getTime();

          } else if (
            user.subscriptionExpiresAt
              .seconds
          ) {
            expiresAt =
              Number(
                user.subscriptionExpiresAt
                  .seconds
              ) * 1000;

          } else {
            const parsed =
              new Date(
                user.subscriptionExpiresAt
              ).getTime();

            if (
              !Number.isNaN(parsed)
            ) {
              expiresAt = parsed;
            }
          }
        }

        if (
          (
            plan === "pro" ||
            plan === "premium"
          ) &&
          expiresAt &&
          expiresAt < now
        ) {
          expiredSubs++;

        } else if (
          plan === "pro"
        ) {
          activePro++;

        } else if (
          plan === "premium"
        ) {
          activePremium++;
        }
      });

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

        if (status === "pending") {
          pendingPayments++;
        }

        if (status === "approved") {
          approvedPayments++;

          const amount =
            Number(
              payment.amount || 0
            );

          if (
            !Number.isNaN(amount)
          ) {
            totalRevenue += amount;
          }
        }

        if (status === "rejected") {
          rejectedPayments++;
        }
      });

      return res.json({
        success: true,
        totalUsers,
        activePro,
        activePremium,
        expiredSubs,
        pendingPayments,
        approvedPayments,
        rejectedPayments,
        totalRevenue:
          Number(
            totalRevenue.toFixed(2)
          )
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

      if (filter === "all") {
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
      const userIds = new Set();

      snap.forEach((doc) => {
        const data =
          doc.data() || {};

        payments.push({
          id: doc.id,
          ...data
        });

        if (data.userId) {
          userIds.add(
            data.userId
          );
        }
      });

      // --------------------------------------------------------
      // SORT NEWEST FIRST
      // --------------------------------------------------------

      const getTime = (value) => {
        if (!value) return 0;

        if (
          typeof value.toDate ===
          "function"
        ) {
          return value
            .toDate()
            .getTime();
        }

        if (value.seconds) {
          return (
            Number(value.seconds) *
            1000
          );
        }

        const parsed =
          new Date(value).getTime();

        return Number.isNaN(parsed)
          ? 0
          : parsed;
      };

      payments.sort((a, b) => {
        return (
          getTime(b.createdAt) -
          getTime(a.createdAt)
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
                  id: userSnap.id,
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
                ""
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
        db.collection("users").get(),
        db.collection("paymentRequests").get()
      ]);

      const userPaymentStats = {};

      paymentsSnap.forEach((doc) => {
        const payment =
          doc.data() || {};

        const uid =
          payment.userId;

        if (!uid) return;

        if (
          !userPaymentStats[uid]
        ) {
          userPaymentStats[uid] = {
            approved: 0,
            total: 0,
            lastAmount: 0,
            lastDate: null,
            lastRequestId: ""
          };
        }

        userPaymentStats[uid]
          .total++;

        if (
          String(
            payment.status || ""
          )
            .toLowerCase() ===
          "approved"
        ) {
          userPaymentStats[uid]
            .approved++;

          let paymentDate = null;

          if (
            payment.approvedAt &&
            typeof payment
              .approvedAt
              .toDate === "function"
          ) {
            paymentDate =
              payment.approvedAt
                .toDate();

          } else if (
            payment.approvedAt
          ) {
            paymentDate =
              new Date(
                payment.approvedAt
              );
          }

          if (
            paymentDate &&
            !Number.isNaN(
              paymentDate.getTime()
            )
          ) {
            const existing =
              userPaymentStats[uid]
                .lastDate;

            if (
              !existing ||
              paymentDate >
                existing
            ) {
              userPaymentStats[uid]
                .lastDate =
                paymentDate;

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

      const users = [];
      const now = Date.now();

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

        let expiresAt = null;

        if (
          data.subscriptionExpiresAt
        ) {
          if (
            typeof data
              .subscriptionExpiresAt
              .toDate === "function"
          ) {
            expiresAt =
              data.subscriptionExpiresAt
                .toDate()
                .getTime();

          } else if (
            data.subscriptionExpiresAt
              .seconds
          ) {
            expiresAt =
              Number(
                data.subscriptionExpiresAt
                  .seconds
              ) * 1000;

          } else {
            const parsed =
              new Date(
                data.subscriptionExpiresAt
              ).getTime();

            if (
              !Number.isNaN(parsed)
            ) {
              expiresAt = parsed;
            }
          }
        }

        let subscriptionStatus =
          "free";

        if (
          (
            plan === "pro" ||
            plan === "premium"
          ) &&
          expiresAt &&
          expiresAt < now
        ) {
          subscriptionStatus =
            "expired";

        } else if (
          plan === "pro" ||
          plan === "premium"
        ) {
          subscriptionStatus =
            "active";
        }

        const stats =
          userPaymentStats[
            doc.id
          ] || {
            approved: 0,
            total: 0,
            lastAmount: 0,
            lastDate: null,
            lastRequestId: ""
          };

        users.push({
          id: doc.id,

          ...data,

          subscriptionStatus,

          approvedPaymentsCount:
            stats.approved,

          totalPaymentRequests:
            stats.total,

          lastPaymentAmount:
            stats.lastAmount,

          lastPaymentDate:
            stats.lastDate,

          lastPaymentRequestId:
            stats.lastRequestId
        });
      });

      users.sort((a, b) => {
        const getUserTime =
          (value) => {
            if (!value) return 0;

            if (
              typeof value.toDate ===
              "function"
            ) {
              return value
                .toDate()
                .getTime();
            }

            if (value.seconds) {
              return (
                Number(
                  value.seconds
                ) * 1000
              );
            }

            const parsed =
              new Date(
                value
              ).getTime();

            return Number.isNaN(
              parsed
            )
              ? 0
              : parsed;
          };

        return (
          getUserTime(
            b.createdAt
          ) -
          getUserTime(
            a.createdAt
          )
        );
      });

      return res.json({
        success: true,
        users,
        count: users.length
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

          const paymentRef =
            db
              .collection(
                "paymentRequests"
              )
              .doc(paymentId);

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

          const currentStatus =
            String(
              payment.status ||
              "pending"
            ).toLowerCase();

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

          const plan =
            String(
              payment.plan || ""
            )
              .trim()
              .toLowerCase();

          let credits = 0;
          let expectedAmount = 0;

          if (plan === "pro") {
            credits =
              PRO_CREDITS;
            expectedAmount =
              PRO_PRICE;

          } else if (
            plan === "premium"
          ) {
            credits =
              PREMIUM_CREDITS;
            expectedAmount =
              PREMIUM_PRICE;

          } else {
            throw new Error(
              "INVALID_PLAN"
            );
          }

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

          if (!payment.userId) {
            throw new Error(
              "USER_ID_MISSING"
            );
          }

          const userRef =
            db
              .collection("users")
              .doc(payment.userId);

          const userDoc =
            await transaction.get(
              userRef
            );

          if (!userDoc.exists) {
            throw new Error(
              "USER_NOT_FOUND"
            );
          }

          // ----------------------------------------------------
          // DUPLICATE TRANSACTION CHECK
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
                duplicateFound = true;
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
          // 30-DAY ENTITLEMENT
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
          // UPDATE PAYMENT
          // ----------------------------------------------------

          transaction.update(
            paymentRef,
            {
              status: "approved",

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
                paymentAmount
            }
          );

          // ----------------------------------------------------
          // UPDATE USER
          // ----------------------------------------------------

          transaction.set(
            userRef,
            {
              plan,

              subscriptionPlan:
                plan,

              credits,

              creditLimit:
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

              freeVideoAvailable:
                false,

              freeVideoRemaining:
                0,

              freeVideoUsed:
                true,

              lastPaymentAmount:
                paymentAmount,

              lastPaymentRequestId:
                paymentId,

              updatedAt:
                admin.firestore
                  .FieldValue
                  .serverTimestamp()
            },
            {
              merge: true
            }
          );
        }
      );

      console.log(
        `Payment approved: ${paymentId} by ${adminUid}`
      );

      return res.json({
        success: true,

        message:
          "Payment approved and user subscription activated.",

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
        success: false,
        error: errorMsg
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
        ).toLowerCase();

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
        status: "rejected",

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
        success: true,

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
        success: false,
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

