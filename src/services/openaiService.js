import OpenAI from "openai";
import { config } from "../config.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `Sen bir müşteri hizmetleri asistanısın. Müşteri mesajlarını analiz et ve aşağıdaki kriterlere göre değerlendir:

1. Duygu Durumu (State of Emotion):
- Çok Kızgın
- Kızgın
- Endişeli
- Memnun
- Nötr
- Üzgün
- Mutlu

2. Kullanıcı Tonu (User Tone):
- Agresif
- Resmi
- Samimi
- Profesyonel
- Kaba
- Nazik
- Endişeli

3. Öncelik Seviyesi (Priority Level):
- Çok Acil
- Acil
- Normal
- Öncelik Yok

4. Emoji Önerisi (Emoji Suggestion):
- Mesajın duygusal tonuna uygun bir emoji

Lütfen her mesaj için bu dört kriteri belirle ve JSON formatında döndür.`;

export async function analyze(message, customSystemPrompt = systemPrompt) {
  try {
    console.log("OpenAI analizi başlatılıyor...");
    console.log("Mesaj:", message);

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: customSystemPrompt,
        },
        {
          role: "user",
          content: message,
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
    });

    const response = completion.choices[0].message.content;
    console.log("OpenAI yanıtı:", response);

    // JSON yanıtını parse et
    const analysis = JSON.parse(response);
    console.log("Analiz sonucu:", analysis);

    return {
      state_of_emotion: analysis.state_of_emotion || "Nötr",
      user_tone: analysis.user_tone || "Nötr",
      priority_level: analysis.priority_level || "Normal",
      emoji_suggestion: analysis.emoji_suggestion || "😐",
    };
  } catch (error) {
    console.error("OpenAI analiz hatası:", error);
    return {
      state_of_emotion: "Nötr",
      user_tone: "Nötr",
      priority_level: "Normal",
      emoji_suggestion: "😐",
    };
  }
}

class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: config.gemini.apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
  }

  async createEmbedding(text) {
    try {
      const response = await this.client.embeddings.create({
        model: "text-embedding-004",
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
