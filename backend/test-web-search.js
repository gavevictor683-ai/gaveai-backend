const {
  needsWebSearch,
  generateAIResponse
} = require("./services/groqService");

const tests = [
  "Who is Wilson Isidor?",
  "Who is Rihanna's current husband?"
];

async function runTests() {
  for (const question of tests) {
    console.log("\n====================================");
    console.log("QUESTION:", question);
    console.log("====================================");

    console.log(
      "SEARCH REQUIRED:",
      needsWebSearch(question)
    );

    const result =
      await generateAIResponse(question);

    console.log("\n------------------------------------");
    console.log("SEARCH STATUS");
    console.log("------------------------------------");

    console.log(
      "Web search used:",
      result.webSearchUsed
    );

    console.log(
      "Current search attempted:",
      result.currentSearchAttempted
    );

    console.log(
      "Number of sources:",
      Array.isArray(result.sources)
        ? result.sources.length
        : 0
    );

    console.log("\n------------------------------------");
    console.log("REAL SOURCES");
    console.log("------------------------------------");

    if (
      Array.isArray(result.sources) &&
      result.sources.length > 0
    ) {
      result.sources.forEach(
        function (source, index) {
          console.log(
            `\nSOURCE ${index + 1}`
          );

          console.log(
            "Provider:",
            source.provider
          );

          console.log(
            "Title:",
            source.title
          );

          console.log(
            "URL:",
            source.url
          );
        }
      );
    } else {
      console.log(
        "NO VERIFIED SOURCES"
      );
    }

    console.log("\n------------------------------------");
    console.log("AI REPLY");
    console.log("------------------------------------");

    console.log(result.reply);
  }
}

runTests().catch(function (error) {
  console.error(
    "TEST ERROR:",
    error
  );
});