CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(255) PRIMARY KEY,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  conversation_id VARCHAR(255),
  user_id VARCHAR(255),
  user_name VARCHAR(255),
  user_email VARCHAR(255),
  state_of_emotion VARCHAR(50),
  user_tone VARCHAR(50),
  priority_level VARCHAR(50),
  emoji_suggestion VARCHAR(10),
  url TEXT,
  created_at_local TIMESTAMP DEFAULT CURRENT_TIMESTAMP
); 