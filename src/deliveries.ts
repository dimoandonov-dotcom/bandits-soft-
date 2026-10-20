import { db } from "./db";
import { gasCall, writeThroughSheets } from "./gas";
import { свържиСтокови } from "./stokovi";
import { ensureFresh, fetchTab } from "./sync";
import { norm, num2, r2, stamp, канонНомер } from "./util";

export const ДОСТАВКИ = "РЕГИСТЪР_ДОСТАВКИ";
const САМО_СТОКОВИ = ["Д КОРЕКТ"];          // доставчици без фактури изобщо

function чистНомер(v: any): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let пръв = s.split("+")[0].split("/")[0];
  пръв = пръв.split("(")[0];
  return пръв.replace(/\s+/g, "").trim();
}

const ПОПРАВИМИ: Record<string, string[]> = {
  "РЕГИСТЪР_ДОСТАВКИ": ["Номер", "Дата", "Сума", "Доставчик", "Бележка", "Тип_документ", "Статус"],
  "СТОКОВИ_ДОСТАВЧИЦИ": ["Номер", "Дата", "Сума", "Доставчик", "Бележка", "Статус", "Фактура"],
};
export async function fixRow(лист: string, ключ: string, поле: string, стойност: any, dry: boolean) {
  const позволени = ПОПРАВИМИ[лист];
  if (!позволени) throw new Error(`лист „${лист}" не се поправя оттук.`);
  if (!позволени.includes(поле)) throw new Error(`поле „${поле}" не се поправя оттук.`);
  if (!ключ) throw new Error("без ключ - спирам.");
  if (стойност === undefined || стойност === null || String(стойност).trim() === "")
    throw new Error("празна стойност - спирам.");
  await ensureFresh(лист, true);
  const преди = await db().collection(лист).find({}, { projection: { _id: 0 } }).toArray();
  const к = канонНомер(ключ);
  const нам = преди.filter((x: any) => канонНомер(x["Номер"]) === к);
  if (нам.length !== 1) throw new Error(`по „${ключ}" намирам ${нам.length} реда - спирам.`);
  const стар: any = нам[0];
  if (поле === "Номер") {
    const цел = канонНомер(стойност);
    if (преди.some((x: any) => канонНомер(x["Номер"]) === цел))
      throw new Error(`номер ${стойност} вече стои в листа - спирам.`);
  }
  if (dry) return { сухо: true, лист, поле, от: стар[поле], на: стойност, ред: стар };
  const w = await gasCall("mirrorApply", { items: [{ "таблица": лист, "действие": "промяна",
    "ключ": String(стар["Номер"]), "поле": { [поле]: стойност } }] });
  await db().collection("_meta").updateOne({ _id: лист as any },
    { $set: { at: new Date(0) } }, { upsert: true });
  await ensureFresh(лист, true);
  const след = await db().collection(лист).find({}, { projection: { _id: 0 } }).toArray();
  const цел = поле === "Номер" ? канонНомер(стойност) : к;
  const нов: any = след.find((x: any) => канонНомер(x["Номер"]) === цел) || null;
  const стана = !!нов && String(нов[поле] ?? "").trim() === String(стойност).trim()
                && след.length === преди.length;
  return { ok: стана, лист, поле, от: стар[поле], на: стойност,
           редове_преди: преди.length, редове_след: след.length, ред: нов, apps_script: w,
           ...(стана ? {} : { грешка: "листът не изглежда поправен - виж го на ръка." }) };
}

export async function addDeliveries(body: any, dry: boolean) {
  const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new Error("празен списък - няма какво да се записва.");
  if (rows.length > 200) throw new Error("над 200 доставки наведнъж - раздели ги.");

  const готови: any[] = [], отказани: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const доставчик = String(r.dostavchik || r["Доставчик"] || "").trim();
    const дата = String(r.date || r["Дата"] || "").trim();
    const вид = String(r.vid || r["Вид"] || "").trim();
    const сума = r2(r.suma ?? r["Сума"]);
    const номер = чистНомер(r.num ?? r["Номер"]);
    const сурово = String(r.num ?? r["Номер"] ?? "").trim();
    const каза = (з: string) => отказани.push({ ред: i + 1, доставчик, номер: сурово, защо: з });

    if (!доставчик) { каза("без доставчик"); continue; }
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(дата)) { каза(`нечетима дата "${дата}"`); continue; }
    if (!номер) { каза("без номер"); continue; }
    if (!/^\d{3,}$/.test(номер)) { каза(`номер „${номер}" не е числов`); continue; }
    if (!(Math.abs(сума) > 0)) { каза("нулева сума"); continue; }

    const самоСтокови = САМО_СТОКОВИ.some(x => norm(доставчик).includes(x));
    if (вид !== "Ф-ра" && вид !== "КИ") {
      if (!самоСтокови) { каза(`"${вид}" не влиза в справката - само Ф-ра и КИ`); continue; }
    }
    готови.push(stamp({
      "Номер": номер, "Дата": дата, "Вид": самоСтокови && вид !== "Ф-ра" && вид !== "КИ" ? "Ф-ра" : вид,
      "Доставчик": доставчик, "Сума": сума,
      "Тип_документ": String(r.tip || r["Тип_документ"] || (вид === "КИ" ? "Кредитно известие" : "Фактура")).trim(),
      "Статус": "активен",
      "Бележка": String(r.belejka || r["Бележка"] || "").trim(),
      ...(сурово !== номер ? { _сурово: сурово } : {}),
    }));
  }

  await ensureFresh(ДОСТАВКИ, true);
  const има = await db().collection(ДОСТАВКИ)
    .find({}, { projection: { _n: 1, "Номер": 1, "Доставчик": 1, _id: 0 } }).toArray();
  const заети = new Map<string, any>();
  for (const h of има as any[]) {
    for (const к of [канонНомер(h["Номер"]), канонНомер(h._n)]) if (к) заети.set(к, h);
  }
  const видяни = new Set<string>();
  const край: any[] = [];
  for (const g of готови) {
    g._к = канонНомер(g["Номер"]);
    if (заети.has(g._к)) {
      const h: any = заети.get(g._к);
      отказани.push({ доставчик: g["Доставчик"], номер: g["Номер"],
        защо: `вече е в регистъра (${h?.["Доставчик"] || "?"}, № ${h?.["Номер"] ?? "?"})` });
    } else if (видяни.has(g._к)) {
      отказани.push({ доставчик: g["Доставчик"], номер: g["Номер"], защо: "повтаря се в самия пакет" });
    } else { видяни.add(g._к); delete g._к; край.push(g); }
  }

  const итог = { подадени: rows.length, за_запис: край.length, отказани,
                 сума: r2(край.reduce((a, x) => a + num2(x["Сума"]), 0)) };
  if (dry) return { сухо: true, ...итог, редове: край };
  if (!край.length) return { ok: true, ...итог, записани: 0 };

  const w = await writeThroughSheets(край, [], [], ДОСТАВКИ);
  const свързване: any = {};
  for (const ф of край) {
    if (String(ф["Вид"]).trim() !== "Ф-ра") continue;
    const р = await свържиСтокови(ф, false);
    if (р && ((р as any)["свързани"] || (р as any)["грешка"] || (р as any)["бележка"]))
      свързване[String(ф["Номер"])] = р;
  }
  const след = await fetchTab(ДОСТАВКИ);
  const вътре = new Set(след.map((x: any) => канонНомер(x["Номер"])));
  const липсващи = край.filter(x => !вътре.has(канонНомер(x["Номер"]))).map(x => x["Номер"]);
  await db().collection("_meta").updateOne({ _id: ДОСТАВКИ as any },
    { $set: { at: new Date(0) } }, { upsert: true });
  return { ok: !w["грешка"] && !липсващи.length, истината_е: "листовете",
           ...итог, записани: край.length - липсващи.length, записване: w,
           ...(Object.keys(свързване).length ? { свързани_стокови: свързване } : {}),
           ...(липсващи.length ? { липсващи } : {}) };
}
