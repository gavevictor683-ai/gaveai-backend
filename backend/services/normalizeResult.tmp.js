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

  /*
  TRUSTED NEWS FILTER

  Only apply this filter to news/current-events searches.
  Non-news factual searches continue to work normally.
  */

  const lowerQuery =
    String(query || "").toLowerCase();

  const isNewsQuery =
    lowerQuery.includes("news") ||
    lowerQuery.includes("latest") ||
    lowerQuery.includes("breaking") ||
    lowerQuery.includes("headline") ||
    lowerQuery.includes("headlines") ||
    lowerQuery.includes("current events") ||
    lowerQuery.includes("today's news") ||
    lowerQuery.includes("today news") ||
    lowerQuery.includes("nouvelles") ||
    lowerQuery.includes("actualités") ||
    lowerQuery.includes("actualite") ||
    lowerQuery.includes("dernières nouvelles") ||
    lowerQuery.includes("dernieres nouvelles") ||
    lowerQuery.includes("nouvèl") ||
    lowerQuery.includes("nouvèl jodi a") ||
    lowerQuery.includes("dènye nouvèl") ||
    lowerQuery.includes("denye nouvel") ||
    lowerQuery.includes("kisa ki pase");

  if (
    isNewsQuery &&
    url &&
    !isTrustedNewsSource(url)
  ) {
    console.log(
      "TRUSTED NEWS FILTER: REJECTED:",
      url
    );

    return null;
  }

  const organization =
    getOrganizationFromUrl(url);

  const official =
    isOfficialSource(url, query);

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

    trustedNews:
      isNewsQuery
        ? isTrustedNewsSource(url)
        : null,

    sourcePriority:
      getSourcePriority(url) +
      (official ? 20 : 0)
  };
}
