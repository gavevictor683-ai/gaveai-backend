/*
========================================================
GAVEAI PAYMENT CONFIGURATION
========================================================
*/

const PAYMENT_CONFIG = {
  currency: "USD",

  bank: {
    name: "SOGEBANK",
    accountHolder: "Gave Victor",
    accountNumber: "2611111879",
    swiftBic: "SOGHHTPP",
    branch: null,
    routingNumber: null
  },

  instructions: [
    "Payments must be made in USD only.",
    "Send the payment to the SOGEBANK account shown above.",
    "After making the transfer, keep your transaction/reference number.",
    "Submit your payment request with the transaction/reference number.",
    "Your subscription will be activated after the payment is manually verified and approved by GaveAI."
  ]
};

module.exports = {
  PAYMENT_CONFIG
};