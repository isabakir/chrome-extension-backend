import express from "express";
import { freshchatService } from "../services/freshchatService.js";
import { openaiService } from "../services/openaiService.js";
import { db } from "../services/database.js";

const router = express.Router();

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

router.post("/freshchat-webhook", async (req, res) => {
  try {
    const payload = req.body;
    console.log("Webhook payload:", payload);

    const actor = payload.actor;

    // Conversation resolution kontrolü
    if (payload.action === "conversation_resolution") {
      const conversationId = payload.data.resolve.conversation.id;
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

    // Sadece kullanıcıdan gelen ilk mesajı işle
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

      const messageContent = message.message_parts
        .map((part) => part.text?.content || "")
        .join(" ")
        .trim();

      if (!messageContent) {
        return res.status(200).json({ message: "Webhook received" });
      }

      // OpenAI ile mesajı analiz et
      const analysis = await openaiService.analyze(
        messageContent,
        systemPrompt
      );

      // Mesaj verisini hazırla
      const messageData = {
        id: message.id,
        message: messageContent,
        created_at: message.created_time,
        conversation_id: message.conversation_id,
        user: {
          id: user.id,
          name: `${user?.first_name || ""} ${user?.last_name || ""}`.trim(),
          email: user?.email,
          avatar: user?.avatar?.url,
        },
        analysis: analysis,
        url: `https://flalingo.myfreshworks.com/crm/messaging/conversation/${message.freshchat_conversation_id}`,
      };

      try {
        // Önce conversation_id kontrolü yap
        const existingMessage = await db.getMessageByConversationId(
          message.conversation_id
        );

        if (existingMessage) {
          // Eğer conversation_id varsa message_details'e ekle
          await db.saveMessageDetail(messageData);
          console.log("Mesaj detayı kaydedildi:", messageData.id);
        } else {
          // Yeni conversation ise messages tablosuna ekle
          await db.saveMessage(messageData);
          console.log("Yeni mesaj kaydedildi:", messageData.id);
        }
      } catch (dbError) {
        console.error("Veritabanı kayıt hatası:", dbError);
      }

      // Socket.IO üzerinden yayınla
      if (req.io) {
        console.log("Emitting message:", messageData);
        req.io.emit("message", messageData);
      } else {
        console.warn("Socket.IO instance not found in request object");
      }

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
