const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { WebSocketServer } = require("ws");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// SSL sertifikaları
const options = {
  key: fs.readFileSync(path.join(__dirname, "../ssl/key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "../ssl/cert.pem")),
  minVersion: "TLSv1.2",
  requestCert: false,
  rejectUnauthorized: false,
};

const server = https.createServer(options, app);

// Test endpoint
app.get("/", (req, res) => {
  res.json({ status: "Server is running" });
});

// WebSocket sunucusu
const wss = new WebSocketServer({ server });

// WebSocket bağlantı yönetimi
wss.on("connection", (ws) => {
  console.log("Yeni WebSocket bağlantısı");

  // Test mesajı gönder
  ws.send(
    JSON.stringify({
      type: "NEW_MESSAGE",
      payload: {
        id: Date.now().toString(),
        message: "Test mesajı",
        PriorityLevel: "high",
        StateOfEmotion: "nötr",
        UserTone: "normal",
        EmojiSuggestion: "👋",
        created_at: new Date().toISOString(),
      },
    })
  );

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      console.log("Alınan mesaj:", message);

      // Mesajı tüm bağlı istemcilere ilet
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(message));
        }
      });
    } catch (error) {
      console.error("Mesaj işleme hatası:", error);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket bağlantısı kesildi");
  });

  ws.on("error", (error) => {
    console.error("WebSocket hatası:", error);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on https://localhost:${PORT}`);
});
