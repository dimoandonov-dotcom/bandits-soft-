import { db } from "./db";

export async function mirrorQueue(items: any[]) {
  if (items.length) await db().collection("_mirror").insertMany(
    items.map(x => ({ ...x, при: new Date(), готово: false })));
}

export async function flushMirror(limit = 200) {
  const url = process.env.GAS_URL;
  if (!url) throw new Error("липсва GAS_URL - не знам накъде да пиша огледалото.");
  const pend = await db().collection("_mirror")
    .find({ готово: false }).sort({ при: 1 }).limit(limit).toArray();
  if (!pend.length) return { изпратени: 0, приложени: 0, чакат: 0, пропуснати: [] };
  const items = pend.map((p: any) => ({
    "таблица": p["таблица"], "действие": p["действие"],
    "ред": p["ред"], "ключ": p["ключ"], "поле": p["поле"],
  }));
  const r = await fetch(url, { method: "POST", redirect: "follow",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "mirrorApply", items }) });
  const txt = await r.text();
  let res: any;
  try { res = JSON.parse(txt); } catch { throw new Error(`огледалото върна нечетим отговор: ${txt.slice(0, 200)}`); }
  const inner = res?.result && typeof res.result === "object" ? res.result : res;
  if (res?.error || inner?.error) throw new Error(`огледалото отказа: ${res?.error || inner?.error}`);
  const applied = Number(inner?.["приложени"] ?? 0);
  const skipped = inner?.["пропуснати"] || [];
  await db().collection("_mirror").updateMany(
    { _id: { $in: pend.map((p: any) => p._id) } },
    { $set: { готово: true, записано_на: new Date(), пропуснато: skipped.length > 0 } });
  if (skipped.length) await db().collection("_meta").updateOne({ _id: "огледало" as any },
    { $push: { пропуснати: { при: new Date(), списък: skipped } } } as any, { upsert: true });
  const left = await db().collection("_mirror").countDocuments({ готово: false });
  return { изпратени: pend.length, приложени: applied, чакат: left, пропуснати: skipped };
}

export async function tryFlush() {
  try { return await flushMirror(); }
  catch (e: any) {
    await db().collection("_meta").updateOne({ _id: "огледало" as any },
      { $push: { провали: { при: new Date(), грешка: String(e?.message || e) } } } as any, { upsert: true });
    return { грешка: String(e?.message || e) };
  }
}
