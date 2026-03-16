document.addEventListener('DOMContentLoaded', function () {
  try {
    var p = location.pathname;
    if (/\.html$/i.test(p)) {
      history.replaceState({}, '', p.replace(/\.html$/i, ''));
    }
    var hasDash = false;
    try { hasDash = localStorage.getItem('has_dashboard') === '1'; } catch(e){}
    var links = document.querySelectorAll('a[href]');
    links.forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      if (/^https?:|^mailto:|^#/.test(href)) return;
      var nh = href.replace(/\.html(\b|$)/i, '').replace(/\/index$/i, '/');
      if (hasDash && /(^|\/)invite-hitman(\b|\/|$)/.test(nh)) {
        nh = nh.replace(/invite-hitman(\b|\/|$)/, 'dashboard$1');
      }
      if (nh !== href) a.setAttribute('href', nh);
    });
  } catch (e) {}

  try {
    var CKEY = 'cookie_consent';
    function getConsent() {
      try { return JSON.parse(localStorage.getItem(CKEY) || ''); } catch(e) { return null; }
    }
    function setConsent(obj) {
      try { localStorage.setItem(CKEY, JSON.stringify(obj)); } catch(e){}
    }
    function createEl(tag, cls) {
      var el = document.createElement(tag);
      if (cls) el.className = cls;
      return el;
    }
    function showBanner() {
      var banner = createEl('div','cookie-banner');
      banner.setAttribute('role','dialog');
      banner.setAttribute('aria-live','polite');
      banner.innerHTML = '' +
        '<div class="cookie-row">' +
          '<div>' +
            '<div class="cookie-title">Cookies on this site</div>' +
            '<div class="cookie-text">We use essential cookies to make this site work and optional analytics to improve it. See our <a class="cookie-link" href="privacy">Privacy Policy</a>.</div>' +
          '</div>' +
          '<div class="cookie-actions">' +
            '<button class="cookie-btn" id="cookieReject">Reject non‑essential</button>' +
            '<button class="cookie-btn" id="cookieSettings">Settings</button>' +
            '<button class="cookie-btn cookie-btn-primary" id="cookieAccept">Accept all</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(banner);
      setTimeout(function(){ banner.style.display='block'; }, 0);

      var backdrop = createEl('div','cookie-modal-backdrop');
      var modal = createEl('div','cookie-modal');
      modal.setAttribute('role','dialog');
      modal.setAttribute('aria-modal','true');
      modal.innerHTML = '' +
        '<h3>Cookie preferences</h3>' +
        '<div class="cookie-pref"><strong>Necessary</strong><span>Always on</span></div>' +
        '<div class="cookie-pref"><div><strong>Analytics</strong><div class="cookie-text">Help us improve with anonymous usage stats</div></div><div class="toggle" id="toggleAnalytics" aria-label="Analytics"></div></div>' +
        '<div class="cookie-pref"><div><strong>Marketing</strong><div class="cookie-text">Personalized content where applicable</div></div><div class="toggle" id="toggleMarketing" aria-label="Marketing"></div></div>' +
        '<div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">' +
          '<button class="cookie-btn" id="cookieCancel">Cancel</button>' +
          '<button class="cookie-btn cookie-btn-primary" id="cookieSave">Save preferences</button>' +
        '</div>';
      document.body.appendChild(backdrop);
      document.body.appendChild(modal);

      function openModal() {
        backdrop.style.display='block';
        modal.style.display='block';
      }
      function closeModal() {
        backdrop.style.display='none';
        modal.style.display='none';
      }

      var c = getConsent() || { necessary: true, analytics: false, marketing: false, v: 1 };
      var tA = modal.querySelector('#toggleAnalytics');
      var tM = modal.querySelector('#toggleMarketing');
      function syncToggles() {
        tA.classList.toggle('active', !!c.analytics);
        tM.classList.toggle('active', !!c.marketing);
      }
      syncToggles();
      tA.addEventListener('click', function(){ c.analytics = !c.analytics; syncToggles(); });
      tM.addEventListener('click', function(){ c.marketing = !c.marketing; syncToggles(); });

      banner.querySelector('#cookieAccept').addEventListener('click', function(){
        setConsent({ necessary: true, analytics: true, marketing: true, ts: Date.now(), v: 1 });
        banner.remove(); backdrop.remove(); modal.remove();
        document.dispatchEvent(new CustomEvent('cookie-consent', { detail: { analytics: true, marketing: true }}));
      });
      banner.querySelector('#cookieReject').addEventListener('click', function(){
        setConsent({ necessary: true, analytics: false, marketing: false, ts: Date.now(), v: 1 });
        banner.remove(); backdrop.remove(); modal.remove();
        document.dispatchEvent(new CustomEvent('cookie-consent', { detail: { analytics: false, marketing: false }}));
      });
      banner.querySelector('#cookieSettings').addEventListener('click', function(){ openModal(); });
      modal.querySelector('#cookieCancel').addEventListener('click', function(){ closeModal(); });
      modal.querySelector('#cookieSave').addEventListener('click', function(){
        setConsent({ necessary: true, analytics: !!c.analytics, marketing: !!c.marketing, ts: Date.now(), v: 1 });
        closeModal(); banner.remove(); backdrop.remove(); modal.remove();
        document.dispatchEvent(new CustomEvent('cookie-consent', { detail: { analytics: !!c.analytics, marketing: !!c.marketing }}));
      });
      backdrop.addEventListener('click', closeModal);
    }

    var existing = getConsent();
    if (!existing) showBanner();
  } catch(e){}
});
