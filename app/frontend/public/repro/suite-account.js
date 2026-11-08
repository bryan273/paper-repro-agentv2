/* One account for the whole Paperlit. Framework-free so the React apps and the static Paper Repro Agent pages run the same file.
   All apps share one origin, so the session in localStorage (pe-session) is the single sign-in; the account service is explainer-account.
   Guests make no network call here. Mounts into the top bar (.stb-act or .tbact) and re-mounts if the bar is re-rendered. */
(() => {
  if (window.__suiteAccount) return;
  window.__suiteAccount = true;

  const URL_ = 'https://wzdkroxbfrlqijbeiwpk.supabase.co/functions/v1/explainer-account';
  const HOME = '/repro-suite/explainer';
  const TOKEN = 'pe-session';
  const USER = 'pe-user';
  const VISITOR = 'pe-visitor';
  const TXT = {
    en: { dashboard: 'Dashboard', settings: 'Settings', login: 'Log in', register: 'Sign up free', logout: 'Log out', account: 'My papers', titleL: 'Welcome back', titleR: 'Create your free account', one: 'One account for every Paperlit app.', email: 'Email', pw: 'Password', hint: '8 characters or more', toR: 'No account yet? Sign up free', toL: 'Already have an account? Log in', close: 'Close', wait: 'One moment...', credits: 'credits', unlimited: 'Unlimited (admin)', menu: 'Account menu', agree: 'By signing up you agree to the', terms: 'terms', fail: 'Could not reach the server. Try again.' },
    zh: { dashboard: '我的看板', settings: '设置', login: '登录', register: '免费注册', logout: '退出登录', account: '我的论文', titleL: '欢迎回来', titleR: '创建免费账户', one: '一个账户，通用于所有 Paperlit 应用。', email: '邮箱', pw: '密码', hint: '至少 8 个字符', toR: '还没有账户？免费注册', toL: '已有账户？去登录', close: '关闭', wait: '请稍候...', credits: '点额度', unlimited: '无限额度（管理员）', menu: '账户菜单', agree: '注册即表示同意', terms: '服务条款', fail: '无法连接服务器，请重试。' },
  };
  const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const put = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };
  const lang = () => (/^zh/i.test(document.documentElement.lang) ? 'zh' : 'en');
  const t = (k) => TXT[lang()][k];
  const visitor = () => {
    let v = get(VISITOR);
    if (!v) { v = crypto.randomUUID ? crypto.randomUUID() : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; put(VISITOR, v); }
    return v;
  };
  const headers = () => ({ 'Content-Type': 'application/json', 'x-visitor-id': visitor(), ...(get(TOKEN) ? { 'x-session': get(TOKEN) } : {}) });
  async function call(op, body = {}) {
    const res = await fetch(URL_, { method: 'POST', headers: headers(), body: JSON.stringify({ op, visitor: visitor(), ...body }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  const css = document.createElement('style');
  css.textContent = `
.sa,.sa-d{--sa-card:#ffffff;--sa-fg:#15151c;--sa-mut:#62627a;--sa-line:#e3e3ee;--sa-soft:#f1f0fb}
[data-theme=dark] .sa,[data-theme=dark] .sa-d,.dark .sa,.dark .sa-d{--sa-card:#1b1b27;--sa-fg:#f3f3fa;--sa-mut:#a4a4bb;--sa-line:#34344a;--sa-soft:#262638}
.sa{position:relative;flex:none;font-family:Inter,'Noto Sans SC',system-ui,sans-serif}
.sa-btn{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 15px;border:0;border-radius:999px;background:#5b4bff;color:#fff;font:600 13.5px Inter,'Noto Sans SC',sans-serif;cursor:pointer;white-space:nowrap}
.sa-btn:hover{background:#4a3bea}.sa-btn:focus-visible,.sa-me:focus-visible,.sa-d button:focus-visible,.sa-d a:focus-visible,.sa-m a:focus-visible,.sa-m button:focus-visible{outline:2px solid #5b4bff;outline-offset:2px}
.sa-btn svg{display:none;width:17px;height:17px}
.sa-me{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:#5b4bff;color:#fff;font:700 14px 'Space Grotesk',Inter,sans-serif;cursor:pointer;text-transform:uppercase}
.sa-m{position:absolute;z-index:80;top:calc(100% + 9px);right:0;width:240px;padding:8px;border:1px solid var(--sa-line);border-radius:14px;background:var(--sa-card);color:var(--sa-fg);box-shadow:0 16px 44px rgba(20,20,50,.18)}
.sa-m p{margin:0;padding:7px 10px 10px;font-size:13px;line-height:1.4;overflow-wrap:anywhere}.sa-m p b{display:block;font-weight:600}.sa-m p span{color:var(--sa-mut)}
.sa-m a,.sa-m button{display:block;width:100%;padding:9px 10px;border:0;border-radius:9px;background:none;color:var(--sa-fg);font:500 14px Inter,'Noto Sans SC',sans-serif;text-align:left;text-decoration:none;cursor:pointer}
.sa-m a:hover,.sa-m button:hover{background:var(--sa-soft)}
.sa-d{width:min(420px,calc(100vw - 32px));margin:auto;padding:30px 28px 24px;border:1px solid var(--sa-line);border-radius:20px;background:var(--sa-card);color:var(--sa-fg);font-family:Inter,'Noto Sans SC',system-ui,sans-serif;box-shadow:0 30px 80px rgba(20,20,50,.35);animation:sa-in .18s ease-out}
@keyframes sa-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.sa-d{animation:none}}
.sa-d::backdrop{background:rgba(16,16,32,.55);backdrop-filter:blur(3px)}
.sa-d h2{margin:0;font:700 25px/1.15 'Space Grotesk',Inter,'Noto Sans SC',sans-serif;letter-spacing:-.02em}.sa-d>p{margin:7px 0 0;font-size:14px;color:var(--sa-mut)}
.sa-d label{display:block;margin-top:15px;font-size:13.5px;font-weight:600}.sa-d input{display:block;width:100%;height:44px;margin-top:6px;padding:0 13px;border:1px solid var(--sa-line);border-radius:11px;background:transparent;color:inherit;font:400 15px Inter,sans-serif;box-sizing:border-box}
.sa-d input:focus{outline:2px solid #5b4bff;outline-offset:0;border-color:transparent}.sa-d small{display:block;margin-top:5px;font-size:12.5px;color:var(--sa-mut)}
.sa-go{width:100%;min-height:46px;margin-top:18px;border:0;border-radius:12px;background:#5b4bff;color:#fff;font:600 15px Inter,'Noto Sans SC',sans-serif;cursor:pointer}.sa-go:disabled{opacity:.6;cursor:wait}
.sa-sw{display:block;margin:12px auto 0;padding:6px;border:0;background:none;color:var(--sa-fg);font:500 13.5px Inter,'Noto Sans SC',sans-serif;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.sa-x{position:absolute;top:12px;right:12px;width:34px;height:34px;border:0;border-radius:50%;background:none;color:var(--sa-mut);font-size:18px;cursor:pointer}
.sa-err{margin:12px 0 0;padding:9px 11px;border-radius:9px;background:rgba(198,40,40,.1);color:#b3261e;font-size:13.5px}.sa-d .sa-fine{font-size:12.5px;text-align:center}.sa-fine a{color:inherit}
@media(max-width:560px){.sa-btn{width:34px;min-height:34px;padding:0;justify-content:center}.sa-btn span{display:none}.sa-btn svg{display:block}.sa-me{width:34px;height:34px}}
`;
  document.head.appendChild(css);

  const root = document.createElement('div');
  root.className = 'sa';
  let user = null;
  let open = false;
  try { user = JSON.parse(get(USER) || 'null'); } catch { user = null; }

  function close() { open = false; paint(); }
  function paint() {
    root.textContent = '';
    if (!user) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sa-btn';
      b.setAttribute('aria-label', t('login'));
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0115 0"/></svg><span></span>';
      b.querySelector('span').textContent = t('login');
      b.onclick = () => dialog('login');
      root.appendChild(b);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sa-me';
    b.textContent = (user.username || '?')[0];
    b.title = user.username;
    b.setAttribute('aria-label', t('menu'));
    b.setAttribute('aria-expanded', String(open));
    b.onclick = (e) => { e.stopPropagation(); open = !open; paint(); };
    root.appendChild(b);
    if (!open) return;
    const m = document.createElement('div');
    m.className = 'sa-m';
    const p = document.createElement('p');
    const name = document.createElement('b');
    name.textContent = user.username;
    p.appendChild(name);
    if (typeof user.credits === 'number') {
      const c = document.createElement('span');
      c.textContent = user.admin ? t('unlimited') : `${user.credits} ${t('credits')}`;
      p.appendChild(c);
    }
    const a = document.createElement('a');
    a.href = `${HOME}/account`;
    a.textContent = t('dashboard');
    const st = document.createElement('a');
    st.href = `${HOME}/?settings=1`;
    st.textContent = t('settings');
    st.onclick = (e) => {
      if (location.pathname.startsWith(HOME)) { e.preventDefault(); open = false; paint(); window.dispatchEvent(new Event('pe-open-settings')); }
    };
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = t('logout');
    out.onclick = async () => {
      try { await call('logout'); } catch { /* the token is dropped locally either way */ }
      set(null, '');
    };
    m.append(p, a, st);
    if (user.admin) {
      const ad = document.createElement('a');
      ad.href = '/repro-suite/hub/console';
      ad.textContent = 'Admin';
      m.append(ad);
    }
    m.append(out);
    root.appendChild(m);
  }

  function set(u, token) {
    user = u;
    open = false;
    if (token !== undefined) put(TOKEN, token);
    put(USER, u ? JSON.stringify(u) : '');
    paint();
    window.dispatchEvent(new Event('suite-auth'));
  }

  function dialog(start) {
    let mode = start;
    const d = document.createElement('dialog');
    d.className = 'sa-d';
    const draw = (err, busy, email = '') => {
      d.innerHTML = `<button type="button" class="sa-x"></button><h2></h2><p></p><form method="dialog" novalidate><label><span class="e"></span><input name="email" type="email" inputmode="email" autocomplete="email" required></label><label><span class="w"></span><input name="pw" type="password" minlength="8" maxlength="72" required></label><small></small><button class="sa-go" type="submit"></button></form><button type="button" class="sa-sw"></button>`;
      const f = d.querySelector('form');
      d.querySelector('.sa-x').textContent = '✕';
      d.querySelector('.sa-x').setAttribute('aria-label', t('close'));
      d.querySelector('.sa-x').onclick = () => d.close();
      d.querySelector('h2').textContent = t(mode === 'login' ? 'titleL' : 'titleR');
      d.querySelector('p').textContent = t('one');
      d.querySelector('.e').textContent = t('email');
      d.querySelector('.w').textContent = t('pw');
      f.pw.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      d.querySelector('small').textContent = mode === 'register' ? t('hint') : '';
      f.email.value = email;
      const go = d.querySelector('.sa-go');
      go.textContent = busy ? t('wait') : t(mode === 'login' ? 'login' : 'register');
      go.disabled = !!busy;
      if (err) {
        const box = document.createElement('p');
        box.className = 'sa-err';
        box.setAttribute('role', 'alert');
        box.textContent = err;
        f.insertBefore(box, go);
      }
      const sw = d.querySelector('.sa-sw');
      sw.textContent = t(mode === 'login' ? 'toR' : 'toL');
      sw.onclick = () => { mode = mode === 'login' ? 'register' : 'login'; draw('', false, f.email.value); };
      if (mode === 'register') {
        const fine = document.createElement('p');
        fine.className = 'sa-fine';
        fine.textContent = `${t('agree')} `;
        const a = document.createElement('a');
        a.href = `${HOME}/terms`;
        a.textContent = t('terms');
        fine.appendChild(a);
        d.appendChild(fine);
      }
      f.onsubmit = async (e) => {
        e.preventDefault();
        const em = f.email.value.trim();
        const pw = f.pw.value;
        draw('', true, em);
        d.querySelector('form').pw.value = pw;
        try {
          const out = await call(mode, { username: em, password: pw });
          set(out.user, out.token);
          sync();
          d.close();
        } catch (x) {
          draw(/fetch|network/i.test(String(x.message)) ? t('fail') : x.message, false, em);
        }
      };
    };
    draw();
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.appendChild(d);
    d.showModal();
  }

  async function sync() {
    const token = get(TOKEN);
    if (!token) { if (user) { user = null; put(USER, ''); paint(); } return; }
    try {
      const res = await fetch(`${URL_}?me=1`, { headers: headers() });
      const out = await res.json();
      if (!res.ok) return;
      user = out.user ? { ...out.user, admin: !!out.admin } : null;
      put(USER, user ? JSON.stringify(user) : '');
      if (!user) put(TOKEN, '');
      paint();
    } catch { /* offline: keep what we have */ }
  }

  function mount() {
    const bar = document.querySelector('.stb-act') || document.querySelector('.tbact');
    if (!bar || root.parentNode === bar) return;
    const burger = bar.querySelector('.stb-burger, #menuBtn');
    if (burger) bar.insertBefore(root, burger);
    else bar.appendChild(root);
    paint();
  }

  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  document.addEventListener('click', (e) => { if (open && !root.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) close(); });
  window.addEventListener('suite-auth', () => { if (get(TOKEN) && !user) sync(); else if (!get(TOKEN) && user) { user = null; put(USER, ''); paint(); } });
  window.addEventListener('suite-open-auth', (e) => { if (!user) dialog(e.detail === 'login' ? 'login' : 'register'); });
  window.addEventListener('storage', (e) => { if (e.key === TOKEN) sync(); });
  sync();
})();
