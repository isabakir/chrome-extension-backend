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
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server } from "socket.io";
import http from "http";
import flamingoRouter from "./flamingo/index.js";

// Express app ve HTTP server oluştur
const app = express();
const server = http.createServer(app);

// Socket.IO yapılandırması
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  },
  path: "/socket.io",
  transports: ["websocket"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

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

// CORS ayarları
app.use(
  cors({
    origin: [
      "https://wchat.freshchat.com",
      "https://flalingo.myfreshworks.com",
      "http://localhost:3000",
      "chrome-extension://*",
      "https://globaleducationtechnologyllc-a0a742a7edcc2d017188649.freshchat.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// JSON boyut limitini artır
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Rate limiter middleware
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again later.",
});

// Helmet middleware for security
app.use(helmet());

// Socket.IO'yu request nesnesine ekle
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Rate limiter'ı webhook route'una uygula
app.use("/webhooks", limiter);

// Initialize webhook routes with proper error handling
app.use(
  "/webhooks",
  (req, res, next) => {
    console.log("Webhook request received:", {
      method: req.method,
      path: req.path,
      body: req.body,
      headers: req.headers,
    });
    next();
  },
  freshchatWebhook
);

// Error handling middleware for webhooks
app.use("/webhooks", (err, req, res, next) => {
  console.error("Webhook error:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
  });
});

// Flamingo route'unu ekle
app.use("/test-flamingo", flamingoRouter);

// Socket.IO bağlantı yönetimi
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Test mesajı gönder
  socket.emit("test", { message: "Bağlantı başarılı!" });

  // Mesaj alma
  socket.on("message", (data) => {
    console.log("Mesaj alındı:", data);
    // Mesajı diğer bağlı clientlara ilet
    socket.broadcast.emit("message", data);
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });

  socket.on("disconnect", (reason) => {
    console.log("Client disconnected:", socket.id, "Reason:", reason);
  });
});

// Root path handler
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Server is running" });
});

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

// Sunucuyu başlat
const PORT = process.env.PORT || 3005;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
  initialize();
});
