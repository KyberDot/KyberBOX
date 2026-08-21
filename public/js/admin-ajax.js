(function () {
  // ---------- Toast notifications ----------
  // Bottom-right confirmation for any <form data-ajax-form> submission,
  // success or failure - works on every page (admin and subscriber alike)
  // since this script loads everywhere. For the rare fallback case where
  // the page does a full navigation instead of an ajax swap, the message
  // is queued in sessionStorage and shown once the new page loads, so a
  // failure still gets confirmed even though the ajax swap itself never
  // got to render it.
  function showToast(message, type) {
    let container = document.getElementById('kbToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'kbToastContainer';
      container.style.cssText = 'position:fixed;bottom:1rem;right:1rem;z-index:100;display:flex;flex-direction:column;gap:0.5rem;align-items:flex-end;pointer-events:none;';
      document.body.appendChild(container);
    }

    const isSuccess = type !== 'error';
    const toast = document.createElement('div');
    toast.className = 'rounded-xl px-4 py-3 text-sm shadow-lg border flex items-center gap-2 ' +
      (isSuccess ? 'bg-emerald-500 border-emerald-400 text-[#0b0f1a]' : 'bg-red-500 border-red-400 text-white');
    toast.style.cssText = 'max-width:320px;pointer-events:auto;opacity:0;transform:translateX(12px);transition:opacity 0.2s,transform 0.2s;';
    toast.innerHTML = '<i class="fas ' + (isSuccess ? 'fa-circle-check' : 'fa-triangle-exclamation') + '"></i><span>' + message + '</span>';
    container.appendChild(toast);

    requestAnimationFrame(function () {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });

    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(12px)';
      setTimeout(function () { toast.remove(); }, 250);
    }, 3200);
  }
  window.showToast = showToast;

  // A toast queued (by the fallback-navigation path below) before this
  // page loaded - show it once, then clear it so it doesn't repeat.
  const queuedToast = sessionStorage.getItem('kb_toast');
  if (queuedToast) {
    sessionStorage.removeItem('kb_toast');
    try {
      const parsed = JSON.parse(queuedToast);
      showToast(parsed.message, parsed.type);
    } catch (_) { /* ignore a malformed/stale queued value */ }
  }

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
      if (el.hasAttribute('data-no-preserve')) return; // this one should close after a save, not stay open
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
        // The toast itself can't show before that navigation happens, so
        // it's queued and picked up once the new page has loaded instead.
        sessionStorage.setItem('kb_toast', JSON.stringify({ message: 'Something went wrong - please check and try again.', type: 'error' }));
        form.removeAttribute('data-ajax-form');
        form.submit();
        return;
      }

      currentMain.innerHTML = newMain.innerHTML;
      if (doc.title) document.title = doc.title;
      restoreOpenState(state);
      window.scrollTo(0, scrollY);
      document.dispatchEvent(new CustomEvent('main:updated'));

      const errorFlag = currentMain.querySelector('#ajaxErrorFlag');
      if (errorFlag) {
        showToast(errorFlag.getAttribute('data-message') || 'Something went wrong - please check and try again.', 'error');
        errorFlag.remove();
      } else {
        showToast('Changes saved', 'success');
      }
    } catch (err) {
      console.error('Ajax form submit failed, falling back to normal navigation', err);
      sessionStorage.setItem('kb_toast', JSON.stringify({ message: 'Something went wrong - please check and try again.', type: 'error' }));
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

  // ---------- Site-wide "a reset is in progress" banner ----------
  // Lives in partials/nav.ejs, present on every logged-in page. Server-side
  // render gets the initial state right; this keeps it accurate afterwards
  // without needing a page reload (e.g. it appearing because someone else
  // just started one, or disappearing the moment it finishes).
  function pollResetBanner() {
    fetch('/system/reset-status')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        const banner = document.getElementById('resetBanner');
        const text = document.getElementById('resetBannerText');
        if (!banner) return;
        if (data.active) {
          if (text) {
            let timeRange;
            if (data.withUpdate === false) timeRange = 'within 4–8 minutes';
            else if (data.withUpdate === true) timeRange = 'within 5–15 minutes';
            else timeRange = 'shortly'; // not the admin Full Reset feature at all - no fixed time range applies
            text.textContent = (data.source || 'A server reset') + ' is currently in progress — service may be briefly interrupted. Expected to resume ' + timeRange + '.';
          }
          banner.classList.remove('hidden');
        } else {
          banner.classList.add('hidden');
        }
      })
      .catch(function () { /* transient network hiccup - try again next tick */ });
  }
  pollResetBanner();
  setInterval(pollResetBanner, 15000);
})();
