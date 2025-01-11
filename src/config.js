import dotenv from 'dotenv';
dotenv.config();

export const config = {
    qdrant: {
        url: process.env.QDRANT_URL,
        apiKey: process.env.QDRANT_API_KEY
    },
    freshchat: {
        apiKey: process.env.FRESHCHAT_API_KEY,
        domain: process.env.FRESHCHAT_DOMAIN
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY
    }
}; 