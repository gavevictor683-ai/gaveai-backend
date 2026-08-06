require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");

const app = express();

app.use(cors());

app.use(express.json());

const groq = new Groq({
apiKey: process.env.GROQ_API_KEY
});

app.get("/", (req, res) => {

res.send("Gave Money Tips AI Backend is running 🚀");

});

app.post("/chat", async (req, res) => {

try {

const userMessage = req.body.message;


const completion = await groq.chat.completions.create({

  model: "llama-3.3-70b-versatile",

  messages: [

    {
      role: "system",
      content: `

You are Gave Money Tips AI Assistant.

You are a helpful professional AI assistant.

You help with:

General knowledge
Technology
Business
Career advice
Remote jobs
Freelancing
AI tools
Online income
Writing ideas

Rules:

Give clear answers.
Explain step by step when needed.
Be professional.

Do not invent fake information.
`
},

  {
    role: "user",
    content: userMessage
  }

]

});

res.json({

reply: completion.choices[0].message.content

});

} catch (error) {

console.error("GROQ ERROR:", error);

res.status(500).json({

error: error.message

});

}

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

console.log(Gave Money Tips AI running on port ${PORT});

});