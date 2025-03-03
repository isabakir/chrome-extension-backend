import express from "express";
import rateLimit from "express-rate-limit";
import { analyzeMessage } from "../services/messageAnalyzer.js";

const router = express.Router();

// Rate limiter middleware
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again later.",
});

// Logging middleware
router.use((req, res, next) => {
  console.log("Flamingo Route - Request received:", {
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query,
  });
  next();
});

// Mesaj analiz endpoint'i
router.post("/analyze", limiter, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Message content is required",
      });
    }

    const analysis = await analyzeMessage(message);

    // WebSocket ile analiz sonuçlarını gönder (eğer socket bağlantısı varsa)
    if (req.io) {
      req.io.emit("message_analysis", {
        ...analysis,
        message: message,
        created_at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      analysis,
    });
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Webhook endpoint'i
router.post("/webhook", limiter, async (req, res) => {
  try {
    const payload = req.body;

    // Webhook doğrulama ve işleme
    if (!payload || !payload.data || !payload.data.message) {
      return res.status(200).json({ message: "Webhook received" });
    }

    const message = payload.data.message;
    const messageContent = Array.isArray(message.message_parts)
      ? message.message_parts.map((part) => part.text?.content || "").join(" ")
      : "";

    if (!messageContent) {
      return res.status(200).json({ message: "Webhook received" });
    }

    // Mesajı analiz et
    const analysis = await analyzeMessage(messageContent);

    // WebSocket ile analiz sonuçlarını gönder
    if (req.io) {
      req.io.emit("message_analysis", {
        ...analysis,
        id: message.id,
        message: messageContent,
        created_at: message.created_time || new Date().toISOString(),
        user: payload.actor || {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Webhook processed successfully",
    });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(200).json({ message: "Webhook received" });
  }
});

export default router;
