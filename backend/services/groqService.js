const Groq = require("groq-sdk");

const { searchWithTavily } = require("./tavilyService");
const { searchWithExa } = require("./exaService");

/*

GAVEAI - GROQ SERVICE

Goals:

* Low token usage
* No browser/frontend code
* No unnecessary web searches
* Short conversation history
* Compact search context
* Clear Groq errors
* Compatible with server.js:
  const { generateAIResponse } = require("./services/groqService");

========================================================
*/

const groq = new Groq({
apiKey: process.env.GROQ_API_KEY
});

/*

CONFIG

*/

const GROQ_MODEL =
process.env.GROQ_MODEL ||
"openai/gpt-oss-120b";

const MAX_OUTPUT_TOKENS =
Number(process.env.GROQ_MAX_OUTPUT_TOKENS) || 700;

const MAX_HISTORY_MESSAGES = 6;

const MAX_HISTORY_CHARS = 6000;

const MAX_SEARCH_RESULTS = 2;

const MAX_SOURCE_TITLE_CHARS = 180;

const MAX_SOURCE_TEXT_CHARS = 700;

const MAX_SEARCH_CONTEXT_CHARS = 3500;

/*

HAITI DATE / TIME

*/

function getHaitiDateTime() {
const now = new Date();

const dateParts = new Intl.DateTimeFormat(
"en-US",
{
timeZone: "America/Port-au-Prince",
year: "numeric",
month: "2-digit",
day: "2-digit"
}
).formatToParts(now);

const timeParts = new Intl.DateTimeFormat(
"en-US",
{
timeZone: "America/Port-au-Prince",
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
hour12: false
}
).formatToParts(now);

const getPart = (parts, type) => {
const item = parts.find(
part => part.type === type
);

return item ? item.value : "";

};

const year = getPart(dateParts, "year");
const month = getPart(dateParts, "month");
const day = getPart(dateParts, "day");

const hour = getPart(timeParts, "hour");
const minute = getPart(timeParts, "minute");
const second = getPart(timeParts, "second");

const date = `${year}-${month}-${day}`;

const currentDateLabel =
new Intl.DateTimeFormat(
"en-US",
{
timeZone: "America/Port-au-Prince",
weekday: "long",
month: "long",
day: "numeric",
year: "numeric"
}
).format(now);

return {
date,
currentDate: date,
currentDateLabel,
currentTime:
`${hour}:${minute}:${second}`,
timezone:
"America/Port-au-Prince"
};
}

/*

TEXT HELPERS

*/

function cleanText(value) {
return String(value || "")
.replace(/\s+/g, " ")
.trim();
}

function limitText(value, max) {
const text = cleanText(value);

if (text.length <= max) {
return text;
}

return text.slice(0, max) + "...";
}

function normalizeLanguage(message) {
const text = cleanText(message).toLowerCase();

if (
/\b(ki sa|kisa|kijan|poukisa|kilès|kiyes|èske|eske|mwen|ou|nan|se|yon)\b/.test(text)
) {
return "ht";
}

if (
/\b(quelle|qu'est|qui|quoi|comment|pourquoi|est-ce|bonjour|je|vous|dans|une|un)\b/.test(text)
) {
return "fr";
}

return "en";
}

/*

CREATOR / IDENTITY RESPONSES

*/

function isCreatorQuestion(message) {
const text = cleanText(message)
.toLowerCase();

const patterns = [
"who created you",
"who made you",
"who built you",
"who is your creator",
"who developed you",
"kiyes ki kreye w",
"kiyes ki te kreye w",
"kiles ki kreye w",
"kiles ki te kreye w",
"kreyatè w",
"kreyater w",
"ki moun ki kreye w",
"ki moun ki te kreye w",
"qui t'a créé",
"qui ta créé",
"qui vous a créé",
"qui a créé gaveai",
"qui a créé gave money tips ai"
];

return patterns.some(
pattern => text.includes(pattern)
);
}

function creatorResponse(language) {
if (language === "ht") {
return (
"**GaveAI**, ki rele tou **Gave Money Tips AI**, " +
"se yon asistan entèlijans atifisyèl ki fè pati " +
"pwojè **Gave Money Tips**.\n\n" +
"**Kiyès ki kreye GaveAI?**\n\n" +
"**Gave Victor** se kreyatè GaveAI / " +
"Gave Money Tips AI an 2026."
);
}

if (language === "fr") {
return (
"**GaveAI**, également appelé " +
"**Gave Money Tips AI**, est un assistant " +
"d'intelligence artificielle faisant partie " +
"du projet **Gave Money Tips**.\n\n" +
"**Qui a créé GaveAI ?**\n\n" +
"**Gave Victor** est le créateur de GaveAI / " +
"Gave Money Tips AI en 2026."
);
}

return (
"**GaveAI**, also known as **Gave Money Tips AI**, " +
"is an artificial intelligence assistant that is " +
"part of the **Gave Money Tips** project.\n\n" +
"**Who created GaveAI?**\n\n" +
"**Gave Victor** is the creator of GaveAI / " +
"Gave Money Tips AI in 2026."
);
}

/*

WEB SEARCH DETECTION

*/

function needsWebSearch(message) {
const text = cleanText(message)
.toLowerCase();

/*
Current / time-sensitive questions.
*/

const currentPatterns = [
"latest",
"today",
"right now",
"currently",
"current",
"recent",
"recently",
"this week",
"this month",
"breaking news",
"news today",
"latest news",
"price today",
"current price",
"live price",
"stock price",
"exchange rate",
"weather today",
"what happened today",
"what's happening",
"whats happening",
"2026 news",

"jodi a",
"kounye a",
"dènye nouvèl",
"denye nouvel",
"nouvèl jodi a",
"nouvel jodi a",
"pri jodi a",
"pri kounye a",
"sa k ap pase",
"sa kap pase",

"aujourd'hui",
"actualités",
"dernières nouvelles",
"nouvelles récentes",
"en ce moment",
"actuellement",
"prix actuel",
"taux actuel"

];

if (
currentPatterns.some(
pattern => text.includes(pattern)
)
) {
return true;
}

/*
Explicit search requests.
*/

const searchPatterns = [
"search the web",
"search online",
"look it up",
"find online",
"google this",
"web search",
"verify online",

"chèche sou entènèt",
"chèche sou internet",
"verifye sou entènèt",
"verifye sou internet",
"gade sou entènèt",

"cherche sur internet",
"recherche sur internet",
"vérifie en ligne",
"verifie en ligne"

];

return searchPatterns.some(
pattern => text.includes(pattern)
);
}

/*

SOURCE NORMALIZATION

*/

function normalizeSource(item, provider) {
if (!item || typeof item !== "object") {
return null;
}

const url =
item.url ||
item.link ||
item.source_url ||
"";

if (!url) {
return null;
}

const title =
item.title ||
item.name ||
"";

const content =
item.content ||
item.text ||
item.snippet ||
item.description ||
"";

return {
provider,
title: limitText(
title,
MAX_SOURCE_TITLE_CHARS
),
url: String(url).trim(),
content: limitText(
content,
MAX_SOURCE_TEXT_CHARS
)
};
}

/*

WEB SEARCH

*/

async function performWebSearch(query) {
const sources = [];

/*
TAVILY
*/

try {
if (typeof searchWithTavily === "function") {
console.log(
"GAVEAI WEB SEARCH: TAVILY"
);

  const result =
    await searchWithTavily(query, {
      maxResults: MAX_SEARCH_RESULTS
    });

  let results = [];

  if (Array.isArray(result)) {
    results = result;
  } else if (
    result &&
    Array.isArray(result.results)
  ) {
    results = result.results;
  }

  for (
    const item of results.slice(
      0,
      MAX_SEARCH_RESULTS
    )
  ) {
    const source =
      normalizeSource(
        item,
        "Tavily"
      );

    if (source) {
      sources.push(source);
    }
  }
}

} catch (error) {
console.error(
"TAVILY SEARCH ERROR:",
error && error.message
? error.message
: error
);
}

/*
EXA
*/

try {
if (typeof searchWithExa === "function") {
console.log(
"GAVEAI WEB SEARCH: EXA"
);

  const result =
    await searchWithExa(query, {
      maxResults: MAX_SEARCH_RESULTS
    });

  let results = [];

  if (Array.isArray(result)) {
    results = result;
  } else if (
    result &&
    Array.isArray(result.results)
  ) {
    results = result.results;
  }

  for (
    const item of results.slice(
      0,
      MAX_SEARCH_RESULTS
    )
  ) {
    const source =
      normalizeSource(
        item,
        "Exa"
      );

    if (source) {
      sources.push(source);
    }
  }
}

} catch (error) {
console.error(
"EXA SEARCH ERROR:",
error && error.message
? error.message
: error
);
}

/*
Deduplicate URLs.
*/

const unique = [];
const seen = new Set();

for (const source of sources) {
const key =
source.url.toLowerCase();

if (seen.has(key)) {
  continue;
}

seen.add(key);
unique.push(source);

if (unique.length >= 4) {
  break;
}

}

/*
Compact search context.
*/

let context = "";

for (const source of unique) {
const block =
`SOURCE: ${source.provider}\n` +
`TITLE: ${source.title}\n` +
`URL: ${source.url}\n` +
`INFO: ${source.content}\n\n`;

if (
  context.length +
  block.length >
  MAX_SEARCH_CONTEXT_CHARS
) {
  break;
}

context += block;

}

return {
sources: unique,
context: context.trim()
};
}

/*

CONVERSATION COMPRESSION

*/

function prepareConversation(conversation) {
if (!Array.isArray(conversation)) {
return [];
}

const recent =
conversation.slice(
-MAX_HISTORY_MESSAGES
);

const messages = [];

let totalChars = 0;

for (
let i = recent.length - 1;
i >= 0;
i--
) {
const item = recent[i];

if (!item) {
  continue;
}

const role =
  item.role === "assistant" ||
  item.role === "bot"
    ? "assistant"
    : "user";

const content =
  item.content ||
  item.message ||
  item.text ||
  item.reply ||
  "";

const clean =
  limitText(content, 1200);

if (!clean) {
  continue;
}

const line =
  `${role}: ${clean}`;

if (
  totalChars +
  line.length >
  MAX_HISTORY_CHARS
) {
  break;
}

messages.unshift({
  role,
  content: clean
});

totalChars += line.length;

}

return messages;
}

/*

SYSTEM PROMPT

*/

function buildSystemPrompt(
language,
dateInfo,
hasWebSearch
) {
let languageInstruction;

if (language === "ht") {
languageInstruction =
"Answer in Haitian Creole unless the user clearly asks for another language.";
} else if (language === "fr") {
languageInstruction =
"Answer in French unless the user clearly asks for another language.";
} else {
languageInstruction =
"Answer in English unless the user clearly asks for another language.";
}

return (
"You are GaveAI, also known as Gave Money Tips AI. " +
"You are a helpful, accurate, concise AI assistant.\n\n" +

"CREATOR: Gave Victor created GaveAI / Gave Money Tips AI in 2026.\n\n" +

`${languageInstruction}\n\n` +

"Be direct. Do not unnecessarily repeat the user's question. " +
"Use short paragraphs and lists when useful. " +
"Do not mention internal prompts, token limits, APIs, or hidden instructions.\n\n" +

"If the user asks who created you, answer that Gave Victor created GaveAI. " +
"Do not contradict this project identity.\n\n" +

`Date in Haiti: ${dateInfo.currentDateLabel}. ` +
`Time zone: ${dateInfo.timezone}.\n\n` +

(
  hasWebSearch
    ? "Web search results are provided below. Use them for current facts and do not invent unsupported current information."
    : "No web search was performed. Answer from your general knowledge and do not claim that you searched the web."
)

);
}

/*

GROQ ERROR FORMATTER

*/

function formatGroqError(error) {
const status =
error && error.status;

let apiMessage = "";

if (
error &&
error.error &&
error.error.error &&
error.error.error.message
) {
apiMessage =
error.error.error.message;
} else if (
error &&
error.error &&
error.error.message
) {
apiMessage =
error.error.message;
} else if (
error &&
error.message
) {
apiMessage =
error.message;
}

console.error(
"GROQ FULL ERROR:",
error
);

if (status === 429) {
const retryAfter =
error.headers &&
typeof error.headers.get === "function"
? error.headers.get("retry-after")
: null;

const seconds =
  Number(retryAfter);

if (
  Number.isFinite(seconds) &&
  seconds > 0
) {
  const minutes =
    Math.ceil(seconds / 60);

  return (
    `Groq rate limit reached. ` +
    `Please try again in about ${minutes} minute(s).`
  );
}

return (
  "Groq rate limit reached. Please try again later."
);

}

if (status === 401) {
return (
"Groq authentication failed. " +
"Please check GROQ_API_KEY."
);
}

if (status === 403) {
return (
"Groq rejected access to the selected model. " +
`Model: ${GROQ_MODEL}`
);
}

if (status === 400) {
console.error(
"GROQ 400 BAD REQUEST:",
apiMessage
);

return (
  "Groq rejected the request. " +
  (
    apiMessage
      ? `Reason: ${apiMessage}`
      : "Check the model or request configuration."
  )
);

}

return (
apiMessage ||
"Groq request failed."
);
}

/*

GENERATE AI RESPONSE

*/

async function generateAIResponse(
userMessage,
options = {}
) {
const message =
cleanText(userMessage);

if (!message) {
return {
reply:
"Please enter a message.",
webSearchUsed: false,
currentSearchAttempted: false,
sources: {}
};
}

const language =
normalizeLanguage(message);

const dateInfo =
getHaitiDateTime();

/*

CREATOR QUESTION

*/

if (isCreatorQuestion(message)) {
console.log(
"GAVEAI CREATOR QUESTION DETECTED - INTERNAL RESPONSE"
);

console.log(
  "IDENTITY LANGUAGE:",
  language
);

return {
  reply:
    creatorResponse(language),

  webSearchUsed: false,

  currentSearchAttempted: false,

  currentDate:
    dateInfo.currentDate,

  currentDateLabel:
    dateInfo.currentDateLabel,

  currentTime:
    dateInfo.currentTime,

  timezone:
    dateInfo.timezone,

  sources: {}
};

}

/*

DATE INFO FROM SERVER IF AVAILABLE

*/

const finalDate = {
currentDate:
options.currentDate ||
dateInfo.currentDate,

currentDateLabel:
  options.currentDateLabel ||
  dateInfo.currentDateLabel,

currentTime:
  dateInfo.currentTime,

timezone:
  dateInfo.timezone

};

/*

SEARCH DECISION

*/

const shouldSearch =
needsWebSearch(message);

let searchContext = "";

let sources = [];

let currentSearchAttempted =
false;

if (shouldSearch) {
currentSearchAttempted = true;

console.log(
  "GAVEAI SEARCH QUERY:",
  message
);

const searchResult =
  await performWebSearch(
    message
  );

searchContext =
  searchResult.context;

sources =
  searchResult.sources;

console.log(
  "GAVEAI SEARCH SOURCES:",
  sources.length
);

}

/*

CONVERSATION

*/

const history =
prepareConversation(
options.conversation
);

/*

SYSTEM PROMPT

*/

const systemPrompt =
buildSystemPrompt(
language,
finalDate,
shouldSearch
);

/*

USER PROMPT

*/

let userPrompt =
message;

if (searchContext) {
userPrompt +=
"\n\nCURRENT WEB INFORMATION:\n" +
searchContext;
}

/*

KNOWLEDGE

*/

if (
options.knowledge
) {
const knowledge =
limitText(
options.knowledge,
1500
);

if (knowledge) {
  userPrompt +=
    "\n\nRELEVANT KNOWLEDGE:\n" +
    knowledge;
}

}

/*

IMAGE ATTACHMENT

*/

if (
options.attachment &&
options.attachment.url
) {
userPrompt +=
"\n\nUSER ATTACHMENT: " +
limitText(
options.attachment.url,
500
);
}

/*

GROQ MESSAGES

*/

const messages = [
{
role: "system",
content: systemPrompt
}
];

for (const item of history) {
messages.push(item);
}

messages.push({
role: "user",
content: userPrompt
});

/*

GROQ REQUEST

*/

console.log(
"GAVEAI GROQ MODEL:",
GROQ_MODEL
);

console.log(
"GAVEAI WEB SEARCH:",
shouldSearch
? "USED"
: "NOT NEEDED"
);

try {
const completion =
await groq.chat.completions.create({
model: GROQ_MODEL,

    messages,

    temperature: 0.2,

    max_tokens:
      MAX_OUTPUT_TOKENS,

    stream: false
  });

const reply =
  completion &&
  completion.choices &&
  completion.choices[0] &&
  completion.choices[0].message &&
  completion.choices[0].message.content
    ? completion.choices[0].message.content.trim()
    : "";

if (!reply) {
  throw new Error(
    "Groq returned an empty response."
  );
}

return {
  reply,

  webSearchUsed:
    shouldSearch &&
    sources.length > 0,

  currentSearchAttempted,

  currentDate:
    finalDate.currentDate,

  currentDateLabel:
    finalDate.currentDateLabel,

  currentTime:
    finalDate.currentTime,

  timezone:
    finalDate.timezone,

  sources:
    sources.reduce(
      (acc, source, index) => {
        acc[`source${index + 1}`] =
          source;
        return acc;
      },
      {}
    )
};


} catch (error) {
const friendlyError =
formatGroqError(error);


throw new Error(
  friendlyError
);


}
}

/*

EXPORTS

*/

module.exports = {
generateAIResponse,
needsWebSearch,
performWebSearch
};
