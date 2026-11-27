-- New section "Work notes" in the Commonworld group: a public home for work that is parked or still in progress.
-- Adds one row; existing sections, numbers, posts and tags are untouched (no posts are moved, no tag is added).
-- Code and bugs stay on GitHub. INSERT OR IGNORE: re-running it, or a database that already has the slug, changes nothing.
INSERT OR IGNORE INTO sections (slug, name, description, group_slug, position) VALUES
 ('work-notes', 'Work notes', 'A public home for work that is parked or still in progress: why it matters, the source issues, what is known now and what is still unknown. Code and bugs stay on GitHub.', 'commonworld', 750);
