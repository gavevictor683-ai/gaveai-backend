require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env")
});

const { searchWithTavily } = require("./tavilyService");
const { searchWithExa } = require("./exaService");

/*
========================================================
DATE
========================================================
*/

function getCurrentDateInfo() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const isoDate = formatter.format(now);

  const parts = isoDate.split("-");

  return {
    isoDate,
    year: parts[0],
    month: parts[1],
    day: parts[2]
  };
}

/*
========================================================
TEXT NORMALIZATION
========================================================
*/

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/*
========================================================
QUESTION DETECTION
========================================================

This is intentionally broader than the old "latest/current"
keyword list.

The goal is to recognize factual questions even when the user
does not explicitly say "latest".

Examples:

- Kiyès ki Wilson Isidor?
- Ki moun Lenny Joseph ye?
- Ki ekip ki te chanpyon Mondyal 2026 la?
- What team does X play for?
- Who is X?
- Where is X?
- What happened?
- How much is Bitcoin?
- What is the result?
- Tell me about X.

========================================================
*/

function looksLikeFactualQuestion(message) {
  const text = normalizeText(message);

  if (!text) {
    return false;
  }

  /*
  Casual/conversational messages that normally do not need
  external search.
  */

  const casualPatterns = [
    "hello",
    "hi",
    "hey",
    "bonjour",
    "bonsoir",
    "bonjou",
    "bonswa",
    "mwen kontan",
    "mwen renmen ou",
    "mwen bezwen pale",
    "kijan ou ye",
    "koman ou ye",
    "how are you",
    "thank you",
    "thanks",
    "mersi",
    "mesi",
    "good morning",
    "good evening",
    "good night",
    "tell me a joke",
    "make me laugh",
    "write me a poem",
    "write a story",
    "ekri yon powem",
    "ekri yon istwa"
  ];

  if (
    casualPatterns.some(function (pattern) {
      return text === pattern;
    })
  ) {
    return false;
  }

  /*
  Direct factual question structures.
  */

  const factualQuestionPatterns = [
    /*
    Haitian Creole
    */

    "kiyes",
    "ki moun",
    "ki sa",
    "kisa",
    "ki ekip",
    "ki peyi",
    "ki klib",
    "ki kote",
    "ki le",
    "ki dat",
    "ki pri",
    "konbyen",
    "poukisa",
    "kijan",
    "kilè",
    "eske",
    "èske",
    "kisa ki pase",
    "ki sa ki pase",
    "ki moun ki",
    "ki ekip ki",
    "ki peyi ki",
    "ki klib ki",

    /*
    French
    */

    "qui est",
    "qui sont",
    "qu'est ce que",
    "qu est ce que",
    "quel",
    "quelle",
    "quels",
    "quelles",
    "ou est",
    "où est",
    "combien",
    "pourquoi",
    "comment",
    "quand",
    "est ce que",
    "résultat",
    "resultat",
    "actualité",
    "actualite",

    /*
    English
    */

    "who is",
    "who are",
    "what is",
    "what are",
    "what happened",
    "which team",
    "which club",
    "which country",
    "where is",
    "when is",
    "how much",
    "how many",
    "why",
    "how",
    "did",
    "does",
    "is ",
    "are "
  ];

  if (
    factualQuestionPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  A question mark is a strong signal that the user may be
  asking for factual information.
  */

  if (text.includes("?")) {
    return true;
  }

  /*
  Named-entity style requests.

  If a short message appears to ask for information about a
  person, organization, team, company, product, place, etc.,
  search is safer than hallucinating.
  */

  const informationRequestPatterns = [
    "tell me about",
    "parle moi de",
    "parle-moi de",
    "pale m de",
    "enfomasyon sou",
    "informations sur",
    "information about",
    "details about",
    "detay sou",
    "about ",
    "sou "
  ];

  if (
    informationRequestPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  Current-information concepts.

  This is only a secondary signal. We are NOT relying on this
  list alone anymore.
  */

  const currentPatterns = [
    "latest",
    "current",
    "currently",
    "right now",
    "today",
    "yesterday",
    "tomorrow",
    "recent",
    "recently",
    "breaking",
    "live",
    "news",
    "2026",
    "2025",
    "jodi",
    "jodia",
    "kounye",
    "denye",
    "dènye",
    "aktyel",
    "aktyèl",
    "resan",
    "aujourd",
    "actuellement",
    "dernier",
    "derniere",
    "récemment",
    "recemment",
    "prix",
    "price",
    "score",
    "result",
    "résultat",
    "resultat",
    "election",
    "élection",
    "weather",
    "meteo",
    "météo",
    "temperature",
    "exchange rate",
    "bitcoin",
    "crypto",
    "stock"
  ];

  if (
    currentPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  return false;
}

/*
========================================================
ORGANIZATION DETECTION
========================================================
*/

function getRequestedOrganizations(query) {
  const text = normalizeText(query);

  return {
    openai:
      text.includes("openai") ||
      text.includes("chatgpt") ||
      text.includes("gpt"),

    google:
      text.includes("google") ||
      text.includes("gemini"),

    anthropic:
      text.includes("anthropic") ||
      text.includes("claude")
  };
}

/*
========================================================
OFFICIAL SOURCE DETECTION
========================================================
*/

function getOrganizationFromUrl(url) {
  const lowerUrl = String(url || "").toLowerCase();

  if (
    lowerUrl.includes("openai.com") ||
    lowerUrl.includes("help.openai.com")
  ) {
    return "openai";
  }

  if (
    lowerUrl.includes("blog.google") ||
    lowerUrl.includes("ai.google") ||
    lowerUrl.includes("deepmind.google") ||
    lowerUrl.includes("support.google.com") ||
    lowerUrl.includes("google.com")
  ) {
    return "google";
  }

  if (lowerUrl.includes("anthropic.com")) {
    return "anthropic";
  }

  return null;
}

function getSourcePriority(url) {
  const lowerUrl = String(url || "").toLowerCase();

  if (
    lowerUrl.includes("openai.com") ||
    lowerUrl.includes("help.openai.com")
  ) {
    return 100;
  }

  if (
    lowerUrl.includes("blog.google") ||
    lowerUrl.includes("ai.google") ||
    lowerUrl.includes("deepmind.google") ||
    lowerUrl.includes("support.google.com") ||
    lowerUrl.includes("google.com")
  ) {
    return 100;
  }

  if (lowerUrl.includes("anthropic.com")) {
    return 100;
  }

  if (
    lowerUrl.includes("reuters.com") ||
    lowerUrl.includes("apnews.com") ||
    lowerUrl.includes("associatedpress.com")
  ) {
    return 95;
  }

  if (
    lowerUrl.includes("bbc.com") ||
    lowerUrl.includes("bbc.co.uk")
  ) {
    return 90;
  }

  if (
    lowerUrl.includes("espn.com") ||
    lowerUrl.includes("fifa.com") ||
    lowerUrl.includes("uefa.com")
  ) {
    return 90;
  }

  if (
    lowerUrl.includes("techcrunch.com") ||
    lowerUrl.includes("theverge.com") ||
    lowerUrl.includes("arstechnica.com") ||
    lowerUrl.includes("wired.com")
  ) {
    return 85;
  }

  if (
    lowerUrl.includes("nytimes.com") ||
    lowerUrl.includes("washingtonpost.com")
  ) {
    return 80;
  }

  return 20;
}

function isOfficialSource(url, query) {
  const organization = getOrganizationFromUrl(url);
  const requested = getRequestedOrganizations(query);

  if (!organization) {
    return false;
  }

  return Boolean(requested[organization]);
}

/*
========================================================
NORMALIZATION
========================================================
*/

function normalizeUrl(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

function normalizeResult(result, provider, query) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const title =
    typeof result.title === "string"
      ? result.title.trim()
      : "";

  const url =
    typeof result.url === "string"
      ? result.url.trim()
      : "";

  const content =
    typeof result.content === "string"
      ? result.content.trim()
      : "";

  const highlights =
    Array.isArray(result.highlights)
      ? result.highlights
          .filter(function (item) {
            return typeof item === "string";
          })
          .join(" ")
          .trim()
      : "";

  if (!title && !url && !content && !highlights) {
    return null;
  }

  const organization = getOrganizationFromUrl(url);
  const official = isOfficialSource(url, query);

  return {
    title,
    url,
    content,
    highlights,

    score:
      typeof result.score === "number"
        ? result.score
        : 0,

    provider,

    official,

    organization,

    sourcePriority:
      getSourcePriority(url) +
      (official ? 20 : 0)
  };
}

/*
========================================================
DEDUPLICATION
========================================================
*/

function deduplicateResults(results) {
  const seen = new Set();
  const unique = [];

  for (const result of results) {
    if (!result) {
      continue;
    }

    const normalizedUrl =
      normalizeUrl(result.url);

    const titleKey =
      String(result.title || "")
        .trim()
        .toLowerCase();

    const contentKey =
      String(result.content || "")
        .trim()
        .slice(0, 150)
        .toLowerCase();

    const key =
      normalizedUrl ||
      titleKey + "|" + contentKey;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(result);
  }

  return unique;
}

/*
========================================================
RANKING
========================================================
*/

function rankResults(results, query) {
  const requested =
    getRequestedOrganizations(query);

  return results
    .slice()
    .sort(function (a, b) {
      const aOfficial =
        Number(Boolean(a.official));

      const bOfficial =
        Number(Boolean(b.official));

      if (bOfficial !== aOfficial) {
        return bOfficial - aOfficial;
      }

      const aPriority =
        a.sourcePriority || 0;

      const bPriority =
        b.sourcePriority || 0;

      if (bPriority !== aPriority) {
        return bPriority - aPriority;
      }

      const aRequested =
        a.organization &&
        requested[a.organization]
          ? 1
          : 0;

      const bRequested =
        b.organization &&
        requested[b.organization]
          ? 1
          : 0;

      if (bRequested !== aRequested) {
        return bRequested - aRequested;
      }

      return (
        (b.score || 0) -
        (a.score || 0)
      );
    });
}

/*
========================================================
BUILD SEARCH QUERY
========================================================
*/

function buildSearchQueries(query) {
  const cleanQuery =
    String(query || "").trim();

  const dateInfo =
    getCurrentDateInfo();

  const queries = [];

  /*
  Primary query.

  We do NOT force "latest" into every query because that can
  distort historical questions.
  */

  queries.push(
    cleanQuery +
      " verify factual information as of " +
      dateInfo.isoDate
  );

  /*
  For current-looking questions, add a second query explicitly
  asking for recent information.
  */

  if (
    looksLikeFactualQuestion(cleanQuery)
  ) {
    queries.push(
      cleanQuery +
        " current verified information " +
        dateInfo.isoDate
    );
  }

  const requested =
    getRequestedOrganizations(
      cleanQuery
    );

  if (requested.openai) {
    queries.push(
      cleanQuery +
        " official OpenAI information site:openai.com " +
        dateInfo.isoDate
    );
  }

  if (requested.google) {
    queries.push(
      cleanQuery +
        " official Google information site:blog.google OR site:ai.google " +
        dateInfo.isoDate
    );
  }

  if (requested.anthropic) {
    queries.push(
      cleanQuery +
        " official Anthropic information site:anthropic.com " +
        dateInfo.isoDate
    );
  }

  return [
    ...new Set(
      queries.filter(Boolean)
    )
  ];
}

/*
========================================================
PROVIDER
========================================================
*/

async function runProviderSearch(
  provider,
  query,
  options
) {
  const searchOptions = {
    ...(options || {}),
    maxResults: 5
  };

  if (provider === "tavily") {
    return await searchWithTavily(
      query,
      searchOptions
    );
  }

  if (provider === "exa") {
    return await searchWithExa(
      query,
      searchOptions
    );
  }

  throw new Error(
    "Unknown search provider: " +
      provider
  );
}

/*
========================================================
MAIN WEB SEARCH
========================================================
*/

async function searchWeb(
  query,
  options = {}
) {
  if (
    !query ||
    typeof query !== "string" ||
    !query.trim()
  ) {
    throw new Error(
      "A valid web search query is required."
    );
  }

  const cleanQuery =
    query.trim();

  const dateInfo =
    getCurrentDateInfo();

  const preferredProvider =
    options.preferredProvider === "exa"
      ? "exa"
      : "tavily";

  /*
  By default we use both providers.

  This gives us redundancy if one provider fails.
  */

  const useBothProviders =
    options.useBothProviders !== false;

  const providers =
    preferredProvider === "exa"
      ? ["exa", "tavily"]
      : ["tavily", "exa"];

  const queries =
    buildSearchQueries(
      cleanQuery
    );

  let allResults = [];

  const successfulProviders = [];

  let lastError = null;

  console.log(
    "================================================"
  );

  console.log(
    "WEB SEARCH STARTED"
  );

  console.log(
    "QUERY:",
    cleanQuery
  );

  console.log(
    "DATE:",
    dateInfo.isoDate
  );

  console.log(
    "QUERIES:",
    queries
  );

  console.log(
    "================================================"
  );

  for (const provider of providers) {
    for (const searchQuery of queries) {
      try {
        console.log(
          `WEB SEARCH [${provider.toUpperCase()}]: ${searchQuery}`
        );

        const response =
          await runProviderSearch(
            provider,
            searchQuery,
            options
          );

        if (
          response &&
          Array.isArray(
            response.results
          )
        ) {
          const normalized =
            response.results
              .map(function (result) {
                return normalizeResult(
                  result,
                  provider,
                  cleanQuery
                );
              })
              .filter(Boolean);

          if (normalized.length > 0) {
            allResults =
              allResults.concat(
                normalized
              );

            if (
              !successfulProviders.includes(
                provider
              )
            ) {
              successfulProviders.push(
                provider
              );
            }

            console.log(
              `WEB SEARCH SUCCESS [${provider.toUpperCase()}]: ${normalized.length} results`
            );
          } else {
            console.log(
              `WEB SEARCH EMPTY [${provider.toUpperCase()}]`
            );
          }
        }
      } catch (error) {
        lastError = error;

        console.error(
          `WEB SEARCH ERROR [${provider.toUpperCase()}]:`,
          error.message
        );
      }
    }

    /*
    If configured to use only one provider, stop after
    the first successful provider.
    */

    if (
      !useBothProviders &&
      successfulProviders.length > 0
    ) {
      break;
    }
  }

  allResults =
    deduplicateResults(
      allResults
    );

  allResults =
    rankResults(
      allResults,
      cleanQuery
    );

  /*
  Keep a useful maximum.
  */

  const finalResults =
    allResults
      .slice(0, 8)
      .map(function (result) {
        return {
          title: result.title,
          url: result.url,
          content: result.content,

          highlights:
            result.highlights
              ? [result.highlights]
              : [],

          score: result.score,

          provider:
            result.provider,

          official:
            result.official,

          organization:
            result.organization
        };
      });

  console.log(
    "WEB SEARCH FINAL RESULTS:",
    finalResults.length
  );

  console.log(
    "WEB SEARCH PROVIDERS:",
    successfulProviders
  );

  console.log(
    "================================================"
  );

  /*
  IMPORTANT:

  Empty results are not automatically treated as a fatal
  error. This allows the AI layer to decide how to handle it.

  But if both providers actually failed, expose the error.
  */

  if (
    finalResults.length === 0 &&
    lastError &&
    successfulProviders.length === 0
  ) {
    throw new Error(
      "All web search providers failed. Last error: " +
        lastError.message
    );
  }

  return {
    provider:
      successfulProviders.length > 1
        ? successfulProviders.join("+")
        : successfulProviders[0] || null,

    query:
      cleanQuery,

    searchDate:
      dateInfo.isoDate,

    results:
      finalResults
  };
}

/*
========================================================
SHOULD USE WEB SEARCH
========================================================

This replaces the old narrow keyword-only logic.

========================================================
*/

function shouldUseWebSearch(message) {
  return looksLikeFactualQuestion(
    message
  );
}

/*
========================================================
EXPORTS
========================================================
*/

module.exports = {
  shouldUseWebSearch,
  searchWeb,
  looksLikeFactualQuestion
};