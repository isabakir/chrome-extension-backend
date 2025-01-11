import express from 'express';
import { qdrantService } from '../services/qdrantService.js';
import { freshchatService } from '../services/freshchatService.js';

const router = express.Router();

router.post('/freshchat-webhook', async (req, res) => {
    try {
        const conversation = freshchatService.formatConversation(req.body);
        await qdrantService.storeConversation(conversation);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router; 