const { db } = require("../firebaseAdmin");

/*
========================================================
CREDIT CONFIGURATION
========================================================
*/

const DAILY_CREDITS = 60;

const HAITI_TIMEZONE =
  "America/Port-au-Prince";

/*
========================================================
GET TODAY KEY
========================================================
*/

function getTodayKey() {
  const now =
    new Date();

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          HAITI_TIMEZONE,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).formatToParts(now);

  const year =
    parts.find(
      (part) =>
        part.type ===
        "year"
    )?.value;

  const month =
    parts.find(
      (part) =>
        part.type ===
        "month"
    )?.value;

  const day =
    parts.find(
      (part) =>
        part.type ===
        "day"
    )?.value;

  return `${year}-${month}-${day}`;
}

/*
========================================================
CHECK AND DEDUCT CREDITS
========================================================
*/

async function checkAndDeductCredits(
  userId,
  amount
) {
  /*
  ======================================================
  VALIDATE USER
  ======================================================
  */

  if (!userId) {
    throw new Error(
      "User ID is required for credit usage."
    );
  }

  /*
  ======================================================
  VALIDATE CREDIT COST
  ======================================================
  */

  const cost =
    Number(amount) || 0;

  if (cost <= 0) {
    throw new Error(
      "Invalid credit amount."
    );
  }

  /*
  ======================================================
  USER DOCUMENT
  ======================================================
  */

  const userRef =
    db
      .collection("users")
      .doc(userId);

  /*
  ======================================================
  FIRESTORE TRANSACTION
  ======================================================
  */

  return db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      /*
      ==================================================
      USER MUST EXIST
      ==================================================
      */

      if (!snapshot.exists) {
        throw new Error(
          "User account not found."
        );
      }

      const data =
        snapshot.data() || {};

      /*
      ==================================================
      CURRENT HAITI DATE
      ==================================================
      */

      const today =
        getTodayKey();

      /*
      ==================================================
      CURRENT USAGE
      ==================================================
      */

      let creditsUsedToday =
        Number(
          data.creditsUsedToday
        ) || 0;

      const creditDate =
        data.creditDate ||
        today;

      /*
      ==================================================
      DAILY RESET
      ==================================================
      */

      if (
        creditDate !==
        today
      ) {
        creditsUsedToday = 0;
      }

      /*
      ==================================================
      REMAINING CREDITS
      ==================================================
      */

      const remaining =
        DAILY_CREDITS -
        creditsUsedToday;

      /*
      ==================================================
      INSUFFICIENT CREDITS
      ==================================================
      */

      if (
        remaining <
        cost
      ) {
        throw new Error(
          `Insufficient credits. You have ${Math.max(
            remaining,
            0
          )} credits remaining today.`
        );
      }

      /*
      ==================================================
      NEW USAGE
      ==================================================
      */

      const newUsed =
        creditsUsedToday +
        cost;

      /*
      ==================================================
      NEW BALANCE
      ==================================================
      */

      const newBalance =
        DAILY_CREDITS -
        newUsed;

      /*
      ==================================================
      SAVE CREDIT DATA
      ==================================================
      */

      transaction.set(
        userRef,
        {
          creditsUsedToday:
            newUsed,

          creditDate:
            today,

          creditBalance:
            newBalance,

          updatedAt:
            new Date()
        },
        {
          merge:
            true
        }
      );

      /*
      ==================================================
      RETURN RESULT
      ==================================================
      */

      return {
        success:
          true,

        creditsDeducted:
          cost,

        newCreditBalance:
          newBalance
      };
    }
  );
}

/*
========================================================
REFUND CREDITS
========================================================
*/

async function refundCredits(
  userId,
  amount
) {
  /*
  ======================================================
  VALIDATE USER
  ======================================================
  */

  if (!userId) {
    throw new Error(
      "User ID is required for credit refund."
    );
  }

  /*
  ======================================================
  VALIDATE REFUND AMOUNT
  ======================================================
  */

  const refundAmount =
    Number(amount) || 0;

  if (
    refundAmount <=
    0
  ) {
    return null;
  }

  /*
  ======================================================
  USER DOCUMENT
  ======================================================
  */

  const userRef =
    db
      .collection("users")
      .doc(userId);

  /*
  ======================================================
  FIRESTORE TRANSACTION
  ======================================================
  */

  return db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      /*
      ==================================================
      USER MUST EXIST
      ==================================================
      */

      if (!snapshot.exists) {
        throw new Error(
          "User account not found."
        );
      }

      const data =
        snapshot.data() || {};

      /*
      ==================================================
      CURRENT HAITI DATE
      ==================================================
      */

      const today =
        getTodayKey();

      /*
      ==================================================
      CURRENT USAGE
      ==================================================
      */

      let creditsUsedToday =
        Number(
          data.creditsUsedToday
        ) || 0;

      /*
      ==================================================
      RESET IF NEW DAY
      ==================================================
      */

      if (
        data.creditDate !==
        today
      ) {
        creditsUsedToday = 0;
      }

      /*
      ==================================================
      REFUND
      ==================================================
      */

      const newUsed =
        Math.max(
          creditsUsedToday -
            refundAmount,
          0
        );

      /*
      ==================================================
      NEW BALANCE
      ==================================================
      */

      const newBalance =
        DAILY_CREDITS -
        newUsed;

      /*
      ==================================================
      SAVE REFUND
      ==================================================
      */

      transaction.set(
        userRef,
        {
          creditsUsedToday:
            newUsed,

          creditDate:
            today,

          creditBalance:
            newBalance,

          updatedAt:
            new Date()
        },
        {
          merge:
            true
        }
      );

      /*
      ==================================================
      RETURN REFUND RESULT
      ==================================================
      */

      return {
        success:
          true,

        refunded:
          refundAmount,

        newCreditBalance:
          newBalance
      };
    }
  );
}

/*
========================================================
EXPORT
========================================================
*/

module.exports = {
  checkAndDeductCredits,
  refundCredits
};