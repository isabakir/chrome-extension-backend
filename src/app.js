import express from "express";
import { config } from "./config.js";
import { qdrantService } from "./services/qdrantService.js";
import { freshchatService } from "./services/freshchatService.js";
import { processingJob } from "./jobs/processingJob.js";
import { deepseekService } from "./services/deepseekService.js";
import freshchatWebhook from "./webhooks/freshchatWebhook.js";
import { openaiService } from "./services/openaiService.js";
import cors from "cors";
import fs from "fs";
import FormData from "form-data";
import fetch from "node-fetch";
import { v2 as cloudinary } from "cloudinary";
import sharp from "sharp";

// Cloudinary yapılandırması
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Görüntü optimizasyonu fonksiyonu
async function optimizeImage(base64Image) {
  try {
    // Base64'ü buffer'a çevir
    const imageBuffer = Buffer.from(base64Image, "base64");

    // Sharp ile optimize et
    const optimizedBuffer = await sharp(imageBuffer)
      .resize({
        width: 1920,
        height: 1080,
        fit: "inside",
        withoutEnlargement: true, // Orijinali küçükse büyütmez
      }) // Maksimum boyut
      .jpeg({ quality: 80 }) // JPEG formatına çevir ve kaliteyi düşür
      .toBuffer();

    // Buffer'ı base64'e geri çevir
    return optimizedBuffer.toString("base64");
  } catch (error) {
    console.error("Görüntü optimizasyonu hatası:", error);
    return base64Image; // Hata durumunda orijinal görüntüyü döndür
  }
}

const app = express();

// CORS ayarları
app.use(
  cors({
    origin: [
      "https://wchat.freshchat.com",
      "https://flalingo.myfreshworks.com",
      "http://localhost:3000",
      "chrome-extension://*",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// JSON boyut limitini artır
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Initialize webhook routes
app.use("/webhooks", freshchatWebhook);

// New endpoint to trigger historical data import
app.get("/api/import-historical", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30; // Get days from query params

    // Initialize Qdrant collection if it doesn't exist
    await qdrantService.initializeCollection();

    // Fetch historical conversations
    const historicalConversations =
      await freshchatService.getHistoricalConversations(
        new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      );

    console.log(
      `Found ${historicalConversations.length} historical conversations`
    );

    // Store historical conversations
    let stored = 0;
    for (const conversation of historicalConversations) {
      const formattedConversation =
        freshchatService.formatConversation(conversation);
      await qdrantService.storeConversation(formattedConversation);
      stored++;
    }

    res.json({
      success: true,
      message: `Successfully processed ${stored} conversations out of ${historicalConversations.length} total conversations`,
    });
  } catch (error) {
    console.error("Import failed:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Add this new endpoint
app.get("/api/test-freshchat", async (req, res) => {
  try {
    const result = await freshchatService.testConnection();
    res.json({
      success: result,
      message: "Successfully connected to Freshchat API",
    });
  } catch (error) {
    console.error("Test endpoint error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      },
    });
  }
});

// Modify the initialize function to only set up the collection and start the job
async function initialize() {
  try {
    await qdrantService.initializeCollection();
    processingJob.start();

    console.log("Server initialization completed successfully");
  } catch (error) {
    console.error("Server initialization failed:", error);
    process.exit(1);
  }
}

app.post("/api/query", async (req, res) => {
  try {
    const { query } = req.body;
    console.log(query);
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    // Semantik arama yap
    const similarConversations = await qdrantService.semanticSearch(query);

    if (similarConversations.length === 0) {
      return res.status(404).json({ error: "No similar conversations found" });
    }

    // En benzer konuşmayı al
    const mostSimilar = similarConversations[0];
    console.log("similar conversation", mostSimilar.payload.conversation);
    // DeepSeek ile cevap üret
    const response = await openaiService.processConversation(
      query,
      mostSimilar.payload.conversation
    );

    res.json({
      response,
      similarity_score: mostSimilar.score,
      similar_conversation: mostSimilar.payload,
    });
  } catch (error) {
    console.error("Error processing query:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Google Chat'e mesaj gönderme endpoint'i
app.post("/api/sendGoogleChat", async (req, res) => {
  try {
    const { text, image } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Mesaj metni gerekli" });
    }

    // Google Chat webhook URL'ini al
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK;
    if (!webhookUrl) {
      return res.status(500).json({ error: "Webhook URL bulunamadı" });
    }

    let imageUrl = null;
    if (image) {
      try {
        // Görüntüyü optimize et
        const optimizedImage = await optimizeImage(image);

        // Optimize edilmiş görüntüyü Cloudinary'ye yükle
        const uploadResponse = await cloudinary.uploader.upload(
          `data:image/jpeg;base64,${image}`,
          {
            folder: "freshchat-screenshots",
          }
        );
        imageUrl = uploadResponse.secure_url;
      } catch (error) {
        console.error("Cloudinary yükleme hatası:", error);
      }
    }

    // Google Chat'e gönder
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        cards: imageUrl
          ? [
              {
                sections: [
                  {
                    widgets: [
                      {
                        textParagraph: {
                          text: "Ekran görüntüsü:",
                        },
                      },
                      {
                        image: {
                          imageUrl: imageUrl,
                        },
                      },
                    ],
                  },
                ],
              },
            ]
          : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Google Chat API yanıt vermedi: ${response.status}`);
    }

    res.json({ success: true, message: "Mesaj Google Chat'e gönderildi" });
  } catch (error) {
    console.error("Google Chat gönderme hatası:", error);
    res.status(500).json({ error: "Mesaj gönderilemedi" });
  }
});

const PORT = config.port || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  initialize();
});
