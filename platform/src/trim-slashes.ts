/** `s` without its trailing "/" characters. Same result as `s.replace(/\/+$/, '')`, but a plain loop, so a long run of
 *  slashes in the middle of a string cannot make it slow (the regex backtracks quadratically). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}
