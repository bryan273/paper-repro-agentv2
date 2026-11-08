// Sending e-mail for sign-up confirmation and password reset. Two providers, so it works for both Chinese and global addresses:
//   RESEND_API_KEY                        Resend (https://resend.com): good for gmail, outlook, icloud and most global mailboxes
//   ALIYUN_DM_KEY_ID + ALIYUN_DM_KEY_SECRET  Alibaba Cloud DirectMail: good for qq.com, 163.com, 126.com, sina, foxmail and school mailboxes in China
//   MAIL_FROM                             the sender address on a domain verified with the provider, for example "Paperlit <no-reply@your-domain.com>"
// An address in China is sent through Aliyun when it is set up, any other through Resend; whichever is missing, the other one is used.
// With neither provider configured mailReady() is false and the app behaves as before (no confirmation, no reset by e-mail).

const CN_DOMAINS = ["qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "188.com", "139.com", "sina.com", "sina.cn", "sohu.com", "aliyun.com", "tom.com", "21cn.com", "wo.cn"];
const isChinese = (to: string) => {
  const d = (to.split("@")[1] ?? "").toLowerCase();
  return d.endsWith(".cn") || CN_DOMAINS.includes(d);
};
const hasResend = () => !!Deno.env.get("RESEND_API_KEY") && !!Deno.env.get("MAIL_FROM");
const hasAliyun = () => !!Deno.env.get("ALIYUN_DM_KEY_ID") && !!Deno.env.get("ALIYUN_DM_KEY_SECRET") && !!Deno.env.get("MAIL_FROM");
export const mailReady = () => hasResend() || hasAliyun();

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const fromAddress = () => {
  const f = Deno.env.get("MAIL_FROM") ?? "";
  return /<([^>]+)>/.exec(f)?.[1] ?? f;
};
const fromName = () => (/^(.*)</.exec(Deno.env.get("MAIL_FROM") ?? "")?.[1] ?? "Paperlit").trim().replace(/^"|"$/g, "") || "Paperlit";

async function viaResend(to: string, subject: string, html: string, text: string) {
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: Deno.env.get("MAIL_FROM"), to: [to], subject, html, text }) });
  if (!r.ok) throw new Error(`resend ${r.status} ${(await r.text()).slice(0, 160)}`);
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  let bin = ""; for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function viaAliyun(to: string, subject: string, html: string, text: string) {
  const p: Record<string, string> = {
    Action: "SingleSendMail", AccountName: fromAddress(), FromAlias: fromName(), AddressType: "1", ReplyToAddress: "false", ToAddress: to, Subject: subject, HtmlBody: html, TextBody: text,
    Format: "JSON", Version: "2015-11-23", AccessKeyId: Deno.env.get("ALIYUN_DM_KEY_ID")!, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), RegionId: "cn-hangzhou",
  };
  const canon = Object.keys(p).sort().map((k) => `${enc(k)}=${enc(p[k])}`).join("&");
  const sign = await hmacSha1(Deno.env.get("ALIYUN_DM_KEY_SECRET")! + "&", `POST&${enc("/")}&${enc(canon)}`);
  const r = await fetch("https://dm.aliyuncs.com/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `Signature=${enc(sign)}&${canon}` });
  if (!r.ok) throw new Error(`aliyun ${r.status} ${(await r.text()).slice(0, 160)}`);
}

export async function sendMail(to: string, subject: string, html: string, text: string): Promise<void> {
  const order = isChinese(to) ? [hasAliyun() && viaAliyun, hasResend() && viaResend] : [hasResend() && viaResend, hasAliyun() && viaAliyun];
  let last: unknown = new Error("no mail provider is set up");
  for (const fn of order) {
    if (!fn) continue;
    try { await fn(to, subject, html, text); return; } catch (e) { last = e; }
  }
  throw last;
}

const COPY: Record<string, { verifyS: string; verifyH: string; verifyB: string; verifyBtn: string; resetS: string; resetH: string; resetB: string; resetBtn: string; ignore: string }> = {
  en: { verifyS: "Confirm your Paperlit email", verifyH: "Confirm your email", verifyB: "Press the button to finish creating your account. The link works for 24 hours.", verifyBtn: "Confirm my email", resetS: "Reset your Paperlit password", resetH: "Reset your password", resetB: "Press the button to choose a new password. The link works for 1 hour.", resetBtn: "Choose a new password", ignore: "If you did not ask for this, you can ignore this email." },
  zh: { verifyS: "确认你的 Paperlit 邮箱", verifyH: "确认你的邮箱", verifyB: "点击按钮完成账户创建。链接 24 小时内有效。", verifyBtn: "确认邮箱", resetS: "重置你的 Paperlit 密码", resetH: "重置密码", resetB: "点击按钮设置新密码。链接 1 小时内有效。", resetBtn: "设置新密码", ignore: "如果这不是你本人的操作，请忽略这封邮件。" },
  vi: { verifyS: "Xác nhận email Paperlit của bạn", verifyH: "Xác nhận email", verifyB: "Nhấn nút để hoàn tất tạo tài khoản. Liên kết có hiệu lực trong 24 giờ.", verifyBtn: "Xác nhận email", resetS: "Đặt lại mật khẩu Paperlit", resetH: "Đặt lại mật khẩu", resetB: "Nhấn nút để chọn mật khẩu mới. Liên kết có hiệu lực trong 1 giờ.", resetBtn: "Chọn mật khẩu mới", ignore: "Nếu bạn không yêu cầu, hãy bỏ qua email này." },
  id: { verifyS: "Konfirmasi email Paperlit Anda", verifyH: "Konfirmasi email Anda", verifyB: "Tekan tombol untuk menyelesaikan pembuatan akun. Tautan berlaku 24 jam.", verifyBtn: "Konfirmasi email saya", resetS: "Atur ulang kata sandi Paperlit Anda", resetH: "Atur ulang kata sandi", resetB: "Tekan tombol untuk memilih kata sandi baru. Tautan berlaku 1 jam.", resetBtn: "Pilih kata sandi baru", ignore: "Jika bukan Anda yang meminta, abaikan email ini." },
};

/** The message for a confirmation or reset link, in the person's language. */
export function linkMail(kind: "verify" | "reset", lang: string, link: string) {
  const c = COPY[lang] ?? COPY.en;
  const head = kind === "verify" ? c.verifyH : c.resetH, body = kind === "verify" ? c.verifyB : c.resetB, btn = kind === "verify" ? c.verifyBtn : c.resetBtn;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">${head}</h2><p style="line-height:1.5">${body}</p><p><a href="${link}" style="display:inline-block;background:#5b4bff;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">${btn}</a></p><p style="color:#666;font-size:13px">${c.ignore}</p><p style="color:#999;font-size:12px;word-break:break-all">${link}</p></div>`;
  return { subject: kind === "verify" ? c.verifyS : c.resetS, html, text: `${head}\n\n${body}\n${link}\n\n${c.ignore}` };
}
