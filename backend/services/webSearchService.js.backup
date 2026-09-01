require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env")
});

const { searchWithTavily } = require("./tavilyService");
const { searchWithExa } = require("./exaService");

function getCurrentDateInfo() {
  const now = new Date();

  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();

  const isoDate =
    year +
    "-" +
    month +
    "-" +
    day;

  const readableDate =
    day +
    " " +
    month +
    " " +
    year;

  return {
    isoDate: isoDate,
    readableDate: readableDate,
    year: year,
    month: month,
    day: day
  };
}

function shouldUseWebSearch(message) {
  if (!message || typeof message !== "string") {
    return false;
  }

  const text = message.toLowerCase();

  const currentInformationPatterns = [
    "kounye a",
    "aktyèl",
    "aktyel",
    "jodi a",
    "yè",
    "demen",
    "semèn sa",
    "semèn sa a",
    "mwa sa",
    "mwa sa a",
    "ane sa",
    "ane sa a",
    "dènye",
    "dènye nouvèl",
    "dènye enfòmasyon",
    "resan",
    "latest",
    "current",
    "today",
    "yesterday",
    "tomorrow",
    "now",
    "recent",
    "this week",
    "this month",
    "this year",
    "live",
    "breaking",
    "news",
    "an dirèk",
    "an real time",
    "real time"
  ];

  return currentInformationPatterns.some(function (pattern) {
    return text.includes(pattern);
  });
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
    lowerUrl.includes("google.com") ||
    lowerUrl.includes("blog.google") ||
    lowerUrl.includes("ai.google") ||
    lowerUrl.includes("deepmind.google") ||
    lowerUrl.includes("support.google.com")
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
    lowerUrl.includes("techcrunch.com") ||
    lowerUrl.includes("theverge.com") ||
    lowerUrl.includes("arstechnica.com") ||
    lowerUrl.includes("wired.com")
  ) {
    return 85;
  }

  if (
    lowerUrl.includes("bbc.com") ||
    lowerUrl.includes("bbc.co.uk") ||
    lowerUrl.includes("nytimes.com") ||
    lowerUrl.includes("washingtonpost.com")
  ) {
    return 80;
  }

  if (
    lowerUrl.includes("mashable.com") ||
    lowerUrl.includes("trendingtopics.eu")
  ) {
    return 60;
  }

  return 20;
}

function isOfficialSource(url, query) {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerQuery = String(query || "").toLowerCase();

  if (
    lowerQuery.includes("openai") ||
    lowerQuery.includes("chatgpt") ||
    lowerQuery.includes("gpt")
  ) {
    return (
      lowerUrl.includes("openai.com") ||
      lowerUrl.includes("help.openai.com")
    );
  }

  if (
    lowerQuery.includes("google") ||
    lowerQuery.includes("gemini")
  ) {
    return (
      lowerUrl.includes("google.com") ||
      lowerUrl.includes("blog.google") ||
      lowerUrl.includes("ai.google") ||
      lowerUrl.includes("deepmind.google") ||
      lowerUrl.includes("support.google.com")
    );
  }

  if (lowerQuery.includes("anthropic")) {
    return lowerUrl.includes("anthropic.com");
  }

  return true;
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

  const official = isOfficialSource(url, query);

  return {
    title: title,
    url: url,
    content: content,
    highlights: highlights,
    score:
      typeof result.score === "number"
        ? result.score
        : 0,
    provider: provider,
    official: official,
    sourcePriority: official
      ? getSourcePriority(url) + 20
      : getSourcePriority(url)
  };
}

function deduplicateResults(results) {
  const seen = new Set();
  const unique = [];

  for (const result of results) {
    if (!result) {
      continue;
    }

    const normalizedUrl = String(result.url || "")
      .toLowerCase()
      .replace(/\/+$/, "");

    const key =
      normalizedUrl ||
      (
        String(result.title || "").toLowerCase() +
        "|" +
        String(result.content || "")
          .slice(0, 100)
          .toLowerCase()
      );

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(result);
  }

  return unique;
}

function rankResults(results) {
  return results.slice().sort(function (a, b) {
    const officialDifference =
      Number(Boolean(b.official)) -
      Number(Boolean(a.official));

    if (officialDifference !== 0) {
      return officialDifference;
    }

    const priorityDifference =
      (b.sourcePriority || 0) -
      (a.sourcePriority || 0);

    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    return (b.score || 0) - (a.score || 0);
  });
}

function buildSearchQueries(query) {
  const cleanQuery = query.trim();
  const lowerQuery = cleanQuery.toLowerCase();

  const dateInfo = getCurrentDateInfo();

  const queries = [
    cleanQuery +
      " latest current information as of " +
      dateInfo.isoDate
  ];

  if (
    lowerQuery.includes("openai") ||
    lowerQuery.includes("gpt") ||
    lowerQuery.includes("chatgpt")
  ) {
    queries.push(
      cleanQuery +
        " OpenAI official site latest news as of " +
        dateInfo.isoDate
    );
  }

  if (
    lowerQuery.includes("google") ||
    lowerQuery.includes("gemini")
  ) {
    queries.push(
      cleanQuery +
        " Google official site latest news as of " +
        dateInfo.isoDate
    );
  }

  if (lowerQuery.includes("anthropic")) {
    queries.push(
      cleanQuery +
        " Anthropic official site latest news as of " +
        dateInfo.isoDate
    );
  }

  return queries.slice(0, 4);
}

async function runProviderSearch(provider, query, options) {
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
    "Unknown search provider: " + provider
  );
}

async function searchWeb(query, options = {}) {
  if (
    !query ||
    typeof query !== "string" ||
    !query.trim()
  ) {
    throw new Error(
      "A valid web search query is required."
    );
  }

  const preferredProvider =
    options.preferredProvider || "tavily";

  const useBothProviders =
    options.useBothProviders !== false;

  const cleanQuery = query.trim();

  const dateInfo = getCurrentDateInfo();

  console.log(
    "WEB SEARCH DATE: " +
      dateInfo.isoDate
  );

  const queries =
    buildSearchQueries(cleanQuery);

  const providers =
    preferredProvider === "exa"
      ? ["exa", "tavily"]
      : ["tavily", "exa"];

  let allResults = [];
  let successfulProviders = [];
  let lastError = null;

  for (const provider of providers) {
    for (const searchQuery of queries) {
      try {
        console.log(
          "WEB SEARCH QUERY [" +
            provider.toUpperCase() +
            "]: " +
            searchQuery
        );

        const response =
          await runProviderSearch(
            provider,
            searchQuery,
            options
          );

        if (
          response &&
          Array.isArray(response.results)
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
              allResults.concat(normalized);

            if (
              !successfulProviders.includes(
                provider
              )
            ) {
              successfulProviders.push(
                provider
              );
            }
          }
        }
      } catch (error) {
        lastError = error;

        console.error(
          provider.toUpperCase() +
            ' SEARCH ERROR FOR QUERY "' +
            searchQuery +
            '":',
          error.message
        );
      }
    }

    if (
      !useBothProviders &&
      successfulProviders.length > 0
    ) {
      break;
    }
  }

  allResults =
    deduplicateResults(allResults);

  allResults =
    rankResults(allResults);

  const finalResults =
    allResults
      .slice(0, 8)
      .map(function (result) {
        return {
          title: result.title,
          url: result.url,
          content: result.content,
          highlights: result.highlights
            ? [result.highlights]
            : [],
          score: result.score,
          provider: result.provider,
          official: result.official
        };
      });

  if (finalResults.length > 0) {
    return {
      provider:
        successfulProviders.length > 1
          ? successfulProviders.join("+")
          : successfulProviders[0] || null,
      query: cleanQuery,
      searchDate: dateInfo.isoDate,
      results: finalResults
    };
  }

  if (lastError) {
    throw new Error(
      "All web search providers failed. Last error: " +
        lastError.message
    );
  }

  return {
    provider: null,
    query: cleanQuery,
    searchDate: dateInfo.isoDate,
    results: []
  };
}

module.exports = {
  shouldUseWebSearch,
  searchWeb
};