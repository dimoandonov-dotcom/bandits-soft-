import { db } from "./db";
import { gasReserve } from "./gas";
import { artRows, netLine, putDocs, regRow } from "./issue";
import { ensureFresh } from "./sync";
import { dkey, pad10, r2 } from "./util";

export async function manualSale(body: any, dry: boolean) {
  const date = String(body.date || "").trim();
  const obekt = String(body.obekt || "").trim();
  const firma = String(body.firma || "").trim();
  const note = String(body.note || "").trim() || "ръчна продажба";
  const lines: any[] = Array.isArray(body.lines) ? body.lines : [];
  const vidove: string[] = (Array.isArray(body.docTypes) && body.docTypes.length)
    ? body.docTypes.map((x: any) => String(x).trim()) : ["Стокова"];
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) throw new Error(`нечетима дата "${date}".`);
  if (!obekt) throw new Error("липсва обект - спирам.");
  if (!lines.length) throw new Error("празен списък редове - няма какво да се издава.");
  for (const v of vidove)
    if (v !== "Стокова" && v !== "Фактура")
      throw new Error(`непознат вид документ "${v}" - само Стокова и Фактура.`);

  const grossTotal = r2(lines.reduce((a, l) => a + (Number(l.sum) || 0), 0));

  if (!dry) await ensureFresh("РЕГИСТЪР", true);
  const day = await db().collection("РЕГИСТЪР").find({ _d: dkey(date) }).toArray();
  let maxOrder = 0;
  day.forEach((r: any) => { const v = Number(r["Ред"]) || 0; if (v > maxOrder) maxOrder = v; });
  const thisOrder = maxOrder + 1;   // стоковата и фактурата носят ЕДИН ред, за да не се разделят при печат

  const newReg: any[] = [], newArt: any[] = [], docs: any[] = [];
  for (const vid of vidove) {
    const series = vid === "Стокова" ? "10" : "11";
    const num = dry ? `нов-${series}` : pad10((await gasReserve(series, 1, date))[0]);
    const isFakt = vid !== "Стокова";
    const ls = isFakt ? lines.map((l: any) => ({ ...netLine(l), partida: "" }))
                      : lines.map((l: any) => ({ code: l.code, name: l.name, unit: l.unit || "бр",
                          qty: l.qty, price: Number(l.price) || 0, partida: l.partida || "",
                          sum: Number(l.sum) || 0 }));
    newReg.push(regRow(num, date, vid, obekt, firma, grossTotal, "", "активен", note, "ръчно въведено", thisOrder));
    newArt.push(...artRows(num, date, vid, obekt, firma, ls));
    docs.push({ num, vid, total: grossTotal });
  }

  const итог = { дата: date, обект: obekt, фирма: firma, ред: thisOrder,
                 документи: docs, сума: grossTotal, артикулни_реда: newArt.length };
  if (dry) return { сухо: true, ...итог, регистър: newReg, артикули: newArt };
  return { истината_е: "листовете", ...итог, ...(await putDocs(newReg, newArt)) };
}

export async function manualNote(body: any, dry: boolean) {
  const vid = String(body.vid || "").trim();
  if (vid !== "КИ" && vid !== "ДИ") throw new Error(`непознат вид "${vid}" - само КИ или ДИ.`);
  const date = String(body.date || "").trim();
  const obekt = String(body.obekt || "").trim();
  const firma = String(body.firma || "").trim();
  const kum = String(body.kum || "").trim();
  const lines: any[] = Array.isArray(body.lines) ? body.lines : [];
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) throw new Error(`нечетима дата "${date}".`);
  if (!obekt) throw new Error("липсва обект - спирам.");
  if (!lines.length) throw new Error("празен списък редове - няма какво да се издава.");
  for (const l of lines)
    if (!(Number(l.price) > 0) || !(Number(l.sum) > 0))
      throw new Error(`Ред "${l.name || l.code}" има нулева/отрицателна цена или стойност `
        + `- правило 20 не позволява такъв ред в ${vid}.`);

  const netLines = lines.map(netLine);
  const base = r2(netLines.reduce((a, l) => a + l.sum, 0));
  const vat = r2(base * 0.2);
  const total = r2(base + vat);   // основа -> ДДС -> сума, както е при всички КИ/ДИ

  const num = dry ? "нов-11" : pad10((await gasReserve("11", 1, date))[0]);
  const note = String(body.note || "").trim()
    || (vid === "КИ" ? "ръчно КИ" : "ръчно ДИ - сторниране на КИ");
  const newReg = [regRow(num, date, vid, obekt, firma, total, kum, "активен", note, "ръчно въведено", "")];
  const newArt = artRows(num, date, vid, obekt, firma, netLines);

  const итог = { дата: date, вид: vid, номер: num, обект: obekt, фирма: firma,
                 към_документ: kum, основа: base, ддс: vat, сума: total,
                 артикулни_реда: newArt.length };
  if (dry) return { сухо: true, ...итог, регистър: newReg, артикули: newArt };
  return { истината_е: "листовете", ...итог, ...(await putDocs(newReg, newArt)) };
}
