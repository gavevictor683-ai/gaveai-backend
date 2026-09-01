/*
========================================================
GAVEAI PAYMENT CONFIGURATION
========================================================
*/

const PAYMENT_CONFIG = {
  /*
  ------------------------------------------------------
  PAYMENT CURRENCY
  ------------------------------------------------------
  */
  currency: "USD",

  /*
  ------------------------------------------------------
  BANK INFORMATION
  ------------------------------------------------------
  */
  bank: {
    name: "SOGEBANK",
    accountHolder: "Gave Victor",
    accountNumber: "2611111879",
    swiftBic: "SOGHHTPP",

    // Not required for this payment method.
    branch: null,
    routingNumber: null
  },

  /*
  ------------------------------------------------------
  CUSTOMER PAYMENT INSTRUCTIONS
  ------------------------------------------------------
  */
  instructions: [
    "Payments must be made in USD only.",
    "Send the payment to the SOGEBANK account shown above.",
    "After completing the transfer, keep your transaction/reference number.",
    "Submit your transaction/reference number through GaveAI.",
    "Your subscription will be activated only after the payment is manually verified and approved by GaveAI."
  ]
};


/*
========================================================
EXPORT
========================================================
*/

module.exports = {
  PAYMENT_CONFIG
};

