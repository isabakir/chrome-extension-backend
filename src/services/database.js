import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.database.url,
});

// Bağlantıyı test et
pool.connect((err, client, release) => {
  if (err) {
    console.error("Veritabanına bağlanırken hata oluştu:", err.stack);
    return;
  }
  console.log("PostgreSQL veritabanına başarıyla bağlandı");
  release();
});

// Veritabanı işlemleri için yardımcı fonksiyonlar
export const db = {
  query: (text, params) => pool.query(text, params),

  // Mesaj kaydetme
  async saveMessage(message) {
    // Gerekli alanları kontrol et
    if (!message.id) {
      throw new Error("Mesaj ID'si gerekli");
    }

    const query = `
      INSERT INTO messages (
        id, message, created_at, conversation_id, freshchat_conversation_id,
        user_id, user_name, user_email,
        state_of_emotion, user_tone, priority_level, emoji_suggestion, url,
        cf_subscription_id, cf_student_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;

    const values = [
      message.id,
      message.message || "",
      message.created_at || new Date().toISOString(),
      message.conversation_id,
      message.freshchat_conversation_id,
      message.user?.id || null,
      message.user?.name || null,
      message.user?.email || null,
      message.analysis?.StateOfEmotion || null,
      message.analysis?.UserTone || null,
      message.analysis?.PriorityLevel || null,
      message.analysis?.EmojiSuggestion || null,
      message.url || null,
      message.subscriptionId || null,
      message.studentId || null,
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error("Mesaj kaydedilirken hata oluştu:", error);
      throw error;
    }
  },

  // Mesajları getirme
  async getMessages() {
    const query = `
      SELECT 
        m.*,
        COALESCE(m.cf_subscription_id, '') as cf_subscription_id,
        COALESCE(m.cf_student_id, '') as cf_student_id
      FROM messages m
      WHERE DATE(m.created_at) = CURRENT_DATE
      AND m.is_resolved = FALSE
      ORDER BY m.created_at DESC
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      console.error("Mesajlar getirilirken hata oluştu:", error);
      throw error;
    }
  },

  // Mesaj silme
  async deleteMessage(id) {
    const query = `
      DELETE FROM messages 
      WHERE id = $1 
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      console.error("Mesaj silinirken hata oluştu:", error);
      throw error;
    }
  },

  // Conversation ID'ye göre mesaj getirme
  async getMessageByConversationId(conversationId) {
    const query = `
      SELECT * FROM messages 
      WHERE conversation_id = $1
      LIMIT 1
    `;

    try {
      const result = await pool.query(query, [conversationId]);
      return result.rows[0];
    } catch (error) {
      console.error("Mesaj aranırken hata oluştu:", error);
      throw error;
    }
  },

  // Mesaj detayı kaydetme
  async saveMessageDetail(message) {
    const query = `
      INSERT INTO message_details (
        conversation_id, message_id, message, created_at,
        user_id, user_name, user_email,
        state_of_emotion, user_tone, priority_level, emoji_suggestion
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (message_id) DO NOTHING
      RETURNING *
    `;

    const values = [
      message.conversation_id,
      message.id,
      message.message,
      message.created_at,
      message.user?.id,
      message.user?.name,
      message.user?.email,
      message.analysis?.StateOfEmotion,
      message.analysis?.UserTone,
      message.analysis?.PriorityLevel,
      message.analysis?.EmojiSuggestion,
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error("Mesaj detayı kaydedilirken hata oluştu:", error);
      throw error;
    }
  },

  // Resolution durumunu güncelleme
  async updateMessageResolution(conversationId, isResolved) {
    const query = `
      UPDATE messages 
      SET is_resolved = $2 
      WHERE conversation_id = $1 
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [conversationId, isResolved]);
      return result.rows[0];
    } catch (error) {
      console.error("Resolution durumu güncellenirken hata oluştu:", error);
      throw error;
    }
  },
};
