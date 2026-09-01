function isTrustedNewsSource(url) {
  const lowerUrl = String(url || "").toLowerCase();

  const trustedDomains = [
    "reuters.com",
    "apnews.com",
    "bbc.com",
    "bbc.co.uk",
    "cbsnews.com",
    "npr.org",
    "theguardian.com",
    "aljazeera.com",
    "dw.com",
    "france24.com",
    "cnn.com",
    "nbcnews.com",
    "abcnews.go.com",
    "nytimes.com",
    "washingtonpost.com",
    "bloomberg.com",
    "ft.com",
    "politico.com",
    "euronews.com",
    "voanews.com",
    "un.org",
    "who.int",
    "state.gov",
    "whitehouse.gov",
    "defense.gov",
    "nato.int",
    "europa.eu"
  ];

  return trustedDomains.some(function (domain) {
    return (
      lowerUrl.includes("://" + domain) ||
      lowerUrl.includes("://www." + domain)
    );
  });
}
