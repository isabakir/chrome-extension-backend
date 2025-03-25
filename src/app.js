import express from "express";
import { config } from "./config.js";
import { qdrantService } from "./services/qdrantService.js";
import { freshchatService } from "./services/freshchatService.js";
import { processingJob } from "./jobs/processingJob.js";
import { deepseekService } from "./services/deepseekService.js";
import freshchatWebhook from "./webhooks/freshchatWebhook.js";
import { openaiService } from "./services/openaiService.js";
import { db } from "./services/database.js";
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
import { setupSocketIO } from "./webhooks/freshchatWebhook.js";

// Express app ve HTTP server oluştur
const app = express();
const server = http.createServer(app);

// CORS ayarları
app.use(
  cors({
    origin: "*",
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

// Socket.IO yapılandırması
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  },
  path: "/socket.io/",
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e8,
  allowUpgrades: true,
  serveClient: false,
  cookie: false,
  handlePreflightRequest: (req, res) => {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": true,
    });
    res.end();
  },
});

// Webhook'u ayarla ve Socket.IO'yu ilet
setupSocketIO(io);

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

// Socket.IO'yu middleware olarak ekle
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Webhook route'unu ekle
app.use("/webhooks", freshchatWebhook);

// Root path handler
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Server is running", socketEnabled: true });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    connections: io.engine.clientsCount,
    timestamp: new Date().toISOString(),
  });
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

// AI öneri geri bildirimlerini kaydetme endpoint'i
app.post("/api/feedback", async (req, res) => {
  try {
    const {
      action,
      suggestion,
      customer_message,
      original_suggestion,
      timestamp,
      agent_id,
      conversation_id,
    } = req.body;

    // Gerekli alanları kontrol et
    if (!action || !suggestion || !customer_message) {
      return res.status(400).json({
        success: false,
        error:
          "Eksik parametreler: action, suggestion ve customer_message alanları gereklidir",
      });
    }

    // Geri bildirimi kaydet
    const feedback = {
      action,
      suggestion,
      customer_message,
      original_suggestion: original_suggestion || null,
      timestamp: timestamp || new Date().toISOString(),
      agent_id: agent_id || "unknown_agent",
      conversation_id: conversation_id || "unknown_conversation",
    };

    const savedFeedback = await db.saveFeedback(feedback);

    // WebSocket ile geri bildirim bilgisini gönder
    if (req.io) {
      req.io.emit("feedback", savedFeedback);
    }

    res.json({
      success: true,
      message: "Geri bildirim başarıyla kaydedildi",
      data: savedFeedback,
    });
  } catch (error) {
    console.error("Geri bildirim kaydedilirken hata oluştu:", error);
    res.status(500).json({
      success: false,
      error: "Geri bildirim kaydedilemedi",
      details: error.message,
    });
  }
});

// Geri bildirimleri getirme endpoint'i
app.get("/api/feedback", async (req, res) => {
  try {
    const feedbacks = await db.getFeedbacks();

    res.json({
      success: true,
      data: feedbacks,
    });
  } catch (error) {
    console.error("Geri bildirimler getirilirken hata oluştu:", error);
    res.status(500).json({
      success: false,
      error: "Geri bildirimler getirilemedi",
      details: error.message,
    });
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

// API route'ları
app.get("/api/messages", async (req, res) => {
  try {
    const messages = await db.getMessages();

    // Veriyi frontend'in beklediği formata dönüştür
    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      message: msg.message,
      created_at: msg.created_at,
      conversation_id: msg.conversation_id,
      freshchat_conversation_id: msg.freshchat_conversation_id,
      url: msg.url,
      is_resolved: msg.is_resolved,
      cf_subscription_id: msg.cf_subscription_id,
      cf_student_id: msg.cf_student_id,
      subscription_type: msg.cf_subscription_id ? "support" : "sales",
      user: {
        id: msg.user_id,
        name: msg.user_name,
        email: msg.user_email,
      },
      analysis: {
        StateOfEmotion: msg.state_of_emotion,
        UserTone: msg.user_tone,
        PriorityLevel: msg.priority_level,
        EmojiSuggestion: msg.emoji_suggestion,
      },
    }));

    res.json({
      success: true,
      data: formattedMessages,
    });
  } catch (error) {
    console.error("Mesajlar getirilirken hata:", error);
    res.status(500).json({
      success: false,
      error: "Mesajlar getirilemedi",
      details: error.message,
    });
  }
});

// Freshchat agentlarını getir
app.get("/api/agents", async (req, res) => {
  try {
    const result = await freshchatService.getAgents();
    if (result.success) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error("Agent listesi getirme hatası:", error);
    res
      .status(500)
      .json({ success: false, error: "Agent listesi getirilemedi" });
  }
});

// Belirli bir agent'ın detaylarını getir
app.get("/api/agents/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    const result = await freshchatService.getAgentDetails(agentId);
    if (result.success) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error("Agent detayları getirme hatası:", error);
    res
      .status(500)
      .json({ success: false, error: "Agent detayları getirilemedi" });
  }
});

// Agent socket haritası
const agentSocketMap = new Map(); // agent_id -> Set of socket IDs
const socketAgentMap = new Map(); // socket_id -> agent_info

io.on("connection", (socket) => {
  console.log("Yeni socket bağlantısı:", socket.id);

  // Query'den agent bilgilerini al
  const { agent_id, agent_name, agent_email } = socket.handshake.query;

  if (agent_id) {
    // Agent bilgilerini sakla
    const agentInfo = {
      id: agent_id,
      name: agent_name || "İsimsiz Agent",
      email: agent_email || "Email yok",
      socket_id: socket.id,
      connected_at: new Date().toISOString(),
    };

    // Socket -> Agent eşleşmesini kaydet
    socketAgentMap.set(socket.id, agentInfo);

    // Agent -> Sockets eşleşmesini güncelle
    if (!agentSocketMap.has(agent_id)) {
      agentSocketMap.set(agent_id, new Set());
    }
    agentSocketMap.get(agent_id).add(socket.id);

    console.log(
      `Agent bağlandı: ${agent_name} (${agent_email}) - ID: ${agent_id}`
    );
    console.log("Güncel agent socket haritası:", mapToObject(agentSocketMap));
  }

  // Agent seçildiğinde
  socket.on("agent_selected", (data) => {
    const { agent_id, agent_name, agent_email, socket_id } = data;

    // Eski eşleşmeleri temizle
    if (socketAgentMap.has(socket.id)) {
      const oldAgentInfo = socketAgentMap.get(socket.id);
      const oldAgentSockets = agentSocketMap.get(oldAgentInfo.id);
      if (oldAgentSockets) {
        oldAgentSockets.delete(socket.id);
        if (oldAgentSockets.size === 0) {
          agentSocketMap.delete(oldAgentInfo.id);
        }
      }
    }

    // Yeni agent bilgilerini kaydet
    const agentInfo = {
      id: agent_id,
      name: agent_name,
      email: agent_email,
      socket_id: socket.id,
      selected_at: new Date().toISOString(),
    };

    socketAgentMap.set(socket.id, agentInfo);

    if (!agentSocketMap.has(agent_id)) {
      agentSocketMap.set(agent_id, new Set());
    }
    agentSocketMap.get(agent_id).add(socket.id);

    console.log(
      `Agent seçildi: ${agent_name} (${agent_email}) - ID: ${agent_id}`
    );
    console.log("Güncel agent socket haritası:", mapToObject(agentSocketMap));
  });

  // Agent bağlantısı kesildiğinde
  socket.on("agent_disconnecting", (data) => {
    const { agent_id, agent_name } = data;
    console.log(`Agent bağlantısı kesiliyor: ${agent_name} - ID: ${agent_id}`);
  });

  // Socket bağlantısı koptuğunda
  socket.on("disconnect", (reason) => {
    // Bağlantısı kesilen agent'ı bul ve logla
    const agentInfo = socketAgentMap.get(socket.id);
    if (agentInfo) {
      console.log(
        `Agent bağlantısı kesildi: ${agentInfo.name} (${agentInfo.email}) - ID: ${agentInfo.id}`
      );
      console.log("Bağlantı kesme sebebi:", reason);

      // Agent'ın socket setinden bu socket'i kaldır
      const agentSockets = agentSocketMap.get(agentInfo.id);
      if (agentSockets) {
        agentSockets.delete(socket.id);
        // Eğer agent'ın hiç socket'i kalmadıysa haritadan kaldır
        if (agentSockets.size === 0) {
          agentSocketMap.delete(agentInfo.id);
          console.log(`${agentInfo.name} için tüm bağlantılar kesildi.`);
        }
      }

      // Socket -> Agent eşleşmesini kaldır
      socketAgentMap.delete(socket.id);
    }

    console.log("Güncel agent socket haritası:", mapToObject(agentSocketMap));
  });

  // Ping mesajlarını karşıla
  socket.on("ping", () => {
    const agentInfo = socketAgentMap.get(socket.id);
    if (agentInfo) {
      console.log(
        `Ping alındı - Agent: ${agentInfo.name} (Socket: ${socket.id})`
      );
    }
    socket.emit("pong");
  });
});

// Map objesini JSON'a çevirmek için yardımcı fonksiyon
function mapToObject(map) {
  const obj = {};
  for (let [key, value] of map) {
    if (value instanceof Set) {
      obj[key] = Array.from(value);
    } else {
      obj[key] = value;
    }
  }
  return obj;
}

// Mesaj route'u
app.post("/api/messages", async (req, res) => {
  try {
    const message = req.body;
    const savedMessage = await saveMessage(message);

    // Mesajı ilgili agent'ın tüm socket'lerine gönder
    if (savedMessage.assigned_agent_id) {
      const agentSockets = agentSocketMap.get(savedMessage.assigned_agent_id);
      if (agentSockets && agentSockets.size > 0) {
        console.log(
          `Mesaj gönderiliyor - Agent ID: ${savedMessage.assigned_agent_id}, Socket sayısı: ${agentSockets.size}`
        );
        agentSockets.forEach((socketId) => {
          io.to(socketId).emit("message", savedMessage);
        });
      } else {
        console.log(
          `Uyarı: ${savedMessage.assigned_agent_id} ID'li agent için aktif socket bulunamadı`
        );
      }
    }

    res.json({ success: true, data: savedMessage });
  } catch (error) {
    console.error("Mesaj kaydedilirken hata:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Agent'ları Freshchat'ten çekip veritabanına kaydetme endpoint'i
app.post("/sync/agents", async (req, res) => {
  try {
    const result = await freshchatService.getAgents();

    if (!result.success) {
      throw new Error(result.error);
    }

    const agents = result.data || [];

    // Her agent'ı veritabanına kaydet
    for (const agent of agents) {
      await db.saveAgent({
        id: agent.id,
        name: `${agent.first_name} ${agent.last_name}`.trim(),
        email: agent.email,
        avatar_url: agent.avatar?.url,
      });
    }

    res.json({
      success: true,
      message: `${agents.length} agent başarıyla senkronize edildi`,
    });
  } catch (error) {
    console.error("Agent senkronizasyon hatası:", error);
    res.status(500).json({
      success: false,
      message: "Agent'lar senkronize edilirken hata oluştu",
      error: error.message,
    });
  }
});

// Agent'ları veritabanından getirme endpoint'i
app.get("/agents", async (req, res) => {
  try {
    const agents = await db.getAgents();
    res.json(agents);
  } catch (error) {
    console.error("Agent'lar getirilirken hata oluştu:", error);
    res.status(500).json({
      success: false,
      message: "Agent'lar getirilirken hata oluştu",
      error: error.message,
    });
  }
});

// Sunucuyu başlat
const PORT = process.env.PORT || 3005;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
  initialize();
});
