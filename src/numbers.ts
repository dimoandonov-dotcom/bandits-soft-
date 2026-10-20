import { SERIES } from "./config";
import { db } from "./db";
import { fetchTab } from "./sync";
import { digits, dkey, pad10 } from "./util";

export async function seedCounters() {
  const out: any = {};
  const nom = await fetchTab("НОМЕРАЦИЯ");
  for (const s of SERIES) {
    const row: any = nom.find((r: any) => String(r["Серия"] || "").trim() === s);
    const fromSheet = Number(digits(row?.["Последен_номер"] || 0)) || 0;
    const top = await db().collection("РЕГИСТЪР")
      .find({ _n: { $regex: `^${s}\\d{8}$` } }).sort({ _n: -1 }).limit(1).toArray();
    const fromReg = Number((top[0] as any)?._n || 0) || 0;
    const last = Math.max(fromSheet, fromReg);
    if (!last) throw new Error(`серия ${s}: не намирам от какво да засея брояча.`);
    const byDate = await db().collection("РЕГИСТЪР")
      .find({ _n: { $regex: `^${s}\\d{8}$` }, _d: { $ne: "" } }).sort({ _d: -1 }).limit(1).toArray();
    const lastKey = String((byDate[0] as any)?._d || "");
    const lastDate = String((byDate[0] as any)?.["Дата"] || "");
    await db().collection("counters").updateOne({ _id: s as any },
      { $max: { last }, $setOnInsert: { series: s },
        ...(lastKey ? { $set: { lastKey, lastDate } } : {}) } as any, { upsert: true });
    out[s] = { брояч: last, от_НОМЕРАЦИЯ_на_живо: fromSheet, от_РЕГИСТЪР: fromReg,
               дата_на_серията: lastDate || "(няма)" };
  }
  return out;
}

export async function reserveNums(series: string, n: number, docDate: string) {
  if (n <= 0) return [];
  if (!SERIES.includes(series)) throw new Error(`непозната серия ${series}`);
  const k = dkey(docDate);
  if (!k) throw new Error(`нечетима дата "${docDate}".`);
  const r: any = await db().collection("counters").findOneAndUpdate(
    { _id: series as any, $or: [{ lastKey: { $exists: false } }, { lastKey: { $lte: k } }] },
    { $inc: { last: n }, $max: { lastKey: k }, $set: { lastDate: docDate, при: new Date() } },
    { returnDocument: "after" });
  if (!r) {
    const cur: any = await db().collection("counters").findOne({ _id: series as any });
    if (!cur) throw new Error(`брояч ${series} не е засят - пусни /counters/seed`);
    throw new Error(`Номерата на серия ${series} вече стигнаха дата ${cur.lastDate || cur.lastKey}. `
      + `Не мога да продължа поредицата с по-стара дата (${docDate}) - номер по-нагоре `
      + `не може да носи по-стара дата от предходния.`);
  }
  const end = Number(r.last), start = end - n + 1;
  const nums: string[] = [];
  for (let i = start; i <= end; i++) nums.push(String(i));
  const clash = await db().collection("РЕГИСТЪР")
    .find({ _n: { $in: nums.map(x => pad10(x)) } }, { projection: { _n: 1, _id: 0 } }).toArray();
  if (clash.length) throw new Error(
    `номера ${clash.map((c: any) => c._n).join(", ")} вече съществуват в регистъра - спирам.`);
  return nums;
}
