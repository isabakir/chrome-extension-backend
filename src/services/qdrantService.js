import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config.js";
import { openaiService } from "./openaiService.js";

class QdrantService {
  constructor() {
    this.client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
    });
  }

  async initializeCollection() {
    try {
      // First check if collection exists
      const collections = await this.client.getCollections();
      const collectionExists = collections.collections.some(
        (collection) => collection.name === "conversations_isa"
      );

      if (!collectionExists) {
        await this.client.createCollection("conversations_isa", {
          vectors: {
            size: 1536, // OpenAI embedding dimension
            distance: "Cosine",
          },
        });
        console.log('Collection "conversations_isa" created successfully');
      } else {
        console.log('Collection "conversations_isa" already exists');
      }
    } catch (error) {
      console.error("Error initializing collection:", error);
      throw error;
    }
  }

  async storeConversation(conversation) {
    try {
      // Check if conversation already exists
      const existing = await this.client.scroll("conversations_isa", {
        filter: {
          must: [{ key: "id", match: { value: conversation.id } }],
        },
        limit: 1,
      });

      if (existing.points && existing.points.length > 0) {
        console.log(
          `Conversation ${conversation.id} already exists, skipping...`
        );
        return;
      }

      const payload = {
        id: conversation.id,
        conversation: this.simplifyConversation(conversation.content),
        user_id: conversation.user_id || null,
        assigned_agent_id: conversation.assigned_agent_id,
        summary: conversation.summary || "",
        is_resolved: conversation.is_resolved || false,
        created_at: new Date().toISOString(),
      };

      // Konuşma metnini birleştir
      const conversationText = payload.conversation
        .map((msg) => msg.text)
        .join("\n");

      // OpenAI'den embedding al
      const vector = await openaiService.createEmbedding(conversationText);

      await this.client.upsert("conversations_isa", {
        wait: true,
        points: [
          {
            id: conversation.id,
            payload,
            vector: vector,
          },
        ],
      });
      console.log(`Conversation ${conversation.id} stored successfully`);
    } catch (error) {
      console.error("Error storing conversation:", error);
      throw error;
    }
  }

  // Helper method to simplify conversation JSON
  simplifyConversation(messages) {
    return messages.map((msg) => ({
      message_id: msg.id,
      message_type: msg.message_type,
      text: msg.message_parts?.[0]?.text || msg.text || "",
      actor_type: msg.actor_type,
      actor_id: msg.actor_id,
      timestamp: msg.created_time,
    }));
  }

  async getConversations(limit = 10, offset = 0) {
    try {
      const response = await this.client.scroll("conversations_simplified", {
        filter: {
          must: [
            {
              key: "4eeefc31-9bba-4c87-9282-0d02a94f3e97",
              match: { value: agentId },
            },
          ],
        },
        limit: limit,
        offset: offset,
      });
      return response.points;
    } catch (error) {
      console.error("Error fetching conversations:", error);
      throw error;
    }
  }

  async searchConversations(query, limit = 10) {
    try {
      const response = await this.client.scroll("conversations_simplified", {
        filter: {
          must: [
            {
              key: "conversation",
              match: {
                text: query,
              },
            },
          ],
        },
        limit: limit,
      });
      return response.points;
    } catch (error) {
      console.error("Error searching conversations:", error);
      throw error;
    }
  }

  async semanticSearch(query, limit = 5) {
    try {
      // Metni vektöre çevir
      const queryVector = await openaiService.createEmbedding(query);

      // Vektör araması yap
      const result = await this.client.search("conversations_simplified", {
        filter: {
          must: [
            {
              key: "assigned_agent_id",
              match: { value: "4eeefc31-9bba-4c87-9282-0d02a94f3e97" },
            },
          ],
        },
        vector: queryVector,
        limit: limit,
        with_payload: true,
      });

      return result;
    } catch (error) {
      console.error("Error in semantic search:", error);
      throw error;
    }
  }
}

export const qdrantService = new QdrantService();
