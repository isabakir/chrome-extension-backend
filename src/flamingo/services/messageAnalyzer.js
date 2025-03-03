import openai from "openai";

// OpenAI yapılandırması
const openaiClient = new openai({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are a professional and helpful assistant who can analyze the user's message and determine the following information:
1. The emotional state the message contains or represents (e.g. angry, sad, happy, etc.).
2. Understanding the tone of the user (e.g. positive, negative, neutral).
3. Determine the urgency and priority level of the message (e.g. urgent, less urgent, no priority).

Provide the results in the following format so that I can easily process them:
*State of Emotion:* [State of Emotion]
*User Tone:* [Tone]
*Priority Level:* [Priority Level]
*Emoji Suggestion:* [Emoji]

Please return the answer in a clear, concise and structured way.
`;

export async function analyzeMessage(messageContent) {
  try {
    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageContent },
      ],
      temperature: 0.7,
    });

    const response = completion.choices[0].message.content;

    // Parse the response
    const stateOfEmotion =
      response.match(/\*State of Emotion:\* (.*)/)?.[1] || "";
    const userTone = response.match(/\*User Tone:\* (.*)/)?.[1] || "";
    const priorityLevel = response.match(/\*Priority Level:\* (.*)/)?.[1] || "";
    const emojiSuggestion =
      response.match(/\*Emoji Suggestion:\* (.*)/)?.[1] || "";

    return {
      StateOfEmotion: stateOfEmotion,
      UserTone: userTone,
      PriorityLevel: priorityLevel,
      EmojiSuggestion: emojiSuggestion,
    };
  } catch (error) {
    console.error("Message analysis error:", error);
    throw error;
  }
}
