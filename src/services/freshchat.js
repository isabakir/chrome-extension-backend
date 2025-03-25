import axios from "axios";
import { config } from "../config.js";

const FRESHCHAT_API_URL = `https://${config.freshchat.domain}/v2`;

class FreshchatService {
  constructor() {
    this.apiKey = config.freshchat.apiKey;
    this.axiosInstance = axios.create({
      baseURL: FRESHCHAT_API_URL,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  // Tüm agentları getir
  async getAgents() {
    try {
      const response = await this.axiosInstance.get("/agents");
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
      const response = await this.axiosInstance.get(`/agents/${agentId}`);
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
