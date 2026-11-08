try { const r = new URLSearchParams(location.search).get('ref'); if (r && /^[0-9a-f]{8}$/i.test(r)) localStorage.setItem('pe-ref', r.toLowerCase()); } catch (_) {}
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
    vi: { dashboard: 'Bảng điều khiển', settings: 'Cài đặt', login: 'Đăng nhập', register: 'Đăng ký miễn phí', logout: 'Đăng xuất', account: 'Bài báo của tôi', titleL: 'Chào mừng trở lại', titleR: 'Tạo tài khoản miễn phí', one: 'Một tài khoản cho mọi ứng dụng Paperlit.', email: 'Email', pw: 'Mật khẩu', hint: '8 ký tự trở lên', toR: 'Chưa có tài khoản? Đăng ký miễn phí', toL: 'Đã có tài khoản? Đăng nhập', close: 'Đóng', wait: 'Vui lòng chờ...', credits: 'tín dụng', unlimited: 'Không giới hạn (quản trị)', menu: 'Menu tài khoản', agree: 'Khi đăng ký, bạn đồng ý với', terms: 'điều khoản', fail: 'Không kết nối được máy chủ. Hãy thử lại.' },
    id: { dashboard: 'Dasbor', settings: 'Pengaturan', login: 'Masuk', register: 'Daftar gratis', logout: 'Keluar', account: 'Makalah saya', titleL: 'Selamat datang kembali', titleR: 'Buat akun gratis Anda', one: 'Satu akun untuk semua aplikasi Paperlit.', email: 'Email', pw: 'Kata sandi', hint: '8 karakter atau lebih', toR: 'Belum punya akun? Daftar gratis', toL: 'Sudah punya akun? Masuk', close: 'Tutup', wait: 'Sebentar...', credits: 'kredit', unlimited: 'Tanpa batas (admin)', menu: 'Menu akun', agree: 'Dengan mendaftar Anda menyetujui', terms: 'ketentuan', fail: 'Tidak dapat terhubung ke server. Coba lagi.' },
  };
  const X = {
    en: { country: 'Country or region', pickC: 'Choose', plang: 'Preferred language', about: 'A little about you (optional)', source: 'Where did you hear about us?', role: 'I am a', pickO: 'Choose',
      src: { friend: 'A friend or classmate', social: 'Social media', search: 'Search engine', class: 'My teacher or class', other: 'Other' },
      rol: { student: 'Student', researcher: 'Researcher', teacher: 'Teacher', pro: 'Working professional', other: 'Other' }, needC: 'Choose your country or region.', needL: 'Choose your language.' },
    zh: { country: '国家或地区', pickC: '请选择', plang: '常用语言', about: '再多介绍一下你（选填）', source: '你是从哪里知道我们的？', role: '我是', pickO: '请选择',
      src: { friend: '朋友或同学', social: '社交媒体', search: '搜索引擎', class: '老师或课程', other: '其他' },
      rol: { student: '学生', researcher: '研究者', teacher: '教师', pro: '在职人士', other: '其他' }, needC: '请选择国家或地区。', needL: '请选择语言。' },
    vi: { country: 'Quốc gia hoặc khu vực', pickC: 'Chọn', plang: 'Ngôn ngữ ưa thích', about: 'Đôi điều về bạn (không bắt buộc)', source: 'Bạn biết đến chúng tôi từ đâu?', role: 'Tôi là', pickO: 'Chọn',
      src: { friend: 'Bạn bè hoặc bạn học', social: 'Mạng xã hội', search: 'Công cụ tìm kiếm', class: 'Thầy cô hoặc lớp học', other: 'Khác' },
      rol: { student: 'Sinh viên', researcher: 'Nhà nghiên cứu', teacher: 'Giảng viên', pro: 'Người đi làm', other: 'Khác' }, needC: 'Hãy chọn quốc gia hoặc khu vực.', needL: 'Hãy chọn ngôn ngữ.' },
    id: { country: 'Negara atau wilayah', pickC: 'Pilih', plang: 'Bahasa pilihan', about: 'Sedikit tentang Anda (opsional)', source: 'Dari mana Anda mengenal kami?', role: 'Saya adalah', pickO: 'Pilih',
      src: { friend: 'Teman atau teman kuliah', social: 'Media sosial', search: 'Mesin pencari', class: 'Dosen atau kelas saya', other: 'Lainnya' },
      rol: { student: 'Mahasiswa', researcher: 'Peneliti', teacher: 'Pengajar', pro: 'Pekerja profesional', other: 'Lainnya' }, needC: 'Pilih negara atau wilayah.', needL: 'Pilih bahasa.' },
  };
  const M = {
    en: { forgot: 'Forgot your password?', fT: 'Reset your password', fP: 'Enter your email and we will send you a link to choose a new password.', fGo: 'Send the link', fDone: 'If that email has an account, we sent a link. It works for 1 hour. Check your spam folder too.',
      cT: 'Check your email', cP: 'We sent a confirmation link to {email}. Open it to finish creating your account. Check your spam folder too.', resend: 'Send the email again', resent: 'Sent again. Please check your inbox.',
      rT: 'Choose a new password', rGo: 'Save password', verified: 'Email confirmed. You are signed in.', ok: 'OK', badLink: 'This link is not valid any more.' },
    zh: { forgot: '忘记密码？', fT: '重置密码', fP: '输入你的邮箱，我们会发送一个设置新密码的链接。', fGo: '发送链接', fDone: '如果该邮箱已注册，我们已发送链接，1 小时内有效。也请查看垃圾邮件。',
      cT: '请查收邮件', cP: '我们已向 {email} 发送了确认链接，点击即可完成账户创建。也请查看垃圾邮件。', resend: '重新发送邮件', resent: '已重新发送，请查收。',
      rT: '设置新密码', rGo: '保存密码', verified: '邮箱已确认，你已登录。', ok: '好的', badLink: '该链接已失效。' },
    vi: { forgot: 'Quên mật khẩu?', fT: 'Đặt lại mật khẩu', fP: 'Nhập email của bạn, chúng tôi sẽ gửi liên kết để chọn mật khẩu mới.', fGo: 'Gửi liên kết', fDone: 'Nếu email đó có tài khoản, chúng tôi đã gửi một liên kết, có hiệu lực 1 giờ. Hãy kiểm tra cả thư rác.',
      cT: 'Hãy kiểm tra email', cP: 'Chúng tôi đã gửi liên kết xác nhận tới {email}. Mở liên kết để hoàn tất tạo tài khoản. Hãy kiểm tra cả thư rác.', resend: 'Gửi lại email', resent: 'Đã gửi lại. Hãy kiểm tra hộp thư.',
      rT: 'Chọn mật khẩu mới', rGo: 'Lưu mật khẩu', verified: 'Đã xác nhận email. Bạn đã đăng nhập.', ok: 'OK', badLink: 'Liên kết này không còn hiệu lực.' },
    id: { forgot: 'Lupa kata sandi?', fT: 'Atur ulang kata sandi', fP: 'Masukkan email Anda dan kami kirim tautan untuk memilih kata sandi baru.', fGo: 'Kirim tautan', fDone: 'Jika email itu punya akun, kami sudah mengirim tautan yang berlaku 1 jam. Periksa juga folder spam.',
      cT: 'Periksa email Anda', cP: 'Kami mengirim tautan konfirmasi ke {email}. Buka tautan itu untuk menyelesaikan pembuatan akun. Periksa juga folder spam.', resend: 'Kirim email lagi', resent: 'Terkirim lagi. Silakan periksa kotak masuk.',
      rT: 'Pilih kata sandi baru', rGo: 'Simpan kata sandi', verified: 'Email dikonfirmasi. Anda sudah masuk.', ok: 'OK', badLink: 'Tautan ini sudah tidak berlaku.' },
  };
  const m = (k) => (M[lang()] || M.en)[k] || M.en[k];
  const Y = {
    en: { emailOrUser: 'Email or username', userLabel: 'Username', userHint: '3 to 24 letters, numbers, dots or underscores. You can sign in with it.', needUser: 'Choose a username.', switchT: 'Accounts on this device', addAcct: 'Add another account', continueAs: 'Continue as', plan: 'plan' },
    zh: { emailOrUser: '邮箱或用户名', userLabel: '用户名', userHint: '3 到 24 位字母、数字、点或下划线，可用它登录。', needUser: '请设置用户名。', switchT: '此设备上的账户', addAcct: '添加其他账户', continueAs: '继续使用', plan: '套餐' },
    vi: { emailOrUser: 'Email hoặc tên người dùng', userLabel: 'Tên người dùng', userHint: '3 đến 24 chữ cái, số, dấu chấm hoặc gạch dưới. Bạn có thể dùng nó để đăng nhập.', needUser: 'Hãy chọn tên người dùng.', switchT: 'Tài khoản trên thiết bị này', addAcct: 'Thêm tài khoản khác', continueAs: 'Tiếp tục với', plan: 'gói' },
    id: { emailOrUser: 'Email atau nama pengguna', userLabel: 'Nama pengguna', userHint: '3 sampai 24 huruf, angka, titik, atau garis bawah. Bisa dipakai untuk masuk.', needUser: 'Pilih nama pengguna.', switchT: 'Akun di perangkat ini', addAcct: 'Tambah akun lain', continueAs: 'Lanjutkan sebagai', plan: 'paket' },
  };
  const y = (k) => (Y[lang()] || Y.en)[k] || Y.en[k];
  const ACC = 'pe-accounts';
  const accts = () => { try { return JSON.parse(get(ACC) || '[]'); } catch (e) { return []; } };
  const saveAccts = (a) => put(ACC, a.length ? JSON.stringify(a.slice(0, 8)) : '');
  const shown = (u) => (u && (u.handle || (u.username || '').split('@')[0])) || '?';
  const LANGNAME = { en: 'English', zh: '中文', vi: 'Tiếng Việt', id: 'Bahasa Indonesia' };
  const COUNTRIES = 'CN VN ID US SG MY TH PH JP KR IN HK TW MO GB AU CA DE FR ES IT NL SE CH BR MX AE SA TR RU PK BD LK NP EG NG ZA KE NZ IE PL UA IL AR CL CO'.split(' ');
  const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const put = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };
  const lang = () => { const h = (document.documentElement.lang || '').slice(0, 2).toLowerCase(); return h === 'zh' || h === 'vi' || h === 'id' ? h : 'en'; };
  const t = (k) => (TXT[lang()] || TXT.en)[k] ?? TXT.en[k];
  const x = () => X[lang()] || X.en;
  const visitor = () => {
    let v = get(VISITOR);
    if (!v) { v = crypto.randomUUID ? crypto.randomUUID() : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; put(VISITOR, v); }
    return v;
  };
  const headers = () => ({ 'Content-Type': 'application/json', 'x-visitor-id': visitor(), ...(get(TOKEN) ? { 'x-session': get(TOKEN) } : {}) });
  async function call(op, body = {}) {
    const res = await fetch(URL_, { method: 'POST', headers: headers(), body: JSON.stringify({ op, visitor: visitor(), ...body }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) { const er = new Error(out.error || `HTTP ${res.status}`); er.code = out.code; er.email = out.email; throw er; }
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
.sa-d input:focus{outline:2px solid #5b4bff;outline-offset:0;border-color:transparent}.sa-d select{display:block;width:100%;height:44px;margin-top:6px;padding:0 10px;border:1px solid var(--sa-line);border-radius:11px;background:transparent;color:inherit;font:400 15px Inter,sans-serif;box-sizing:border-box}.sa-d select option{color:#111}
.sa-d small{display:block;margin-top:5px;font-size:12.5px;color:var(--sa-mut)}
.sa-go{width:100%;min-height:46px;margin-top:18px;border:0;border-radius:12px;background:#5b4bff;color:#fff;font:600 15px Inter,'Noto Sans SC',sans-serif;cursor:pointer}.sa-go:disabled{opacity:.6;cursor:wait}
.sa-ab{display:block;width:100%;padding:11px 14px;border:1px solid var(--sa-line);border-radius:11px;background:transparent;color:var(--sa-fg);font:600 14px Inter,'Noto Sans SC',sans-serif;cursor:pointer;text-align:left}.sa-ab:hover{border-color:#5b4bff}
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
    b.textContent = shown(user)[0].toUpperCase();
    b.title = shown(user) + ' (' + user.username + ')';
    b.setAttribute('aria-label', t('menu'));
    b.setAttribute('aria-expanded', String(open));
    b.onclick = (e) => { e.stopPropagation(); open = !open; paint(); };
    root.appendChild(b);
    if (!open) return;
    const m = document.createElement('div');
    m.className = 'sa-m';
    const p = document.createElement('p');
    const name = document.createElement('b');
    name.textContent = shown(user);
    p.appendChild(name);
    const mail = document.createElement('small');
    mail.textContent = user.username;
    mail.style.cssText = 'display:block;font-weight:400;opacity:.7;word-break:break-all';
    p.appendChild(mail);
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
    const others = accts().filter((a) => a.id !== user.id);
    if (others.length) {
      const hd = document.createElement('p'); hd.className = 'sa-fine'; hd.style.margin = '10px 0 4px'; hd.textContent = y('switchT');
      m.append(hd);
      others.forEach((a) => {
        const sw = document.createElement('button');
        sw.type = 'button'; sw.textContent = shown(a.user) + ' (' + a.user.username + ')';
        sw.onclick = () => switchTo(a);
        m.append(sw);
      });
    }
    const add = document.createElement('button');
    add.type = 'button'; add.textContent = '+ ' + y('addAcct');
    add.onclick = () => { open = false; paint(); dialog('login'); };
    m.append(add);
    m.append(out);
    root.appendChild(m);
  }

  function switchTo(a) {
    put(TOKEN, a.token);
    user = { ...a.user };
    open = false;
    put(USER, JSON.stringify(user));
    paint();
    sync();   // loads the real profile of that account, or drops it when its session has ended
    window.dispatchEvent(new Event('suite-auth'));
  }

  function set(u, token) {
    const oldToken = get(TOKEN);
    user = u;
    open = false;
    if (token !== undefined) put(TOKEN, token);
    let list = accts();
    if (u && token) list = [{ id: u.id, token, user: { id: u.id, username: u.username, handle: u.handle || null } }, ...list.filter((a) => a.id !== u.id)];
    else if (!u && oldToken) list = list.filter((a) => a.token !== oldToken);
    saveAccts(list);
    put(USER, u ? JSON.stringify(u) : '');
    paint();
    window.dispatchEvent(new Event('suite-auth'));
  }

  // small dialogs for e-mail confirmation and password reset
  function panel(title, build) {
    const d = document.createElement('dialog');
    d.className = 'sa-d';
    const x0 = document.createElement('button'); x0.type = 'button'; x0.className = 'sa-x'; x0.textContent = '✕'; x0.setAttribute('aria-label', t('close')); x0.onclick = () => d.close();
    const h = document.createElement('h2'); h.textContent = title;
    d.append(x0, h);
    build(d);
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.appendChild(d);
    d.showModal();
    return d;
  }
  const para = (text) => { const p = document.createElement('p'); p.textContent = text; return p; };
  const msgBox = () => { const b = document.createElement('p'); b.className = 'sa-fine'; b.setAttribute('role', 'status'); b.style.marginTop = '12px'; return b; };
  function labelled(text, input) { const l = document.createElement('label'); const sp = document.createElement('span'); sp.textContent = text; l.append(sp, input); return l; }
  function button(text, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'sa-go'; b.textContent = text; b.onclick = fn; return b; }

  function checkEmailDialog(email) {
    panel(m('cT'), (d) => {
      d.append(para(m('cP').replace('{email}', email)));
      const note = msgBox();
      const again = button(m('resend'), async () => { again.disabled = true; try { await call('resend_verify', { username: email, lang: lang() }); note.textContent = m('resent'); } catch (e) { note.textContent = e.message; } finally { setTimeout(() => { again.disabled = false; }, 15000); } });
      d.append(again, note);
    });
  }
  function forgotDialog(email0) {
    panel(m('fT'), (d) => {
      d.append(para(m('fP')));
      const inp = document.createElement('input'); inp.type = 'email'; inp.autocomplete = 'email'; inp.inputMode = 'email'; inp.value = email0 || '';
      const note = msgBox();
      const go = button(m('fGo'), async () => {
        const em = inp.value.trim();
        if (!em) return;
        go.disabled = true;
        try { await call('reset_request', { username: em, lang: lang() }); note.textContent = m('fDone'); } catch (e) { note.textContent = e.message; go.disabled = false; }
      });
      d.append(labelled(t('email'), inp), go, note);
    });
  }
  function resetDialog(token) {
    panel(m('rT'), (d) => {
      const inp = document.createElement('input'); inp.type = 'password'; inp.autocomplete = 'new-password';
      const hint = document.createElement('small'); hint.textContent = t('hint');
      const note = msgBox();
      const go = button(m('rGo'), async () => {
        go.disabled = true;
        try {
          const out = await call('reset_confirm', { token, password: inp.value });
          set(out.user, out.token);
          try { history.replaceState(null, '', location.pathname + location.hash); } catch (_) {}
          d.close();
          panel(m('rT'), (d2) => { d2.append(para(m('verified')), button(m('ok'), () => d2.close())); });
        } catch (e) { note.textContent = e.message; go.disabled = false; }
      });
      d.append(labelled(t('pw'), inp), hint, go, note);
    });
  }
  async function handleLinks() {
    let q; try { q = new URLSearchParams(location.search); } catch (_) { return; }
    const v = q.get('verify'), r = q.get('reset');
    if (v) {
      try {
        const out = await call('verify_email', { token: v });
        set(out.user, out.token);
        panel(m('cT'), (d) => d.append(para(m('verified')), button(m('ok'), () => d.close())));
      } catch (e) {
        panel(m('cT'), (d) => d.append(para(e.message || m('badLink')), button(m('ok'), () => d.close())));
      }
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (_) {}
    } else if (r) {
      resetDialog(r);
    }
  }

  function dialog(start) {
    let mode = start;
    const d = document.createElement('dialog');
    d.className = 'sa-d';
    const draw = (err, busy, email = '') => {
      const prev = (() => { const g = d.querySelector('form'); return g && g.country ? { c: g.country.value, l: g.plang.value, s: g.source.value, r: g.role.value, h: g.handle ? g.handle.value : '' } : {}; })();
      d.innerHTML = `<button type="button" class="sa-x"></button><h2></h2><p></p><form method="dialog" novalidate><label><span class="e"></span><input name="email" type="email" inputmode="email" autocomplete="email" required></label><label><span class="w"></span><input name="pw" type="password" minlength="8" maxlength="72" required></label><small></small><button class="sa-go" type="submit"></button></form><button type="button" class="sa-sw"></button>`;
      const f = d.querySelector('form');
      d.querySelector('.sa-x').textContent = '✕';
      d.querySelector('.sa-x').setAttribute('aria-label', t('close'));
      d.querySelector('.sa-x').onclick = () => d.close();
      d.querySelector('h2').textContent = t(mode === 'login' ? 'titleL' : 'titleR');
      d.querySelector('p').textContent = t('one');
      d.querySelector('.e').textContent = mode === 'login' ? y('emailOrUser') : t('email');
      d.querySelector('.w').textContent = t('pw');
      f.pw.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      d.querySelector('small').textContent = mode === 'register' ? t('hint') : '';
      f.email.value = email;
      if (mode === 'login') { f.email.type = 'text'; f.email.setAttribute('inputmode', 'email'); f.email.autocomplete = 'username'; }
      if (mode === 'login' && accts().length && !d.querySelector('.sa-accts')) {
        const box = document.createElement('div'); box.className = 'sa-accts'; box.style.cssText = 'display:grid;gap:6px;margin:12px 0 0';
        accts().forEach((a) => {
          const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'sa-ab';
          bt.textContent = y('continueAs') + ' ' + shown(a.user);
          bt.onclick = () => { d.close(); switchTo(a); };
          box.append(bt);
        });
        d.querySelector('p').after(box);
      }
      if (mode === 'register') {
        const wrapH = document.createElement('label');
        const spH = document.createElement('span'); spH.textContent = y('userLabel') + ' *';
        const inH = document.createElement('input'); inH.name = 'handle'; inH.type = 'text'; inH.autocomplete = 'username'; inH.maxLength = 24; inH.value = prev.h || '';
        const smH = document.createElement('small'); smH.textContent = y('userHint');
        wrapH.append(spH, inH, smH);
        const labels = f.querySelectorAll(':scope > label');
        labels[0].after(wrapH);
      }
      const go = d.querySelector('.sa-go');
      go.textContent = busy ? t('wait') : t(mode === 'login' ? 'login' : 'register');
      go.disabled = !!busy;
      if (mode === 'register') {
        const mk = (label, name, opts, req, pre) => {
          const l = document.createElement('label');
          const sp = document.createElement('span'); sp.textContent = label + (req ? ' *' : '');
          const sel = document.createElement('select'); sel.name = name;
          const o0 = document.createElement('option'); o0.value = ''; o0.textContent = x().pickC; sel.appendChild(o0);
          opts.forEach(([v, n]) => { const o = document.createElement('option'); o.value = v; o.textContent = n; sel.appendChild(o); });
          sel.value = pre || '';
          l.append(sp, sel);
          return l;
        };
        const dn = (() => { try { return new Intl.DisplayNames([lang()], { type: 'region' }); } catch (e) { return null; } })();
        const cs = COUNTRIES.map((c) => [c, (dn && dn.of(c)) || c]);
        const guess = ((navigator.language || '').split('-')[1] || '').toUpperCase();
        const keep = prev.c || (COUNTRIES.indexOf(guess) >= 0 ? guess : '');
        const keepL = prev.l || lang();
        const go0 = d.querySelector('.sa-go');
        const wrap = document.createElement('div');
        wrap.append(
          mk(x().country, 'country', cs, true, keep),
          mk(x().plang, 'plang', Object.keys(LANGNAME).map((k) => [k, LANGNAME[k]]), true, keepL),
        );
        const more = document.createElement('p'); more.className = 'sa-fine'; more.style.marginTop = '16px'; more.textContent = x().about;
        wrap.append(more,
          mk(x().source, 'source', Object.keys(x().src).map((k) => [k, x().src[k]]), false, prev.s || ''),
          mk(x().role, 'role', Object.keys(x().rol).map((k) => [k, x().rol[k]]), false, prev.r || ''));
        f.insertBefore(wrap, go0);
      }
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
      if (mode === 'login') {
        const fg = document.createElement('button'); fg.type = 'button'; fg.className = 'sa-sw'; fg.textContent = m('forgot'); fg.onclick = () => { const em = f.email.value.trim(); d.close(); forgotDialog(em); };
        sw.parentNode.insertBefore(fg, sw);
      }
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
          let ref; try { ref = localStorage.getItem('pe-ref') || undefined; } catch (_) {}
          if (mode === 'register' && !f.handle.value.trim()) throw new Error(y('needUser'));
          if (mode === 'register' && !(f.country.value && f.plang.value)) throw new Error(!f.country.value ? x().needC : x().needL);
          const out = await call(mode, mode === 'register' ? { username: em, email: em, handle: f.handle.value.trim().toLowerCase(), password: pw, ref, country: f.country.value, lang: f.plang.value, source: f.source.value, role: f.role.value } : { username: em, password: pw });
          if (out.pending) { d.close(); checkEmailDialog(out.email || em); return; }
          set(out.user, out.token);
          sync();
          d.close();
        } catch (x) {
          if (x.code === 'need_verify') { d.close(); checkEmailDialog(x.email || em); return; }
          draw(/fetch|network/i.test(String(x.message)) ? t('fail') : x.message, false, em);
          d.querySelector('form').pw.value = pw;
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
      if (!user) { saveAccts(accts().filter((a) => a.token !== token)); put(TOKEN, ''); }
      else if (token) saveAccts(accts().map((a) => (a.token === token ? { ...a, user: { id: user.id, username: user.username, handle: user.handle || null } } : a)));
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
  handleLinks();
  window.addEventListener('suite-open-auth', (e) => { if (!user) dialog(e.detail === 'login' ? 'login' : 'register'); });
  window.addEventListener('storage', (e) => { if (e.key === TOKEN) sync(); });
  sync();
})();
