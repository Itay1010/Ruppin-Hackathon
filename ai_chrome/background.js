
async function askAI(message) {
    try {
        const response = await fetch("http://localhost:3001/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ message })
        });

        if (!response.ok) {
            throw new Error("Failed to connect to AI");
        }

        const data = await response.json();

        return data.answer;

    } catch (error) {
        console.error("AI Error:", error);
        throw error;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.type === "ASK_AI") {

        askAI(request.message)
            .then(answer => {
                sendResponse({ answer: answer });
            })
            .catch(error => {
                sendResponse({ error: error.message });
            });

        return true;
    }
});
