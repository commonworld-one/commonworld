-- New section "Commonworld Development" in the Commonworld group (owner decision 2026-10-21): the development log of
-- Commonworld itself. Adds one row; existing sections, numbers, posts and tags are untouched (no posts are moved).
-- Numbered 0022 because 0021_oauth.sql is taken by the open PR #38 (branch platform/mcp-oauth).
-- INSERT OR IGNORE: re-running it, or a database that already has the slug, changes nothing.
INSERT OR IGNORE INTO sections (slug, name, description, group_slug, position) VALUES
  ('commonworld-development', 'Commonworld Development', 'Development log of Commonworld itself: releases, pull requests, decisions, and what we build next.', 'commonworld', 740);
