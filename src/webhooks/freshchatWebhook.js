import express from "express";
import { freshchatService } from "../services/freshchatService.js";
import { openaiService } from "../services/openaiService.js";
import { db } from "../services/database.js";
import axios from "axios";

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

// Socket haritaları
let io;
const socketAgentMap = new Map(); // socket_id -> agent_id
const agentSocketsMap = new Map(); // agent_id -> Set<socket_id>
const extensionAgentMap = new Map(); // extension_id -> agent_id

// Socket.IO'yu ayarla
export function setupSocketIO(socketIO) {
  io = socketIO;

  io.on("connection", (socket) => {
    console.log("==========================================");
    console.log("🔌 YENİ SOCKET BAĞLANTISI");
    console.log("Socket ID:", socket.id);
    console.log("==========================================");

    // Test mesajını dinle
    socket.on("test_message", (data) => {
      console.log("==========================================");
      console.log("📨 TEST MESAJI ALINDI");
      console.log("Socket ID:", socket.id);
      console.log("Mesaj:", data);
      console.log("==========================================");

      // Test yanıtı gönder
      const response = {
        type: "test_response",
        message: "Test yanıtı",
        received: data,
        timestamp: new Date().toISOString(),
      };

      console.log("📤 Test yanıtı gönderiliyor:", response);
      socket.emit("test_response", response);
    });

    // Agent seçildiğinde
    socket.on("agent_selected", (data) => {
      console.log("==========================================");
      console.log("👤 AGENT SEÇİMİ ALINDI");
      console.log("Socket ID:", socket.id);
      console.log("Agent Bilgileri:", {
        agent_id: data.agent_id,
        agent_name: data.agent_name,
        agent_email: data.agent_email,
        extension_id: data.extension_id,
        timestamp: data.timestamp,
      });
      console.log("==========================================");

      const { agent_id, extension_id } = data;

      // Eski eşleştirmeleri temizle
      const oldAgentId = socketAgentMap.get(socket.id);
      if (oldAgentId) {
        console.log("🔄 Eski agent eşleştirmesi temizleniyor:", {
          socket_id: socket.id,
          old_agent_id: oldAgentId,
        });
        const agentSockets = agentSocketsMap.get(oldAgentId) || new Set();
        agentSockets.delete(socket.id);
        if (agentSockets.size === 0) {
          agentSocketsMap.delete(oldAgentId);
        } else {
          agentSocketsMap.set(oldAgentId, agentSockets);
        }
      }

      // Yeni eşleştirmeleri kaydet
      socketAgentMap.set(socket.id, agent_id);
      extensionAgentMap.set(extension_id, agent_id);

      const agentSockets = agentSocketsMap.get(agent_id) || new Set();
      agentSockets.add(socket.id);
      agentSocketsMap.set(agent_id, agentSockets);

      console.log("==========================================");
      console.log("✅ AGENT BAĞLANTISI BAŞARILI");
      console.log("Socket ID:", socket.id);
      console.log("Agent ID:", agent_id);
      console.log("Extension ID:", extension_id);
      console.log(
        "Güncel Agent Socket Haritası:",
        Object.fromEntries([...agentSocketsMap].map(([k, v]) => [k, [...v]]))
      );
      console.log("==========================================");

      // Başarılı bağlantı yanıtı gönder
      socket.emit("agent_selection_response", {
        success: true,
        message: "Agent bağlantısı başarılı",
        agent_id: agent_id,
        socket_id: socket.id,
        timestamp: new Date().toISOString(),
      });
    });

    // Bağlantı kesildiğinde
    socket.on("disconnect", () => {
      console.log("==========================================");
      console.log("🔌 SOCKET BAĞLANTISI KESİLDİ");
      console.log("Socket ID:", socket.id);
      console.log("==========================================");

      // Agent eşleştirmelerini temizle
      const agentId = socketAgentMap.get(socket.id);
      if (agentId) {
        console.log("🔄 Agent eşleştirmesi temizleniyor:", {
          socket_id: socket.id,
          agent_id: agentId,
        });
        const agentSockets = agentSocketsMap.get(agentId);
        if (agentSockets) {
          agentSockets.delete(socket.id);
          if (agentSockets.size === 0) {
            agentSocketsMap.delete(agentId);
          } else {
            agentSocketsMap.set(agentId, agentSockets);
          }
        }
      }
      socketAgentMap.delete(socket.id);

      // Extension eşleştirmelerini de temizle
      for (const [extId, agtId] of extensionAgentMap.entries()) {
        if (agtId === agentId) {
          extensionAgentMap.delete(extId);
        }
      }

      console.log("==========================================");
      console.log("✅ SOCKET TEMİZLİĞİ TAMAMLANDI");
      console.log(
        "Güncel Agent Socket Haritası:",
        Object.fromEntries([...agentSocketsMap].map(([k, v]) => [k, [...v]]))
      );
      console.log("==========================================");
    });
  });
}

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
    console.log("==========================================");
    console.log("🤖 MESAJ ANALİZİ TAMAMLANDI");
    console.log("Analiz sonucu:", analysis);
    console.log("==========================================");

    // İlk mesajı ana mesaj olarak kaydet
    const firstMessage = messages[0];
    firstMessage.analysis = {
      PriorityLevel: analysis.priority_level,
      StateOfEmotion: analysis.state_of_emotion,
      UserTone: analysis.user_tone,
      EmojiSuggestion: analysis.emoji_suggestion,
    };

    console.log("==========================================");
    console.log("📝 MESAJ ANALİZ SONUÇLARI");
    console.log("Priority Level:", firstMessage.analysis.PriorityLevel);
    console.log("State of Emotion:", firstMessage.analysis.StateOfEmotion);
    console.log("User Tone:", firstMessage.analysis.UserTone);
    console.log("Emoji Suggestion:", firstMessage.analysis.EmojiSuggestion);
    console.log("==========================================");

    // Veritabanında bu konuşma ID'si ile kayıtlı mesaj var mı kontrol et
    const existingMessage = await db.getMessageByConversationId(conversationId);

    if (!existingMessage) {
      // Yeni konuşma ise ana mesajı kaydet
      try {
        await db.saveMessage(firstMessage);
        processedConversations.add(conversationId);

        // Socket.IO üzerinden yayınla
        if (io) {
          console.log("==========================================");
          console.log("📤 SOCKET ÜZERİNDEN MESAJ GÖNDERİLİYOR");
          console.log("Mesaj:", firstMessage);
          console.log("==========================================");

          // Mesajın atandığı agent'ın socket'lerini bul
          const assignedAgentId = firstMessage.agent_id;

          if (!assignedAgentId) {
            console.log(
              "Agent ID bulunamadı, mesaj tüm bağlı socket'lere gönderiliyor"
            );
            io.emit("message", firstMessage);
            return;
          }

          const agentSockets = agentSocketsMap.get(assignedAgentId);

          if (agentSockets && agentSockets.size > 0) {
            console.log(
              `Mesaj ${assignedAgentId} ID'li agent'ın ${agentSockets.size} socket bağlantısına gönderiliyor`
            );

            // Bu agent'a ait tüm socket'lere mesajı gönder
            agentSockets.forEach((socketId) => {
              io.to(socketId).emit("message", firstMessage);
            });

            console.log(
              `Mesaj başarıyla ${agentSockets.size} socket'e iletildi`
            );
          } else {
            console.log(
              `${assignedAgentId} ID'li agent için aktif socket bağlantısı bulunamadı, mesaj tüm bağlı socket'lere gönderiliyor`
            );
            // Agent'a socket bağlantısı yoksa tüm bağlı socket'lere gönder
            io.emit("message", firstMessage);
          }
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
    try {
      await axios.post(
        "https://app.tipbaks.com/api/fresh-chat-message-webhook",
        {
          payload: payload,
        }
      );
    } catch (error) {
      console.error("Error sending webhook to ngrok:", error);
    }

    const actor = payload.actor;

    // Conversation assignment kontrolü
    if (payload.action === "conversation_assignment") {
      const conversationId =
        payload.data.assignment.conversation.conversation_id;
      const assignedAgentId =
        payload.data.assignment.conversation.assigned_agent_id;

      try {
        // Messages tablosunda agent_id'yi güncelle
        await db.updateMessageAgent(conversationId, assignedAgentId);
        console.log(
          `Conversation ${conversationId} agent ${assignedAgentId}'ye atandı`
        );

        // Eğer bu konuşma için önbellekte mesaj varsa, agent_id'yi güncelle
        if (messageBuffers[conversationId]) {
          messageBuffers[conversationId].forEach((msg) => {
            msg.agent_id = assignedAgentId;
          });
          console.log(
            `Önbellekteki mesajlar için agent_id güncellendi: ${assignedAgentId}`
          );
        }

        return res.status(200).json({ message: "Agent assignment updated" });
      } catch (error) {
        console.error("Error updating agent assignment:", error);
        return res
          .status(200)
          .json({ message: "Error updating agent assignment" });
      }
    }

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
      const userName = user.properties.find(
        (property) => property.name === "cf_user_name"
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
        agent_id: message.assigned_agent_id || message.agent_id || null, // Agent ID'sini ekle
      };

      console.log("Webhook'tan gelen mesaj verisi:", {
        message_id: message.id,
        assigned_agent_id: message.assigned_agent_id,
        agent_id: message.agent_id,
        conversation_id: message.conversation_id,
      });

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
