const { Exa } = require("exa-js");

async function searchWithExa(query, options = {}) {
if (!process.env.EXA_API_KEY) {
throw new Error("EXA_API_KEY is not configured.");
}

if (!query || typeof query !== "string" || !query.trim()) {
throw new Error("A valid search query is required.");
}

const {
maxResults = 5,
type = "auto"
} = options;

const exa = new Exa(process.env.EXA_API_KEY);

const response = await exa.search(query.trim(), {
type,
numResults: maxResults,
contents: {
highlights: true
}
});

return {
provider: "exa",
query: query.trim(),
results: Array.isArray(response?.results)
? response.results.map((result) => ({
title: result.title || "",
url: result.url || "",
highlights: Array.isArray(result.highlights)
? result.highlights
: [],
score: result.score || 0
}))
: []
};
}

module.exports = {
searchWithExa
};
