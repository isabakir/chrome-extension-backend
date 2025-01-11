import OpenAI from 'openai';
import { config } from '../config.js';

class OpenAIService {
    constructor() {
        this.client = new OpenAI({
            apiKey: config.openai.apiKey
        });
    }

    async processConversation(conversation) {
        try {
            const response = await this.client.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    {
                        role: 'system',
                        content: 'Analyze the following customer service conversation and provide: 1) A brief summary 2) Whether the issue was resolved (true/false)'
                    },
                    {
                        role: 'user',
                        content: JSON.stringify(conversation.content)
                    }
                ]
            });

            const analysis = JSON.parse(response.choices[0].message.content);
            return {
                summary: analysis.summary,
                is_resolved: analysis.is_resolved
            };
        } catch (error) {
            console.error('Error processing conversation with OpenAI:', error);
            throw error;
        }
    }
}

export const openaiService = new OpenAIService(); 