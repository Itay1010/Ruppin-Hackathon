
const express = require("express");
require("dotenv").config();

const app = express();

app.use(express.json());

app.post("/api/chat", async (req, res) => {
    try {
        const { message } = req.body;

        if (typeof message !== "string" || !message.trim() || message.length > 4000) {
            return res.status(400).json({ error: "Invalid message" });
        }

        const response = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "openai/gpt-oss-20b",
                    messages: [
                        { role: "user", content: message }
                    ]
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Groq error:", data);
            return res.status(502).json({ error: "Groq request failed" });
        }

        res.json({
            answer: data.choices[0].message.content
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

app.listen(3001, () => {
    console.log("Server running on port 3001");
});
