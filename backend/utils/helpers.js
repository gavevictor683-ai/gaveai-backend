function cleanText(text) {
if (typeof text !== "string") {
return "";
}

return text.trim();
}

function isValidMessage(text) {
const cleanedText = cleanText(text);

return cleanedText.length > 0;
}

function getLanguageHint(text) {
const cleanedText = cleanText(text).toLowerCase();

if (!cleanedText) {
return "unknown";
}

const creoleWords = [
"mwen",
"ou",
"nou",
"kijan",
"poukisa",
"kisa",
"lajan",
"fè",
"genyen"
];

const frenchWords = [
"bonjour",
"comment",
"pourquoi",
"argent",
"travail",
"avec",
"vous"
];

const englishWords = [
"hello",
"how",
"why",
"money",
"work",
"with",
"you"
];

const creoleScore = creoleWords.filter((word) =>
cleanedText.includes(word)
).length;

const frenchScore = frenchWords.filter((word) =>
cleanedText.includes(word)
).length;

const englishScore = englishWords.filter((word) =>
cleanedText.includes(word)
).length;

if (creoleScore > frenchScore && creoleScore > englishScore) {
return "ht";
}

if (frenchScore > creoleScore && frenchScore > englishScore) {
return "fr";
}

if (englishScore > creoleScore && englishScore > frenchScore) {
return "en";
}

return "unknown";
}

module.exports = {
cleanText,
isValidMessage,
getLanguageHint
};
