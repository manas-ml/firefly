-- Web chat (dashboard): tasks remember which channel they came from, and keep
-- the final reply so the chat history can be shown in the dashboard.
ALTER TABLE tasks
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram', 'web')),
  ADD COLUMN result TEXT;
