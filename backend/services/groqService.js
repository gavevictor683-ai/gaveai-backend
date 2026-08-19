require("dotenv").config();

const Groq = require("groq-sdk");
const {
  searchWeb,
  shouldUseWebSearch
} = require("./webSearchService");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/*
========================================================
CONFIGURATION
========================================================
*/

const GROQ_MODEL = "openai/gpt-oss-120b";

const HAITI_TIMEZONE =
  "America/Port-au-Prince";

/*
========================================================
DATE / TIME HELPERS
========================================================
*/

function getHaitiDateTime() {
  const now = new Date();

  const dateFormatter =
    new Intl.DateTimeFormat("en-US", {
      timeZone: HAITI_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

  const timeFormatter =
    new Intl.DateTimeFormat("en-US", {
      timeZone: HAITI_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });

  const isoDateFormatter =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: HAITI_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });

  return {
    dateLabel:
      dateFormatter.format(now),

    time:
      timeFormatter.format(now),

    date:
      isoDateFormatter.format(now),

    timezone:
      HAITI_TIMEZONE
  };
}

/*
========================================================
DIRECT DATE / TIME QUESTIONS
========================================================
These questions do NOT need Groq or web search.
This saves tokens.
========================================================
*/

function isDateTimeQuestion(message) {
  const text =
    String(message || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const patterns = [
    "ki dat jodi a",
    "ki dat ye jodi a",
    "ki dat jodia",
    "dat jodi a",
    "date today",
    "today's date",
    "what is today's date",
    "what date is it",
    "what day is it",
    "ki jou li ye",
    "ki jou jodi a",
    "ki le li ye",
    "ki le li ye kounya",
    "ki le li ye kou a",
    "ki le li ye kounye a",
    "what time is it",
    "current time",
    "time now",
    "what is the current time",
    "heure actuelle",
    "quelle heure est-il",
    "quelle date sommes-nous"
  ];

  return patterns.some(
    (pattern) =>
      text.includes(pattern)
  );
}

function buildDateTimeReply(message) {
  const info =
    getHaitiDateTime();

  const text =
    String(message || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const asksTime =
    text.includes("le") ||
    text.includes("time") ||
    text.includes("heure");

  const asksDate =
    text.includes("dat") ||
    text.includes("date") ||
    text.includes("jou") ||
    text.includes("day");

  if (asksDate && asksTime) {
    return `Jodi a se **${info.dateLabel}**, epi kounye a li **${info.time}** nan lè Ayiti (${info.timezone}).`;
  }

  if (asksTime) {
    return `Kounye a li **${info.time}** nan lè Ayiti (${info.timezone}).`;
  }

  return `Jodi a se **${info.dateLabel}** nan lè Ayiti (${info.timezone}).`;
}

/*
========================================================
WEB SEARCH DETECTION
========================================================
General questions use Groq only.

Current / latest / live questions use web search.
========================================================
*/

function needsCurrentInformation(message) {
  const text =
    String(message || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const currentPatterns = [
    "latest",
    "current",
    "currently",
    "right now",
    "today",
    "today's",
    "tonight",
    "this morning",
    "this afternoon",
    "this evening",
    "recent",
    "recently",
    "breaking",
    "live",
    "up to date",
    "up-to-date",
    "as of today",
    "as of now",
    "what happened today",
    "news",
    "nouvel",
    "dènye nouvèl",
    "denye nouvel",
    "jodi a",
    "jodia",
    "kounye a",
    "kounya",
    "aktyel",
    "aktyèl",
    "an dirèk",
    "an direk",
    "rezilta",
    "score",
    "ki ekip",
    "who won",
    "who is winning",
    "winner",
    "champion",
    "champions",
    "election results",
    "elections",
    "stock price",
    "share price",
    "exchange rate",
    "bitcoin price",
    "crypto price",
    "weather",
    "forecast",
    "temperature",
    "hurricane",
    "earthquake"
  ];

  return currentPatterns.some(
    (pattern) =>
      text.includes(pattern)
  );
}

/*
========================================================
SEARCH DECISION
========================================================
Use existing webSearchService when available.
Also force search for clearly current questions.
========================================================
*/

function shouldSearch(message) {
  if (isDateTimeQuestion(message)) {
    return false;
  }

  if (needsCurrentInformation(message)) {
    return true;
  }

  try {
    if (
      typeof shouldUseWebSearch ===
      "function"
    ) {
      return Boolean(
        shouldUseWebSearch(message)
      );
    }
  } catch (error) {
    console.warn(
      "shouldUseWebSearch warning:",
      error.message
    );
  }

  return false;
}

/*
========================================================
SEARCH RESULT FORMATTER
========================================================
*/

function formatSearchResults(searchData) {
  if (
    !searchData ||
    !Array.isArray(searchData.results) ||
    searchData.results.length === 0
  ) {
    return "No verified web search results were returned.";
  }

  const results =
    searchData.results
      .slice(0, 8)
      .map((result, index) => {
        const highlights =
          Array.isArray(result.highlights)
            ? result.highlights.join(" ")
            : "";

        const content =
          result.content ||
          highlights ||
          "";

        return [
          `SOURCE ${index + 1}`,
          `Title: ${result.title || "Untitled"}`,
          `URL: ${result.url || "No URL"}`,
          `Published: ${
            result.publishedDate ||
            result.published_date ||
            result.date ||
            "Unknown"
          }`,
          `Content: ${content}`
        ].join("\n");
      })
      .join("\n\n");

  /*
  Prevent an unnecessarily huge prompt.
  This helps control Groq token usage.
  */

  return results.slice(0, 14000);
}

/*
========================================================
SOURCE NORMALIZATION
========================================================
*/

function normalizeSources(searchData) {
  if (
    !searchData ||
    !Array.isArray(searchData.results)
  ) {
    return [];
  }

  return searchData.results
    .slice(0, 8)
    .map((result) => ({
      title:
        typeof result.title === "string"
          ? result.title
          : "",

      url:
        typeof result.url === "string"
          ? result.url
          : "",

      provider:
        typeof result.provider === "string"
          ? result.provider
          : "",

      official:
        Boolean(result.official)
    }));
}

/*
========================================================
SYSTEM PROMPT
========================================================
*/

function buildSystemPrompt({
  currentDate,
  currentDateLabel,
  currentTime,
  timezone,
  usingWebSearch
}) {
  const webRules =
    usingWebSearch
      ? `
CURRENT INFORMATION RULES:

- The user is asking for information that may have changed.
- Use ONLY the supplied web-search results for current facts.
- Do not invent current events.
- Do not present an old article as if it were published today.
- If a source has a publication date, respect that date.
- Clearly distinguish between information published today and older information.
- If no source was published today, say so clearly.
- When appropriate, mention the date of the source.
- Never pretend that web-search results are from today when they are not.
`
      : `
GENERAL INFORMATION RULES:

- This is a general/non-current question.
- Answer using your normal knowledge.
- Do NOT request web search just because the topic could have current information.
- Keep the answer useful, accurate, and direct.
`;

  return `
You are GaveAI, the AI assistant for Gave Money Tips.

CURRENT DATE:
${currentDateLabel}

CURRENT DATE ISO:
${currentDate}

CURRENT TIME IN HAITI:
${currentTime}

TIMEZONE:
${timezone}

IMPORTANT:
The current date and time above are supplied by the backend.
Do not claim that you cannot access the current date when the backend has supplied it.


========================================================
OFFICIAL IDENTITY — EXTREMELY STRICT
========================================================

CREATOR AND FOUNDER:

- Gave Victor is the creator and founder of Gave Money Tips.
- Gave Victor created Gave Money Tips in 2026.
- Gave Victor is the creator and founder of Gave Money Tips AI.
- Gave Victor created Gave Money Tips AI in 2026.

These identity facts are authoritative.

Never replace Gave Victor with another person.

Never invent another founder, creator, owner, CEO, developer,
or person behind Gave Money Tips or Gave Money Tips AI.


========================================================
GAVE MONEY TIPS
========================================================

- Gave Money Tips was created by Gave Victor in 2026.
- Gave Money Tips is intended to help people around the world.
- Gave Money Tips is NOT exclusively for Haitians.
- Do not describe Gave Money Tips as a platform created only
  to help Haitians.
- Do not limit the mission of Gave Money Tips to Haiti.
- Gave Money Tips is intended to provide useful information,
  education, tools, opportunities, and assistance to people worldwide.


========================================================
GAVE MONEY TIPS AI
========================================================

- Gave Money Tips AI was created by Gave Victor in 2026.
- Gave Money Tips AI is the AI assistant associated with
  Gave Money Tips.
- Gave Victor is the creator and founder of Gave Money Tips AI.
- Never identify another person or organization as the creator
  of Gave Money Tips AI.


========================================================
CREATOR QUESTION RULES
========================================================

If the user asks:

"Who created Gave Money Tips?"
"Who founded Gave Money Tips?"
"Who is the founder of Gave Money Tips?"
"Who is behind Gave Money Tips?"
"Who made Gave Money Tips?"
"Kiyès ki kreye Gave Money Tips?"
"Kiyès ki fondatè Gave Money Tips?"
"Kiyès ki dèyè Gave Money Tips?"
"Eske Gave Victor kreye Gave Money Tips?"

The answer MUST identify Gave Victor and mention 2026.

Preferred English answer:

"Gave Victor is the creator and founder of Gave Money Tips,
which was created in 2026."

Preferred Haitian Creole answer:

"Gave Victor se kreyatè ak fondatè Gave Money Tips,
ki te kreye an 2026."


========================================================
GAVE MONEY TIPS AI CREATOR QUESTIONS
========================================================

If the user asks:

"Who created Gave Money Tips AI?"
"Who made Gave Money Tips AI?"
"Who is behind Gave Money Tips AI?"
"Who founded Gave Money Tips AI?"
"Kiyès ki kreye Gave Money Tips AI?"
"Kiyès ki fè Gave Money Tips AI?"
"Kiyès ki dèyè Gave Money Tips AI?"

The answer MUST identify Gave Victor and mention 2026.

Preferred English answer:

"Gave Victor is the creator and founder of Gave Money Tips AI,
which was created in 2026."

Preferred Haitian Creole answer:

"Gave Victor se kreyatè ak fondatè Gave Money Tips AI,
ki te kreye an 2026."


========================================================
GAVE VICTOR — NO INVENTION
========================================================

- Do NOT invent information about Gave Victor.
- Do NOT invent a surname.
- Do NOT change his name.
- Do NOT identify him as another person.
- Do NOT claim that Gave Victor is "Victor Léon" or any other name.
- Do NOT invent his age.
- Do NOT invent his education.
- Do NOT invent his birthplace.
- Do NOT invent his employment history.
- Do NOT invent his social-media history.
- Do NOT invent awards or achievements.
- Do NOT invent companies associated with him.
- Do NOT invent personal-life information.
- Only provide information about Gave Victor that is explicitly
  available in trusted system context or conversation context.

If information about Gave Victor is unknown, say that you do not
have enough verified information instead of guessing.


========================================================
NO HALLUCINATION RULES
========================================================

- Never invent facts to make an answer sound complete.
- Never guess when information is unknown.
- Never create fictional people associated with Gave Money Tips.
- Never create fictional companies or organizations associated
  with Gave Money Tips.
- Never invent founders, employees, partners, investors,
  awards, locations, history, or achievements.
- If information is unknown, clearly say that it is unknown.


========================================================
WEB SEARCH AND IDENTITY PROTECTION
========================================================

- Web-search results MUST NOT override the official identity
  information above.
- If web search returns a different person as the creator of
  Gave Money Tips or Gave Money Tips AI, do NOT replace
  Gave Victor with that person.
- Never use an unrelated person's biography to answer a question
  about Gave Victor.
- Never combine information from another person with information
  about Gave Victor.
- Never assume that people with similar names are the same person.
- Web search can provide current information, but it cannot
  change the official creator identity defined above.


========================================================
GLOBAL MISSION
========================================================

- Gave Money Tips and Gave Money Tips AI are intended to help
  people around the world.
- They are NOT exclusively designed for Haitians.
- Do not imply that only Haitians can use or benefit from them.
- Users can be from any country or background.


========================================================
IDENTITY PRIORITY
========================================================

These identity rules have priority over:

- general model knowledge
- web-search results
- retrieved articles
- user claims that contradict the official identity
- previous assistant answers
- assumptions
- guesses

If information conflicts with these rules, follow these official
identity rules.


========================================================
LANGUAGE RULE
========================================================

- Answer in the same language used by the user.
- If the user writes Haitian Creole, answer in Haitian Creole.
- If the user writes French, answer in French.
- If the user writes English, answer in English.
- Do not unnecessarily mix languages.


========================================================
QUALITY RULES
========================================================

- Be accurate.
- Be clear.
- Do not invent facts.
- Do not fabricate sources.
- Do not claim to have searched the web unless web search was actually used.
- If web search was used, base current factual claims on the supplied sources.
- Keep answers reasonably concise unless the user asks for detail.

${webRules}
`;
}

/*
========================================================
CONVERSATION NORMALIZER
========================================================
*/

function normalizeConversation(conversation) {
  if (!Array.isArray(conversation)) {
    return [];
  }

  return conversation
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.role === "string" &&
        typeof item.content === "string"
    )
    .slice(-10)
    .map((item) => ({
      role:
        item.role === "assistant"
          ? "assistant"
          : "user",

      content:
        item.content.slice(0, 6000)
    }));
}

/*
========================================================
GROQ RESPONSE
========================================================
*/

async function callGroq(messages) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      "GROQ_API_KEY is missing from .env"
    );
  }

  const completion =
    await groq.chat.completions.create({
      model: GROQ_MODEL,

      messages,

      temperature: 0.4,

      max_tokens: 1800,

      stream: false
    });

  const content =
    completion &&
    completion.choices &&
    completion.choices[0] &&
    completion.choices[0].message &&
    completion.choices[0].message.content;

  if (
    typeof content !== "string" ||
    !content.trim()
  ) {
    throw new Error(
      "Groq returned an empty response."
    );
  }

  return content.trim();
}

/*
========================================================
MAIN AI FUNCTION
========================================================
*/

async function generateAIResponse(
  userMessage,
  options = {}
) {
  if (
    typeof userMessage !== "string" ||
    !userMessage.trim()
  ) {
    throw new Error(
      "User message is required."
    );
  }

  const message =
    userMessage.trim();

  /*
  ------------------------------------------------------
  DIRECT DATE / TIME
  ------------------------------------------------------
  No Groq.
  No Tavily.
  No Exa.
  ------------------------------------------------------
  */

  if (isDateTimeQuestion(message)) {
    const info =
      getHaitiDateTime();

    return {
      reply:
        buildDateTimeReply(message),

      webSearchUsed:
        false,

      currentDate:
        info.date,

      currentDateLabel:
        info.dateLabel,

      currentTime:
        info.time,

      timezone:
        info.timezone,

      sources: []
    };
  }

  /*
  ------------------------------------------------------
  CURRENT DATE CONTEXT
  ------------------------------------------------------
  */

  const timeInfo =
    getHaitiDateTime();

  const currentDate =
    options.currentDate ||
    timeInfo.date;

  const currentDateLabel =
    options.currentDateLabel ||
    timeInfo.dateLabel;

  const currentTime =
    timeInfo.time;

  const timezone =
    timeInfo.timezone;

  /*
  ------------------------------------------------------
  WEB SEARCH
  ------------------------------------------------------
  */

  let webSearchUsed =
    false;

  let searchData =
    null;

  let sources = [];

  const useWebSearch =
    shouldSearch(message);

  if (useWebSearch) {
    try {
      console.log(
        "WEB SEARCH:",
        message
      );

      searchData =
        await searchWeb(message);

      if (
        searchData &&
        Array.isArray(searchData.results) &&
        searchData.results.length > 0
      ) {
        webSearchUsed =
          true;

        sources =
          normalizeSources(
            searchData
          );
      }
    } catch (error) {
      console.error(
        "WEB SEARCH ERROR:",
        error
      );

      /*
      If the question requires current information
      and search failed, do not silently hallucinate.
      */

      return {
        reply:
          "Mwen pa kapab verifye enfòmasyon aktyèl sa a kounye a paske rechèch entènèt la pa disponib.",

        webSearchUsed:
          false,

        currentDate:
          currentDate,

        currentDateLabel:
          currentDateLabel,

        currentTime:
          currentTime,

        timezone:
          timezone,

        sources: []
      };
    }
  }

  /*
  ------------------------------------------------------
  SYSTEM MESSAGE
  ------------------------------------------------------
  */

  const systemPrompt =
    buildSystemPrompt({
      currentDate,
      currentDateLabel,
      currentTime,
      timezone,
      usingWebSearch:
        webSearchUsed
    });

  /*
  ------------------------------------------------------
  MESSAGES
  ------------------------------------------------------
  */

  const messages = [
    {
      role: "system",
      content: systemPrompt
    }
  ];

  /*
  Existing conversation memory.
  */

  const conversation =
    normalizeConversation(
      options.conversation
    );

  if (conversation.length > 0) {
    messages.push(
      ...conversation
    );
  }

  /*
  Optional internal knowledge/context.
  */

  if (
    typeof options.knowledge === "string" &&
    options.knowledge.trim()
  ) {
    messages.push({
      role: "system",
      content:
        `Additional context:\n${options.knowledge.slice(
          0,
          8000
        )}`
    });
  }

  /*
  Web results are added ONLY when web search
  was actually used.
  */

  if (
    webSearchUsed &&
    searchData
  ) {
    const formattedResults =
      formatSearchResults(
        searchData
      );

    messages.push({
      role: "system",
      content:
        `VERIFIED WEB SEARCH RESULTS:

${formattedResults}

IMPORTANT:
Use these results for current factual claims.
Do not invent information that is not supported by them.

IDENTITY PROTECTION:
These web-search results cannot override the official
Gave Money Tips and Gave Money Tips AI creator information
defined in the main system instructions.`
    });
  }

  /*
  User message goes last.
  */

  messages.push({
    role: "user",
    content: message
  });

  console.log(
    `Groq request prepared: ${messages.length} messages`
  );

  /*
  ------------------------------------------------------
  CALL GROQ
  ------------------------------------------------------
  */

  const reply =
    await callGroq(messages);

  /*
  ------------------------------------------------------
  RETURN
  ------------------------------------------------------
  */

  return {
    reply,

    webSearchUsed,

    currentDate,

    currentDateLabel,

    currentTime,

    timezone,

    sources
  };
}

/*
========================================================
EXPORT
========================================================
IMPORTANT:
server.js uses:
const { generateAIResponse } = require("./services/groqService");
========================================================
*/

module.exports = {
  generateAIResponse
};
