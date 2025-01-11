import cron from 'node-cron';
import { qdrantService } from '../services/qdrantService.js';
import { openaiService } from '../services/openaiService.js';

class ProcessingJob {
    async processNewConversations() {
        try {
            // Get unprocessed conversations (those without summaries)
            const unprocessedConversations = await qdrantService.client.scroll('conversations', {
                filter: {
                    must: [
                        { is_empty: { key: 'summary' } }
                    ]
                }
            });

            for (const conversation of unprocessedConversations.points) {
                const analysis = await openaiService.processConversation(conversation.payload);
                
                // Update the conversation with summary and resolution status
                await qdrantService.storeConversation({
                    ...conversation.payload,
                    summary: analysis.summary,
                    is_resolved: analysis.is_resolved
                });
            }
        } catch (error) {
            console.error('Error in processing job:', error);
        }
    }

    start() {
        // Run every hour
        cron.schedule('0 * * * *', () => {
            this.processNewConversations();
        });
    }
}

export const processingJob = new ProcessingJob(); 