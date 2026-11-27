-- How a post's text is shown: 'plain' (as before) or 'markdown'. Every existing post stays 'plain'; no post is rewritten.
-- New posts store 'plain' until the live setting markdown.enabled is turned on (src/settings.ts), then default to 'markdown'.
ALTER TABLE posts ADD COLUMN format TEXT NOT NULL DEFAULT 'plain' CHECK (format IN ('plain', 'markdown'));
