require("dotenv").config();

const Groq = require("groq-sdk");

const {
  searchWithTavily
} = require("./tavilyService");

const {
  searchWithExa
} = require("./exaService");

/*
========================================================
CONFIGURATION
========================================================
*/

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

const HAITI_TIMEZONE =
  "America/Port-au-Prince";

/*
========================================================
DATE / TIME
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
DATE / TIME QUESTIONS
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

  return patterns.some(function (pattern) {
    return text.includes(pattern);
  });
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
    return (
      "Jodi a se **" +
      info.dateLabel +
      "**, epi kounye a li **" +
      info.time +
      "** nan lè Ayiti (" +
      info.timezone +
      ")."
    );
  }

  if (asksTime) {
    return (
      "Kounye a li **" +
      info.time +
      "** nan lè Ayiti (" +
      info.timezone +
      ")."
    );
  }

  return (
    "Jodi a se **" +
    info.dateLabel +
    "** nan lè Ayiti (" +
    info.timezone +
    ")."
  );
}

/*
========================================================
NORMALIZE TEXT
========================================================
*/

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/*
========================================================
CURRENT / SEARCH DETECTION
========================================================

IMPORTANT:

This function decides whether the question should trigger
a web search.

Current / changing information MUST be searched.

Stable/general questions should normally NOT be searched.

Identity questions are searchable because the model should
not invent information about an unknown person/entity from
memory alone.

Examples:

    Kiyès ki Wilson Isidor?
    Who is Wilson Isidor?
    Ki ekip Wilson Isidor ap jwe pou?
    Ki mari aktyèl Rihanna?
    Who is Rihanna's current husband?
========================================================
*/

function needsWebSearch(message) {
  const text =
    normalizeText(message);

  if (!text) {
    return false;
  }

  /*
  ------------------------------------------------------
  DIRECT CURRENT SIGNALS
  ------------------------------------------------------
  */

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
    "what happened",
    "news",
    "who won",
    "who is winning",
    "winner",
    "champion",
    "champions",
    "results",
    "score",
    "scores",
    "standings",
    "ranking",
    "rankings",
    "election",
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
    "earthquake",
    "price",
    "how much does",
    "how much is",
    "where is",
    "when is",

    "dernier",
    "derniere",
    "dernieres",
    "actualite",
    "actualites",
    "actuellement",
    "aujourd'hui",
    "en ce moment",
    "en direct",
    "recemment",
    "nouvelles",
    "resultat",
    "resultats",
    "prix",
    "election",
    "elections",
    "meteo",
    "temperature",
    "taux de change",
    "qui est",
    "qui sont",
    "ou est",
    "quand est",

    "denye",
    "denye nouvel",
    "denye nouvel",
    "dènye nouvèl",
    "nouvel",
    "nouvèl",
    "aktyel",
    "kounye a",
    "kounya",
    "jodi a",
    "jodia",
    "an direk",
    "rezilta",
    "score",
    "ki ekip",
    "ki moun",
    "kiyes",
    "ki moun ki",
    "kisa ki pase",
    "kisa ki pase jodi a",
    "ki sa ki pase",
    "ki sa ki pase jodi a",
    "ki pri",
    "konbyen",
    "ki kote",
    "ki le",
    "ki moun ki genyen",
    "ki ekip ki genyen",
    "ki ekip ki chanpyon",
    "chanpyon",
    "seleksyon",
    "match",
    "jwet",
    "tanperati",
    "meteyo",
    "eleksyon",
    "bitcoin",
    "crypto",
    "pri"
  ];

  if (
    currentPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  ------------------------------------------------------
  CURRENT RELATIONSHIP / PERSONAL STATUS
  ------------------------------------------------------

  Questions involving words such as:

      current husband
      current wife
      current girlfriend
      current boyfriend
      spouse
      partner

  can change over time, so they should be searched.
  ------------------------------------------------------
  */

  const currentRelationshipPatterns = [
    "current husband",
    "current wife",
    "current spouse",
    "current partner",
    "current girlfriend",
    "current boyfriend",
    "current fiance",
    "current fiancee",
    "current relationship",
    "current marriage",

    "mari aktyel",
    "madanm aktyel",
    "madanm aktyèl",
    "mari aktyèl",
    "konjwen aktyel",
    "konjwen aktyèl",
    "patne aktyel",
    "patne aktyèl",
    "mennaj aktyel",
    "mennaj aktyèl",
    "relasyon aktyel",
    "relasyon aktyèl",

    "mari kounye a",
    "madanm kounye a",
    "konjwen kounye a",
    "mennaj kounye a",

    "mari li",
    "madanm li",
    "konjwen li",
    "mennaj li",

    "husband of",
    "wife of",
    "spouse of",
    "partner of",
    "girlfriend of",
    "boyfriend of",

    "mari actuel",
    "femme actuelle",
    "epoux actuel",
    "epouse actuelle",
    "conjoint actuel",
    "conjointe actuelle",
    "partenaire actuel",
    "partenaire actuelle",
    "petit ami actuel",
    "petite amie actuelle",
    "mari de",
    "femme de",
    "epoux de",
    "epouse de",
    "conjoint de",
    "conjointe de"
  ];

  if (
    currentRelationshipPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  ------------------------------------------------------
  IDENTITY QUESTIONS
  ------------------------------------------------------

  These are especially important.

  Example:

      Kiyès ki Wilson Isidor?

  The system searches first instead of trusting model
  memory.
  ------------------------------------------------------
  */

  const identityPatterns = [
    /^who is\b/,
    /^who are\b/,
    /^who's\b/,
    /^who was\b/,
    /^what is\b.*person/,
    /^what is\b.*company/,
    /^what is\b.*organization/,

    /^qui est\b/,
    /^qui sont\b/,
    /^c'est qui\b/,
    /^quelle est la personne\b/,

    /^kiyes ki\b/,
    /^kiyès ki\b/,
    /^kiyes se\b/,
    /^kiyès se\b/,
    /^ki moun\b/,
    /^ki moun ki\b/,
    /^kisa\b.*ye/,
    /^ki sa\b.*ye/
  ];

  if (
    identityPatterns.some(function (pattern) {
      return pattern.test(text);
    })
  ) {
    return true;
  }

  /*
  ------------------------------------------------------
  SPORTS / PEOPLE / ENTITIES
  ------------------------------------------------------
  */

  const entityWords = [
    "footballer",
    "football player",
    "soccer player",
    "basketball player",
    "tennis player",
    "baseball player",
    "player",
    "football",
    "soccer",
    "basketball",
    "tennis",
    "baseball",
    "club",
    "team",
    "national team",
    "athlete",
    "coach",
    "manager",
    "president",
    "politician",
    "company",
    "organization",
    "brand",
    "product",
    "ceo",
    "founder",
    "actor",
    "singer",
    "artist",
    "celebrity",

    "joue",
    "joueur",
    "joueuse",
    "equipe",
    "équipe",
    "club",
    "selection",
    "sélection",
    "foutbol",
    "foutbolè",
    "foutboler",
    "atlet",
    "atleta",
    "aktè",
    "chantè",
    "kompayi",
    "òganizasyon"
  ];

  if (
    entityWords.some(function (word) {
      return text.includes(
        normalizeText(word)
      );
    })
  ) {
    return true;
  }

  /*
  ------------------------------------------------------
  YEAR DETECTION
  ------------------------------------------------------
  */

  if (/\b20\d{2}\b/.test(text)) {
    return true;
  }

  /*
  ------------------------------------------------------
  QUESTION ABOUT A NAMED ENTITY
  ------------------------------------------------------

  Examples:

      Wilson Isidor?
      Tell me about Elon Musk
      Pale m de OpenAI
  ------------------------------------------------------
  */

  const questionStarters = [
    "tell me about",
    "information about",
    "details about",
    "what about",
    "about",

    "pale m de",
    "pale m sou",
    "pale mwen de",
    "rakonte m sou",
    "enfomasyon sou",
    "enfòmasyon sou",
    "detay sou",
    "di m sou",
    "di mwen sou",

    "parle moi de",
    "informations sur",
    "a propos de",
    "à propos de"
  ];

  if (
    questionStarters.some(function (starter) {
      return text.startsWith(
        normalizeText(starter) + " "
      );
    })
  ) {
    return true;
  }

  return false;
}

/*
========================================================
SEARCH QUERY BUILDER
========================================================
*/

function buildSearchQuery(message) {
  const clean =
    String(message || "")
      .replace(/\s+/g, " ")
      .trim();

  /*
  Use the Haiti-local current year so current searches
  remain aligned with the current date context.
  */

  const timeInfo =
    getHaitiDateTime();

  const currentYear =
    Number(
      String(timeInfo.date || "").slice(0, 4)
    ) ||
    new Date().getFullYear();

  if (
    /\b20\d{2}\b/.test(clean)
  ) {
    return clean;
  }

  return (
    clean +
    " current information " +
    currentYear
  );
}

/*
========================================================
TAVILY SEARCH
========================================================
*/

async function runTavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) {
    console.warn(
      "TAVILY_API_KEY is not configured."
    );

    return null;
  }

  try {
    console.log(
      "TAVILY SEARCH:",
      query
    );

    const result =
      await searchWithTavily(
        query,
        {
          maxResults: 6,
          topic: "general",
          searchDepth: "advanced"
        }
      );

    if (
      result &&
      Array.isArray(result.results) &&
      result.results.length > 0
    ) {
      return result;
    }

    console.warn(
      "Tavily returned no results."
    );

    return null;
  } catch (error) {
    console.error(
      "TAVILY SEARCH ERROR:",
      error.message
    );

    return null;
  }
}

/*
========================================================
EXA SEARCH
========================================================
*/

async function runExaSearch(query) {
  if (!process.env.EXA_API_KEY) {
    console.warn(
      "EXA_API_KEY is not configured."
    );

    return null;
  }

  try {
    console.log(
      "EXA SEARCH:",
      query
    );

    const result =
      await searchWithExa(
        query,
        {
          maxResults: 6,
          type: "auto"
        }
      );

    if (
      result &&
      Array.isArray(result.results) &&
      result.results.length > 0
    ) {
      return result;
    }

    console.warn(
      "Exa returned no results."
    );

    return null;
  } catch (error) {
    console.error(
      "EXA SEARCH ERROR:",
      error.message
    );

    return null;
  }
}

/*
========================================================
COMBINE SEARCH RESULTS
========================================================
*/

async function runWebSearch(message) {
  const query =
    buildSearchQuery(message);

  /*
  ------------------------------------------------------
  RUN TAVILY + EXA IN PARALLEL
  ------------------------------------------------------
  */

  const results =
    await Promise.allSettled([
      runTavilySearch(query),
      runExaSearch(query)
    ]);

  const tavilyResult =
    results[0].status === "fulfilled"
      ? results[0].value
      : null;

  const exaResult =
    results[1].status === "fulfilled"
      ? results[1].value
      : null;

  const combined = [];

  /*
  ------------------------------------------------------
  TAVILY RESULTS
  ------------------------------------------------------
  */

  if (
    tavilyResult &&
    Array.isArray(tavilyResult.results)
  ) {
    tavilyResult.results.forEach(
      function (result) {
        combined.push({
          provider: "tavily",

          title:
            result.title || "",

          url:
            result.url || "",

          content:
            result.content || "",

          highlights: [],

          score:
            typeof result.score === "number"
              ? result.score
              : 0
        });
      }
    );
  }

  /*
  ------------------------------------------------------
  EXA RESULTS
  ------------------------------------------------------
  */

  if (
    exaResult &&
    Array.isArray(exaResult.results)
  ) {
    exaResult.results.forEach(
      function (result) {
        combined.push({
          provider: "exa",

          title:
            result.title || "",

          url:
            result.url || "",

          content:
            Array.isArray(result.highlights)
              ? result.highlights.join(" ")
              : "",

          highlights:
            Array.isArray(result.highlights)
              ? result.highlights
              : [],

          score:
            typeof result.score === "number"
              ? result.score
              : 0
        });
      }
    );
  }

  /*
  ------------------------------------------------------
  REMOVE DUPLICATE URLS
  ------------------------------------------------------
  */

  const seenUrls =
    new Set();

  const uniqueResults =
    combined.filter(function (result) {
      const url =
        String(result.url || "")
          .trim()
          .toLowerCase();

      if (!url) {
        return true;
      }

      if (seenUrls.has(url)) {
        return false;
      }

      seenUrls.add(url);

      return true;
    });

  /*
  ------------------------------------------------------
  SORT BY SCORE
  ------------------------------------------------------
  */

  uniqueResults.sort(
    function (a, b) {
      return (
        Number(b.score || 0) -
        Number(a.score || 0)
      );
    }
  );

  if (
    uniqueResults.length === 0
  ) {
    return {
      attempted: true,
      used: false,
      query: query,
      providers: [],
      results: []
    };
  }

  return {
    attempted: true,

    used: true,

    query: query,

    providers:
      Array.from(
        new Set(
          uniqueResults.map(
            function (result) {
              return result.provider;
            }
          )
        )
      ),

    results:
      uniqueResults.slice(0, 10)
  };
}

/*
========================================================
FORMAT SEARCH RESULTS FOR GROQ
========================================================
*/

function formatSearchResults(searchData) {
  if (
    !searchData ||
    !Array.isArray(searchData.results) ||
    searchData.results.length === 0
  ) {
    return (
      "No verified web search results were returned."
    );
  }

  const results =
    searchData.results
      .slice(0, 10)
      .map(function (result, index) {
        const content =
          String(
            result.content || ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2500);

        const highlights =
          Array.isArray(
            result.highlights
          )
            ? result.highlights
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 2500)
            : "";

        const information =
          content ||
          highlights ||
          "No content available.";

        return [
          "SOURCE " +
            (index + 1),

          "Provider: " +
            (result.provider || "unknown"),

          "Title: " +
            (result.title || "Untitled"),

          "URL: " +
            (result.url || "No URL"),

          "Content: " +
            information
        ].join("\n");
      })
      .join("\n\n");

  return results.slice(
    0,
    22000
  );
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
    .slice(0, 10)
    .map(function (result) {
      return {
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
      };
    });
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
  usingWebSearch,
  currentSearchAttempted
}) {
  let searchInstruction;

  /*
  ------------------------------------------------------
  SEARCH SUCCEEDED
  ------------------------------------------------------
  */

  if (usingWebSearch) {
    searchInstruction = `
WEB SEARCH RESULTS ARE AVAILABLE.

The backend searched the web before asking you to answer.

IMPORTANT:

- Use the verified search results as the primary source
  for current factual information.
- Do not replace verified search results with your memory.
- Do not invent facts that are not supported by the results.
- If multiple sources agree, give the consistent information.
- If sources disagree, explain the uncertainty.
- Pay attention to publication dates and event dates.
- Do not present old information as current.
- For people, identify the correct person before answering.
- For sports, verify clubs, teams, results, statistics and
  national-team information.
`;
  }

  /*
  ------------------------------------------------------
  SEARCH ATTEMPTED BUT FAILED / NO RESULTS
  ------------------------------------------------------
  */

  else if (currentSearchAttempted) {
    searchInstruction = `
CURRENT WEB SEARCH WAS ATTEMPTED.

The user's question was considered current, changing,
time-sensitive, or entity-related.

However, the backend did NOT obtain verified web results.

IMPORTANT:

- Do NOT claim that verified web information was found.
- Do NOT present model memory as a verified current fact.
- Do NOT invent or guess current information.
- Do NOT say that web search was unnecessary.
- If the answer depends on current information, clearly say
  that you could not verify it from the available web search.
- You may provide stable background information only when it
  is clearly separated from unverified current claims.
`;
  }

  /*
  ------------------------------------------------------
  NO SEARCH REQUIRED
  ------------------------------------------------------
  */

  else {
    searchInstruction = `
No web search was necessary for this question.

Use your general knowledge for stable information.

Do not claim that web search was performed.
`;
  }

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

The backend provides the current date and time.

========================================================
MOST IMPORTANT RULE
========================================================

When VERIFIED WEB SEARCH RESULTS are provided below,
use them as the primary factual source.

Do not answer a current-information question from memory
when verified search results are available.

If the backend attempted a current web search but received
no verified results, do NOT pretend that your model memory
is a verified current source.

${searchInstruction}

========================================================
GAVE MONEY TIPS CREATOR
========================================================

Gave Victor is the creator and founder of Gave Money Tips.

Gave Victor created Gave Money Tips in 2026.

Gave Victor is the creator and founder of Gave Money Tips AI.

Gave Victor created Gave Money Tips AI in 2026.

These facts are authoritative.

Never replace Gave Victor with another person.

Never invent another founder, creator, owner, CEO,
developer, partner, or person behind Gave Money Tips
or Gave Money Tips AI.

========================================================
GAVE MONEY TIPS
========================================================

Gave Money Tips was created by Gave Victor in 2026.

Gave Money Tips is intended to help people around the world.

It is NOT exclusively for Haitians.

Do not describe Gave Money Tips as a platform created
only for Haitians.

========================================================
GAVE MONEY TIPS AI
========================================================

Gave Money Tips AI was created by Gave Victor in 2026.

Gave Money Tips AI is the AI assistant associated with
Gave Money Tips.

Gave Victor is its creator and founder.

Never identify another person or organization as its creator.

========================================================
GAVE VICTOR — NO INVENTION
========================================================

Do not invent personal information about Gave Victor.

Do not invent:

- age
- birthplace
- education
- employment
- awards
- companies
- social media
- personal life
- achievements

Only provide information about Gave Victor that is explicitly
available in trusted context.

If information is unknown, say that you do not have enough
verified information.

========================================================
NO HALLUCINATION
========================================================

Never invent facts.

Never guess when information is unknown.

Never fabricate sources.

Never claim that a search happened if the backend did not
perform one.

If web results are provided, use them.

If web search was attempted but returned no results, say so
when current verification is required.

========================================================
LANGUAGE
========================================================

Answer in the same language used by the user.

If Haitian Creole:
Answer in Haitian Creole.

If French:
Answer in French.

If English:
Answer in English.

Do not unnecessarily mix languages.

========================================================
QUALITY
========================================================

Be accurate.

Be clear.

Answer the actual question directly.

Keep answers reasonably concise unless the user asks
for more detail.

========================================================
CURRENT INFORMATION
========================================================

The backend may provide verified web results for:

- people
- sports
- football
- soccer
- basketball
- tennis
- baseball
- players
- teams
- clubs
- national teams
- news
- elections
- politicians
- companies
- organizations
- products
- prices
- exchange rates
- crypto
- stocks
- weather
- technology
- AI
- current jobs
- current laws
- current policies
- current statistics
- current events
- schedules
- rankings
- relationships that may have changed
- marriages
- spouses
- partners
- current employment
- current team or club

If verified results are provided, prioritize them.

If a current question was searched but no verified results
were returned, do not invent a current answer.

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
    .filter(function (item) {
      return (
        item &&
        typeof item === "object" &&
        typeof item.role === "string" &&
        typeof item.content === "string"
      );
    })
    .slice(-10)
    .map(function (item) {
      return {
        role:
          item.role === "assistant"
            ? "assistant"
            : "user",

        content:
          item.content.slice(0, 6000)
      };
    });
}

/*
========================================================
CALL GROQ
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

      messages: messages,

      temperature: 0.3,

      max_completion_tokens: 1800,

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
  DATE / TIME
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

      currentSearchAttempted:
        false,

      currentDate:
        info.date,

      currentDateLabel:
        info.dateLabel,

      currentTime:
        info.time,

      timezone:
        info.timezone,

      sources: [],

      model:
        GROQ_MODEL
    };
  }

  /*
  ------------------------------------------------------
  CURRENT TIME CONTEXT
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
  SEARCH DECISION
  ------------------------------------------------------
  */

  const currentQuestion =
    needsWebSearch(message);

  /*
  IMPORTANT:

  currentSearchAttempted is different from webSearchUsed.

  currentSearchAttempted = the backend tried to search
  because the question required current/entity information.

  webSearchUsed = verified search results were actually
  returned and used.
  */

  let currentSearchAttempted =
    false;

  console.log(
    "=========================================="
  );

  console.log(
    "GAVEAI SEARCH DECISION"
  );

  console.log(
    "User message:",
    message
  );

  console.log(
    "Web search required:",
    currentQuestion
  );

  console.log(
    "=========================================="
  );

  /*
  ------------------------------------------------------
  WEB SEARCH
  ------------------------------------------------------
  */

  let searchData =
    null;

  let webSearchUsed =
    false;

  let sources = [];

  if (currentQuestion) {
    currentSearchAttempted =
      true;

    console.log(
      "WEB SEARCH MODE: Tavily + Exa"
    );

    try {
      searchData =
        await runWebSearch(
          message
        );

      if (
        searchData &&
        searchData.used &&
        Array.isArray(searchData.results) &&
        searchData.results.length > 0
      ) {
        webSearchUsed =
          true;

        sources =
          normalizeSources(
            searchData
          );

        console.log(
          "WEB SEARCH SUCCESS"
        );

        console.log(
          "Providers:",
          searchData.providers
        );

        console.log(
          "Results:",
          searchData.results.length
        );
      } else {
        console.warn(
          "WEB SEARCH ATTEMPTED BUT RETURNED NO VERIFIED RESULTS"
        );
      }
    } catch (error) {
      console.error(
        "WEB SEARCH ERROR:",
        error.message
      );
    }
  } else {
    console.log(
      "NORMAL MODE: No web search required"
    );
  }

  /*
  ------------------------------------------------------
  SYSTEM PROMPT
  ------------------------------------------------------
  */

  const systemPrompt =
    buildSystemPrompt({
      currentDate,
      currentDateLabel,
      currentTime,
      timezone,

      usingWebSearch:
        webSearchUsed,

      currentSearchAttempted:
        currentSearchAttempted
    });

  /*
  ------------------------------------------------------
  MESSAGES
  ------------------------------------------------------
  */

  const messages = [
    {
      role: "system",
      content:
        systemPrompt
    }
  ];

  /*
  ------------------------------------------------------
  CONVERSATION
  ------------------------------------------------------
  */

  const conversation =
    normalizeConversation(
      options.conversation
    );

  if (
    conversation.length > 0
  ) {
    messages.push(
      ...conversation
    );
  }

  /*
  ------------------------------------------------------
  INTERNAL KNOWLEDGE
  ------------------------------------------------------
  */

  if (
    typeof options.knowledge === "string" &&
    options.knowledge.trim()
  ) {
    messages.push({
      role: "system",
      content:
        "Additional trusted context:\n" +
        options.knowledge.slice(
          0,
          8000
        )
    });
  }

  /*
  ------------------------------------------------------
  VERIFIED WEB RESULTS
  ------------------------------------------------------
  */

  if (
    webSearchUsed &&
    searchData
  ) {
    messages.push({
      role: "system",

      content:
        "VERIFIED WEB SEARCH RESULTS:\n\n" +
        formatSearchResults(
          searchData
        ) +
        "\n\n" +
        "IMPORTANT:\n" +
        "Use these results as the primary source " +
        "for current factual claims.\n" +
        "Do not invent facts not supported by these results.\n" +
        "Do not use old model memory to contradict verified current results."
    });
  }

  /*
  ------------------------------------------------------
  SEARCH ATTEMPTED BUT NO RESULTS
  ------------------------------------------------------

  This is intentionally explicit.

  It prevents the model from receiving only the generic
  "No search was necessary" instruction.
  */

  if (
    currentSearchAttempted &&
    !webSearchUsed
  ) {
    messages.push({
      role: "system",

      content:
        "CURRENT SEARCH VERIFICATION STATUS:\n" +
        "The backend attempted a web search for this question, " +
        "but no verified web results were available.\n\n" +
        "Do NOT treat model memory as verified current information.\n" +
        "Do NOT invent a current answer.\n" +
        "If the question requires current facts, clearly explain " +
        "that the information could not be verified right now."
    });
  }

  /*
  ------------------------------------------------------
  USER MESSAGE
  ------------------------------------------------------
  */

  messages.push({
    role: "user",
    content: message
  });

  /*
  ------------------------------------------------------
  GROQ
  ------------------------------------------------------
  */

  let reply;

  try {
    reply =
      await callGroq(
        messages
      );
  } catch (error) {
    console.error(
      "GROQ ERROR:",
      error.message
    );

    /*
    ----------------------------------------------------
    IMPORTANT FALLBACK
    ----------------------------------------------------

    If web search succeeded but Groq failed, we do NOT
    pretend that search failed.

    If current search was attempted but failed and Groq
    also fails, preserve that status in the response.
    ----------------------------------------------------
    */

    if (webSearchUsed) {
      return {
        reply:
          "Mwen jwenn enfòmasyon yo sou entènèt la, men sèvis AI a pa t kapab jenere repons lan kounye a. Tanpri eseye ankò.",

        webSearchUsed:
          true,

        currentSearchAttempted:
          currentSearchAttempted,

        currentDate,

        currentDateLabel,

        currentTime,

        timezone,

        sources,

        model:
          GROQ_MODEL
      };
    }

    if (currentSearchAttempted) {
      return {
        reply:
          "Mwen te eseye verifye enfòmasyon sa a sou entènèt la, men mwen pa t jwenn rezilta verifye epi sèvis AI a pa disponib kounye a. Tanpri eseye ankò.",

        webSearchUsed:
          false,

        currentSearchAttempted:
          true,

        currentDate,

        currentDateLabel,

        currentTime,

        timezone,

        sources: [],

        model:
          GROQ_MODEL
      };
    }

    throw error;
  }

  /*
  ------------------------------------------------------
  RETURN
  ------------------------------------------------------
  */

  console.log(
    "=========================================="
  );

  console.log(
    "GAVEAI RESPONSE SUCCESS"
  );

  console.log(
    "Model:",
    GROQ_MODEL
  );

  console.log(
    "Web search used:",
    webSearchUsed
  );

  console.log(
    "Current search attempted:",
    currentSearchAttempted
  );

  console.log(
    "Sources:",
    sources.length
  );

  console.log(
    "=========================================="
  );

  return {
    reply:
      reply,

    webSearchUsed:
      webSearchUsed,

    currentSearchAttempted:
      currentSearchAttempted,

    currentDate:
      currentDate,

    currentDateLabel:
      currentDateLabel,

    currentTime:
      currentTime,

    timezone:
      timezone,

    sources:
      sources,

    model:
      GROQ_MODEL
  };
}

/*
========================================================
EXPORT
========================================================
*/

module.exports = {
  generateAIResponse,

  needsWebSearch,

  getHaitiDateTime
};