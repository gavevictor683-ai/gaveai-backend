const {
  needsWebSearch
} = require("./services/groqService");

const tests = [
  "What is the Bitcoin price right now?",
  "Who is Rihanna's current husband?",
  "Who is Wilson Isidor?",
  "Ki pri Bitcoin kounye a?",
  "Ki ekip Wilson Isidor ap jwe pou?",
  "Quel est le prix actuel du Bitcoin ?",
  "What is photosynthesis?"
];

for (const question of tests) {
  console.log(
    needsWebSearch(question),
    "=>",
    question
  );
}