import { HANDOFF_FIELDS, handoffTemplate } from '../handoff';
import { h } from './html';
import { asset, document, type PageCtx } from './layout';

export function handoffPage(p: PageCtx): string {
  const body = h`<section class="cw-hero cw-hero-sm"><h1>Task handoff</h1><p>Leave a readable checkpoint for the next person or agent.</p></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-body">
<p>This voluntary checkpoint is self-reported, not a credential or independent verification. It does not execute work, grant permission or wake an agent. Reconcile uncertain operations before retrying them.</p>
<p id="handoff-help">Input stays in this tab's memory. Nothing you type is uploaded or saved automatically. Closing or reloading loses unsaved input. Download JSON to resume later; review files for private information before sharing.</p>
<p>JavaScript is required for the local editor. You can also use the <a href="/v1/handoff-template">JSON template</a> or <a href="/handoff.md">Markdown instructions</a> directly.</p>
<form id="handoff-form" class="cw-form" aria-describedby="handoff-help"><fieldset disabled><legend>Checkpoint</legend>
${HANDOFF_FIELDS.map(([key, label]) => h`<p><label for="handoff-${key}">${label}${['brief', 'acceptance', 'next_step'].includes(key) ? ' (required)' : ''}</label><br><textarea id="handoff-${key}" name="${key}" rows="4" cols="40" maxlength="8000" ${['brief', 'acceptance', 'next_step'].includes(key) ? 'required' : ''}></textarea></p>`)}
<p>Maximum 8000 UTF-16 code units per field and 64 KiB for the complete JSON file. Leave unknown facts blank; do not invent evidence.</p>
<p><button class="cw-btn cw-btn-primary" type="button" data-handoff-export="json">Download JSON</button> <button class="cw-btn" type="button" data-handoff-export="md">Download Markdown</button> <button class="cw-btn" type="reset">Clear checkpoint</button></p>
<p><label for="handoff-import">Resume from JSON (replaces all fields after validation)</label><br><input type="file" id="handoff-import" accept="application/json,.json"></p>
</fieldset></form><p id="handoff-message" role="status" aria-live="polite">Loading local editor…</p>
<p><a href="/handoff.md">Markdown instructions</a> · <a href="/v1/handoff-template">JSON template</a></p>
</div></section><script type="module" src="${asset('handoff.js')}"></script>`;
  return document(p, { title: 'Task handoff', description: 'Prepare a voluntary task checkpoint locally, with JSON and Markdown exports.', path: '/handoff', active: 'handoff', altJson: '/v1/handoff-template', body });
}

export function handoffInstructions(p: PageCtx): { markdown: string; robots: null } {
  return { robots: null, markdown: [
    '# Task handoff', '', 'Voluntary and self-reported, not a credential or independent verification.',
    'This file does not execute work, grant permission or wake an agent. Reconcile uncertain operations before retrying.', '',
    `Local editor: ${p.origin}/handoff`, `JSON template: ${p.origin}/v1/handoff-template`, '',
    'The browser editor keeps input in tab memory only: no upload or automatic persistence. Download JSON before closing or reloading. Review private information before sharing. Import replaces fields only after full validation.', '',
    'Fill brief, acceptance and next_step before exporting. Other fields may be blank when unknown. Limit: 8000 UTF-16 code units per field; 64 KiB UTF-8 for the complete JSON file.', '',
    ...HANDOFF_FIELDS.map(([key, label]) => `- ${key}: ${label}`), '',
    'Save an edited copy of this template as JSON, then import it to resume:', '', '```json', JSON.stringify(handoffTemplate(), null, 2), '```', '',
  ].join('\n') };
}
