import { KEYS, TABS } from "./config";
import { db } from "./db";
import { mirrorQueue, tryFlush } from "./mirror";
import { digits, stamp } from "./util";

export async function addRows(tab: string, rows: any[]) {
  if (!TABS.includes(tab)) throw new Error(`непозната таблица ${tab}`);
  if (!Array.isArray(rows) || !rows.length) throw new Error("празен списък редове.");
  if (rows.length > 2000) throw new Error("над 2000 реда наведнъж - раздели ги.");
  const key = KEYS[tab];
  const docs = rows.map(r => stamp({ ...r }));
  if (key && tab !== "АРТИКУЛИ") {
    const vals = docs.map(d => String(d[key] ?? "").trim());
    if (vals.some(v => !v)) throw new Error(`има ред без ${key} - спирам, нищо не е записано.`);
    const dup = vals.filter((v, i) => vals.indexOf(v) !== i);
    if (dup.length) throw new Error(`${key} се повтаря в самия пакет: ${[...new Set(dup)].join(", ")}`);
    const have = await db().collection(tab).find({ [key]: { $in: vals } },
      { projection: { [key]: 1, _id: 0 } }).toArray();
    if (have.length) throw new Error(
      `вече съществува в базата: ${have.map((h: any) => h[key]).join(", ")} - спирам, нищо не е записано.`);
  }
  const res = await db().collection(tab).insertMany(docs, { ordered: true });
  await mirrorQueue(docs.map(d => ({ "таблица": tab, "действие": "добавяне", "ред": d })));
  return { таблица: tab, записани: res.insertedCount, огледало: await tryFlush() };
}

export async function setRow(tab: string, keyVal: string, set: any) {
  if (!TABS.includes(tab)) throw new Error(`непозната таблица ${tab}`);
  const key = KEYS[tab];
  if (!key) throw new Error(`за ${tab} няма ключ за единичен ред.`);
  const v = String(keyVal ?? "").trim();
  if (!v) throw new Error(`липсва ${key}.`);
  if (!set || typeof set !== "object" || !Object.keys(set).length) throw new Error("няма какво да се промени.");
  for (const f of Object.keys(set)) if (f.startsWith("_")) throw new Error(`служебното поле ${f} не се пипа отвън.`);
  const q = (tab === "РЕГИСТЪР" || tab === "РЕГИСТЪР_ДОСТАВКИ") ? { _n: digits(v) } : { [key]: v };
  const n = await db().collection(tab).countDocuments(q);
  if (n !== 1) throw new Error(
    `${v} отговаря на ${n} реда в ${tab}, а трябва на точно един - не пипам нищо.`);
  await db().collection(tab).updateOne(q, { $set: stamp({ ...set }) });
  await mirrorQueue([{ "таблица": tab, "действие": "промяна", "ключ": v, "поле": set }]);
  return { таблица: tab, ключ: v, променени: 1, полета: Object.keys(set), огледало: await tryFlush() };
}

export async function stashPut(key: string, text: string, part: number, total: number) {
  if (!key) throw new Error("липсва ключ.");
  await db().collection("_stash").updateOne({ _id: `${key}#${part}` as any },
    { $set: { key, part, total, text, при: new Date() } }, { upsert: true });
  const have = await db().collection("_stash").countDocuments({ key });
  return { ключ: key, част: part, от: total, получени: have, знаци: text.length };
}
export async function stashGet(key: string) {
  const parts = await db().collection("_stash").find({ key }).sort({ part: 1 }).toArray();
  if (!parts.length) throw new Error(`няма нищо под ключ ${key}`);
  const total = Number((parts[0] as any).total || parts.length);
  if (parts.length !== total) throw new Error(`непълно: ${parts.length} от ${total} части`);
  return parts.map((p: any) => p.text).join("");
}
