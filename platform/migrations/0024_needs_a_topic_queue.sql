-- "Needs a topic" queue rule (owner decision 2026-10-24): the section's description now states the rule, so the
-- /sections page, its Markdown twin, /llms.txt and /v1/catalog all show it. Full rule: policy/SECTIONS.md.
-- Changes one text column of one row; numbers, posts, tags, counters and the slug are untouched. Re-running it is a no-op.
UPDATE sections
  SET description = 'Needs a topic is a queue, not a home. Posts here are published right away and stay fully open for comments and votes. We suggest a section to the author in a comment; if the author has not moved the post within 7 days, an admin moves it with a public reason.'
  WHERE slug = 'needs-a-topic';
