import express from "express";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import routes from "./routes/index.js";

// Express app oluştur
const app = express();
const server = http.createServer(app);

// Socket.IO yapılandırması
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middleware'ler
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Socket.IO'yu request nesnesine ekle
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Ana route'u ekle
app.use("/test-flamingo", routes);

// Socket.IO bağlantı yönetimi
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: "Internal Server Error",
  });
});

export { app, server, io };

const router = express.Router();

// Ana route'u ekle
router.use("/", routes);

export default router;
