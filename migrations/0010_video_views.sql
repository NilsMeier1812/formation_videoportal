-- Aufrufe je Video (insgesamt, nicht pro Tag): +1, wenn jemand das Video im Player abspielt.
-- Sehen dürfen die Zahl nur Trainer (siehe publicVideo in src/routes/videos.js).
ALTER TABLE video ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
