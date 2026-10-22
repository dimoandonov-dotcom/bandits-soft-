import { db } from "./db";
import { gasCall, gasReserve } from "./gas";
import { artRows, netLine, putDocs, regRow } from "./issue";
import { ensureFresh, fetchTabChecked } from "./sync";
import { digits, dkey, pad10, r2 } from "./util";

const ИЗДАДЕНИ_КИ = "ИЗДАДЕНИ_КИ";

async function claimCredits(id: string) {
  const sheet = await fetchTabChecked(ИЗДАДЕНИ_КИ, ["Идентификатор", "Издадено на"]);
  const hit: any = sheet.find((r: any) => String(r["Идентификатор"] || "").trim() === id);
  if (hit) return { зает: true, кога: String(hit["Издадено на"] || "") };
  try {
    await db().collection("_издадени_ки").insertOne({ _id: id as any, при: new Date() } as any);
  } catch (e: any) {
    if (e?.code === 11000) {
      const d: any = await db().collection("_издадени_ки").findOne({ _id: id as any });
      return { зает: true, кога: d?.при ? new Date(d.при).toLocaleString("bg-BG") : "по-рано" };
    }
    throw e;
  }
  return { зает: false, кога: "" };
}

export async function issueCredits(body: any, dry: boolean) {
  const date = String(body.date || "").trim();
  const subject = String(body.subject || "").trim();
  const sourceId = String(body.source_id || "").trim();
  const notes: any[] = Array.isArray(body.notes) ? body.notes : [];
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) throw new Error(`нечетима дата "${date}".`);
  if (!notes.length) throw new Error("празен списък - няма какво да се издава.");
  if (notes.length > 300) throw new Error("над 300 известия наведнъж - раздели ги.");
  for (let i = 0; i < notes.length; i++)
    if (!String(notes[i].obekt || "").trim()) throw new Error(`известие ${i + 1} е без обект - спирам.`);

  if (sourceId && !dry) {
    const c = await claimCredits(sourceId);
    if (c["зает"]) return { duplicate: true, loadedAt: c["кога"],
      съобщение: `Този файл с връщания вече е издаден на ${c["кога"]} - нищо не е записано повторно.` };
  }
  // От заключването нататък всичко е в try: при изключение файлът се отключва.
  // Иначе остава заключен завинаги и не може да се пусне повторно - точно това
  // стана на 21.10.2026, когато `netLine` липсваше и функцията гръмна тук.
  try {
    return await издай();
  } catch (e) {
    if (sourceId && !dry)
      await db().collection("_издадени_ки").deleteOne({ _id: sourceId as any }).catch(() => {});
    throw e;
  }

  async function издай() {
  if (!dry) await ensureFresh("РЕГИСТЪР", true);
  const day = await db().collection("РЕГИСТЪР").find({ _d: dkey(date) }).toArray();
  let order = 0;
  day.forEach((r: any) => { const v = Number(r["Ред"]) || 0; if (v > order) order = v; });

  // Номерата се вземат ЧАК СЛЕД като всичко е построено - виж замениНомер по-долу.
  // Дотогава редовете носят запазено място. Преди номерата се заделяха тук и при
  // всеки провал се изяждаха безвъзвратно (11 броя на 21.10.2026).
  const ЗАПАЗЕНО = (i: number) => `@11#${i}`;
  const nums = notes.map((_, i) => dry ? `нов-11-${i + 1}` : ЗАПАЗЕНО(i));
  const newReg: any[] = [], newArt: any[] = [], written: any[] = [];
  notes.forEach((n: any, i: number) => {
    const num = nums[i];
    const netLines = (n.lines || []).map((l: any) => ({ ...netLine(l), partida: "" }));
    const base = r2(netLines.reduce((a: number, l: any) => a + l.sum, 0));
    const vat = r2(base * 0.2);
    const total = netLines.length ? r2(base + vat) : (Number(n.suma) || 0);
    newReg.push(regRow(num, date, "КИ", String(n.obekt).trim(), n.firma || "", total,
      n.kum || "", "активен", "Връщания — " + subject, "Връщания (мейл)", ++order));
    newArt.push(...artRows(num, date, "КИ", String(n.obekt).trim(), n.firma || "", netLines));
    written.push({ num, obekt: n.obekt, suma: total, kum: n.kum || "" });
  });

  const сума = r2(notes.reduce((a: number, n: any) => a + (Number(n.suma) || 0), 0));
  const итог = { дата: date, източник: subject, известия: notes.length,
                 артикулни_реда: newArt.length, сума: сума, ред_до: order };
  if (dry) return { сухо: true, ...итог, written, регистър: newReg, артикули: newArt };

  // Истинските номера - подменя се и `_n`, иначе редът остава с отпечатък от
  // запазеното място и не се познава по номер.
  const реални = await gasReserve("11", notes.length, date);
  const карта = new Map<string, string>();
  nums.forEach((z, i) => карта.set(z, pad10(реални[i])));
  const см = (v: any) => карта.get(String(v)) ?? v;
  [...newReg, ...newArt].forEach((x: any) => { x["Номер"] = см(x["Номер"]); x._n = digits(x["Номер"]); });
  written.forEach((w: any) => { w.num = см(w.num); });
  const остатък = [...newReg, ...newArt].filter((x: any) => /^@11#/.test(String(x["Номер"])));
  if (остатък.length)
    throw new Error(`${остатък.length} реда останаха без номер - спирам, нищо не е записано.`);

  const res: any = await putDocs(newReg, newArt);
  if (sourceId) {
    if (!res.ok) await db().collection("_издадени_ки").deleteOne({ _id: sourceId as any }).catch(() => {});
    else {
      try {
        await gasCall("mirrorApply", { items: [{ "таблица": ИЗДАДЕНИ_КИ, "действие": "добавяне", "ред": {
          "Идентификатор": sourceId, "Издадено на": new Date().toLocaleString("bg-BG"),
          "Тема": subject, "Дата документи": date, "Брой КИ": written.length, "Сума": сума } }] });
      } catch (e: any) {
        (res as any)["защита"] = `КИ-тата са записани, но редът в ${ИЗДАДЕНИ_КИ} не мина: ${String(e?.message || e)}`;
      }
    }
  }
  return { истината_е: "листовете", ...итог, written, ...res };
  }
}
