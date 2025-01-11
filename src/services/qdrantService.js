import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

class QdrantService {
    constructor() {
        this.client = new QdrantClient({
            url: config.qdrant.url,
            apiKey: config.qdrant.apiKey
        });
    }

    async initializeCollection() {
        try {
            // First check if collection exists
            const collections = await this.client.getCollections();
            const collectionExists = collections.collections.some(
                collection => collection.name === 'conversations'
            );

            if (!collectionExists) {
                await this.client.createCollection('conversations', {
                    vectors: {
                        size: 1536, // OpenAI embedding dimension
                        distance: 'Cosine'
                    }
                });
                console.log('Collection "conversations" created successfully');
            } else {
                console.log('Collection "conversations" already exists');
            }
        } catch (error) {
            console.error('Error initializing collection:', error);
            throw error;
        }
    }

    async storeConversation(conversation) {
        try {
            // Check if conversation already exists
            const existing = await this.client.scroll('conversations', {
                filter: {
                    must: [
                        { key: 'id', match: { value: conversation.id } }
                    ]
                },
                limit: 1
            });

            if (existing.points && existing.points.length > 0) {
                console.log(`Conversation ${conversation.id} already exists, skipping...`);
                return;
            }

            const payload = {
                id: conversation.id,
                conversation: this.simplifyConversation(conversation.content),
                user_id: conversation.user_id || null,
                assigned_agent_id: conversation.assigned_agent_id,
                summary: conversation.summary || '',
                is_resolved: conversation.is_resolved || false,
                created_at: new Date().toISOString()
            };

            await this.client.upsert('conversations', {
                wait: true,
                points: [{
                    id: conversation.id,
                    payload,
                    vector: new Array(1536).fill(0)
                }]
            });
            console.log(`Conversation ${conversation.id} stored successfully`);
        } catch (error) {
            console.error('Error storing conversation:', error);
            throw error;
        }
    }

    // Helper method to simplify conversation JSON
    simplifyConversation(messages) {
        return messages.map(msg => ({
            message_id: msg.id,
            message_type: msg.message_type,
            text: msg.message_parts?.[0]?.text || msg.text || '',
            actor_type: msg.actor_type,
            actor_id: msg.actor_id,
            timestamp: msg.created_time
        }));
    }
}

export const qdrantService = new QdrantService(); 