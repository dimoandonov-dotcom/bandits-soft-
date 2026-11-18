import { SHEET_ID, STALE_MS } from "./config";
import { db, mode } from "./db";
import { parseCSV, stamp } from "./util";

export async function fetchTabChecked(tab: string, задължителни: string[]) {
  const { head, docs } = await fetchTabFull(tab);
  const има = new Set(head.filter(Boolean));
  const липсват = задължителни.filter(k => !има.has(k));
  if (липсват.length)
    throw new Error(`листът ${tab} или го няма, или не е този - липсват колони: `
      + `${липсват.join(", ")}. (Google връща първия лист, когато наименуваният липсва.)`);
  return docs;
}

// 16.11.2026: листът се затваря за външни (беше „всеки с линка" — заедно със заплатите).
// Тогава публичният CSV адрес спира да работи и редовете идват през Apps Script
// (readTab, с ключ). Превключва се с SHEET_VIA_GAS=1 — чак след като е сверено,
// че двата пътя дават еднакви редове.
async function редовеПрезGAS(tab: string): Promise<string[][]> {
  const url = process.env.GAS_URL;
  if (!url) throw new Error("липсва GAS_URL");
  const q = new URLSearchParams({ action: "readTab", name: tab, key_: process.env.GAS_KEY || "", cb: String(Date.now()) });
  const r = await fetch(`${url}?${q}`, { redirect: "follow" });
  const txt = await r.text();
  let j: any;
  try { j = JSON.parse(txt); } catch { throw new Error(`${tab}: нечетим отговор от Apps Script: ${txt.slice(0, 150)}`); }
  const inner = j?.result && typeof j.result === "object" ? j.result : j;
  if (j?.error || inner?.error) throw new Error(`${tab}: ${j?.error || inner?.error}`);
  if (!Array.isArray(inner?.values)) throw new Error(`${tab}: Apps Script не върна редове.`);
  return inner.values.map((r: any[]) => r.map(c => (c === null || c === undefined) ? "" : String(c)));
}
export async function редовеПрезCSV(tab: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
            + `?tqx=out:csv&sheet=${encodeURIComponent(tab)}&cb=${Date.now()}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${tab}: HTTP ${r.status} от Google Sheets.`);
  return parseCSV(await r.text());
}
export { редовеПрезGAS };

async function fetchTabFull(tab: string): Promise<{ head: string[]; docs: any[] }> {
  const rows = process.env.SHEET_VIA_GAS === "1" ? await редовеПрезGAS(tab) : await редовеПрезCSV(tab);
  if (rows.length < 1) throw new Error(`${tab}: празен отговор от Google Sheets.`);
  const head = rows[0].map(h => String(h).trim());
  const docs = rows.slice(1).map((r, i) => {
    const o: any = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = r[j] === undefined ? "" : String(r[j]); });
    return stamp(o);
  });
  return { head, docs };
}

export async function fetchTab(tab: string) {
  return (await fetchTabFull(tab)).docs;
}

const SYNCING: Record<string, Promise<number>> = {};

async function syncOnce(tab: string): Promise<number> {
  const docs = await fetchTab(tab);
  const tmp = `${tab}__tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (docs.length) {
      // 18.11.2026: по 4 пакета наведнъж - АРТИКУЛИ (50 000 реда) се записваха пакет
      // по пакет и само това правеше опресняването над 30 секунди.
      const пакети: any[][] = [];
      for (let i = 0; i < docs.length; i += 2000) пакети.push(docs.slice(i, i + 2000));
      for (let i = 0; i < пакети.length; i += 4)
        await Promise.all(пакети.slice(i, i + 4).map(п => db().collection(tmp).insertMany(п, { ordered: false })));
    } else {
      await db().createCollection(tmp);
    }
    const c = db().collection(tmp);
    const got = await c.countDocuments();
    if (got !== docs.length)
      throw new Error(`${tab}: записах ${got} реда вместо ${docs.length} - спирам, старото остава.`);
    if (tab === "РЕГИСТЪР") await c.createIndexes([{ key: { _d: 1 } }, { key: { _n: 1 } }, { key: { "Статус": 1 } }]);
    if (tab === "АРТИКУЛИ") await c.createIndexes([{ key: { _n: 1 } }, { key: { _d: 1 } }, { key: { "Код": 1 } }]);
    await c.rename(tab, { dropTarget: true });
    await db().collection("_meta").updateOne({ _id: tab as any },
      { $set: { rows: docs.length, at: new Date() } }, { upsert: true });
    return docs.length;
  } finally {
    await db().collection(tmp).drop().catch(() => {});
  }
}

export async function syncTab(tab: string): Promise<number> {
  if (SYNCING[tab]) return await SYNCING[tab];
  const run = syncOnce(tab);
  SYNCING[tab] = run;
  try { return await run; } finally { delete SYNCING[tab]; }
}

export async function sweepTemp() {
  const names = (await db().listCollections({}, { nameOnly: true }).toArray())
    .map((c: any) => c.name).filter((n: string) => /__tmp_|__new$/.test(n));
  for (const n of names) await db().collection(n).drop().catch(() => {});
  return names;
}

async function lastSync(tab: string) {
  const m: any = await db().collection("_meta").findOne({ _id: tab as any });
  return m?.at ? new Date(m.at).getTime() : 0;
}

export async function ensureFresh(tab: string, force: boolean) {
  if (await mode() === "стопанин") return null;
  if (force) {
    // Току-що опреснено (до 15 сек) - не се прави наново. Иначе повторен опит след
    // прекъсната връзка пуска второ 30-секундно опресняване веднага след първото.
    const m0: any = await db().collection("_meta").findOne({ _id: tab as any });
    if (!SYNCING[tab] && m0?.at && Date.now() - new Date(m0.at).getTime() < 15000) return null;
    return await syncTab(tab);
  }
  // 18.11.2026: обикновеното четене вече не чака пълното опресняване. АРТИКУЛИ са
  // 50 000 реда - през Apps Script опресняването отнема над половин минута и печатът
  // от регистъра падаше с „Load failed". Щом в базата вече има данни, отговаря се
  // веднага с тях, а опресняването тръгва отзад (едно на лист). Всичко, което апито
  // само записва, и без това е в базата веднага; със „fresh=1" се чака както преди.
  const m: any = await db().collection("_meta").findOne({ _id: tab as any });
  const at = m?.at ? new Date(m.at).getTime() : 0;
  if (Date.now() - at <= STALE_MS) return null;
  if (at && (m?.rows || 0) > 0) {
    syncTab(tab).catch(e => console.error(`фоново опресняване ${tab}:`, e?.message || e));
    return null;
  }
  return await syncTab(tab);
}
