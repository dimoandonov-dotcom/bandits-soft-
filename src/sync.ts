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

async function fetchTabFull(tab: string): Promise<{ head: string[]; docs: any[] }> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
            + `?tqx=out:csv&sheet=${encodeURIComponent(tab)}&cb=${Date.now()}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${tab}: HTTP ${r.status} от Google Sheets.`);
  const rows = parseCSV(await r.text());
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
      for (let i = 0; i < docs.length; i += 2000)
        await db().collection(tmp).insertMany(docs.slice(i, i + 2000), { ordered: false });
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
  if (force || Date.now() - (await lastSync(tab)) > STALE_MS) return await syncTab(tab);
  return null;
}
