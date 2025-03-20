import express from "express";
import { freshchatService } from "../services/freshchatService.js";
import { openaiService } from "../services/openaiService.js";
import { db } from "../services/database.js";

const router = express.Router();

// Mesaj önbelleği ve zamanlayıcıları tutmak için nesneler
const messageBuffers = {}; // conversation_id -> mesaj listesi
const messageTimers = {}; // conversation_id -> timer
const processedConversations = new Set(); // İşlenmiş konuşmaları takip etmek için

const INITIAL_DELAY = 30 * 1000; // 30 saniye
const FOLLOW_UP_DELAY = 10 * 60 * 1000; // 10 dakika

const systemPrompt = `
You are a professional and helpful assistant who can analyze the user's message and determine the following information:

1. The emotional state the message contains or represents (e.g., angry, sad, happy, etc.).
2. Understanding the tone of the user (e.g., positive, negative, neutral).
3. Determine the urgency and priority level of the message (e.g., urgent, less urgent, no priority).

⚠️ **Important Rule:**  
- If the message consists only of a greeting (e.g., "Hello," "Hi," "Merhaba," "مرحبا," "How are you?"), **skip emotion and tone analysis** and set:
  - **Priority Level:** "No Priority"  
  - **Emoji Suggestion:** "👋"  

Provide the results in the following format so that I can easily process them:

*State of Emotion:* [State of Emotion]  
*User Tone:* [Tone]  
*Priority Level:* [Priority Level]  
*Emoji Suggestion:* [Emoji]
`;

// Mesajları işleme ve gönderme fonksiyonu
async function processAndSendMessages(conversationId, io) {
  try {
    const messages = messageBuffers[conversationId] || [];
    if (messages.length === 0) return;

    console.log(
      `${conversationId} konuşması için ${messages.length} mesaj işleniyor...`
    );

    // Tüm mesajları birleştir
    const combinedMessage = messages.map((msg) => msg.message).join("\n");

    // OpenAI ile analiz et
    const analysis = await openaiService.analyze(combinedMessage, systemPrompt);

    // İlk mesajı ana mesaj olarak kaydet
    const firstMessage = messages[0];
    firstMessage.analysis = analysis;

    // Veritabanında bu konuşma ID'si ile kayıtlı mesaj var mı kontrol et
    const existingMessage = await db.getMessageByConversationId(conversationId);

    if (!existingMessage) {
      // Yeni konuşma ise ana mesajı kaydet
      try {
        await db.saveMessage(firstMessage);
        processedConversations.add(conversationId);

        // Socket.IO üzerinden yayınla
        if (io) {
          console.log("Emitting message:", firstMessage);
          io.emit("message", firstMessage);
        } else {
          console.warn("Socket.IO instance not found");
        }
        console.log("Yeni mesaj kaydedildi:", firstMessage.id);
      } catch (error) {
        // Eğer kayıt sırasında unique constraint hatası oluşursa, işlemi atla
        if (
          error.code === "23505" &&
          error.constraint === "unique_conversation_id"
        ) {
          console.log(
            `Konuşma ID ${conversationId} zaten kaydedilmiş, yeni kayıt atlanıyor.`
          );
          processedConversations.add(conversationId);
        } else {
          throw error; // Başka bir hata ise yeniden fırlat
        }
      }
    } else {
      console.log(
        `Konuşma ID ${conversationId} zaten mevcut, yeni mesaj detayları kaydediliyor.`
      );
      processedConversations.add(conversationId);
    }

    // Diğer mesajları detay olarak kaydet
    for (let i = 1; i < messages.length; i++) {
      await db.saveMessageDetail(messages[i]);
      console.log("Mesaj detayı kaydedildi:", messages[i].id);
    }

    // Önbelleği temizle
    delete messageBuffers[conversationId];
  } catch (error) {
    console.error(`Mesajları işlerken hata: ${conversationId}`, error);
  }
}

// Mesajı önbelleğe ekle ve zamanlayıcıyı ayarla
function bufferMessage(message, io) {
  const conversationId = message.conversation_id;

  // Eğer bu konuşma için bir önbellek yoksa oluştur
  if (!messageBuffers[conversationId]) {
    messageBuffers[conversationId] = [];
  }

  // Mesajı önbelleğe ekle
  messageBuffers[conversationId].push(message);

  // Eğer mevcut bir zamanlayıcı varsa temizle
  if (messageTimers[conversationId]) {
    clearTimeout(messageTimers[conversationId]);
  }

  // Konuşmanın daha önce işlenip işlenmediğine bağlı olarak bekleme süresini belirle
  const delay = processedConversations.has(conversationId)
    ? FOLLOW_UP_DELAY
    : INITIAL_DELAY;

  // Yeni zamanlayıcı oluştur
  messageTimers[conversationId] = setTimeout(() => {
    processAndSendMessages(conversationId, io);
    delete messageTimers[conversationId];
  }, delay);

  console.log(
    `${conversationId} konuşması için ${
      delay / 1000
    } saniye zamanlayıcı ayarlandı`
  );
}

router.post("/freshchat-webhook", async (req, res) => {
  try {
    const payload = req.body;
    console.log("Webhook payload:", payload);
    axios.post(
      "https://cc15-178-233-20-100.ngrok-free.app/api/fresh-chat-message-webhook",
      {
        payload: payload,
      }
    );

    const actor = payload.actor;

    // Conversation resolution kontrolü
    if (payload.action === "conversation_resolution") {
      const conversationId = payload.data.resolve.conversation.conversation_id;
      const status = payload.data.resolve.conversation.status;

      try {
        // Messages tablosunda is_resolved'ı güncelle
        await db.updateMessageResolution(conversationId, status === "resolved");
        console.log(
          `Conversation ${conversationId} resolution status updated to: ${status}`
        );
        return res.status(200).json({ message: "Resolution status updated" });
      } catch (error) {
        console.error("Error updating resolution status:", error);
        return res
          .status(200)
          .json({ message: "Error updating resolution status" });
      }
    }

    // Sadece kullanıcıdan gelen mesajları işle
    if (actor.actor_type !== "user" || payload.action !== "message_create") {
      return res.status(200).json({ message: "Webhook received" });
    }

    const message = payload.data.message;

    try {
      const user = await freshchatService.getUser(message.user_id);

      if (!user || !user.properties) {
        return res.status(200).json({ message: "Webhook received" });
      }

      const userStatus = user.properties.find(
        (property) => property.name === "cf_user_status"
      );
      if (userStatus?.value !== "Subscribed") {
        return res.status(200).json({ message: "Webhook received" });
      }
      const subscriptionId = user.properties.find(
        (property) => property.name === "cf_subscription_id"
      )?.value;

      const studentId = user.properties.find(
        (property) => property.name === "cf_student_id"
      )?.value;

      const messageContent = message.message_parts
        .map((part) => part.text?.content || "")
        .join(" ")
        .trim();

      if (!messageContent) {
        return res.status(200).json({ message: "Webhook received" });
      }

      // Mesaj verisini hazırla
      const messageData = {
        id: message.id,
        message: messageContent,
        created_at: message.created_time,
        conversation_id: message.conversation_id,
        freshchat_conversation_id: message.freshchat_conversation_id,
        user: {
          id: user.id,
          name: `${user?.first_name || ""} ${user?.last_name || ""}`.trim(),
          email: user?.email,
          avatar: user?.avatar?.url,
        },
        analysis: null, // Analiz daha sonra yapılacak
        url: `https://globaleducationtechnologyllc-a0a742a7edcc2d017188649.freshchat.com/a/884923745698942/inbox/2/0/conversation/${message.freshchat_conversation_id}`,
        subscriptionId: subscriptionId,
        studentId: studentId,
        subscription_type: subscriptionId ? "support" : "sales",
      };

      // Mesajı önbelleğe ekle ve zamanlayıcıyı ayarla
      bufferMessage(messageData, req.io);

      res.status(200).json({
        message: "Webhook received",
        status: "success",
        data: {
          message_id: message.id,
          conversation_id: message.conversation_id,
        },
      });
    } catch (error) {
      console.error("Error processing webhook:", error);
      res.status(200).json({ message: "Webhook received" });
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(200).json({ message: "Webhook received" });
  }
});

export default router;
