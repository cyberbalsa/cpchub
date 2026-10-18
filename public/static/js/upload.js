(() => {
  const form = document.querySelector('[data-creation-upload]');
  if (!form || !window.fetch || !window.FormData) return;

  const notice = document.createElement('div');
  notice.setAttribute('role', 'alert');
  notice.tabIndex = -1;
  notice.hidden = true;
  form.prepend(notice);
  let submitting = false;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const button = form.querySelector('[type="submit"]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Uploading…';
    form.setAttribute('aria-busy', 'true');
    notice.hidden = true;
    form.querySelectorAll('.errorlist').forEach(list => list.remove());

    try {
      // The hidden input named "action" shadows form.action.
      const response = await fetch(form.getAttribute('action') || window.location.href, {
        method: 'POST',
        body: new FormData(form),
        credentials: 'same-origin',
        headers: {'Accept': 'application/json'},
      });
      if (response.redirected) throw new Error('Unexpected redirect');
      const data = await response.json();
      if (response.ok && data.redirect_url) {
        window.location.assign(data.redirect_url);
        return;
      }
      if (!Array.isArray(data.errors) || !data.errors.length) throw new Error('Unexpected response');
      showErrors(data.errors);
    } catch (error) {
      showErrors(['The upload could not be confirmed. Your details and selected files are still here. Check My uploads before retrying.']);
    } finally {
      submitting = false;
      button.disabled = false;
      button.textContent = label;
      form.removeAttribute('aria-busy');
    }
  });

  function showErrors(errors) {
    const list = document.createElement('ul');
    list.className = 'errorlist';
    errors.forEach(message => {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    });
    notice.replaceChildren(list);
    notice.hidden = false;
    notice.focus();
  }
})();
