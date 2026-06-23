(function initSiyaqCall() {
  const WS_URL = 'wss://siyaq-thhr.onrender.com/ws/browser';

  // Keywords that trigger escalation alert — extend as needed
  const ESCALATION_KEYWORDS = [
    'موظف', 'بشر', 'إنسان', 'مسؤول', 'مدير',
    'أتكلم مع', 'أكلم', 'تحويل', 'حول', 'ما أبي',
    'مو راضي', 'زهقت', 'تعبت', 'أشتكي', 'شكوى'
  ];

  let ws             = null;
  let reconnectTimer = null;
  let activeCallSid  = null;
  let partialLineEl  = null;   // the current in-progress transcript line element

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  function panel()          { return document.getElementById('call-panel'); }
  function statusDot()      { return document.getElementById('cp-dot'); }
  function statusTxt()      { return document.getElementById('cp-status'); }
  function customerBox()    { return document.getElementById('cp-customer'); }
  function callerId()       { return document.getElementById('cp-caller-id'); }
  function transcriptEl()   { return document.getElementById('cp-transcript'); }
  function emptyState()     { return document.getElementById('cp-transcript-empty'); }
  function escBanner()      { return document.getElementById('cp-esc-banner'); }
  function escalateBtn()    { return document.getElementById('cp-escalate-btn'); }

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      setStatus('متصل', 'idle');
      clearTimeout(reconnectTimer);
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      setStatus('جارٍ إعادة الاتصال…', 'idle');
      reconnectTimer = setTimeout(connect, 3000);
    });

    ws.addEventListener('error', () => ws.close());
  }

  // ── Message handler ───────────────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {

      case 'call_started':
        activeCallSid = msg.call_sid || null;
        showPanel();
        setStatus('مكالمة نشطة', 'active');
        if (callerId()) callerId().textContent = msg.from || '';
        clearCustomer();
        clearTranscript();
        break;

      case 'customer_detected':
        showCustomer(msg.customer);
        if (window._siyaqOpenReport && msg.customer?.id) {
          window._siyaqOpenReport(String(msg.customer.id));
        }
        panel()?.classList.add('cp-report-open');
        break;

      case 'new_caller':
        prefillForm({ phone: msg.phone });
        if (window._siyaqGoPage) window._siyaqGoPage('add');
        break;

      case 'national_id_not_found':
        prefillForm({ national_id: msg.national_id });
        break;

      case 'form_update':
        applyFormUpdate(msg);
        break;

      // ── Live transcript from Twilio/Deepgram ─────────────────────────────
      // Partial result: word-by-word while customer is still speaking
      case 'transcript_partial':
        appendPartial(msg.text || '');
        break;

      // Final result: customer finished the utterance
      case 'transcript_final':
        commitFinal(msg.text || '');
        checkEscalation(msg.text || '');
        break;

      // ── Escalation triggered by server-side keyword detection ─────────────
      case 'escalation_requested':
        triggerEscalation();
        break;

      case 'call_ended':
        activeCallSid = null;
        setStatus('انتهت المكالمة', 'ended');
        if (window._siyaqLoadCustomers) {
          window._siyaqLoadCustomers().then(() => {
            if (window._siyaqRefreshOpenReport) window._siyaqRefreshOpenReport();
          }).catch(() => {});
        }
        setTimeout(hidePanel, 8000);
        break;

      default:
        break;
    }
  }

  // ── Transcript helpers ────────────────────────────────────────────────────────

  function clearTranscript() {
    partialLineEl = null;
    const t = transcriptEl();
    if (!t) return;
    // Remove all bubble lines but keep the empty-state placeholder
    t.querySelectorAll('.cp-line').forEach(el => el.remove());
    const es = emptyState();
    if (es) es.hidden = false;
    resetEscalation();
  }

  // Called repeatedly while customer is still speaking — updates same line
  function appendPartial(text) {
    if (!text) return;
    const t = transcriptEl();
    if (!t) return;

    // Hide empty state on first content
    const es = emptyState();
    if (es) es.hidden = true;

    if (!partialLineEl) {
      partialLineEl = document.createElement('div');
      partialLineEl.className = 'cp-line cp-line--customer cp-line--partial';
      t.appendChild(partialLineEl);
    }
    partialLineEl.textContent = text;
    t.scrollTop = t.scrollHeight;
  }

  // Called when Deepgram marks the utterance as final
  function commitFinal(text) {
    if (!text) return;
    const t = transcriptEl();
    if (!t) return;

    const es = emptyState();
    if (es) es.hidden = true;

    if (partialLineEl) {
      // Upgrade the existing partial line to a final line
      partialLineEl.textContent = text;
      partialLineEl.classList.remove('cp-line--partial');
      partialLineEl = null;
    } else {
      // No partial was open — create a fresh final line
      const line = document.createElement('div');
      line.className = 'cp-line cp-line--customer';
      line.textContent = text;
      t.appendChild(line);
    }
    t.scrollTop = t.scrollHeight;
  }

  // Client-side keyword check as a safety net (server should also detect)
  function checkEscalation(text) {
    if (!text) return;
    const hasKeyword = ESCALATION_KEYWORDS.some(kw => text.includes(kw));
    if (hasKeyword) triggerEscalation();
  }

  // ── Escalation ────────────────────────────────────────────────────────────────

  function triggerEscalation() {
    const banner = escBanner();
    const btn    = escalateBtn();

    if (banner) {
      banner.setAttribute('aria-hidden', 'false');
      banner.classList.add('cp-esc-banner--active');
    }
    if (btn) btn.classList.add('cp-escalate-btn--alert');
    panel()?.classList.add('cp-escalating');
  }

  function resetEscalation() {
    const banner = escBanner();
    const btn    = escalateBtn();

    if (banner) {
      banner.setAttribute('aria-hidden', 'true');
      banner.classList.remove('cp-esc-banner--active');
    }
    if (btn) {
      btn.classList.remove('cp-escalate-btn--alert');
      btn.disabled = false;
      btn.innerHTML = `
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M3 3.5A1.5 1.5 0 014.5 2h1a1.5 1.5 0 011.5 1.5v1A1.5 1.5 0 015.5 6H5a7 7 0 005.5 5.5v-.5A1.5 1.5 0 0112 9.5h1A1.5 1.5 0 0114.5 11v1A1.5 1.5 0 0113 13.5C7.201 13.5 2.5 8.799 2.5 3"
            stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        تحويل إلى موظف`;
    }
    panel()?.classList.remove('cp-escalating');
  }

  // ── Form helpers ──────────────────────────────────────────────────────────────
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
    if (window._siyaqGoPage) window._siyaqGoPage('add');
    prefillForm({
      name       : msg.name,
      summary    : msg.summary,
      status     : msg.status,
      national_id: msg.national_id,
    });
    const summaryEl = document.getElementById('f-summary');
    if (summaryEl && msg.summary) {
      summaryEl.style.borderColor = '#2DD4A0';
      setTimeout(() => { summaryEl.style.borderColor = ''; }, 1000);
    }
  }

  // ── Panel UI helpers ──────────────────────────────────────────────────────────
  function showPanel() { panel()?.classList.add('cp-visible'); }

  function hidePanel() {
    panel()?.classList.remove('cp-visible', 'cp-report-open', 'cp-escalating');
    clearCustomer();
    clearTranscript();
    if (callerId()) callerId().textContent = '';
    activeCallSid = null;
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

    const reasonHtml = customer.predicted_reason
      ? `<div class="cp-cust-reason">
           <span class="cp-reason-label">السبب المتوقع</span>
           <span class="cp-reason-text">${escHtml(customer.predicted_reason)}</span>
         </div>`
      : '';

    box.innerHTML = `
      <div class="cp-cust-inner">
        <div class="cp-cust-av">${avatarInitials(customer.name)}</div>
        <div class="cp-cust-info">
          <div class="cp-cust-name">${escHtml(customer.name)}</div>
          <div class="cp-cust-phone">${escHtml(customer.phone || '')}</div>
        </div>
        <div class="cp-cust-badge">تم التعرف عليه</div>
      </div>
      ${reasonHtml}`;
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

  // ── Button listeners ──────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {

    // Close panel
    if (e.target.closest('#cp-close')) {
      hidePanel();
      return;
    }

    // Dismiss escalation banner
    if (e.target.closest('#cp-esc-dismiss')) {
      resetEscalation();
      return;
    }

    // Escalation transfer button
    if (e.target.closest('#cp-escalate-btn')) {
      const btn = escalateBtn();
      if (btn && !btn.disabled) {
        btn.disabled = true;
        btn.textContent = 'تم التحويل ✓';
        btn.classList.remove('cp-escalate-btn--alert');
        panel()?.classList.remove('cp-escalating');
        const banner = escBanner();
        if (banner) banner.setAttribute('aria-hidden', 'true');
        // Re-enable after 5 seconds in case of mistake
        setTimeout(() => {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = `
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 3.5A1.5 1.5 0 014.5 2h1a1.5 1.5 0 011.5 1.5v1A1.5 1.5 0 015.5 6H5a7 7 0 005.5 5.5v-.5A1.5 1.5 0 0112 9.5h1A1.5 1.5 0 0114.5 11v1A1.5 1.5 0 0113 13.5C7.201 13.5 2.5 8.799 2.5 3"
                  stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              </svg>
              تحويل إلى موظف`;
          }
        }, 5000);
      }
      return;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────
  connect();

}());
