export function parseCSV(txt: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); f = ""; rows.push(row); row = []; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ""));
}

export function dkey(v: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(v || "").trim());
  if (!m) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
export const digits = (v: any) => String(v == null ? "" : v).replace(/\D/g, "");
export const num2 = (v: any) => Math.round((parseFloat(String(v == null ? "" : v).replace(",", ".")) || 0) * 100) / 100;
export const norm = (v: any) => String(v == null ? "" : v).toUpperCase()
  .replace(/["„“”]/g, "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim();
export function stamp(o: any) {
  if (o["Дата"] !== undefined) o._d = dkey(o["Дата"]);
  if (o["Номер"] !== undefined) o._n = digits(o["Номер"]);
  return o;
}
export const r2 = (v: any) => Math.round((Number(v) || 0) * 100) / 100;
export const r3 = (v: any) => Math.round((Number(v) || 0) * 1000) / 1000;
export function канонНомер(v: any): string {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}
export const pad10 = (n: any) => { let s = String(n); while (s.length < 10) s = "0" + s; return s; };

export function normObekt(s: any): string {
  let x = String(s || "").toUpperCase().replace(/["„“”]/g, "");
  x = x.replace(/\s*[-\/]\s*/g, " ").replace(/\./g, "").replace(/\s+/g, " ").trim();
  x = x.replace(/^(300|СТАР)\s+/, "");
  x = x.replace(/[\+\*]+$/, "").trim();
  x = x.replace(/(ЪТ|ЯТ|ТЕ|ТА|ТО)$/, "").trim();
  return x;
}
function obektNet(s: any): string {
  const x = String(s || "").toUpperCase().replace(/["„“”]/g, "").trim();
  const m = x.match(/^(300|СТАР)\s+/);
  return m ? m[1] : "";
}
export function sameObekt(a: any, b: any): boolean {
  if (normObekt(a) !== normObekt(b)) return false;
  const na = obektNet(a), nb = obektNet(b);
  return !(na && nb && na !== nb);
}


export function linieAdd(m: any, n: string, v: number) { m[n] = r2((m[n] || 0) + v); }
