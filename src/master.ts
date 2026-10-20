import { MASTER_URL } from "./config";
import { db } from "./db";

// Обектите с ЕИК, ДДС, МОЛ и адреси. Истината е в листовете; тук се държи
// копие в базата, за да не зависят проверките от публичния master.json.
//
// Защо изобщо: докато обектите се дърпаха само от публичния адрес с try/catch,
// падне ли адресът (или му се сложи парола), проверките "издадени без реквизити"
// и "документи на непознат обект" тихо отпадаха, а справката излизаше
// ПО-ЧИСТА ОТ ИСТИНАТА. Затова тук се връща и откъде са дошли данните, а
// който ги ползва, е длъжен да каже, ако ги няма.

export const ОБЕКТИ = "_obekti";

export type Обекти = { обекти: any[]; източник: string };

export async function четиОбекти(): Promise<Обекти> {
  // 1) базата
  try {
    const docs = await db().collection(ОБЕКТИ).find({}, { projection: { _id: 0 } }).toArray();
    if (docs.length) return { обекти: docs, източник: "базата" };
  } catch {}
  // 2) публичният адрес - само докато базата още не е напълнена
  try {
    const r = await fetch(MASTER_URL, { redirect: "follow" });
    if (r.ok) {
      const m: any = await r.json();
      const objs = m.objects || m || [];
      if (Array.isArray(objs) && objs.length) return { обекти: objs, източник: "master.json" };
    }
  } catch {}
  return { обекти: [], източник: "няма" };
}

export async function запишиОбекти(objs: any[]): Promise<number> {
  if (!Array.isArray(objs) || !objs.length) throw new Error("празен списък с обекти - отказано");
  const c = db().collection(ОБЕКТИ);
  await c.deleteMany({});
  await c.insertMany(objs.map((o: any) => ({ ...o })));
  return objs.length;
}
