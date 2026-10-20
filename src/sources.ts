import { db } from "./db";
import { gasCall } from "./gas";
import { fetchTabChecked } from "./sync";
import { dkey, normObekt } from "./util";

export const ЗАЯВКИ = "ЗАРЕДЕНИ_ЗАЯВКИ";

export async function claimSource(id: string, subject: string, date: string) {
  const sheet = await fetchTabChecked(ЗАЯВКИ, ["Идентификатор", "Дата на зареждане"]);
  const hit: any = sheet.find((r: any) => String(r["Идентификатор"] || "").trim() === id);
  if (hit) return { зает: true, кога: String(hit["Дата на зареждане"] || "") };
  try {
    await db().collection("_заредени").insertOne(
      { _id: id as any, тема: subject, дата: date, при: new Date() } as any);
  } catch (e: any) {
    if (e?.code === 11000) {
      const d: any = await db().collection("_заредени").findOne({ _id: id as any });
      return { зает: true, кога: d?.при ? new Date(d.при).toLocaleString("bg-BG") : "по-рано" };
    }
    throw e;
  }
  return { зает: false, кога: "" };
}

export async function releaseSource(id: string) {
  await db().collection("_заредени").deleteOne({ _id: id as any }).catch(() => {});
}

export async function recordSource(id: string, subject: string, date: string, broi: number, suma: number) {
  try {
    await gasCall("mirrorApply", { items: [{ "таблица": ЗАЯВКИ, "действие": "добавяне", "ред": {
      "Идентификатор": id,
      "Дата на зареждане": new Date().toLocaleString("bg-BG"),
      "Тема": subject, "Дата документи": date, "Брой": broi, "Сума": suma } }] });
    return "";
  } catch (e: any) { return String(e?.message || e); }
}

const VEGA_КОДОВЕ = new Set(["537", "539", "542", "538"]);

export async function vegaDuplicate(date: string, rows: any[]) {
  const k = dkey(date);
  const reg = await db().collection("РЕГИСТЪР")
    .find({ _d: k, "Статус": "активен", "Вид": "Стокова" }).toArray();
  if (!reg.length) return { duplicate: false };
  const byNum: any = {};
  reg.forEach((r: any) => { byNum[r._n] = normObekt(r["Обект"]); });
  const art = await db().collection("АРТИКУЛИ")
    .find({ _d: k, _n: { $in: Object.keys(byNum) }, "Код": { $in: [...VEGA_КОДОВЕ] } }).toArray();
  const have = new Set(art.map((a: any) =>
    `${byNum[a._n]}|${String(a["Код"]).trim()}|${Number(a["Кол."])}`));
  let total = 0;
  const already: string[] = [];
  for (const s of rows) for (const l of (s.lines || [])) {
    const code = String(l.code || "").trim();
    if (!VEGA_КОДОВЕ.has(code)) continue;
    total++;
    if (have.has(`${normObekt(s.obekt)}|${code}|${Number(l.qty)}`))
      already.push(`${s.obekt} - ${l.name} x${l.qty}`);
  }
  if (total && already.length >= Math.ceil(total * 0.6))
    return { duplicate: true, count: already.length, total,
      error: `Този ВЕГА файл вече е зареден за ${date} - ${already.length} от ${total} реда `
           + `вече съществуват. Нищо не е записано, за да не се удвоят закуските.` };
  return { duplicate: false };
}

function отпечатък(date: string, rows: any[]): string {
  const ядро = JSON.stringify(rows.map((r: any) => [String(r.obekt || "").trim(),
    (r.lines || []).map((l: any) => `${l.code ?? ""}:${Number(l.qty) || 0}`).sort()]).sort());
  let h = 2166136261;
  for (let i = 0; i < ядро.length; i++) { h ^= ядро.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `файл-${dkey(date)}-${rows.length}-${(h >>> 0).toString(36)}`;
}
export function източнициID(body: any): string[] {
  if (body["повторно"] === true) return [];
  const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
  const date = String(body.date || "").trim();
  const out: string[] = [];
  const даден = String(body.source_id || "").trim();
  if (даден) out.push(даден);
  if (rows.length && date) out.push(отпечатък(date, rows));
  return out;
}
