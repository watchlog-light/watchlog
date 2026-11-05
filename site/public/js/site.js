// SPDX-License-Identifier: AGPL-3.0-only
// The site's only script: the install panel's copy button. Everything else is HTML and
// CSS; without this script the button stays hidden.
document.querySelectorAll('[data-copy]').forEach((button) => {
  const term = button.closest('.term');
  if (!term || !navigator.clipboard) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    const tab = term.querySelector('input[name="install"]:checked');
    const pre = term.querySelector(`pre[data-cmd="${tab ? tab.value : 'helm'}"]`);
    if (!pre) return;
    // Comment lines are for reading; the copied text is only the commands.
    const text = pre.textContent
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1600);
  });
});

// The Cloud waitlist form: posts JSON to /api/waitlist and says what happened. Without
// this script the browser posts the form itself and the service answers with a page.
document.querySelectorAll('form[data-waitlist]').forEach((form) => {
  const note = document.getElementById(form.getAttribute('aria-describedby'));
  const button = form.querySelector('button[type="submit"]');
  const params = new URLSearchParams(location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    if (params.get(key)) form.elements[key].value = params.get(key);
  }
  if (document.referrer && !document.referrer.startsWith(location.origin)) {
    form.elements.referrer.value = document.referrer;
  }
  const show = (text, kind) => {
    note.textContent = text;
    note.className = `wait-note ${kind}`;
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = 'Join the waitlist';
    button.disabled = true;
    button.textContent = 'Sending…';
    show('Sending…', '');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (res.ok) {
        form.hidden = true;
        show('Check your inbox: we sent a link to confirm your address.', 'ok');
        return;
      }
      const error = (await res.json().catch(() => ({}))).error;
      show(
        error === 'invalid_email'
          ? "That address doesn't look right. Check it and try again."
          : error === 'rate_limited'
            ? 'Too many tries from here. Wait a few minutes, then try again.'
            : 'Something went wrong. Please try again.',
        'error',
      );
    } catch {
      show("Couldn't reach the server. Check your connection and try again.", 'error');
    }
    button.disabled = false;
    button.textContent = label;
  });
});
