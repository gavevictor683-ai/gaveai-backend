const fs = require("fs");
const path = require("path");

const usageFile = path.join(__dirname, "..", "data", "searchUsage.json");

const DEFAULT_LIMITS = {
tavily: 800,
exa: 1000
};

function getMonthKey() {
const now = new Date();

return `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}`;
}

function ensureUsageFile() {
const dataDirectory = path.dirname(usageFile);

if (!fs.existsSync(dataDirectory)) {
fs.mkdirSync(dataDirectory, {
recursive: true
});
}

if (!fs.existsSync(usageFile)) {
fs.writeFileSync(
usageFile,
JSON.stringify(
{
month: getMonthKey(),
tavily: 0,
exa: 0
},
null,
2
),
"utf8"
);
}
}

function readUsage() {
ensureUsageFile();

try {
const data = JSON.parse(
fs.readFileSync(usageFile, "utf8")
);

```
const currentMonth = getMonthKey();

if (data.month !== currentMonth) {
  const resetData = {
    month: currentMonth,
    tavily: 0,
    exa: 0
  };

  fs.writeFileSync(
    usageFile,
    JSON.stringify(resetData, null, 2),
    "utf8"
  );

  return resetData;
}

return {
  month: currentMonth,
  tavily: Number(data.tavily) || 0,
  exa: Number(data.exa) || 0
};
```

} catch (error) {
const resetData = {
month: getMonthKey(),
tavily: 0,
exa: 0
};

```
fs.writeFileSync(
  usageFile,
  JSON.stringify(resetData, null, 2),
  "utf8"
);

return resetData;
```

}
}

function saveUsage(usage) {
ensureUsageFile();

fs.writeFileSync(
usageFile,
JSON.stringify(usage, null, 2),
"utf8"
);
}

function canUseProvider(provider) {
const usage = readUsage();

if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, provider)) {
return false;
}

return usage[provider] < DEFAULT_LIMITS[provider];
}

function recordUsage(provider, amount = 1) {
if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, provider)) {
throw new Error(`Unknown search provider: ${provider}`);
}

const usage = readUsage();

usage[provider] += Number(amount) || 0;

saveUsage(usage);

return usage;
}

function getUsage() {
const usage = readUsage();

return {
month: usage.month,
tavily: {
used: usage.tavily,
limit: DEFAULT_LIMITS.tavily,
remaining: Math.max(
DEFAULT_LIMITS.tavily - usage.tavily,
0
)
},
exa: {
used: usage.exa,
limit: DEFAULT_LIMITS.exa,
remaining: Math.max(
DEFAULT_LIMITS.exa - usage.exa,
0
)
}
};
}

module.exports = {
canUseProvider,
recordUsage,
getUsage
};
