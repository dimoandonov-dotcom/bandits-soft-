import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Вход с парола — 16.11.2026.
//
// Защо: страницата се отваряше от всеки, а ключът за запис стоеше в самия ѝ код.
// ИТ хората, които ползват компютъра на Дамян, можеха да видят и регистъра,
// и партньорите, и цените. Сега:
//   * POST /login {user, pass} → сесиен ключ, подписан с AUTH_SECRET;
//   * всяко защитено извикване приема ИЛИ стария WRITE_KEY (за задачите по график),
//     ИЛИ валиден сесиен ключ;
//   * паролите НЕ стоят в кода — в AUTH_USERS има само солена SHA-256 сума.
//
// AUTH_USERS = {"dimo":{"salt":"…","hash":"…","role":"admin","name":"Димо"}, …}

type Потребител = { salt: string; hash: string; role: string; name?: string };

const ЧАСА_СЕСИЯ = 12;

function потребители(): Record<string, Потребител> {
  try { return JSON.parse(process.env.AUTH_USERS || "{}"); } catch { return {}; }
}
function тайна() {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 32) throw new Error("AUTH_SECRET не е зададен - входът е спрян.");
  return s;
}
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const равни = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Срещу налучкване: 8 грешни опита от един адрес за 15 минути → спира.
const ОПИТИ: Record<string, number[]> = {};
function блокиран(ip: string) {
  const сега = Date.now();
  ОПИТИ[ip] = (ОПИТИ[ip] || []).filter(t => сега - t < 15 * 60e3);
  return ОПИТИ[ip].length >= 8;
}

export function вход(user: string, pass: string, ip: string) {
  if (блокиран(ip)) return { error: "Твърде много грешни опити. Опитай пак след 15 минути." };
  const u = String(user || "").trim().toLowerCase();
  const p = потребители()[u];
  if (!p || !равни(sha(p.salt + String(pass || "")), p.hash)) {
    (ОПИТИ[ip] = ОПИТИ[ip] || []).push(Date.now());
    return { error: "Грешно име или парола." };
  }
  const exp = Date.now() + ЧАСА_СЕСИЯ * 3600e3;
  const тяло = b64(JSON.stringify({ u, r: p.role, exp }));
  const подпис = createHmac("sha256", тайна()).update(тяло).digest("base64url");
  return { ok: true, token: `${тяло}.${подпис}`, role: p.role, name: p.name || u, exp };
}

export function провериСесия(token: string): { u: string; r: string } | null {
  if (!token || !token.includes(".")) return null;
  const [тяло, подпис] = token.split(".");
  let s = "";
  try { s = тайна(); } catch { return null; }
  const очакван = createHmac("sha256", s).update(тяло).digest("base64url");
  if (!равни(подпис, очакван)) return null;
  try {
    const d = JSON.parse(Buffer.from(тяло, "base64url").toString());
    if (!d.exp || d.exp < Date.now()) return null;
    return { u: d.u, r: d.r };
  } catch { return null; }
}

// Помощно: сума за нов потребител (ползва се само при задаване на пароли).
export function сумаЗаПарола(salt: string, pass: string) { return sha(salt + pass); }
