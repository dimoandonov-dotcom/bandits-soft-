import { fetchTab } from "./sync";
import { digits } from "./util";

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
// БЕЗ повторен опит - нарочно.
//
// Дотук при „Липсва action" се чакаше 1.5 сек и се пробваше пак. Това има
// смисъл само ако първият опит НЕ е направил нищо. Но през gasCall минават
// единствено ЗАПИСИ - reserveNumbers и mirrorApply, нито едно четене. А
// „Липсва action" значи, че Google е пренасочил заявката и отговорът се е
// загубил; дали записът е минал, оттук не се вижда. Минал ли е, повторният
// опит го прави ВТОРИ ПЪТ.
//
// Точно така на 25.10.2026 редовете на цялата дневна заявка влязоха по два
// пъти в листа АРТИКУЛИ: 54 от 68 документа, 736 излишни реда, всеки
// документ с двойна сума при печат. Сумите в регистъра си останаха верни,
// затова нищо не изгърмя - видя се чак на екрана за печат.
//
// Затова: един опит. Провали ли се, човекът вижда грешката и пуска наново -
// а повторното пускане е безопасно, защото номерата се взимат чак накрая и
// при провал нищо не е записано. По-добре да падне на видно място, отколкото
// да се удвои тихо.
export async function gasCall(action: string, extra: any) {
  return await gasOnce(action, extra);
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
