function needsWebSearch(message) {
  const text = String(message || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return false;
  }

  /*
  ========================================================
  CURRENT / LIVE INFORMATION
  ========================================================
  These MUST trigger web search.
  ========================================================
  */

  const currentPatterns = [
    "latest",
    "current",
    "currently",
    "right now",
    "today",
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

    "news",
    "nouvèl",
    "nouvel",
    "nouvelles",
    "actualite",
    "actualites",
    "dernier",
    "derniere",
    "dernieres",
    "denye",
    "dènye",

    "jodi",
    "jodia",
    "jodi a",
    "kounye",
    "kounya",
    "kounye a",
    "aktyel",
    "resan",

    "what happened",
    "what happened today",
    "kisa ki pase",
    "kisa ki pase jodi a",

    "prix",
    "price",
    "cost",
    "score",
    "result",
    "results",
    "rezilta",

    "election",
    "elections",

    "weather",
    "forecast",
    "temperature",
    "meteo",

    "exchange rate",
    "bitcoin",
    "bitcoin price",
    "crypto",
    "crypto price",
    "stock",
    "stock price",
    "share price"
  ];

  if (
    currentPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  ========================================================
  SPORTS / LIVE FACTUAL QUESTIONS
  ========================================================
  */

  const sportsPatterns = [
    "ki lè match",
    "ki le match",
    "pwochen match",
    "prochain match",
    "next match",
    "next game",
    "upcoming match",
    "upcoming game",
    "ki ekip",
    "ki ekipay",
    "ki ekip li jwe pou",
    "ki ekip li ap jwe pou",
    "ki ekip li ye",
    "what team",
    "what club",
    "which team",
    "which club",
    "who does he play for",
    "who does she play for",
    "who does x play for",
    "goals",
    "gols",
    "goal",
    "match",
    "game",
    "score"
  ];

  if (
    sportsPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  ========================================================
  PEOPLE / ENTITY FACTUAL QUESTIONS
  ========================================================
  */

  const entityPatterns = [
    "kiyes",
    "kiyes ki",
    "kiyès",
    "kiyès ki",

    "who is",
    "who's",
    "who was",

    "kisa",
    "kisa ki",
    "what is",
    "what's",
    "what was",

    "tell me about",
    "information about",
    "informations sur",
    "information sur",
    "detay sou",
    "details about",
    "enfomasyon sou",
    "enfòmasyon sou",
    "pale m de",
    "parle moi de",
    "parle-moi de",

    "mari aktyel",
    "mari actuel",
    "husband",
    "wife",
    "president",
    "prezidan",
    "CEO",
    "founder"
  ];

  if (
    entityPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    /*
    Do not search for obvious transformation requests.
    */

    const nonSearchPatterns = [
      "translate",
      "tradui",
      "traduire",
      "write",
      "ekri",
      "ecris",
      "écris",
      "draft",
      "rewrite",
      "rephrase",
      "corrige",
      "korije"
    ];

    if (
      nonSearchPatterns.some(function (pattern) {
        return text.includes(pattern);
      })
    ) {
      return false;
    }

    return true;
  }

  /*
  ========================================================
  EXPLICIT FACTUAL QUESTIONS
  ========================================================
  */

  const factualPatterns = [
    "how many goals",
    "how many gols",
    "konbyen gol",
    "konbyen gòl",
    "konbyen gòl",
    "how many",
    "konbyen",

    "where is",
    "where does",
    "where did",
    "ki kote",

    "when is",
    "when was",
    "when did",
    "kilè",
    "ki le",

    "which team",
    "which club",
    "ki ekip",

    "who won",
    "who is winning",
    "ki moun ki genyen",

    "what happened",
    "kisa ki pase"
  ];

  if (
    factualPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return true;
  }

  /*
  ========================================================
  GENERAL KNOWLEDGE / CREATIVE / TRANSFORMATION
  ========================================================
  */

  const noSearchPatterns = [
    "translate",
    "tradui",
    "traduire",

    "write a",
    "write me",
    "ekri yon",
    "ekri mwen",

    "cover letter",
    "resume",
    "cv",
    "email",
    "letter",

    "rewrite",
    "rephrase",
    "summarize",
    "summary",
    "paraphrase",

    "grammar",
    "spelling",
    "meaning of",

    "what does this mean",
    "sa vle di",

    "how do i",
    "how can i",
    "kijan poum",
    "kijan pou mwen"
  ];

  if (
    noSearchPatterns.some(function (pattern) {
      return text.includes(pattern);
    })
  ) {
    return false;
  }

  /*
  ========================================================
  IMPORTANT:
  A question mark ALONE is NOT enough anymore.
  ========================================================
  */

  return false;
}