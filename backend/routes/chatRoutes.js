const express = require("express");
const fs = require("fs");
const path = require("path");

const {
  cleanText,
  isValidMessage
} = require("../utils/helpers");

const {
  generateAIResponse
} = require("../services/groqService");

const router = express.Router();

/*
========================================================
LOAD GAVEAI KNOWLEDGE
========================================================

Loads the knowledge base from:

data/knowledge.json

If the file cannot be loaded, the chat can still
continue without the knowledge base.
========================================================
*/

function loadKnowledge() {
  try {
    const knowledgePath = path.join(
      __dirname,
      "..",
      "data",
      "knowledge.json"
    );

    const knowledgeData = fs.readFileSync(
      knowledgePath,
      "utf8"
    );

    return knowledgeData;

  } catch (error) {
    console.error(
      "Could not load knowledge.json:",
      error?.message || error
    );

    return "";
  }
}


/*
========================================================
POST /CHAT
========================================================

Main GaveAI chat endpoint.

Flow:

1. Receive user message.
2. Clean the message.
3. Validate the message.
4. Receive conversation history.
5. Load GaveAI knowledge.
6. Send everything to groqService.
7. Return the AI response.
========================================================
*/

router.post("/chat", async (req, res, next) => {
  try {
    /*
    ----------------------------------------------------
    CLEAN USER MESSAGE
    ----------------------------------------------------
    */

    const message = cleanText(
      req.body?.message
    );

    /*
    ----------------------------------------------------
    VALIDATE MESSAGE
    ----------------------------------------------------
    */

    if (!isValidMessage(message)) {
      return res.status(400).json({
        success: false,
        error: true,
        message:
          "Please provide a valid message."
      });
    }

    /*
    ----------------------------------------------------
    CONVERSATION HISTORY
    ----------------------------------------------------
    */

    const conversation =
      Array.isArray(req.body?.conversation)
        ? req.body.conversation
        : [];

    /*
    ----------------------------------------------------
    LOAD KNOWLEDGE BASE
    ----------------------------------------------------
    */

    const knowledge = loadKnowledge();

    /*
    ----------------------------------------------------
    GENERATE AI RESPONSE
    ----------------------------------------------------
    */

    const reply = await generateAIResponse(
      message,
      {
        conversation,
        knowledge
      }
    );

    /*
    ----------------------------------------------------
    RETURN RESPONSE
    ----------------------------------------------------
    */

    return res.json({
      success: true,
      reply
    });

  } catch (error) {
    console.error(
      "CHAT ROUTE ERROR:",
      error?.message || error
    );

    return next(error);
  }
});


/*
========================================================
EXPORT ROUTER
========================================================
*/

module.exports = router;

