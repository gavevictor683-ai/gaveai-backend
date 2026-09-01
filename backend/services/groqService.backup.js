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
*/

const LIMITS = {
  systemPrompt: 5000,
  knowledge: 1200,
  searchContext: 4200,
  conversationMessage: 700,
  conversationMessages: 4,
  userMessage: 1600,
  companySearches: 3
};

function safeSlice(text, maxChars) {
  if (typeof text !== "string") {
    return "";
  }

  return text.trim().slice(0, maxChars);
}

/*
|--------------------------------------------------------------------------
| DETECT MULTIPLE COMPANIES / ENTITIES
|--------------------------------------------------------------------------
|
| When a user asks about several AI companies in one current-news
| question, search each important company separately.
|
*/

function detectCompanies(message) {
  if (!message || typeof message !== "string") {
    return [];
  }

  const text = message.toLowerCase();

  const companies = [];

  const patterns = [
    {
      name: "OpenAI",
      patterns: [
        "openai",
        "chatgpt",
        "gpt-5",
        "gpt 5",
        "gpt-5.5",
        "gpt 5.5"
      ]
    },
    {
      name: "Google Gemini",
      patterns: [
        "google gemini",
        "gemini",
        "google ai"
      ]
    },
    {
      name: "Anthropic",
      patterns: [
        "anthropic",
        "claude"
      ]
    },
    {
      name: "Meta AI",
      patterns: [
        "meta ai",
        "meta",
        "llama"
      ]
    },
    {
      name: "Microsoft AI",
      patterns: [
        "microsoft ai",
        "microsoft",
        "copilot"
      ]
    },
    {
      name: "xAI",
      patterns: [
        "xai",
        "x.ai",
        "grok"
      ]
    }
  ];

  for (const company of patterns) {
    if (
      company.patterns.some((pattern) =>
        text.includes(pattern)
      )
    ) {
      companies.push(company.name);
    }
  }

  return companies.slice(
    0,
    LIMITS.companySearches
  );
}

/*
|--------------------------------------------------------------------------
| BUILD COMPANY SEARCH QUERY
|--------------------------------------------------------------------------
*/

function buildCompanySearchQuery(
  originalMessage,
  company
) {
  return `${company} latest news August 2026 ${originalMessage}`;
}

/*
|--------------------------------------------------------------------------
| FORMAT SEARCH RESULTS
|--------------------------------------------------------------------------
*/

function formatSearchResults(
  searchData,
  label = ""
) {
  if (
    !searchData ||
    !Array.isArray(searchData.results)
  ) {
    return "";
  }

  const heading = label
    ? `SEARCH RESULTS FOR ${label}:`
    : "SEARCH RESULTS:";

  const results = searchData.results
    .slice(0, 3)
    .map((result, index) => {
      const title = safeSlice(
        result.title || "Untitled",
        220
      );

      const url = safeSlice(
        result.url || "",
        500
      );

      const rawContent =
        result.content ||
        (
          Array.isArray(result.highlights)
            ? result.highlights.join(" ")
            : ""
        );

      const content = safeSlice(
        rawContent,
        650
      );

      return [
        `Source ${index + 1}: ${title}`,
        `URL: ${url}`,
        `Content: ${content}`
      ].join("\n");
    })
    .join("\n\n");

  return `${heading}\n${results}`;
}

/*
|--------------------------------------------------------------------------
| LIMIT CONVERSATION
|--------------------------------------------------------------------------
*/

function limitConversation(
  conversation
) {
  if (!Array.isArray(conversation)) {
    return [];
  }

  const validMessages =
    conversation.filter(
      (item) =>
        item &&
        (
          item.role === "user" ||
          item.role === "assistant"
        ) &&
        typeof item.content === "string" &&
        item.content.trim()
    );

  const recentMessages =
    validMessages.slice(
      -LIMITS.conversationMessages
    );

  return recentMessages.map(
    (item) => ({
      role: item.role,
      content: safeSlice(
        item.content,
        LIMITS.conversationMessage
      )
    })
  );
}

/*
|--------------------------------------------------------------------------
| SEARCH MULTIPLE COMPANIES
|--------------------------------------------------------------------------
*/

async function searchMultipleCompanies(
  message,
  companies
) {
  const combinedResults = [];

  for (const company of companies) {
    try {
      const query =
        buildCompanySearchQuery(
          message,
          company
        );

      console.log(
        `WEB SEARCH: ${company}`
      );

      const result =
        await searchWeb(query);

      const formatted =
        formatSearchResults(
          result,
          company
        );

      if (formatted) {
        combinedResults.push(
          formatted
        );
      }

    } catch (error) {
      console.error(
        `${company} SEARCH FAILED:`,
        error.message
      );

      combinedResults.push(
        `SEARCH FAILED FOR ${company}: ${error.message}`
      );
    }
  }

  return combinedResults.join(
    "\n\n--------------------------------\n\n"
  );
}

/*
|--------------------------------------------------------------------------
| GENERATE AI RESPONSE
|--------------------------------------------------------------------------
*/

async function generateAIResponse(
  message,
  options = {}
) {
  const {
    conversation = [],
    knowledge = ""
  } = options;

  const cleanMessage =
    safeSlice(
      message,
      LIMITS.userMessage
    );

  if (!cleanMessage) {
    throw new Error(
      "AI message is empty."
    );
  }

  /*
  |--------------------------------------------------------------------------
  | SYSTEM PROMPT
  |--------------------------------------------------------------------------
  */

  const baseSystemPrompt =
    safeSlice(
      systemPrompt,
      LIMITS.systemPrompt
    );

  const messages = [
    {
      role: "system",
      content: `${baseSystemPrompt}

REAL-TIME INFORMATION RULE:

- When a question requires current, recent, latest, today's, this week's, this month's, or otherwise time-sensitive information, web search may be used before answering.
- When web search results are provided, use them to verify current facts.
- Do not claim that you searched the web unless web search results were actually provided.
- Do not invent facts, dates, sources, URLs, companies, events, products, or search results.
- Clearly distinguish historical facts from current information.
- If reliable sources disagree, explain the disagreement instead of guessing.
- For current facts, include relevant dates when useful.
- Answer in the same language the user is using whenever possible.
- When web sources are provided, use the source information carefully.
- Prefer authoritative and directly relevant sources.
- If the user asks for sources, provide the actual URLs from the supplied search results.
- Never invent or modify a URL.
- Never attribute information to a source that does not support the claim.
- If information about one company is unavailable, say so clearly instead of filling the gap with information about another company.

MULTI-COMPANY CURRENT NEWS RULE:

- If the user's question mentions multiple companies or organizations, evaluate each one separately.
- Do not assume that information found for one company applies to another.
- When separate search results are provided for different companies, organize the answer by company.
- Make sure every company explicitly requested by the user is addressed.
- If reliable information is available for only some companies, clearly identify which companies could and could not be verified.
- Do not invent missing information.
- When appropriate, include the date of each important development.
- When the user asks for sources, place the relevant source URL immediately after or below the corresponding information.`
    }
  ];

  /*
  |--------------------------------------------------------------------------
  | ADDITIONAL KNOWLEDGE
  |--------------------------------------------------------------------------
  */

  const cleanKnowledge =
    safeSlice(
      knowledge,
      LIMITS.knowledge
    );

  if (cleanKnowledge) {
    messages.push({
      role: "system",
      content:
        "Additional knowledge that may help answer the user:\n" +
        cleanKnowledge
    });
  }

  /*
  |--------------------------------------------------------------------------
  | WEB SEARCH
  |--------------------------------------------------------------------------
  */

  if (
    shouldUseWebSearch(
      cleanMessage
    )
  ) {
    try {
      const companies =
        detectCompanies(
          cleanMessage
        );

      let searchContext = "";

      /*
      |--------------------------------------------------------------------------
      | MULTI-COMPANY SEARCH
      |--------------------------------------------------------------------------
      */

      if (companies.length >= 2) {
        console.log(
          `MULTI-COMPANY SEARCH: ${companies.join(
            ", "
          )}`
        );

        searchContext =
          await searchMultipleCompanies(
            cleanMessage,
            companies
          );
      }

      /*
      |--------------------------------------------------------------------------
      | NORMAL SINGLE SEARCH
      |--------------------------------------------------------------------------
      */

      if (!searchContext) {
        console.log(
          "NORMAL WEB SEARCH"
        );

        const webSearchData =
          await searchWeb(
            cleanMessage
          );

        searchContext =
          formatSearchResults(
            webSearchData
          );
      }

      searchContext =
        safeSlice(
          searchContext,
          LIMITS.searchContext
        );

      if (searchContext) {
        messages.push({
          role: "system",
          content:
            "REAL-TIME WEB SEARCH RESULTS:\n\n" +
            "The following information was retrieved from the web for the user's current-information request.\n\n" +
            searchContext +
            "\n\n" +
            "Use these results to verify the answer. " +
            "Do not treat search snippets as automatically correct. " +
            "Prefer authoritative and directly relevant sources. " +
            "If a company has no reliable result, say that it could not be verified."
        });
      } else {
        messages.push({
          role: "system",
          content:
            "Web search was performed but no useful results were returned. " +
            "Do not invent current information. " +
            "Clearly state that the current information could not be verified."
        });
      }

    } catch (error) {
      console.error(
        "WEB SEARCH FAILED:",
        error.message
      );

      messages.push({
        role: "system",
        content:
          "Web search was attempted but failed. " +
          "Do not pretend that current information was verified online. " +
          "If the answer depends on current information, clearly say that verification was unavailable."
      });
    }
  }

  /*
  |--------------------------------------------------------------------------
  | RECENT CONVERSATION
  |--------------------------------------------------------------------------
  */

  const recentConversation =
    limitConversation(
      conversation
    );

  messages.push(
    ...recentConversation
  );

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

  const completion =
    await groq.chat.completions.create({
      model: config.ai.model,
      messages,
      temperature: 0.7,
      max_tokens: 700
    });

  const response =
    completion?.choices?.[0]?.message?.content?.trim();

  if (!response) {
    throw new Error(
      "AI returned an empty response."
    );
  }

  return response;
}

module.exports = {
  generateAIResponse
};