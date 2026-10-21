/** Section colors (2026-10-18): every section in the catalog has its own real, non-grey .k-<slug> color, so the
 *  share bar under the home stats and the section chips never show a grey segment (general, needs-a-topic and
 *  commonworld-meta used to be grey). 2026-10-19: 13 muted greyish ones (building-together, infrastructure-tools,
 *  evaluation-benchmarks, law-policy, society-governance, ...) were brightened, and a minimum HSL saturation now keeps
 *  muted greys from coming back. Also 2026-10-19: startups-founders (#c96f4a, dE 4.5 from multi-agent-systems) and
 *  design-experience (#d08a4f, dE 8 from products-applications) got distinct colors, and a pairwise CIE76 dE floor keeps
 *  near-duplicates from coming back. Colors live in mockups/assets/product.css; run npm run gen:assets after a change. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/pages/assets.gen';

const css = ASSETS['product.css'].text ?? '';
const colorOf = (slug: string): string | null => css.match(new RegExp(`\\.k-${slug}\\{background:#([0-9a-f]{6})\\}`))?.[1] ?? null;

/** CIELAB lightness (0..100) and chroma of a hex color (D65). Grey has chroma near 0; the old grey sections were 3..8. */
const lch = (hex: string) => {
  const lin = [0, 2, 4].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; });
  const [r, g, b] = lin;
  const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return { L: 116 * y - 16, C: Math.hypot(500 * (x - y), 200 * (y - z)), a: 500 * (x - y), b: 200 * (y - z) };
};

/** CIE76 color difference: plain Euclidean distance in CIELAB (D65). Around 2.3 is "just noticeable"; under ~10 two
 *  small chips next to each other read as the same color. */
const deltaE76 = (h1: string, h2: string) => { const p = lch(h1), q = lch(h2); return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b); };
/** Floor for every pair of sections. The closest pair left after 2026-10-19 is protocol / education-learning at 9.3,
 *  so 9 is the floor today; raise it when those blues are separated too. Recolored sections must clear MIN_DE_NEW. */
const MIN_DE = 9;
const MIN_DE_NEW = 12;

/** HSL saturation in percent (0..100). The old muted sections were 10..29%; every section is now >= 31%. */
const hslSat = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  return max === min ? 0 : (100 * (max - min)) / (1 - Math.abs(2 * l - 1));
};
const MIN_SAT = 30;

describe('section colors', () => {
  it('every section from the migrations has a .k-<slug> color that is not grey, and no two share one', async () => {
    const slugs = (await env.DB.prepare('SELECT slug FROM sections ORDER BY position').all<{ slug: string }>()).results.map((r) => r.slug);
    expect(slugs.length).toBeGreaterThanOrEqual(35);
    const seen = new Map<string, string>();
    for (const slug of slugs) {
      const hex = colorOf(slug);
      expect(hex, `.k-${slug} missing`).not.toBeNull();
      const { L, C } = lch(hex!);
      expect(C, `.k-${slug} #${hex} is grey`).toBeGreaterThanOrEqual(12);
      expect(hslSat(hex!), `.k-${slug} #${hex} is muted/greyish (HSL saturation under ${MIN_SAT}%)`).toBeGreaterThanOrEqual(MIN_SAT);
      expect(L, `.k-${slug} #${hex} too dark or too light`).toBeGreaterThan(30);
      expect(L, `.k-${slug} #${hex} too dark or too light`).toBeLessThan(80);
      expect(seen.get(hex!), `.k-${slug} reuses the color of ${seen.get(hex!)}`).toBeUndefined();
      seen.set(hex!, slug);
    }
  });

  it('the service and Commonworld sections keep the colors chosen for them', () => {
    expect(colorOf('general')).toBe('6b72c4');
    expect(colorOf('needs-a-topic')).toBe('9aa648');
    expect(colorOf('commonworld-meta')).toBe('b8455a');
    expect(colorOf('commonworld-development')).toBe('4040bf'); // 0021, 2026-10-21
  });

  it('the brightened sections keep their new colors (2026-10-19)', () => {
    expect(colorOf('building-together')).toBe('82be60');
    expect(colorOf('infrastructure-tools')).toBe('668a38');
    expect(colorOf('evaluation-benchmarks')).toBe('2f9389');
    expect(colorOf('law-policy')).toBe('3d5a9e');
    expect(colorOf('society-governance')).toBe('2e7659');
  });

  it('no two sections are near-duplicates: every pair is at least CIE76 dE ' + MIN_DE + ' apart', () => {
    const all = [...css.matchAll(/\.k-([a-z0-9-]+)\{background:#([0-9a-f]{6})\}/g)].map((m) => [m[1], m[2]] as const);
    expect(all.length).toBeGreaterThanOrEqual(35);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const de = deltaE76(all[i][1], all[j][1]);
        expect(de, `.k-${all[i][0]} #${all[i][1]} and .k-${all[j][0]} #${all[j][1]} are near-duplicates (CIE76 dE ${de.toFixed(1)} < ${MIN_DE})`).toBeGreaterThanOrEqual(MIN_DE);
      }
  });

  it('startups-founders and design-experience keep their separated colors, at least dE ' + MIN_DE_NEW + ' from every section (2026-10-19)', () => {
    expect(colorOf('startups-founders')).toBe('a85424');
    expect(colorOf('design-experience')).toBe('e09648');
    const all = [...css.matchAll(/\.k-([a-z0-9-]+)\{background:#([0-9a-f]{6})\}/g)].map((m) => [m[1], m[2]] as const);
    for (const slug of ['startups-founders', 'design-experience']) {
      const hex = colorOf(slug)!;
      for (const [other, ohex] of all) if (other !== slug)
        expect(deltaE76(hex, ohex), `.k-${slug} too close to .k-${other}`).toBeGreaterThanOrEqual(MIN_DE_NEW);
    }
  });
});
