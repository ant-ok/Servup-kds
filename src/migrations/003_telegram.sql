-- Telegram alerts: the venue links its chat by sending a one-time code to the bot.
ALTER TABLE accounts
  ADD COLUMN telegram_chat_id   text,
  ADD COLUMN telegram_link_code text,
  ADD COLUMN telegram_link_exp  timestamptz;
