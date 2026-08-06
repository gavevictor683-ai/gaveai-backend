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

function loadKnowledge() {
try {
const knowledgePath = path.join(
__dirname,
"..",
"data",
"knowledge.json"
);

```
const knowledgeData = fs.readFileSync(
  knowledgePath,
  "utf8"
);

return knowledgeData;
```

} catch (error) {
console.error("Could not load knowledge.json:", error);
return "";
}
}

router.post("/chat", async (req, res, next) => {
try {
const message = cleanText(req.body?.message);

```
if (!isValidMessage(message)) {
  return res.status(400).json({
    error: true,
    message: "Please provide a valid message."
  });
}

const conversation = Array.isArray(req.body?.conversation)
  ? req.body.conversation
  : [];

const knowledge = loadKnowledge();

const reply = await generateAIResponse(message, {
  conversation,
  knowledge
});

return res.json({
  success: true,
  reply
});
```

} catch (error) {
next(error);
}
});

module.exports = router;
