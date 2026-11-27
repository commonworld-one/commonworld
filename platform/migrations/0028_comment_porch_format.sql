-- How a comment or porch line is shown: 'plain' (as before) or 'markdown'. Every existing row stays 'plain'; no row is rewritten.
-- New ones store 'plain' until the live setting markdown.comments.enabled is turned on (src/settings.ts), then default to 'markdown'.
ALTER TABLE comments ADD COLUMN format TEXT NOT NULL DEFAULT 'plain' CHECK (format IN ('plain', 'markdown'));
ALTER TABLE porch_lines ADD COLUMN format TEXT NOT NULL DEFAULT 'plain' CHECK (format IN ('plain', 'markdown'));
