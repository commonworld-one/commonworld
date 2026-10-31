import { HANDOFF_FIELDS, HANDOFF_MAX_BYTES, handoffTemplate, parseHandoff, handoffMarkdown } from '../src/handoff';

const form = document.querySelector<HTMLFormElement>('#handoff-form');
if (form) {
  const message = document.querySelector<HTMLElement>('#handoff-message')!;
  const imported = document.querySelector<HTMLInputElement>('#handoff-import')!;
  const say = (text: string) => { message.textContent = text; };
  const read = () => {
    const value = handoffTemplate();
    for (const [key] of HANDOFF_FIELDS) value[key] = (form.elements.namedItem(key) as HTMLTextAreaElement).value;
    return parseHandoff(JSON.stringify(value));
  };
  const download = (text: string, extension: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = `commonworld-handoff.${extension}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-handoff-export]')) {
    button.addEventListener('click', () => {
      try {
        const value = read();
        const markdown = button.dataset.handoffExport === 'md';
        download(markdown ? handoffMarkdown(value) : JSON.stringify(value, null, 2), markdown ? 'md' : 'json', markdown ? 'text/markdown;charset=utf-8' : 'application/json');
        say('Download prepared locally. Review its contents before sharing.');
      } catch (error) { say(error instanceof Error ? error.message : 'Cannot export checkpoint.'); }
    });
  }
  imported.addEventListener('change', async () => {
    const file = imported.files?.[0]; if (!file) return;
    try {
      if (file.size > HANDOFF_MAX_BYTES) throw new Error('Checkpoint exceeds 64 KiB.');
      const value = parseHandoff(await file.text());
      // Validate the entire object before replacing any current input.
      for (const [key] of HANDOFF_FIELDS) (form.elements.namedItem(key) as HTMLTextAreaElement).value = value[key];
      say('Checkpoint imported locally. Reconcile uncertain operations before continuing.');
    } catch (error) { say(error instanceof Error ? error.message : 'Cannot import checkpoint.'); }
    finally { imported.value = ''; }
  });
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('reset', () => { imported.value = ''; say('Checkpoint cleared. Downloaded files are unchanged.'); });
  // Inputs start disabled so a missing script cannot submit private text to a server.
  form.querySelectorAll<HTMLFieldSetElement>('fieldset').forEach(fieldset => { fieldset.disabled = false; });
  say('Ready. Input stays in this tab; download before closing or reloading.');
}
