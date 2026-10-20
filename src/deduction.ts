import { db } from "./db";
import { ensureFresh } from "./sync";
import { digits, dkey, r2, r3, sameObekt } from "./util";

async function дедДанни(date: string) {
  await ensureFresh("РЕГИСТЪР", true);
  await ensureFresh("АРТИКУЛИ", true);
  const reg = await db().collection("РЕГИСТЪР")
    .find({ _d: dkey(date) }, { projection: { _id: 0 } }).toArray() as any[];
  const art = await db().collection("АРТИКУЛИ")
    .find({ _n: { $in: reg.map(r => digits(r["Номер"])) } }, { projection: { _id: 0 } }).toArray() as any[];
  const поНомер = new Map<string, any[]>();
  for (const a of art) {
    const k = digits(a["Номер"]);
    if (!поНомер.has(k)) поНомер.set(k, []);
    поНомер.get(k)!.push(a);
  }
  return { reg, поНомер, редовеНа: (r: any) => поНомер.get(digits(r?.["Номер"])) || [] };
}

function дедДвойка(reg: any[], obekt: any) {
  let s: any = null, f: any = null;
  for (const r of reg) {
    if (String(r["Статус"]).trim() !== "активен") continue;
    if (!sameObekt(r["Обект"], obekt)) continue;
    const v = String(r["Вид"]).trim();
    if (v === "Стокова" && !s) s = r;
    if (v === "Фактура" && !f) f = r;
  }
  return { s, f };
}

function дедСметка(стокова: any, стараСума: number, фактура: any, фРедове: any[], брак: any[]) {
  const негативни = брак.map((l: any) => ({
    код: String(l.code ?? ""), име: l.name, мярка: l.unit || "бр",
    кол: -Math.abs(Number(l.qty) || 0), цена: Number(l.price) || 0,
    стойност: -Math.abs(r2(l.sum)),
  }));
  const бракСума = r2(негативни.reduce((a, l) => a - l.стойност, 0));
  const нова = r2(стараСума - бракСума);
  const out: any = { обект: String(стокова["Обект"]), стокова: String(стокова["Номер"]),
    брак: бракСума, стокова_стара: стараСума, стокова_нова: нова, отрицателни: негативни };
  if (!фактура) { out.фактура = null; return out; }
  const дял = стараСума > 0 ? нова / стараСума : 1;
  let основа = 0;
  out.фактурни_редове = фРедове.map((a: any) => {
    const v = r2(Number(a["Стойност €"]) * дял), q = Number(a["Кол."]) || 0;
    основа = r2(основа + v);
    return { код: String(a["Код"] ?? ""), кол: q, стойност_стара: r2(a["Стойност €"]),
             стойност_нова: v, цена_нова: q ? r3(v / q) : r3(a["Цена"]) };
  });
  out.фактура = String(фактура["Номер"]);
  out.фактура_стара = r2(фактура["Сума"]);
  out.фактура_нова = нова;
  out.основа = основа;
  out.ддс = r2(нова - основа);
  return out;
}

export async function дедПлан(date: string, items: any[]) {
  const { reg, редовеНа } = await дедДанни(date);
  const план: any[] = [], пропуснати: any[] = [];
  for (const it of items || []) {
    const { s, f } = дедДвойка(reg, it.obekt);
    if (!s) { пропуснати.push({ обект: it.obekt, защо: "няма активна стокова за тази дата" }); continue; }
    if (редовеНа(s).some((a: any) => Number(a["Кол."]) < 0)) {
      пропуснати.push({ обект: it.obekt, защо: "вече има приспаднат брак" }); continue;
    }
    план.push(дедСметка(s, r2(s["Сума"]), f, редовеНа(f), it.lines || []));
  }
  await db().collection("_приспадане").insertOne({ при: new Date(), дата: date, план, пропуснати })
    .catch(() => {});
  return { дата: date, режим: "на тъмно - в листовете не е пипано нищо", план, пропуснати };
}

export async function дедРевизия(date: string) {
  const { reg, редовеНа } = await дедДанни(date);
  const случаи: any[] = [], разлики: any[] = [];
  for (const s of reg) {
    if (String(s["Вид"]).trim() !== "Стокова" || String(s["Статус"]).trim() !== "активен") continue;
    const редове = редовеНа(s);
    const отр = редове.filter((a: any) => Number(a["Кол."]) < 0);
    if (!отр.length) continue;
    const брак = r2(отр.reduce((a: number, l: any) => a - Number(l["Стойност €"]), 0));
    const сборРедове = r2(редове.reduce((a: number, l: any) => a + Number(l["Стойност €"]), 0));
    const вЛиста = r2(s["Сума"]);
    const c: any = { обект: String(s["Обект"]), стокова: String(s["Номер"]), брак,
      стокова_в_листа: вЛиста, сбор_артикулни_редове: сборРедове };
    if (сборРедове !== вЛиста)
      разлики.push({ ...c, какво: "стоковата не е равна на сбора на редовете си",
                     разлика: r2(вЛиста - сборРедове) });
    const { f } = дедДвойка(reg, s["Обект"]);
    if (f) {
      const фр = редовеНа(f);
      const основа = r2(фр.reduce((a: number, l: any) => a + Number(l["Стойност €"]), 0));
      const фСума = r2(f["Сума"]);
      c.фактура = String(f["Номер"]); c.фактура_в_листа = фСума;
      c.основа = основа; c.ддс = r2(фСума - основа);
      if (фСума !== вЛиста)
        разлики.push({ ...c, какво: "фактурата не е равна на стоковата (правило 8.2)",
                       разлика: r2(фСума - вЛиста) });
      const откл = основа > 0 ? Math.abs(c.ддс / основа - 0.2) : 0;
      if (откл > 0.005)
        разлики.push({ ...c, какво: "ДДС-то се отклонява от 20%",
                       процент: r3((c.ддс / основа) * 100) });
    }
    случаи.push(c);
  }
  const пазен = await db().collection("_приспадане")
    .find({ дата: date }, { projection: { _id: 0 } }).sort({ при: -1 }).limit(1).toArray() as any[];
  const сверка: any[] = [];
  for (const p of (пазен[0]?.план || [])) {
    const c = случаи.find(x => String(x.стокова) === String(p.стокова));
    if (!c) { сверка.push({ стокова: p.стокова, какво: "сметката го очакваше, а в листа няма приспадане" }); continue; }
    if (r2(p.стокова_нова) !== c.стокова_в_листа || r2(p.брак) !== c.брак
        || (p.фактура && r2(p.фактура_нова) !== c.фактура_в_листа))
      сверка.push({ стокова: p.стокова, обект: p.обект,
        сметката: { стокова: p.стокова_нова, фактура: p.фактура_нова, брак: p.брак },
        в_листа: { стокова: c.стокова_в_листа, фактура: c.фактура_в_листа, брак: c.брак } });
  }
  return { дата: date, приспаднати_документи: случаи.length,
    съвпада: разлики.length === 0 && сверка.length === 0,
    разлики, сметка_срещу_лист: пазен.length ? сверка : "няма запазена сметка за тази дата",
    случаи };
}
