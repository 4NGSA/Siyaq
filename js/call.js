(function initSiyaqCall() {
  const WS_URL = 'wss://siyaq-thhr.onrender.com/ws/browser';

  let ws             = null;
  let reconnectTimer = null;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  function panel()       { return document.getElementById('call-panel'); }
  function statusDot()   { return document.getElementById('cp-dot'); }
  function statusTxt()   { return document.getElementById('cp-status'); }
  function customerBox() { return document.getElementById('cp-customer'); }
  function callerId()    { return document.getElementById('cp-caller-id'); }

  // ── WebSocket ────────────────────────────────────────────────────────────────
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => setStatus('متصل', 'idle'));
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener('close', () => {
      setStatus('جارٍ إعادة الاتصال…', 'idle');
      reconnectTimer = setTimeout(connect, 5000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  // ── Message handler ──────────────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {

      case 'call_started':
        showPanel();
        setStatus('مكالمة نشطة', 'active');
        if (callerId()) callerId().textContent = msg.from || '';
        clearCustomer();
        break;

      case 'customer_detected':
        showCustomer(msg.customer);
        if (window._siyaqOpenReport && msg.customer?.id) {
          window._siyaqOpenReport(String(msg.customer.id));
        }
        break;

      case 'new_caller':
        prefillForm({ phone: msg.phone });
        if (window._siyaqGoPage) window._siyaqGoPage('add');
        break;

      case 'national_id_not_found':
        prefillForm({ national_id: msg.national_id });
        break;

      // ── Progressive form fill during the call ───────────────────────────────
      case 'form_update':
        applyFormUpdate(msg);
        break;

      case 'call_ended':
        setStatus('انتهت المكالمة', 'ended');
        setTimeout(hidePanel, 8000);
        break;

      default:
        break;
    }
  }

  // ── Form helpers ─────────────────────────────────────────────────────────────
  function prefillForm({ phone, national_id, name, summary, status } = {}) {
    if (name) {
      const el = document.getElementById('f-name');
      if (el && !el.value) el.value = name;
    }
    if (phone) {
      const el = document.getElementById('f-phone');
      if (el) el.value = phone;
    }
    if (national_id) {
      const el = document.getElementById('f-national-id');
      if (el && !el.value) el.value = national_id;
    }
    if (summary) {
      const el = document.getElementById('f-summary');
      if (el) el.value = summary;
    }
    if (status && window._siyaqSetStatus) {
      window._siyaqSetStatus(status);
    }
  }

  function applyFormUpdate(msg) {
    // Make sure we're on the add page
    if (window._siyaqGoPage) window._siyaqGoPage('add');

    prefillForm({
      name       : msg.name,
      summary    : msg.summary,
      status     : msg.status,
      national_id: msg.national_id,
    });

    // Flash the summary field to show it updated
    const summaryEl = document.getElementById('f-summary');
    if (summaryEl && msg.summary) {
      summaryEl.style.borderColor = '#2DD4A0';
      setTimeout(() => { summaryEl.style.borderColor = ''; }, 1000);
    }
  }

  // ── Panel UI helpers ─────────────────────────────────────────────────────────
  function showPanel() { panel()?.classList.add('cp-visible'); }

  function hidePanel() {
    panel()?.classList.remove('cp-visible');
    clearCustomer();
    if (callerId()) callerId().textContent = '';
  }

  function setStatus(text, state) {
    const dot = statusDot();
    const txt = statusTxt();
    if (txt) txt.textContent = text;
    if (dot) {
      dot.className = 'cp-dot';
      if (state) dot.classList.add(`cp-dot-${state}`);
    }
  }

  function clearCustomer() {
    const box = customerBox();
    if (box) { box.classList.remove('cp-cust-visible'); box.innerHTML = ''; }
  }

  function showCustomer(customer) {
    const box = customerBox();
    if (!box || !customer) return;
    box.innerHTML = `
      <div class="cp-cust-inner">
        <div class="cp-cust-av">${avatarInitials(customer.name)}</div>
        <div>
          <div class="cp-cust-name">${escHtml(customer.name)}</div>
          <div class="cp-cust-phone">${escHtml(customer.phone || '')}</div>
        </div>
        <div class="cp-cust-badge">تم التعرف عليه</div>
      </div>`;
    box.classList.add('cp-cust-visible');
  }

  function avatarInitials(name) {
    if (!name) return '؟';
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  }

  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g,
      (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  // ── Close button ─────────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (e.target.closest('#cp-close')) hidePanel();
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  connect();

}());
