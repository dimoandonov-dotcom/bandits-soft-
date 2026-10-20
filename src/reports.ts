import { MASTER_URL, SERIES } from "./config";
import { db } from "./db";
import { ensureFresh } from "./sync";
import { digits, dkey, linieAdd, norm, num2, r2 } from "./util";

export async function healthCheck() {
  const reg = await db().collection("РЕГИСТЪР").find({ "Статус": "активен" }).toArray();
  const art = await db().collection("АРТИКУЛИ").find({}).toArray();
  const dost = await db().collection("РЕГИСТЪР_ДОСТАВКИ").find({ "Статус": "активен" }).toArray();
  let objs: any[] = [];
  try {
    const r = await fetch(MASTER_URL, { redirect: "follow" });
    if (r.ok) { const m = await r.json(); objs = m.objects || m || []; }
  } catch {}
  const known = new Set(objs.map((o: any) => norm(o.obekt)));
  const seen: any = {}, dupNums: string[] = [];
  reg.forEach((r: any) => { const n = r._n; if (!n) return; if (seen[n]) dupNums.push(n); seen[n] = 1; });
  const unknownObj: any = {};
  if (known.size) reg.forEach((r: any) => {
    const o = String(r["Обект"] || "").trim();
    if (o && !known.has(norm(o))) unknownObj[o] = (unknownObj[o] || 0) + 1;
  });
  const noObj = reg.filter((r: any) => !String(r["Обект"] || "").trim()).map((r: any) => r["Номер"]);
  const zeroSum = reg.filter((r: any) => num2(r["Сума"]) === 0 && !String(r["Вид"] || "").startsWith("КИ"))
    .map((r: any) => `${r["Номер"]} ${r["Обект"]}`);
  const zeroPrice = art.filter((a: any) => num2(a["Цена"]) === 0).length;
  const badDost = dost.filter((r: any) => /[\/+]/.test(String(r["Номер"] || "")))
    .map((r: any) => `${r["Доставчик"]} ${r["Номер"]}`);
  const counters = await db().collection("counters").find({}).toArray();
  const behind: string[] = [];
  for (const c of counters as any[]) {
    const top = await db().collection("РЕГИСТЪР")
      .find({ _n: { $regex: `^${c._id}\\d{8}$` } }).sort({ _n: -1 }).limit(1).toArray();
    const max = Number((top[0] as any)?._n || 0);
    if (max > Number(c.last)) behind.push(`серия ${c._id}: брояч ${c.last}, а в регистъра има ${max}`);
  }
  const pending = await db().collection("_mirror").countDocuments({ готово: false });
  const dupRows = reg.length - new Set(reg.map((r: any) => `${r["Номер"]}|${r["Дата"]}|${r["Обект"]}`)).size;
  const findings: any = {};
  if (dupNums.length) findings["дублирани номера"] = [...new Set(dupNums)];
  if (dupRows) findings["дублирани редове в базата"] = dupRows;
  if (Object.keys(unknownObj).length) findings["документи на непознат обект"] = unknownObj;
  if (noObj.length) findings["документи без обект"] = noObj;
  if (zeroSum.length) findings["документи с нулева сума"] = zeroSum.slice(0, 20);
  if (zeroPrice) findings["артикулни реда с цена 0"] = zeroPrice;
  if (badDost.length) findings["номера на доставки с / или +"] = badDost;
  if (behind.length) findings["брояч под максимума"] = behind;
  if (pending) findings["чакащи в огледалото"] = pending;
  return {
    чисто: Object.keys(findings).length === 0,
    проверени: { документи: reg.length, артикулни_реда: art.length, доставки: dost.length,
                 обекти_в_master: objs.length },
    находки: findings,
  };
}

export async function dailyCheck(from: string, to: string) {
  const q: any = {};
  if (from || to) {
    q._d = {};
    if (from) q._d.$gte = dkey(from);
    if (to) q._d.$lte = dkey(to);
    if (!Object.keys(q._d).length) delete q._d;
  }
  const reg = await db().collection("РЕГИСТЪР").find({ ...q, "Статус": "активен" }).toArray();
  const art = await db().collection("АРТИКУЛИ").find(q).toArray();

  const линии: any = {};
  art.forEach((a: any) => {
    const n = a._n; if (!n) return;
    linieAdd(линии, n, num2(a["Стойност €"]));
  });

  const находки: any = {};

  const разминати: string[] = [];
  reg.forEach((r: any) => {
    const n = r._n; if (!n || !(n in линии)) return;
    const vid = String(r["Вид"] || "").trim();
    if (vid === "Фактура") return;
    const очаквано = (vid === "Стокова") ? линии[n] : r2(r2(линии[n]) + r2(линии[n] * 0.2));
    const раз = r2(num2(r["Сума"]) - очаквано);
    if (Math.abs(раз) > 0.005)
      разминати.push(`${r["Номер"]} ${r["Дата"]} ${vid} ${r["Обект"]}: ${r["Сума"]} срещу ${очаквано} (${раз > 0 ? "+" : ""}${раз})`);
  });
  if (разминати.length) находки["сума не отговаря на редовете"] = разминати.slice(0, 30);

  const двойки: any = {};
  reg.forEach((r: any) => {
    const vid = String(r["Вид"] || "").trim();
    if (vid !== "Стокова" && vid !== "Фактура") return;
    const k = `${r["Дата"]}|${String(r["Обект"] || "").trim()}`;
    (двойки[k] = двойки[k] || {})[vid] = r;
  });
  const неравни: string[] = [];
  for (const k of Object.keys(двойки)) {
    const d = двойки[k];
    if (!d["Стокова"] || !d["Фактура"]) continue;
    const раз = r2(num2(d["Фактура"]["Сума"]) - num2(d["Стокова"]["Сума"]));
    if (Math.abs(раз) > 0.005)
      неравни.push(`${k.replace("|", " ")}: стокова ${d["Стокова"]["Сума"]}, фактура ${d["Фактура"]["Сума"]} (${раз > 0 ? "+" : ""}${раз})`);
  }
  if (неравни.length) находки["фактура и стокова с различни суми"] = неравни.slice(0, 30);

  let objs: any[] = [];
  try {
    const r = await fetch(MASTER_URL, { redirect: "follow" });
    if (r.ok) { const m = await r.json(); objs = m.objects || m || []; }
  } catch {}
  if (objs.length) {
    const byObj: any = {};
    objs.forEach((o: any) => { byObj[norm(o.obekt)] = o; });
    const без: any = {};
    reg.forEach((r: any) => {
      const vid = String(r["Вид"] || "").trim();
      if (vid === "Стокова") return;             // реквизитите тежат на фактурите и известията
      const o = byObj[norm(r["Обект"])];
      if (!o) { (без["непознат обект"] = без["непознат обект"] || []).push(`${r["Номер"]} ${r["Обект"]}`); return; }
      const липсва: string[] = [];
      if (!String(o.eik || "").trim()) липсва.push("ЕИК");
      if (!String(o.dds || "").trim()) липсва.push("ДДС");
      if (!String(o.mol || "").trim()) липсва.push("МОЛ");
      if (липсва.length)
        (без[липсва.join("+")] = без[липсва.join("+")] || []).push(`${r["Номер"]} ${r["Обект"]}`);
    });
    const сбито: any = {};
    for (const k of Object.keys(без)) сбито[k] = { брой: без[k].length, примери: без[k].slice(0, 5) };
    if (Object.keys(сбито).length) находки["издадени без реквизити"] = сбито;
  }

  await ensureFresh("НОМЕРАЦИЯ", true);
  const ном = await db().collection("НОМЕРАЦИЯ").find({}).toArray();
  const номер: string[] = [];
  for (const row of ном as any[]) {
    const s = String(row["Серия"] || "").trim();
    if (!SERIES.includes(s)) continue;
    const last = Number(digits(row["Последен_номер"])) || 0;
    const top = await db().collection("РЕГИСТЪР")
      .find({ _n: { $regex: `^${s}\\d{8}$` } }).sort({ _n: -1 }).limit(1).toArray();
    const max = Number((top[0] as any)?._n || 0);
    if (max > last) номер.push(`серия ${s}: листът казва ${last}, а в регистъра има ${max}`);
  }
  if (номер.length) находки["номерацията изостава"] = номер;

  const чакат = await db().collection("_mirror").countDocuments({ готово: false });
  if (чакат) находки["чакат в огледалото"] = чакат;
  const log: any = await db().collection("_meta").findOne({ _id: "огледало" as any });
  const провали = (log?.["провали"] || []).slice(-3);
  if (провали.length) находки["последни провали на огледалото"] = провали;

  return {
    период: { от: from || "(всичко)", до: to || "(всичко)" },
    проверени: { документи: reg.length, артикулни_реда: art.length },
    чисто: Object.keys(находки).length === 0,
    находки,
  };
}
