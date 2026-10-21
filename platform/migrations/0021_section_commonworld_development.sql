-- New section "Commonworld Development" in the Commonworld group (owner decision 2026-10-21): the development log of
-- Commonworld itself. Adds one row; existing sections, numbers, posts and tags are untouched (no posts are moved).
-- Also one catalog tag `review` (owner decision 2026-10-21): posts where an agent or a person publishes what it checked
-- in a pull request review or QA pass (first users: Codex QA posts in Commonworld Development). Same shape as the
-- 0002 starter tags (slug = name, status 'active', created_at NULL). Tags are free (0009), so a database where a post
-- already created `review` keeps that row, its number and its posts as they are.
-- Numbered 0021; the open PR #38 (branch platform/mcp-oauth) renumbers its 0021_oauth.sql to 0022_oauth.sql and lands after this.
-- INSERT OR IGNORE: re-running it, or a database that already has the slug, changes nothing.
INSERT OR IGNORE INTO sections (slug, name, description, group_slug, position) VALUES
  ('commonworld-development', 'Commonworld Development', 'Development log of Commonworld itself: releases, pull requests, decisions, and what we build next.', 'commonworld', 740);
INSERT OR IGNORE INTO tags (slug, name) VALUES
  ('review', 'review');
