const { tavily } = require("@tavily/core");

async function searchWithTavily(query, options = {}) {
if (!process.env.TAVILY_API_KEY) {
throw new Error("TAVILY_API_KEY is not configured.");
}

if (!query || typeof query !== "string" || !query.trim()) {
throw new Error("A valid search query is required.");
}

const {
maxResults = 5,
topic = "general",
searchDepth = "basic"
} = options;

const client = tavily({
apiKey: process.env.TAVILY_API_KEY
});

const response = await client.search(query.trim(), {
maxResults,
topic,
searchDepth,
includeAnswer: false,
includeRawContent: false
});

return {
provider: "tavily",
query: query.trim(),
results: Array.isArray(response?.results)
? response.results.map((result) => ({
title: result.title || "",
url: result.url || "",
content: result.content || "",
score: result.score || 0
}))
: []
};
}

module.exports = {
searchWithTavily
};
