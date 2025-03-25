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
    console.log("Yeni socket bağlantısı:", socket.id);

    // Agent seçildiğinde
    socket.on("agent_selected", (data) => {
      console.log("Agent seçildi:", data);
      const { agent_id, extension_id } = data;

      // Eski eşleştirmeleri temizle
      const oldAgentId = socketAgentMap.get(socket.id);
      if (oldAgentId) {
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

      console.log(
        `Socket ${socket.id} agent ${agent_id}'ye bağlandı (Extension: ${extension_id})`
      );
      console.log(
        "Güncel agent socket haritası:",
        Object.fromEntries([...agentSocketsMap].map(([k, v]) => [k, [...v]]))
      );
    });

    // Bağlantı kesildiğinde
    socket.on("disconnect", () => {
      console.log("Socket bağlantısı kesildi:", socket.id);

      // Agent eşleştirmelerini temizle
      const agentId = socketAgentMap.get(socket.id);
      if (agentId) {
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

      console.log(
        "Güncel agent socket haritası:",
        Object.fromEntries([...agentSocketsMap].map(([k, v]) => [k, [...v]]))
      );
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

// Freshchat webhook handler
router.post("/freshchat", async (req, res) => {
  try {
    const webhookData = req.body;
    console.log("Freshchat webhook alındı:", webhookData);

    // Mesajı işle
    const message = {
      message: webhookData.message?.text || "",
      conversation_id: webhookData.conversation?.id,
      freshchat_conversation_id: webhookData.conversation?.id,
      url: webhookData.conversation?.app_url,
      user_id: webhookData.actor?.id,
      user_name: webhookData.actor?.display_name || "Bilinmeyen Kullanıcı",
      user_email: webhookData.actor?.email,
      agent_id: webhookData.conversation?.assigned_agent_id,
      is_resolved: webhookData.conversation?.status === "resolved",
      timestamp: new Date().toISOString(),
    };

    // Mesaj analizini yap
    const analysis = await openaiService.analyze(message.message, systemPrompt);
    message.state_of_emotion = analysis.state_of_emotion;
    message.user_tone = analysis.user_tone;
    message.priority_level = analysis.priority_level;
    message.emoji_suggestion = analysis.emoji_suggestion;

    // Mesajı veritabanına kaydet
    const savedMessage = await db.saveMessage(message);

    if (savedMessage.success) {
      // Mesajın atandığı agent'ın socket'lerini bul
      const assignedAgentId = message.agent_id;
      const agentSockets = agentSocketsMap.get(assignedAgentId);

      if (agentSockets && agentSockets.size > 0) {
        console.log(
          `Mesaj ${assignedAgentId} ID'li agent'ın ${agentSockets.size} socket bağlantısına gönderiliyor`
        );

        // Bu agent'a ait tüm socket'lere mesajı gönder
        agentSockets.forEach((socketId) => {
          io.to(socketId).emit("message", {
            ...savedMessage.data,
            analysis,
            timestamp: message.timestamp,
          });
        });

        console.log(`Mesaj başarıyla ${agentSockets.size} socket'e iletildi`);
      } else {
        console.log(
          `${assignedAgentId} ID'li agent için aktif socket bağlantısı bulunamadı`
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Webhook işleme hatası:", error);
    res.status(500).json({ success: false, error: "Webhook işlenemedi" });
  }
});

export default router;
