import { config } from "../config.js";
import OpenAI from "openai";
const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: config.deepseek.apiKey,
});
class DeepSeekService {
  constructor() {}

  async generateResponse(query, context) {
    try {
      const response = await openai.chat.completions.create({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "Sen bir müşteri hizmetleri asistanısın. Verilen konuşma geçmişini ve soruyu kullanarak en uygun cevabı üret.",
          },
          {
            role: "user",
            content: `Konuşma Geçmişi: ${JSON.stringify(
              context
            )}\n\nSoru: ${query}`,
          },
        ],
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error("Error generating response:", error);
      throw error;
    }
  }
}

export const deepseekService = new DeepSeekService();
