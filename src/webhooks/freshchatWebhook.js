import express from "express";
import { freshchatService } from "../services/freshchatService.js";

const router = express.Router();

router.post("/freshchat-webhook", async (req, res) => {
  try {
    const payload = req.body;
    const actor = payload.actor;

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

      const messageContent = message.message_parts
        .map((part) => part.text.content)
        .join(" ");

      // Mesajı analiz et
      const analysis = {
        StateOfEmotion: freshchatService.getEmotionState(messageContent),
        UserTone: freshchatService.getUserTone(messageContent),
        PriorityLevel: freshchatService.getPriorityLevel(messageContent),
        EmojiSuggestion: freshchatService.getEmojiSuggestion(messageContent),
      };

      // Socket.IO üzerinden yayınla
      if (req.io) {
        req.io.emit("message", {
          ...analysis,
          id: message.id,
          message: messageContent,
          created_at: message.created_time,
          user: {
            name: `${user?.first_name || ""} ${user?.last_name || ""}`.trim(),
            email: user?.email,
            avatar: user?.avatar?.url,
          },
          url: `https://flalingo.myfreshworks.com/crm/messaging/a/884923745698942/inbox/3/0/conversation/`,
        });
      }

      res.status(200).json({ message: "Webhook received" });
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
