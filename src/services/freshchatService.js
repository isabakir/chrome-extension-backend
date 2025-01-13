import axios from "axios";
import { config } from "../config.js";

class FreshchatService {
  constructor() {
    const baseURL = `https://${config.freshchat.domain}`;
    console.log("Initializing Freshchat service with baseURL:", baseURL);

    this.client = axios.create({
      baseURL: baseURL,
      headers: {
        Authorization: `Bearer ${config.freshchat.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    // Add request interceptor for debugging
    this.client.interceptors.request.use((request) => {
      return request;
    });

    // Add response interceptor for debugging
    this.client.interceptors.response.use(
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
        const response = await this.client.get("/v2/users", {
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
        const response = await this.client.get(
          `/v2/users/${userId}/conversations`
        );

        const userConversations = response.data.conversations || [];
        if (userConversations.length === 0) break;

        // Fetch messages for each conversation if not included
        for (let conversation of userConversations) {
          //check if conversation is resolved
          const conversationObj = await this.client.get(
            `/v2/conversations/${conversation.id}`
          );
          conversation.is_resolved = conversationObj.data.status;
          conversation.assigned_agent_id =
            conversationObj.data.assigned_agent_id;
          conversation.user_id = userId;
          await new Promise((resolve) => setTimeout(resolve, 100));

          const messages = await this.client.get(
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

  async testConnection() {
    try {
      // First, log the request configuration
      console.log("Testing connection with config:", {
        baseURL: this.client.defaults.baseURL,
        headers: {
          ...this.client.defaults.headers,
          Authorization: `Bearer ${config.freshchat.apiKey}`,
        },
      });

      const response = await this.client.get("/agents/list"); // Changed to /agents/list endpoint
      console.log("Connection test successful:", {
        status: response.status,
        data: response.data,
      });
      return true;
    } catch (error) {
      console.error("Connection test failed:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        headers: error.response?.headers,
        url: error.config?.url,
        method: error.config?.method,
      });

      // Throw a more detailed error
      throw new Error(
        `Freshchat API Error: ${error.response?.status} - ${
          error.response?.data?.message || error.message
        }`
      );
    }
  }
}

export const freshchatService = new FreshchatService();
