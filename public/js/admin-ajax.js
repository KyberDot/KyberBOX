(function () {
  // ---------- Modals ----------
  window.openModal = function (id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('hidden');
    m.classList.add('flex');
  };
  window.closeModal = function (id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.add('hidden');
    m.classList.remove('flex');
  };

  // ---------- Preserve open <details>/panels across an in-place swap ----------
  function collectOpenState() {
    const state = { details: [], panels: [] };
    document.querySelectorAll('main details[data-ajax-key]').forEach(function (d) {
      if (d.open) state.details.push(d.getAttribute('data-ajax-key'));
    });
    document.querySelectorAll('main [data-toggle-key]').forEach(function (el) {
      if (!el.classList.contains('hidden')) state.panels.push(el.getAttribute('data-toggle-key'));
    });
    return state;
  }

  function restoreOpenState(state) {
    state.details.forEach(function (key) {
      const el = document.querySelector('main details[data-ajax-key="' + key + '"]');
      if (el) el.open = true;
    });
    state.panels.forEach(function (key) {
      const el = document.querySelector('main [data-toggle-key="' + key + '"]');
      if (el) el.classList.remove('hidden');
    });
  }

  // ---------- Ajax form submission ----------
  // Any <form data-ajax-form> submits via fetch and swaps just <main> with
  // the server's response instead of doing a full page navigation, so the
  // person stays exactly where they were (scroll position, open sections).
  // Falls back to a normal form submission if anything looks off, so error
  // pages / edge cases still work correctly.
  async function submitFormViaAjax(form) {
    const scrollY = window.scrollY;
    const state = collectOpenState();
    const submitBtn = form.querySelector('[type="submit"]');
    const originalBtnHtml = submitBtn ? submitBtn.innerHTML : null;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
      const formData = new FormData(form);
      let body;
      const headers = {};

      // FormData sent directly always forces multipart/form-data, which
      // routes without file uploads can't parse (they only understand
      // application/x-www-form-urlencoded) - that silently left req.body
      // empty and let "successful" saves write blank/default values.
      // Only forms that actually declare enctype="multipart/form-data"
      // (i.e. ones with a file input, handled by multer server-side)
      // should be sent as multipart; everything else goes urlencoded,
      // matching what a normal <form> submission would have sent.
      if (form.enctype === 'multipart/form-data') {
        body = formData;
      } else {
        body = new URLSearchParams(formData);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const res = await fetch(form.action, { method: 'POST', body, headers });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const newMain = doc.querySelector('main');
      const currentMain = document.querySelector('main');

      if (!res.ok || !newMain || !currentMain) {
        // Something unexpected (validation error page, network issue, etc.)
        // - do a real navigation so the person sees the actual result.
        form.removeAttribute('data-ajax-form');
        form.submit();
        return;
      }

      currentMain.innerHTML = newMain.innerHTML;
      if (doc.title) document.title = doc.title;
      restoreOpenState(state);
      window.scrollTo(0, scrollY);
      document.dispatchEvent(new CustomEvent('main:updated'));
    } catch (err) {
      console.error('Ajax form submit failed, falling back to normal navigation', err);
      form.removeAttribute('data-ajax-form');
      form.submit();
    } finally {
      if (submitBtn && originalBtnHtml !== null) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
      }
    }
  }

  document.addEventListener('submit', function (e) {
    const form = e.target.closest('[data-ajax-form]');
    if (!form) return;

    const confirmMsg = form.getAttribute('data-confirm');
    if (confirmMsg && !confirm(confirmMsg)) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    submitFormViaAjax(form);
  });

  // ---------- Generic toggle helper (works after swaps, no re-binding needed) ----------
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-toggle-target]');
    if (!btn) return;
    const target = document.querySelector('[data-toggle-key="' + btn.getAttribute('data-toggle-target') + '"]');
    if (target) target.classList.toggle('hidden');
  });
})();
