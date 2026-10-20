import { TABS } from "./config";
import { issueCredits } from "./credits";
import { conn, db, mode } from "./db";
import { дедПлан, дедРевизия } from "./deduction";
import { addDeliveries, fixRow } from "./deliveries";
import { issueDocs } from "./issue";
import { manualNote, manualSale } from "./manual";
import { flushMirror } from "./mirror";
import { reserveNums, seedCounters } from "./numbers";
import { dailyCheck, healthCheck } from "./reports";
import { addRows, setRow, stashGet, stashPut } from "./sheetops";
import { addStokovi, непокрити } from "./stokovi";
import { запишиОбекти, четиОбекти } from "./master";
import { ensureFresh, sweepTemp, syncTab } from "./sync";
import { digits, dkey } from "./util";

function buildQuery(tab: string, p: URLSearchParams) {
  const q: any = {};
  const from = p.get("from"), to = p.get("to"), date = p.get("date");
  if (date) q._d = dkey(date);
  else if (from || to) {
    q._d = {};
    if (from) q._d.$gte = dkey(from);
    if (to)   q._d.$lte = dkey(to);
    if (!Object.keys(q._d).length) delete q._d;
  }
  const nums = p.get("nums");
  if (nums) q._n = { $in: nums.split(",").map(s => digits(s)).filter(Boolean) };
  for (const f of ["Статус", "Вид", "Обект", "Фирма", "Код", "Доставчик", "Серия"]) {
    const v = p.get(f);
    if (v) q[f] = { $in: v.split("|") };
  }
  return q;
}

// Беше "*". Стеснено до страницата; ALLOW_ORIGIN може да го смени,
// а ALLOW_ORIGIN="*" връща старото поведение, ако дотрябва.
const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOW_ORIGIN || "https://bandits-import.netlify.app",
  "Access-Control-Allow-Headers": "content-type,x-bandits-key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (o: any, code = 200) =>
  new Response(JSON.stringify(o), { status: code, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(req: Request) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    try {
      await conn();
      const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const arg = (k: string) => (body[k] !== undefined ? body[k] : u.searchParams.get(k));
      const want = process.env.WRITE_KEY || "";
      const given = req.headers.get("x-bandits-key") || String(arg("key_") || "");
      const guard = () => {
        if (!want) throw new Error("WRITE_KEY не е зададен на услугата - писането е спряно.");
        if (given !== want) throw new Error("грешен или липсващ ключ.");
      };

      if (u.pathname === "/" || u.pathname === "/health") {
        const meta = await db().collection("_meta").find({ _id: { $in: TABS } } as any).toArray();
        const cnt = await db().collection("counters").find({}).toArray();
        const pending = await db().collection("_mirror").countDocuments({ готово: false });
        const live: any = {};
        for (const t of TABS) live[t] = await db().collection(t).countDocuments();
        return json({ ok: true, режим: await mode(),
          tables: meta.map((m: any) => ({ name: m._id, rows: m.rows, at: m.at, в_базата: live[m._id] })),
          counters: cnt.map((c: any) => ({ series: c._id, last: c.last, дата: c.lastDate || "" })),
          чакат_огледало: pending });
      }

      if (u.pathname === "/check") return json({ ok: true, ...(await healthCheck()) });

      if (u.pathname === "/daily") {
        const arg2 = (k: string) => String(u.searchParams.get(k) || "");
        let from = arg2("from");
        if (!from && !arg2("to")) {           // по подразбиране: последните 3 дни
          const d = new Date(Date.now() - 3 * 864e5);
          from = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
        }
        return json({ ok: true, ...(await dailyCheck(from, arg2("to"))) });
      }

      if (u.pathname === "/issue") {
        if (req.method !== "POST") return json({ error: "само POST" }, 405);
        const dry = u.searchParams.get("dry") === "1" || body.dry === true;
        if (!dry) guard();
        return json(await issueDocs(body, dry));
      }

      if (u.pathname === "/stokovi") {
        const dry = u.searchParams.get("dry") === "1" || body.dry === true;
        if (req.method !== "POST")
          return json({ ok: true, ...(await непокрити(String(u.searchParams.get("dostavchik") || ""))) });
        if (!dry) guard();
        return json(await addStokovi(body, dry));
      }

      if (u.pathname === "/deliveries") {
        if (req.method !== "POST") return json({ error: "само POST" }, 405);
        const dry = u.searchParams.get("dry") === "1" || body.dry === true;
        if (!dry) guard();
        return json(await addDeliveries(body, dry));
      }

      if (u.pathname === "/credits") {
        if (req.method !== "POST") return json({ error: "само POST" }, 405);
        const dry = u.searchParams.get("dry") === "1" || body.dry === true;
        if (!dry) guard();
        return json(await issueCredits(body, dry));
      }

      if (u.pathname === "/sale" || u.pathname === "/note") {
        if (req.method !== "POST") return json({ error: "само POST" }, 405);
        const dry = u.searchParams.get("dry") === "1" || body.dry === true;
        if (!dry) guard();
        return json(await (u.pathname === "/sale" ? manualSale(body, dry) : manualNote(body, dry)));
      }

      if (u.pathname === "/stash") {
        guard();
        if (req.method === "POST")
          return json({ ok: true, ...(await stashPut(String(body.name || ""), String(body.text || ""),
            Number(body.part || 1), Number(body.total || 1))) });
        return new Response(await stashGet(String(arg("name") || "")),
          { headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
      }

      if (u.pathname === "/fix") {
        if (req.method !== "POST") return json({ error: "само POST" }, 405);
        const dry = u.searchParams.get("dry") === "1" || body.dry === true;
        if (!dry) guard();
        return json(await fixRow(String(body.list || ""), String(body.key || ""),
                                 String(body.field || ""), body.value, dry));
      }

      if (u.pathname === "/mode") {
        const to = String(arg("to") || "");
        if (!to) return json({ ok: true, режим: await mode() });
        guard();
        if (to !== "огледало" && to !== "стопанин") return json({ error: "режимът е огледало или стопанин" }, 400);
        if (String(arg("потвърждавам") || "") !== to)
          return json({ error: `за смяна подай и потвърждавам=${to}` }, 400);
        await db().collection("_meta").updateOne({ _id: "режим" as any },
          { $set: { mode: to, at: new Date() } }, { upsert: true });
        return json({ ok: true, режим: to });
      }

      if (u.pathname === "/sweep") { guard(); return json({ ok: true, изметени: await sweepTemp() }); }

      if (u.pathname === "/sync") {
        const only = arg("name");
        const force = u.searchParams.get("force") === "1" || body.force === true;
        if (force) guard();
        if (await mode() === "стопанин" && !force)
          return json({ error: "В режим стопанин тегленето от листовете би изтрило това, което базата знае. Ако наистина трябва - force=1 с ключ." }, 409);
        const list = only ? [only] : TABS;
        const out: any = {};
        for (const t of list) {
          if (!TABS.includes(t)) return json({ error: `непозната таблица ${t}` }, 400);
          out[t] = await syncTab(t);
        }
        return json({ ok: true, synced: out });
      }

      if (u.pathname === "/numbers") {
        guard();
        const lim = Math.min(Number(u.searchParams.get("limit") || 40), 300);
        const само = String(u.searchParams.get("статус") || "").trim();
        const редове = await db().collection("_номера")
          .find(само ? { статус: само } : {}, { projection: { _id: 0 } })
          .sort({ при: -1 }).limit(lim).toArray();
        const по_статус: any = {};
        for (const r of await db().collection("_номера")
             .find({}, { projection: { статус: 1, брой: 1, _id: 0 } }).toArray() as any[])
          по_статус[r["статус"]] = (по_статус[r["статус"]] || 0) + (Number(r["брой"]) || 0);
        return json({ ok: true, по_статус_номера: по_статус, редове });
      }

      if (u.pathname === "/deduction") {
        const дата = String(arg("date") || "").trim();
        if (!dkey(дата)) return json({ error: "дата във вид ДД.ММ.ГГГГ" }, 400);
        if (req.method !== "POST") return json({ ok: true, ...(await дедРевизия(дата)) });
        guard();
        if (!Array.isArray(body.items)) return json({ error: "липсва items" }, 400);
        return json({ ok: true, ...(await дедПлан(дата, body.items)) });
      }

      if (u.pathname === "/counters") { guard(); return json({ ok: true, counters: await db().collection("counters").find({}).toArray() }); }
      if (u.pathname === "/counters/seed") { guard(); return json({ ok: true, seeded: await seedCounters() }); }

      if (u.pathname === "/number") {
        guard();
        return json({ ok: true, номера: await reserveNums(String(arg("series") || ""),
          Number(arg("count") || 1), String(arg("date") || "")) });
      }

      if (u.pathname === "/rows" || u.pathname === "/row") {
        guard();
        if (await mode() !== "стопанин")
          return json({ error: "В режим огледало истината е в Google Sheets и тук не се пише. Превключи с /mode." }, 409);
        if (req.method !== "POST") return json({ error: "само POST" }, 405);
        if (u.pathname === "/rows")
          return json({ ok: true, ...(await addRows(String(body.table || ""), body.rows)) });
        return json({ ok: true, ...(await setRow(String(body.table || ""), body.key, body.set)) });
      }

      if (u.pathname === "/mirror/flush") { guard(); return json({ ok: true, ...(await flushMirror(Number(arg("limit") || 200))) }); }

      if (u.pathname === "/mirror") {
        guard();
        const pend = await db().collection("_mirror")
          .find({ готово: false }).sort({ при: 1 }).limit(Number(u.searchParams.get("limit") || 50)).toArray();
        const log: any = await db().collection("_meta").findOne({ _id: "огледало" as any });
        return json({ ok: true,
          чакат: await db().collection("_mirror").countDocuments({ готово: false }),
          редове: pend,
          последни_пропуснати: (log?.["пропуснати"] || []).slice(-3),
          последни_провали: (log?.["провали"] || []).slice(-3) });
      }

      // Обектите в базата, за да не зависят проверките от публичния master.json.
      if (u.pathname === "/master") {
        if (req.method === "POST") {
          guard();
          return json({ ok: true, записани: await запишиОбекти(body.objects || body) });
        }
        const { обекти, източник } = await четиОбекти();
        return json({ ok: true, брой: обекти.length, източник });
      }

      if (u.pathname === "/sheet") {
        // Страницата още вика /sheet БЕЗ ключ (т. 5 го изнася в Netlify функция).
        // Затова ключът тук се пали чак когато страницата е готова: SHEET_KEY=1.
        if (process.env.SHEET_KEY === "1") guard();
        const tab = String(arg("name") || "");
        if (!TABS.includes(tab)) return json({ error: `непозната таблица ${tab}` }, 400);
        const synced = await ensureFresh(tab, u.searchParams.get("fresh") === "1");
        const q = buildQuery(tab, u.searchParams);
        const lim = Math.min(Number(u.searchParams.get("limit") || 60000), 60000);
        const rows = await db().collection(tab).find(q, { projection: { _id: 0 } }).limit(lim).toArray();
        return json({ ok: true, table: tab, rows: rows.length, synced, data: rows });
      }

      return json({ error: "непознат път" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
