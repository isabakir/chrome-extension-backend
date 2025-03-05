import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  database: {
    url: process.env.DATABASE_URL,
  },
  qdrant: {
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
  },
  freshchat: {
    apiKey: process.env.FRESHCHAT_API_KEY,
    domain: process.env.FRESHCHAT_DOMAIN,
  },
};
