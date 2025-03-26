import OpenAI from "openai";
import { config } from "../config.js";

class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }

  async analyze(messageContent, systemPrompt) {
    try {
      const response = await this.client.chat.completions.create({
        model: "gemini-2.0-flash",
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: messageContent,
          },
        ],
      });

      const content = response.choices[0].message.content;

      // Yanıtı parse et
      const stateMatch = content.match(/\*State of Emotion:\* (.*)/);
      const toneMatch = content.match(/\*User Tone:\* (.*)/);
      const priorityMatch = content.match(/\*Priority Level:\* (.*)/);
      const emojiMatch = content.match(/\*Emoji Suggestion:\* (.*)/);

      return {
        state_of_emotion: stateMatch ? stateMatch[1].trim() : "neutral",
        user_tone: toneMatch ? toneMatch[1].trim() : "neutral",
        priority_level: priorityMatch ? priorityMatch[1].trim() : "low",
        emoji_suggestion: emojiMatch ? emojiMatch[1].trim() : "💬",
      };
    } catch (error) {
      console.error("Error analyzing message with OpenAI:", error);
      // Hata durumunda varsayılan değerleri döndür
      return {
        state_of_emotion: "neutral",
        user_tone: "neutral",
        priority_level: "low",
        emoji_suggestion: "💬",
      };
    }
  }

  async createEmbedding(text) {
    try {
      const response = await this.client.embeddings.create({
        model: "gemini-2.0-flash",
        input: text,
        encoding_format: "float",
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error("Error creating embedding:", error);
      throw error;
    }
  }

  async processConversation(conversation, pastAnswers) {
    try {
      console.log("pastAnswers", pastAnswers);
      const response = await this.client.chat.completions.create({
        model: "gemini-2.0-flash",
        messages: [
          {
            role: "system",
            content:
              "Sen flalingo.com'da çalışan bir müşteri destek operatörüsün. Gelen mesajlara doğal tarzında cevap ver.Konusma geçmisindeki agent sensin   user kullanıcı.Yazım tarzın  doğal  olmalı. Emoji kullanma şeklin de doğal olmalı çok fazla emoji kullanma gerektiği kadar kullan yada hiç kullanma ve bir chat sohbeti gibi olmalı. kullanıcıyla mesajlaşıyorsun mailleşmiyorsun. eğer yeteri kadar veri yoksa ve  cevap üretme daha fazla veriye ihtiyacın oldugunu söyleyebilirsin. Gelen mesajların alakasız oldugunu düşünüyorsan son mesajına cevap ver.",
          },
          {
            role: "user",
            content: `Konuşma Geçmişi: ${JSON.stringify(
              pastAnswers
            )}\n\nSoru: ${conversation}`,
          },
        ],
      });
      console.log(response.choices[0].message.content);
      const content = response.choices[0].message.content;

      // Eğer yanıt JSON formatında değilse, metni parse ederek JSON oluştur
      if (content.includes("Summary:")) {
        const summaryMatch = content.match(
          /Summary:(.*?)(?=Was the issue resolved:|$)/s
        );
        const resolvedMatch = content.match(
          /Was the issue resolved:\s*(true|false)/i
        );

        return {
          summary: summaryMatch ? summaryMatch[1].trim() : "Özet bulunamadı",
          is_resolved: resolvedMatch
            ? resolvedMatch[1].toLowerCase() === "true"
            : false,
        };
      }

      // JSON parse etmeyi dene
      try {
        return JSON.parse(content);
      } catch (parseError) {
        console.warn(
          "JSON parse hatası, düz metin yanıtı dönüştürülüyor:",
          parseError
        );
        return {
          summary: content,
          is_resolved: false,
        };
      }
    } catch (error) {
      console.error("Error processing conversation with OpenAI:", error);
      throw error;
    }
  }
}

export const openaiService = new OpenAIService();
