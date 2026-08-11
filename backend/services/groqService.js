const Groq = require("groq-sdk");
const systemPrompt = require("../prompts/systemPrompt");
const config = require("../config/config");

const {
  shouldUseWebSearch,
  searchWeb
} = require("./webSearchService");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  defaultHeaders: {
    "Groq-Model-Version": "latest"
  }
});

/*
|--------------------------------------------------------------------------
| TOKEN / CONTEXT PROTECTION
|--------------------------------------------------------------------------
| Groq has a TPM limit. We keep the total input comfortably below it.
*/

const LIMITS = {
  systemPrompt: 5000,
  knowledge: 1200,
  searchContext: 2800,
  conversationMessage: 700,
  conversationMessages: 4,
  userMessage: 1600
};

function safeSlice(text, maxChars) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, maxChars);
}

function formatSearchResults(searchData) {
  if (!searchData || !Array.isArray(searchData.results)) {
    return "";
  }

  return searchData.results
    .slice(0, 3)
    .map((result, index) => {
      const title = safeSlice(result.title || "Untitled", 200);
      const url = safeSlice(result.url || "", 400);

      const rawContent =
        result.content ||
        (Array.isArray(result.highlights)
          ? result.highlights.join(" ")
          : "");

      const content = safeSlice(rawContent, 600);

      return [
        `Source ${index + 1}: ${title}`,
        `URL: ${url}`,
        `Content: ${content}`
      ].join("\n");
    })
    .join("\n\n");
}

function limitConversation(conversation) {
  if (!Array.isArray(conversation)) {
    return [];
  }

  const validMessages = conversation.filter(
    (item) =>
      item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim()
  );

  // Only keep the latest 4 messages.
  const recentMessages = validMessages.slice(-LIMITS.conversationMessages);

  return recentMessages.map((item) => ({
    role: item.role,
    content: safeSlice(item.content, LIMITS.conversationMessage)
  }));
}

async function generateAIResponse(message, options = {}) {
  const {
    conversation = [],
    knowledge = ""
  } = options;

  const cleanMessage = safeSlice(
    message,
    LIMITS.userMessage
  );

  if (!cleanMessage) {
    throw new Error("AI message is empty.");
  }

  /*
  |--------------------------------------------------------------------------
  | SYSTEM PROMPT
  |--------------------------------------------------------------------------
  */

  const baseSystemPrompt = safeSlice(
    systemPrompt,
    LIMITS.systemPrompt
  );

  const messages = [
    {
      role: "system",
      content: `${baseSystemPrompt}

REAL-TIME INFORMATION RULE:

- When a question requires current, recent, latest, today's, this week's, or otherwise time-sensitive information, web search may be used before answering.
- When web search results are provided, use them to verify current facts.
- Do not claim that you searched the web unless web search results were actually provided.
- Do not invent facts, dates, sources, URLs, or search results.
- Clearly distinguish historical facts from current information.
- If reliable sources disagree, explain the disagreement instead of guessing.
- For current facts, include relevant dates when useful.
- Answer in the same language the user is using whenever possible.
- When web sources are provided, use the source information carefully and prioritize reliable sources.`
    }
  ];

  /*
  |--------------------------------------------------------------------------
  | ADDITIONAL KNOWLEDGE
  |--------------------------------------------------------------------------
  */

  const cleanKnowledge = safeSlice(
    knowledge,
    LIMITS.knowledge
  );

  if (cleanKnowledge) {
    messages.push({
      role: "system",
      content:
        `Additional knowledge that may help answer the user:\n${cleanKnowledge}`
    });
  }

  /*
  |--------------------------------------------------------------------------
  | WEB SEARCH
  |--------------------------------------------------------------------------
  */

  let webSearchData = null;

  if (shouldUseWebSearch(cleanMessage)) {
    try {
      webSearchData = await searchWeb(cleanMessage);

      const searchContext = safeSlice(
        formatSearchResults(webSearchData),
        LIMITS.searchContext
      );

      if (searchContext) {
        messages.push({
          role: "system",
          content: `REAL-TIME WEB SEARCH RESULTS:

The following information was retrieved from the web for the user's current-information request.

Search provider:
${safeSlice(webSearchData.provider || "unknown", 100)}

${searchContext}

Use these results to verify the answer. Do not treat search snippets as automatically correct. Prefer authoritative and directly relevant sources.`
        });
      }
    } catch (error) {
      console.error("WEB SEARCH FAILED:", error.message);

      messages.push({
        role: "system",
        content:
          "Web search was attempted but failed. Do not pretend that current information was verified online. If the answer depends on information that may have changed, clearly say that verification was unavailable."
      });
    }
  }

  /*
  |--------------------------------------------------------------------------
  | RECENT CONVERSATION
  |--------------------------------------------------------------------------
  */

  const recentConversation = limitConversation(
    conversation
  );

  messages.push(...recentConversation);

  /*
  |--------------------------------------------------------------------------
  | CURRENT USER MESSAGE
  |--------------------------------------------------------------------------
  */

  messages.push({
    role: "user",
    content: cleanMessage
  });

  /*
  |--------------------------------------------------------------------------
  | GROQ REQUEST
  |--------------------------------------------------------------------------
  */

  console.log(
    `Groq request prepared: ${messages.length} messages`
  );

  const completion = await groq.chat.completions.create({
    model: config.ai.model,
    messages,
    temperature: 0.7,
    max_tokens: 700
  });

  const response =
    completion?.choices?.[0]?.message?.content?.trim();

  if (!response) {
    throw new Error("AI returned an empty response.");
  }

  return response;
}

module.exports = {
  generateAIResponse
};