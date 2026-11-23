/** Single pass over header blocks and CSP tokens. No backtracking search. */
export function hasAtlasCsp(headers) {
  let inAtlas = false;
  for (const line of headers.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line[0] !== ' ' && line[0] !== '\t') {
      inAtlas = line.trim() === '/*';
      continue;
    }
    if (!inAtlas) continue;
    const header = line.trim();
    const colon = header.indexOf(':');
    if (colon < 0 || header.slice(0, colon).toLowerCase() !== 'content-security-policy') continue;
    for (const directive of header.slice(colon + 1).split(';')) {
      const tokens = directive.trim().split(/\s+/);
      if (tokens[0] === 'script-src' && tokens[1] === "'self'") return true;
    }
  }
  return false;
}
