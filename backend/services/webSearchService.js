const { searchWithTavily } = require("./tavilyService");
const { searchWithExa } = require("./exaService");

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
    "semèn sa",
    "semèn sa a",
    "mwa sa",
    "dènye",
    "dènye nouvèl",
    "latest",
    "current",
    "today",
    "now",
    "recent",
    "this week",
    "this month",
    "live",
    "an dirèk",
    "an real time",
    "real time",
    "2026"
  ];

  return currentInformationPatterns.some((pattern) =>
    text.includes(pattern)
  );
}

async function searchWeb(query, options = {}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("A valid web search query is required.");
  }

  const {
    preferredProvider = "tavily"
  } = options;

  const providers =
    preferredProvider === "exa"
      ? ["exa", "tavily"]
      : ["tavily", "exa"];

  let lastError = null;

  for (const provider of providers) {
    try {
      if (provider === "tavily") {
        const result = await searchWithTavily(query, options);

        if (result && Array.isArray(result.results) && result.results.length > 0) {
          return result;
        }
      }

      if (provider === "exa") {
        const result = await searchWithExa(query, options);

        if (result && Array.isArray(result.results) && result.results.length > 0) {
          return result;
        }
      }
    } catch (error) {
      lastError = error;

      console.error(
        `${provider.toUpperCase()} SEARCH ERROR:`,
        error.message
      );
    }
  }

  if (lastError) {
    throw new Error(
      `All web search providers failed. Last error: ${lastError.message}`
    );
  }

  return {
    provider: null,
    query: query.trim(),
    results: []
  };
}

module.exports = {
  shouldUseWebSearch,
  searchWeb
};