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

function formatSearchResults(searchData) {
  if (!searchData || !Array.isArray(searchData.results)) {
    return "";
  }

  const results = searchData.results
    .slice(0, 8)
    .map((result, index) => {
      const title = result.title || "Untitled";
      const url = result.url || "";
      const content =
        result.content ||
        (Array.isArray(result.highlights)
          ? result.highlights.join(" ")
          : "");

      return [
        `Source ${index + 1}: ${title}`,
        `URL: ${url}`,
        `Content: ${content}`
      ].join("\n");
    })
    .join("\n\n");

  return results;
}

async function generateAIResponse(message, options = {}) {
  const {
    conversation = [],
    knowledge = ""
  } = options;

  const messages = [
    {
      role: "system",
      content: `${systemPrompt}

REAL-TIME INFORMATION RULE:

* When a question requires current, recent, latest, today's, this week's, or otherwise time-sensitive information, web search may be used before answering.
* When web search results are provided, use them to verify current facts.
* Do not claim that you searched the web unless web search results were actually provided.
* Do not invent facts, dates, sources, URLs, or search results.
* Clearly distinguish historical facts from current information.
* If reliable sources disagree, explain the disagreement instead of guessing.
* For current facts, include relevant dates when useful.
* Answer in the same language the user is using whenever possible.
* When web sources are provided, use the source information carefully and prioritize reliable sources.`
    }
  ];

  if (knowledge) {
    messages.push({
      role: "system",
      content: `Additional knowledge that may help answer the user:\n${knowledge}`
    });
  }

  let webSearchData = null;

  if (shouldUseWebSearch(message)) {
    try {
      webSearchData = await searchWeb(message);

      const searchContext = formatSearchResults(webSearchData);

      if (searchContext) {
        messages.push({
          role: "system",
          content: `REAL-TIME WEB SEARCH RESULTS:

The following information was retrieved from the web for the user's current-information request.

Search provider:
${webSearchData.provider || "unknown"}

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

  if (Array.isArray(conversation)) {
    for (const item of conversation) {
      if (
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim()
      ) {
        messages.push({
          role: item.role,
          content: item.content.trim()
        });
      }
    }
  }

  messages.push({
    role: "user",
    content: message
  });

  const completion = await groq.chat.completions.create({
    model: config.ai.model,
    messages,
    temperature: 0.7,
    max_tokens: 2048
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