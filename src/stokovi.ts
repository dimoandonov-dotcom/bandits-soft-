import { db } from "./db";
import { ДОСТАВКИ } from "./deliveries";
import { gasCall, writeThroughSheets } from "./gas";
import { fetchTabChecked } from "./sync";
import { dkey, norm, num2, r2, канонНомер } from "./util";

const СТОКОВИ = "СТОКОВИ_ДОСТАВЧИЦИ";
const ПРОЗОРЕЦ_ДНИ = 45;      // колко назад се гледат стоковите спрямо фактурата
const НАПРЕД_ДНИ = 7;         // фактура с днешна дата покрива и утрешната доставка
const МАКС_КАНДИДАТИ = 18;    // над това комбинациите стават твърде много

const ПЕРИОДИЧНИ = ["ПИРАНИ"];

async function периодНаФактура(дост: string, ден: number, номер: any) {
  if (!ПЕРИОДИЧНИ.some(x => дост.includes(x)))
    return { от: ден - ПРОЗОРЕЦ_ДНИ * 864e5, до: ден + НАПРЕД_ДНИ * 864e5, периодичен: false };
  const негови = await db().collection(ДОСТАВКИ)
    .find({ "Вид": "Ф-ра" }, { projection: { "Доставчик": 1, "Дата": 1, "Номер": 1, _id: 0 } }).toArray();
  const предх = негови
    .filter((x: any) => norm(x["Доставчик"]) === дост
      && канонНомер(x["Номер"]) !== канонНомер(номер)
      && isFinite(денНомер(x["Дата"])) && денНомер(x["Дата"]) < ден)
    .map((x: any) => денНомер(x["Дата"])).sort((a: number, b: number) => b - a)[0];
  return { от: предх === undefined ? ден - 9 * 864e5 : предх + 864e5,
           до: ден + 2 * 864e5, периодичен: true };
}

async function четиСтокови(): Promise<any[]> {
  try {
    return await fetchTabChecked(СТОКОВИ, ["Номер", "Дата", "Доставчик", "Сума", "Към_фактура"]);
  } catch (e: any) {
    throw new Error(`листът ${СТОКОВИ} още го няма или не е както трябва - създай го с колони `
      + `Номер, Дата, Доставчик, Сума, Статус, Към_фактура, Бележка. (${String(e?.message || e)})`);
  }
}

const денНомер = (d: string) => { const k = dkey(d); return k ? Date.parse(k) : NaN; };
const денСтр = (ms: number) => { const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`; };

function комбинации(канд: any[], цел: number): any[][] {
  const цент = Math.round(цел * 100);
  const нам: any[][] = [];
  const n = канд.length;
  const стойности = канд.map(x => Math.round(num2(x["Сума"]) * 100));
  const рек = (i: number, сбор: number, взети: number[]) => {
    if (нам.length >= 2) return;
    if (сбор === цент && взети.length) { нам.push(взети.map(j => канд[j])); return; }
    if (i >= n || сбор > цент) return;
    рек(i + 1, сбор + стойности[i], [...взети, i]);
    рек(i + 1, сбор, взети);
  };
  рек(0, 0, []);
  return нам;
}

export async function свържиСтокови(фактура: any, dry: boolean) {
  let всички: any[];
  try { всички = await четиСтокови(); } catch (e: any) { return { грешка: String(e?.message || e) }; }
  const дост = norm(фактура["Доставчик"]);
  const ден = денНомер(фактура["Дата"]);
  if (!isFinite(ден)) return { пропуснато: "нечетима дата" };
  const пер = await периодНаФактура(дост, ден, фактура["Номер"]);
  const канд = всички.filter((x: any) =>
    norm(x["Доставчик"]) === дост &&
    !String(x["Към_фактура"] || "").trim() &&
    isFinite(денНомер(x["Дата"])) &&
    денНомер(x["Дата"]) >= пер.от && денНомер(x["Дата"]) <= пер.до);
  const общо = r2(канд.reduce((a, x) => a + num2(x["Сума"]), 0));
  if (!канд.length) return { кандидати: 0, свързани: 0, бележка: "няма непокрити стокови за този доставчик" };
  if (канд.length > МАКС_КАНДИДАТИ)
    return { кандидати: канд.length, свързани: 0,
             бележка: `над ${МАКС_КАНДИДАТИ} непокрити стокови - не търся комбинации, виж ги на ръка` };

  const цел = Math.abs(num2(фактура["Сума"]));
  const нам = комбинации(канд, цел);
  if (нам.length === 0)
    return { кандидати: канд.length, свързани: 0, сбор_на_непокритите: общо,
             разлика: r2(общо - цел),
             период: пер.периодичен ? `${денСтр(пер.от)} - ${денСтр(пер.до)}` : undefined,
             бележка: "никоя комбинация не дава сумата на фактурата - вероятно липсва стокова" };
  if (нам.length > 1)
    return { кандидати: канд.length, свързани: 0,
             бележка: "повече от една комбинация дава сумата - не гадая, виж ги на ръка" };

  const избрани = нам[0];
  if (dry) return { кандидати: канд.length, свързани: избрани.length,
                    сухо: true, номера: избрани.map((x: any) => x["Номер"]) };
  const items = избрани.map((x: any) => ({ "таблица": СТОКОВИ, "действие": "промяна",
    "ключ": String(x["Номер"]),
    "поле": { "Статус": "покрита", "Към_фактура": String(фактура["Номер"]) } }));
  try { await gasCall("mirrorApply", { items }); }
  catch (e: any) { return { свързани: 0, грешка: String(e?.message || e) }; }
  return { кандидати: канд.length, свързани: избрани.length,
           номера: избрани.map((x: any) => x["Номер"]),
           сума: r2(избрани.reduce((a: number, x: any) => a + num2(x["Сума"]), 0)) };
}

export async function addStokovi(body: any, dry: boolean) {
  const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new Error("празен списък - няма какво да се записва.");
  if (rows.length > 300) throw new Error("над 300 наведнъж - раздели ги.");
  const има = await четиСтокови();
  const заети = new Set(има.map((x: any) => канонНомер(x["Номер"])));

  const готови: any[] = [], отказани: any[] = [];
  const видяни = new Set<string>();
  rows.forEach((r: any, i: number) => {
    const доставчик = String(r.dostavchik || r["Доставчик"] || "").trim();
    const дата = String(r.date || r["Дата"] || "").trim();
    const сума = r2(r.suma ?? r["Сума"]);
    const номер = String(r.num ?? r["Номер"] ?? "").trim();
    const каза = (з: string) => отказани.push({ ред: i + 1, доставчик, номер, защо: з });
    if (!доставчик) return каза("без доставчик");
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(дата)) return каза(`нечетима дата "${дата}"`);
    if (!номер) return каза("без номер");
    if (!(Math.abs(сума) > 0)) return каза("нулева сума");
    const канон = канонНомер(номер);
    if (заети.has(канон)) return каза("вече е в регистъра на стоковите");
    if (видяни.has(канон)) return каза("повтаря се в самия пакет");
    видяни.add(канон);
    готови.push({ "Номер": номер, "Дата": дата, "Доставчик": доставчик, "Сума": сума,
      "Статус": "без фактура", "Към_фактура": "",
      "Бележка": String(r.belejka || r["Бележка"] || "").trim() });
  });

  const итог = { подадени: rows.length, за_запис: готови.length, отказани,
                 сума: r2(готови.reduce((a, x) => a + num2(x["Сума"]), 0)) };
  if (dry) return { сухо: true, ...итог, редове: готови };
  if (!готови.length) return { ok: true, ...итог, записани: 0 };
  const w = await writeThroughSheets(готови, [], [], СТОКОВИ);
  const след = await четиСтокови();
  const вътре = new Set(след.map((x: any) => канонНомер(x["Номер"])));
  const липсващи = готови.filter(x => !вътре.has(канонНомер(x["Номер"]))).map(x => x["Номер"]);
  return { ok: !w["грешка"] && !липсващи.length, истината_е: "листовете", ...итог,
           записани: готови.length - липсващи.length, записване: w,
           ...(липсващи.length ? { липсващи } : {}) };
}

export async function непокрити(дост: string) {
  const всички = await четиСтокови();
  const о = всички.filter((x: any) => !String(x["Към_фактура"] || "").trim()
    && (!дост || norm(x["Доставчик"]) === norm(дост)));
  const по: any = {};
  о.forEach((x: any) => {
    const d = String(x["Доставчик"] || "").trim();
    (по[d] = по[d] || { брой: 0, сума: 0, редове: [] });
    по[d].брой++; по[d].сума = r2(по[d].сума + num2(x["Сума"]));
    по[d].редове.push({ номер: x["Номер"], дата: x["Дата"], сума: num2(x["Сума"]) });
  });
  return { непокрити: о.length, сума: r2(о.reduce((a, x) => a + num2(x["Сума"]), 0)), по_доставчик: по };
}
