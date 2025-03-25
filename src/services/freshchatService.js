import axios from "axios";
import { config } from "../config.js";

const freshchatApi = axios.create({
  baseURL: `https://${process.env.FRESHCHAT_DOMAIN}`,
  headers: {
    Authorization: `Bearer ${process.env.FRESHCHAT_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

class FreshchatService {
  constructor() {
    console.log(
      "Initializing Freshchat service with baseURL:",
      freshchatApi.defaults.baseURL
    );

    // Add request interceptor for debugging
    freshchatApi.interceptors.request.use((request) => {
      return request;
    });

    // Add response interceptor for debugging
    freshchatApi.interceptors.response.use(
      (response) => {
        return response;
      },
      (error) => {
        console.error("Response error:", {
          status: error.response?.status,
          data: error.response?.data,
          headers: error.response?.headers,
        });
        return Promise.reject(error);
      }
    );
  }

  async getHistoricalConversations(fromDate) {
    try {
      // First, get all users
      const users = await this.getAllUsers();
      console.log(`Found ${users.length} users`);

      let allConversations = [];

      // For each user, get their conversations
      for (const user of users) {
        try {
          console.log(`Fetching conversations for user: ${user}`);
          const userConversations = await this.getUserConversations(
            user,
            fromDate
          );
          allConversations = allConversations.concat(userConversations);
        } catch (error) {
          console.error(
            `Error fetching conversations for user ${user.id}:`,
            error
          );
        }
        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return allConversations;
    } catch (error) {
      console.error("Error fetching historical conversations:", error);
      if (error.response) {
        console.error("Error response:", {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers,
          url: error.config?.url,
          method: error.config?.method,
        });
      }
      throw error;
    }
  }

  async getAllUsers() {
    let userIds = [];
    let page = 1;
    let i = 1;
    while (i < 10) {
      i++;
      try {
        const response = await freshchatApi.get("/v2/users", {
          params: {
            created_from: "2024-10-01T00:00:00Z", //UTC Format From 1st October 2024, can be changed to any date
            page: page,
          },
        });

        const users = response.data.users || [];
        if (users.length === 0) break;

        console.log("Total users fetched:", response.data);

        //STORE USERS'S ids
        for (const user of users) {
          userIds.push(user.id);
        }

        let currentPage = response.data.pagination.current_page;
        let totalPages = response.data.pagination.total_pages;

        if (currentPage < totalPages) {
          console.log(
            `current_page: ${currentPage} > total_pages: ${totalPages}`
          );
          page++;
        } else {
          console.log(
            `current_page: ${currentPage} <= total_pages: ${totalPages}`
          );
          break;
        }

        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error fetching users page ${page}:`, error);
        throw error;
      }
    }

    return userIds;
  }

  async getUserConversations(userId, fromDate) {
    let conversations = [];
    let page = 1;
    let i = 1;
    while (i < 10) {
      i++;
      try {
        const response = await freshchatApi.get(
          `/v2/users/${userId}/conversations`
        );

        const userConversations = response.data.conversations || [];
        if (userConversations.length === 0) break;

        // Fetch messages for each conversation if not included
        for (let conversation of userConversations) {
          //check if conversation is resolved
          const conversationObj = await freshchatApi.get(
            `/v2/conversations/${conversation.id}`
          );
          conversation.is_resolved = conversationObj.data.status;
          conversation.assigned_agent_id =
            conversationObj.data.assigned_agent_id;
          conversation.user_id = userId;
          await new Promise((resolve) => setTimeout(resolve, 100));

          const messages = await freshchatApi.get(
            `/v2/conversations/${conversation.id}/messages`
          );
          conversation.messages = messages.data.messages || [];

          //check if conversation has summary
          await new Promise((resolve) => setTimeout(resolve, 100));
          conversations.push(conversation);
        }

        console.log(
          `Fetched ${userConversations.length} conversations for user ${userId} from page ${page}`
        );

        if (!response.data.pagination?.has_next) break;
        page++;

        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(
          `Error fetching conversations for user ${userId} page ${page}:`,
          error
        );
        throw error;
      }
    }

    return conversations;
  }

  formatConversation(rawConversation) {
    return {
      id: rawConversation.id,
      content: rawConversation.messages || [],
      user_id: rawConversation.user_id,
      assigned_agent_id: rawConversation.assigned_agent_id,
      summary: "",
      is_resolved: "",
    };
  }

  async getUser(userId) {
    try {
      const response = await freshchatApi.get(`/v2/users/${userId}`);
      console.log("user+:", response.data);
      return response.data;
    } catch (error) {
      console.error("Error fetching Freshchat user:", error);
      return null;
    }
  }

  getEmotionState(message) {
    const emotions = {
      mutlu: ["teşekkür", "harika", "güzel", "süper", ":)", "😊", "👍"],
      üzgün: ["maalesef", "kötü", "olmadı", "yapamadım", ":(", "😢", "👎"],
      kızgın: ["saçma", "berbat", "rezalet", "çok kötü", "😠", "🤬"],
      endişeli: ["acaba", "emin değilim", "korkarım", "endişe", "😰", "😨"],
    };

    message = message.toLowerCase();

    for (const [emotion, keywords] of Object.entries(emotions)) {
      if (keywords.some((keyword) => message.includes(keyword))) {
        return emotion;
      }
    }

    return "nötr";
  }

  getUserTone(message) {
    const tones = {
      resmi: ["sayın", "rica ederim", "merhaba", "iyi günler", "saygılarımla"],
      samimi: ["selam", "hey", "dostum", "kardeş", "abi", "abla"],
      agresif: ["hemen", "derhal", "şimdi", "bekliyorum", "!"],
    };

    message = message.toLowerCase();

    for (const [tone, keywords] of Object.entries(tones)) {
      if (keywords.some((keyword) => message.includes(keyword))) {
        return tone;
      }
    }

    return "normal";
  }

  getPriorityLevel(message) {
    const urgentKeywords = ["acil", "hemen", "şimdi", "kritik", "önemli"];
    const highKeywords = ["problem", "sorun", "hata", "yardım", "destek"];
    const mediumKeywords = ["nasıl", "bilgi", "?", "neden", "nerede"];

    message = message.toLowerCase();

    if (urgentKeywords.some((keyword) => message.includes(keyword))) {
      return "urgent";
    } else if (highKeywords.some((keyword) => message.includes(keyword))) {
      return "high";
    } else if (mediumKeywords.some((keyword) => message.includes(keyword))) {
      return "medium";
    }
    return "low";
  }

  getEmojiSuggestion(message) {
    const emojiMap = {
      teşekkür: "🙏",
      harika: "🌟",
      problem: "❗",
      yardım: "🆘",
      nasıl: "❓",
      tamam: "👍",
      hayır: "👎",
      para: "💰",
      zaman: "⏰",
      bekle: "⌛",
      hata: "⚠️",
      çözüldü: "✅",
      merhaba: "👋",
      "güle güle": "👋",
      "iyi günler": "🌞",
      "iyi akşamlar": "🌙",
    };

    message = message.toLowerCase();

    for (const [keyword, emoji] of Object.entries(emojiMap)) {
      if (message.includes(keyword)) {
        return emoji;
      }
    }

    return "💬";
  }

  async testConnection() {
    try {
      await freshchatApi.get("/v2/agents");
      return true;
    } catch (error) {
      console.error("Freshchat connection test failed:", error);
      return false;
    }
  }

  // Tüm agentları getir
  async getAgents() {
    try {
      const response = await freshchatApi.get("/v2/agents");
      return {
        success: true,
        data: response.data.agents.map((agent) => ({
          id: agent.id,
          email: agent.email,
          first_name: agent.first_name,
          last_name: agent.last_name,
          avatar: agent.avatar?.url,
          role: agent.role,
          status: agent.status,
        })),
      };
    } catch (error) {
      console.error(
        "Freshchat agentları getirme hatası:",
        error.response?.data || error.message
      );
      return {
        success: false,
        error: "Agentlar getirilemedi",
      };
    }
  }

  // Belirli bir agent'ın detaylarını getir
  async getAgentDetails(agentId) {
    try {
      const response = await freshchatApi.get(`/v2/agents/${agentId}`);
      return {
        success: true,
        data: {
          id: response.data.id,
          email: response.data.email,
          first_name: response.data.first_name,
          last_name: response.data.last_name,
          avatar: response.data.avatar?.url,
          role: response.data.role,
          status: response.data.status,
        },
      };
    } catch (error) {
      console.error(
        "Freshchat agent detayları getirme hatası:",
        error.response?.data || error.message
      );
      return {
        success: false,
        error: "Agent detayları getirilemedi",
      };
    }
  }
}

export const freshchatService = new FreshchatService();
