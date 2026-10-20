import { MongoClient } from "mongodb";
import { DB_NAME } from "./config";

let client: MongoClient | null = null;
let ready: Promise<void> | null = null;
export async function conn() {
  if (!ready) {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("Липсва MONGO_URI в променливите на услугата.");
    client = new MongoClient(uri, { maxPoolSize: 5 });
    ready = client.connect().then(() => {});
  }
  await ready;
}
export const db = () => client!.db(DB_NAME);

export async function mode(): Promise<string> {
  const m: any = await db().collection("_meta").findOne({ _id: "режим" as any });
  return m?.mode === "стопанин" ? "стопанин" : "огледало";
}
