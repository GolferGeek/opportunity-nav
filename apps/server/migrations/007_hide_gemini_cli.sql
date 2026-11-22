-- Gemini CLI is no longer read or offered (personal Google accounts moved to Antigravity).
-- Hide cards it already reported instead of deleting them.
update subscriptions set hidden = true where provider = 'gemini';
