(function initSiyaqCall() {
  const WS_URL = 'wss://siyaq-thhr.onrender.com/ws/browser';
  let ws            = null;
  let reconnectTimer = null;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  function panel()       { return document.getElementById('call-panel'); }
  function statusDot()   { return document.getElementById('cp-dot'); }
  function statusTxt()   { return document.getElementById('cp-status'); }
  function transcript()  { return document.getElementById('cp-transcript'); }
  function customerBox() { return document.getElementById('cp-customer'); }
  function callerId()    { return document.getElementById('cp-caller-id'); }

  // ── WebSocket ────────────────────────────────────────────────────────────────
  function connect() {
    if (ws && ws.readyState <= 1) return;

    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      setStatus('متصل', 'idle');
    });

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

      // ── Call just came in ───────────────────────────────────────────────────
      case 'call_started':
        showPanel();
        setStatus('مكالمة نشطة', 'active');
        if (callerId()) callerId().textContent = msg.from || '';
        clearTranscript();
        clearCustomer();
        break;

      // ── Known customer identified by caller ID ──────────────────────────────
      case 'customer_detected':
        showCustomer(msg.customer);
        // Auto-open customer report panel
        if (window._siyaqOpenReport && msg.customer?.id) {
          window._siyaqOpenReport(String(msg.customer.id));
        }
        break;

      // ── Unknown number — open "إضافة للقاعدة" with phone pre-filled ─────────
      case 'new_caller':
        prefillAddForm({ phone: msg.phone });
        goAddPage();
        break;

      // ── National ID spoken and found in DB ─────────────────────────────────
      // (customer_detected is reused for this case too)

      // ── National ID spoken but NOT in DB — pre-fill form with it ───────────
      case 'national_id_not_found':
        prefillAddForm({ national_id: msg.national_id });
        // Already on add page (new_caller sent earlier), just fill the field
        break;

      // ── Live transcript line ────────────────────────────────────────────────
      case 'transcript':
        appendTranscript(msg.text);
        break;

      // ── Call finished ───────────────────────────────────────────────────────
      case 'call_ended':
        setStatus('انتهت المكالمة', 'ended');
        appendTranscript('── انتهت المكالمة ──');
        setTimeout(hidePanel, 8000);
        break;

      default:
        break;
    }
  }

  // ── Form helpers ─────────────────────────────────────────────────────────────
  function prefillAddForm({ phone, national_id } = {}) {
    if (phone) {
      const phoneInput = document.getElementById('f-phone');
      if (phoneInput) phoneInput.value = phone;
    }
    if (national_id) {
      const idInput = document.getElementById('f-national-id');
      if (idInput) idInput.value = national_id;
    }
  }

  function goAddPage() {
    // Reuse app.js navigation — it exposes goPage globally after bootstrap
    if (window._siyaqGoPage) {
      window._siyaqGoPage('add');
    }
  }

  // ── Panel UI helpers ─────────────────────────────────────────────────────────
  function showPanel() {
    panel()?.classList.add('cp-visible');
  }

  function hidePanel() {
    panel()?.classList.remove('cp-visible');
    clearTranscript();
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

  function clearTranscript() {
    const t = transcript();
    if (t) t.innerHTML = '';
  }

  function appendTranscript(text) {
    const t = transcript();
    if (!t) return;
    const line = document.createElement('p');
    line.className = 'cp-line';
    line.textContent = text;
    t.appendChild(line);
    t.scrollTop = t.scrollHeight;
  }

  function clearCustomer() {
    const box = customerBox();
    if (box) {
      box.classList.remove('cp-cust-visible');
      box.innerHTML = '';
    }
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
