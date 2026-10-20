import { fetchTab } from "./sync";
import { digits } from "./util";

const ПРАЗНО_ПОВИКВАНЕ = /Липсва action|нечетим отговор/i;
async function gasOnce(action: string, extra: any) {
  const url = process.env.GAS_URL;
  if (!url) throw new Error("липсва GAS_URL - не знам накъде да пиша.");
  const r = await fetch(url, { method: "POST", redirect: "follow",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }) });
  const txt = await r.text();
  let res: any;
  try { res = JSON.parse(txt); } catch { throw new Error(`${action}: нечетим отговор: ${txt.slice(0, 200)}`); }
  const inner = res?.result && typeof res.result === "object" ? res.result : res;
  if (res?.error || inner?.error) throw new Error(`${action}: ${res?.error || inner?.error}`);
  return inner;
}
export async function gasCall(action: string, extra: any) {
  try { return await gasOnce(action, extra); }
  catch (e: any) {
    if (!ПРАЗНО_ПОВИКВАНЕ.test(String(e?.message || e))) throw e;
    await new Promise(s => setTimeout(s, 1500));
    return await gasOnce(action, extra);
  }
}

export async function gasReserve(series: string, n: number, docDate: string): Promise<string[]> {
  if (n <= 0) return [];
  const inner = await gasCall("reserveNumbers", { series, count: n, date: docDate });
  const nums = (inner?.numbers || []).map((x: any) => String(x));
  if (nums.length !== n)
    throw new Error(`Apps Script върна ${nums.length} номера вместо ${n} - спирам, нищо не е записано.`);
  return nums;
}

export async function writeThroughSheets(newReg: any[], newArt: any[], sumUpd: any[], лист = "РЕГИСТЪР") {
  if (!лист) throw new Error("writeThroughSheets без лист - спирам.");
  const items = [
    ...newReg.map(x => ({ "таблица": лист, "действие": "добавяне", "ред": x })),
    ...newArt.map(x => ({ "таблица": "АРТИКУЛИ", "действие": "добавяне", "ред": x })),
    ...sumUpd.map(u => ({ "таблица": лист, "действие": "промяна", "ключ": u.num,
                          "поле": { "Сума": u.suma } })),
  ];
  let sent = 0, applied = 0, skipped: any[] = [], err = "";
  for (let i = 0; i < items.length; i += 400) {
    const chunk = items.slice(i, i + 400);
    try {
      const inner = await gasCall("mirrorApply", { items: chunk });
      applied += Number(inner?.["приложени"] ?? 0);
      skipped = skipped.concat(inner?.["пропуснати"] || []);
      sent += chunk.length;
    } catch (e: any) { err = String(e?.message || e); break; }
  }
  return { изпратени: sent, приложени: applied, пропуснати: skipped, грешка: err };
}

async function четиБрой(tab: string, want: Set<string>) {
  const rows = await fetchTab(tab);
  const c: any = {};
  rows.forEach((x: any) => { if (want.has(x._n)) c[x._n] = (c[x._n] || 0) + 1; });
  return c;
}

export async function verifyInSheets(nums: string[], дълбоко: boolean) {
  const want = new Set(nums.map(n => digits(n)));
  let r: any = {}, a: any = {};
  for (let опит = 1; опит <= 3; опит++) {
    r = await четиБрой("РЕГИСТЪР", want);
    a = дълбоко ? await четиБрой("АРТИКУЛИ", want) : {};
    const празно = !Object.keys(r).length || (дълбоко && !Object.keys(a).length);
    if (!празно || опит === 3) break;
    await new Promise(s => setTimeout(s, 4000));
  }
  return { регистър: r, артикули: a };
}
