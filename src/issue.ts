import { db, mode } from "./db";
import { gasReserve, verifyInSheets, writeThroughSheets } from "./gas";
import { mirrorQueue, tryFlush } from "./mirror";
import { reserveNums } from "./numbers";
import { claimSource, recordSource, releaseSource, vegaDuplicate, ЗАЯВКИ, източнициID } from "./sources";
import { ensureFresh } from "./sync";
import { digits, dkey, pad10, r2, r3, sameObekt, stamp } from "./util";

export async function issueDocs(body: any, dry: boolean) {
  const sids = източнициID(body);
  try { return await issueDocsInner(body, dry); }
  catch (e) { if (!dry) for (const x of sids) await releaseSource(x); throw e; }
}

async function issueDocsInner(body: any, dry: boolean) {
  const date = String(body.date || "").trim();
  const source = String(body.source || "").trim();
  const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) throw new Error(`нечетима дата "${date}".`);
  if (!rows.length) throw new Error("празен списък - няма какво да се издава.");
  if (rows.length > 500) throw new Error("над 500 обекта наведнъж - раздели ги.");
  for (let i = 0; i < rows.length; i++)
    if (!String(rows[i].obekt || "").trim()) throw new Error(`ред ${i + 1} е без обект - спирам.`);

  const sourceIds = източнициID(body);
  const sourceId = sourceIds[0] || "";
  const пусни = async () => { for (const x of sourceIds) await releaseSource(x); };
  const subject = String(body.subject || source || "").trim();
  if (!dry) for (let i = 0; i < sourceIds.length; i++) {
    const c = await claimSource(sourceIds[i], subject, date);
    if (c["зает"]) {
      for (let j = 0; j < i; j++) await releaseSource(sourceIds[j]);
      return { duplicate: true, вече_заредена: true, loadedAt: c["кога"],
        същото_съдържание: i > 0,
        съобщение: `${i > 0 ? `Същите количества за ${date}` : "Тази заявка"} вече `
          + `са заредени на ${c["кога"]} - нищо не е записано повторно.` };
    }
  }

  if (!dry) {
    await ensureFresh("РЕГИСТЪР", true);
    if (body["вега"]) await ensureFresh("АРТИКУЛИ", true);
  }
  if (body["вега"] && !dry) {
    const d: any = await vegaDuplicate(date, rows);
    if (d.duplicate) { await пусни(); return d; }
  }

  const day = await db().collection("РЕГИСТЪР").find({ _d: dkey(date) }).toArray();
  let order = 0;
  day.forEach((r: any) => { const v = Number(r["Ред"]) || 0; if (v > order) order = v; });

  const live: any[] = day.map((r: any) => ({
    num: String(r["Номер"]), vid: String(r["Вид"] || "").trim(),
    obekt: String(r["Обект"] || ""), status: String(r["Статус"] || "").trim(),
    suma: Number(r["Сума"]) || 0, ред: Number(r["Ред"]) || 0, нов: false,
  }));
  const findExisting = (vid: string, obekt: string) =>
    live.find(x => x.vid === vid && x.status === "активен" && sameObekt(x.obekt, obekt)) || null;

  const plan: any[] = [];
  let needStock = 0, needFakt = 0;
  for (const r of rows) {
    const p: any = { r, stok: findExisting("Стокова", r.obekt) };
    if (!p.stok) { needStock++; p.order = ++order; } else { p.order = p.stok.ред; }
    if (r.needsInvoice) {
      p.fakt = findExisting("Фактура", r.obekt);
      if (!p.fakt) needFakt++;
      const своиРедове = Array.isArray(r.faktLines) && r.faktLines.length > 0;
      const фРедове = своиРедове ? r.faktLines : (r.lines || []);
      if (своиРедове) {
        const бруто = r2(фРедове.reduce((a: number, l: any) => a + (Number(l.sum) || 0), 0));
        if (бруто !== r2(r.suma))
          throw new Error(`${r.obekt}: фактурните редове дават ${бруто}, а стоковата е `
            + `${r2(r.suma)} - трябва да съвпадат точно, затова спирам.`);
      }
      p.netLines = фРедове.map((l: any) => ({
        code: l.code, name: l.name, unit: l.unit || "бр", qty: l.qty,
        price: r3((Number(l.price) || 0) / 1.2), sum: r2((Number(l.sum) || 0) / 1.2),
      }));
      p.faktTotal = r2(r.suma);
    }
    plan.push(p);
    if (!p.stok) live.push({ num: "", vid: "Стокова", obekt: r.obekt, status: "активен",
                             suma: r2(r.suma), ред: p.order, нов: true, _p: p });
    if (r.needsInvoice && !p.fakt) live.push({ num: "", vid: "Фактура", obekt: r.obekt,
                             status: "активен", suma: p.faktTotal, ред: p.order, нов: true, _pf: p });
  }

  const mirrorOnly = !dry && (await mode()) !== "стопанин";
  const дневникIds: any[] = [];
  const take = async (series: string, n: number) => {
    if (n <= 0) return [];
    const rec: any = { при: new Date(), серия: series, брой: n, дата: date,
                       източник: source, тема: subject, режим: mirrorOnly ? "огледало" : "стопанин",
                       статус: "заделя" };
    let id: any = null;
    try { id = (await db().collection("_номера").insertOne(rec)).insertedId; дневникIds.push(id); }
    catch (e) { /* дневникът никога не спира издаването */ }
    try {
      const ns = mirrorOnly ? await gasReserve(series, n, date) : await reserveNums(series, n, date);
      if (id) await db().collection("_номера").updateOne({ _id: id },
        { $set: { статус: "заделени", номера: ns.map(String) } }).catch(() => {});
      return ns;
    } catch (e: any) {
      if (id) await db().collection("_номера").updateOne({ _id: id },
        { $set: { статус: "провал", грешка: String(e?.message || e) } }).catch(() => {});
      throw e;
    }
  };
  const ЗАПАЗЕНО = (s: string, i: number) => `@${s}#${i}`;
  const stockNums = Array.from({ length: needStock }, (_, i) => ЗАПАЗЕНО("10", i));
  const faktNums = Array.from({ length: needFakt }, (_, i) => ЗАПАЗЕНО("11", i));

  let si = 0, fi = 0;
  const newReg: any[] = [], newArt: any[] = [], sumUpd: any[] = [], written: any[] = [];
  const промени: any[] = [];

  for (const p of plan) {
    const r = p.r, vid = String(r.vid || "Стокова");
    let num: string;
    if (p.stok) {
      num = p.stok.num;
      const беше = r2(p.stok.suma);
      p.stok.suma = r2(p.stok.suma + (Number(r.suma) || 0));
      промени.push({ номер: num, обект: r.obekt, вид: vid, беше, става: p.stok.suma,
        добавено: r2(p.stok.suma - беше),
        редове: (r.lines || []).map((l: any) => `${l.name} x ${l.qty}`) });
      if (!p.stok.нов) sumUpd.push({ num, suma: p.stok.suma });
      else { const t = newReg.find(x => x["Номер"] === num); if (t) t["Сума"] = p.stok.suma; }
    } else {
      num = stockNums[si++];
      newReg.push({ "Номер": num, "Дата": date, "Вид": vid, "Обект": r.obekt, "Фирма": r.firma || "",
        "Сума": r2(r.suma), "Към документ": "", "Партида": "", "Статус": "активен",
        "Бележка": r.belejka || "", "Източник": source, "Ред": p.order });
      const mine = live.find(x => x.нов && x._p === p); if (mine) mine.num = num;
    }
    (r.lines || []).forEach((l: any) => newArt.push({ "Номер": num, "Дата": date, "Вид": vid,
      "Обект": r.obekt, "Фирма": r.firma || "", "Код": l.code, "Артикул": l.name,
      "Мярка": l.unit || "бр", "Кол.": l.qty, "Цена": l.price, "Партида": l.partida || "",
      "Стойност €": l.sum }));
    const entry: any = { num, obekt: r.obekt, suma: r2(r.suma), слят: !!p.stok };
    if (r.needsInvoice) {
      let fnum: string;
      if (p.fakt) {
        fnum = p.fakt.num;
        const бешеФ = r2(p.fakt.suma);
        p.fakt.suma = r2(p.fakt.suma + p.faktTotal);
        промени.push({ номер: fnum, обект: r.obekt, вид: "Фактура", беше: бешеФ,
          става: p.fakt.suma, добавено: r2(p.fakt.suma - бешеФ), редове: [] });
        if (!p.fakt.нов) sumUpd.push({ num: fnum, suma: p.fakt.suma });
        else { const t = newReg.find(x => x["Номер"] === fnum); if (t) t["Сума"] = p.fakt.suma; }
      } else {
        fnum = faktNums[fi++];
        newReg.push({ "Номер": fnum, "Дата": date, "Вид": "Фактура", "Обект": r.obekt,
          "Фирма": r.firma || "", "Сума": p.faktTotal, "Към документ": "", "Партида": "",
          "Статус": "активен", "Бележка": r.belejka || "", "Източник": source, "Ред": p.order });
        const mine = live.find(x => x.нов && x._pf === p); if (mine) mine.num = fnum;
      }
      p.netLines.forEach((l: any) => newArt.push({ "Номер": fnum, "Дата": date, "Вид": "Фактура",
        "Обект": r.obekt, "Фирма": r.firma || "", "Код": l.code, "Артикул": l.name,
        "Мярка": l.unit, "Кол.": l.qty, "Цена": l.price, "Партида": "", "Стойност €": l.sum }));
      entry.фактура = fnum; entry.фактура_сума = p.faktTotal; entry.фактура_слята = !!p.fakt;
    }
    written.push(entry);
  }

  const замениНомер = (карта: Map<string, string>) => {
    const см = (v: any) => карта.get(String(v)) ?? v;
    newReg.forEach(x => { x["Номер"] = см(x["Номер"]); });
    newArt.forEach(x => { x["Номер"] = см(x["Номер"]); });
    written.forEach(e => { e.num = см(e.num); if (e["фактура"]) e["фактура"] = см(e["фактура"]); });
    промени.forEach(x => { x.номер = см(x.номер); });
    live.forEach((x: any) => { if (x.num) x.num = см(x.num); });
  };
  if (dry) {
    const к = new Map<string, string>();
    stockNums.forEach((z, i) => к.set(z, `нов-10-${i + 1}`));
    faktNums.forEach((z, i) => к.set(z, `нов-11-${i + 1}`));
    замениНомер(к);
  } else {
    const реални10 = await take("10", needStock);
    const реални11 = await take("11", needFakt);
    const к = new Map<string, string>();
    stockNums.forEach((z, i) => к.set(z, pad10(реални10[i])));
    faktNums.forEach((z, i) => к.set(z, pad10(реални11[i])));
    замениНомер(к);
    const остатък = [...newReg, ...newArt].filter(x => /^@1[01]#/.test(String(x["Номер"])));
    if (остатък.length)
      throw new Error(`${остатък.length} реда останаха без номер - спирам, нищо не е записано.`);
  }

  const итог = {
    дата: date, източник: source, обекти: rows.length,
    нови_стокови: newReg.filter(x => x["Вид"] !== "Фактура").length,
    нови_фактури: newReg.filter(x => x["Вид"] === "Фактура").length,
    слети: written.filter(w => w.слят).length,
    промени,
    артикулни_реда: newArt.length,
    сума_стокови: r2(rows.reduce((a, x) => a + (Number(x.suma) || 0), 0)),
    ред_до: order,
  };

  if (dry) return { сухо: true, ...итог, редове: written, регистър: newReg, артикули: newArt };

  if (mirrorOnly) {
    const w = await writeThroughSheets(
      newReg.map(x => stamp({ ...x })), newArt.map(x => stamp({ ...x })), sumUpd);
    const { липсващи, двойни, артикулни, зле } = await провериЗапис(newReg, newArt, w);
    if (дневникIds.length) await db().collection("_номера").updateMany(
      { _id: { $in: дневникIds } },
      { $set: { статус: зле ? "под въпрос" : "записани", при_запис: new Date() } }).catch(() => {});
    let guardErr = "";
    if (sourceId) {
      if (зле) await пусни();
      else guardErr = await recordSource(sourceId, subject, date,
             (итог as any)["обекти"], (итог as any)["сума_стокови"]);
    }
    return { ok: !зле, истината_е: "листовете", ...итог, редове: written, записване: w,
      ...(guardErr ? { защита: `документите са записани, но редът в ${ЗАЯВКИ} не мина: ${guardErr}` } : {}),
      проверка: { липсващи, двойни, артикулни_разлики: артикулни },
      ...(зле ? { внимание: "Номерата вече са взети. Виж листовете, преди да пуснеш пак - "
                          + "повторно пускане ще издаде НОВИ документи, няма да поправи тези." } : {}) };
  }

  if (newReg.length) await db().collection("РЕГИСТЪР").insertMany(newReg.map(x => stamp({ ...x })));
  if (newArt.length) for (let i = 0; i < newArt.length; i += 2000)
    await db().collection("АРТИКУЛИ").insertMany(newArt.slice(i, i + 2000).map(x => stamp({ ...x })));
  for (const u of sumUpd)
    await db().collection("РЕГИСТЪР").updateOne({ _n: digits(u.num) }, { $set: { "Сума": u.suma } });
  await mirrorQueue([
    ...newReg.map(x => ({ "таблица": "РЕГИСТЪР", "действие": "добавяне", "ред": stamp({ ...x }) })),
    ...newArt.map(x => ({ "таблица": "АРТИКУЛИ", "действие": "добавяне", "ред": stamp({ ...x }) })),
    ...sumUpd.map(u => ({ "таблица": "РЕГИСТЪР", "действие": "промяна", "ключ": u.num,
                          "поле": { "Сума": u.suma } })),
  ]);
  if (sourceId) await recordSource(sourceId, subject, date,
    (итог as any)["обекти"], (итог as any)["сума_стокови"]);
  return { ok: true, ...итог, редове: written, огледало: await tryFlush() };
}

export function netLine(l: any) {
  return { code: l.code, name: l.name, unit: l.unit || "бр", qty: l.qty,
           price: r3((Number(l.price) || 0) / 1.2),
           sum: r2((Number(l.sum) || 0) / 1.2), partida: l.partida || "" };
}

export function regRow(num: string, date: string, vid: string, obekt: string, firma: string,
                suma: number, kum: string, status: string, note: string, src: string, red: any) {
  const o: any = { "Номер": num, "Дата": date, "Вид": vid, "Обект": obekt, "Фирма": firma,
    "Сума": suma, "Към документ": kum, "Партида": "", "Статус": status,
    "Бележка": note, "Източник": src };
  if (red !== "" && red !== null && red !== undefined) o["Ред"] = red;
  return stamp(o);
}

export function artRows(num: string, date: string, vid: string, obekt: string, firma: string, lines: any[]) {
  return lines.map((l: any) => stamp({ "Номер": num, "Дата": date, "Вид": vid, "Обект": obekt,
    "Фирма": firma, "Код": l.code, "Артикул": l.name, "Мярка": l.unit || "бр", "Кол.": l.qty,
    "Цена": l.price, "Партида": l.partida || "", "Стойност €": l.sum }));
}

async function провериЗапис(newReg: any[], newArt: any[], w: any) {
  const nums = newReg.map(x => String(x["Номер"]));
  const очаквани: any = {};
  newArt.forEach(x => { const k = digits(x["Номер"]); очаквани[k] = (очаквани[k] || 0) + 1; });

  const изпратени = Number(w["изпратени"] ?? 0);
  const приложени = Number(w["приложени"] ?? 0);
  const пропуснати = ((w["пропуснати"] || []) as any[]).length;
  const всичкоМина = !w["грешка"] && изпратени > 0 && приложени >= изпратени && !пропуснати;

  const v = await verifyInSheets(nums, !всичкоМина);
  const липсващи = nums.filter(n => !((v["регистър"] as any)[digits(n)] >= 1));
  const двойни = nums.filter(n => ((v["регистър"] as any)[digits(n)] || 0) > 1);
  const артикулни = всичкоМина ? [] : Object.keys(очаквани)
    .filter(k => ((v["артикули"] as any)[k] || 0) < очаквани[k])
    .map(k => `${k}: очаквам ${очаквани[k]} реда, в листа са ${(v["артикули"] as any)[k] || 0}`);
  for (const t of ["РЕГИСТЪР", "АРТИКУЛИ"])
    await db().collection("_meta").updateOne({ _id: t as any },
      { $set: { at: new Date(0) } }, { upsert: true });
  return { липсващи, двойни, артикулни,
           зле: !!w["грешка"] || !!липсващи.length || !!двойни.length || !!артикулни.length };
}

export async function putDocs(newReg: any[], newArt: any[]) {
  const w = await writeThroughSheets(newReg, newArt, []);
  const { липсващи, двойни, артикулни, зле } = await провериЗапис(newReg, newArt, w);
  return { ok: !зле, записване: w, проверка: { липсващи, двойни, артикулни_разлики: артикулни },
    ...(зле ? { внимание: "Номерата вече са взети. Виж листовете, преди да пуснеш пак - "
                        + "повторно пускане ще издаде НОВИ документи, няма да поправи тези." } : {}) };
}
