import type { Env } from '../env';
import type { WorkRadarDocument, WorkRadarItem } from './work-radar';

interface WorkRadarRow {
  number: number;
  title: string;
  body: string;
  created_at: string;
  tags: string | null;
}

const WORK_TAGS = ['work', 'review', 'plan', 'roadmap'] as const;

function stateFromTags(tags: Set<string>): WorkRadarItem['state'] {
  if (tags.has('review')) return 'review';
  return 'open';
}

function summarize(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return 'Open public work in Commonworld Development.';
  return plain.length > 280 ? `${plain.slice(0, 277)}…` : plain;
}

/**
 * Build Work Radar from the existing public post catalog rather than a new
 * database table. The module is based on Commonworld posts 19, 31, and 38.
 */
export async function loadWorkRadar(env: Env): Promise<WorkRadarDocument> {
  const placeholders = WORK_TAGS.map(() => '?').join(', ');
  const statement = env.DB.prepare(`
    SELECT
      p.number,
      p.title,
      p.body,
      p.created_at,
      GROUP_CONCAT(pt.tag_slug) AS tags
    FROM posts p
    LEFT JOIN post_tags pt ON pt.post_number = p.number
    WHERE p.status = 'visible'
      AND p.withdrawn_at IS NULL
      AND p.section_slug = 'commonworld-development'
      AND EXISTS (
        SELECT 1
        FROM post_tags wanted
        WHERE wanted.post_number = p.number
          AND wanted.tag_slug IN (${placeholders})
      )
    GROUP BY p.number, p.title, p.body, p.created_at
    ORDER BY p.number DESC
    LIMIT 100
  `).bind(...WORK_TAGS);

  const { results } = await statement.all<WorkRadarRow>();
  const items: WorkRadarItem[] = results.map((row) => {
    const tags = new Set((row.tags ?? '').split(',').filter(Boolean));
    const state = stateFromTags(tags);
    const url = `https://commonworld.one/posts/${row.number}`;
    return {
      id: `post-${row.number}`,
      title: row.title,
      summary: summarize(row.body),
      url,
      state,
      updatedAt: row.created_at,
      evidenceUrl: state === 'review' ? url : null,
    };
  });

  return {
    title: 'Work Radar',
    description: 'Public Commonworld work that can be discovered, reviewed, and evidenced. Built on posts 19, 31, and 38.',
    generatedAt: new Date().toISOString(),
    items,
  };
}
