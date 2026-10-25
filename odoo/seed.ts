// Seeds the local Odoo with the same site as the MaintainOps demo
// (eval/fixtures/site.json): employees, equipment, storable parts with stock,
// and the consumption location parts are moved to when used.
// Idempotent: anything that already exists by name is left alone.
//   npx tsx odoo/seed.ts                 create what's missing
//   npx tsx odoo/seed.ts --reset-stock   also set every part back to its fixture quantity
import { readFile } from "node:fs/promises";
import { getConfig } from "../src/config.js";
import { CONSUMPTION_LOCATION, OdooRpc } from "../src/odoo.js";

const cfg = getConfig();
const rpc = new OdooRpc(cfg.odooUrl, cfg.odooDb, cfg.odooUser, cfg.odooPassword);
const site = JSON.parse(await readFile(new URL("../eval/fixtures/site.json", import.meta.url), "utf8")) as {
  equipment: string[];
  parts: { name: string; quantity: number }[];
  employees: { name: string; role: string }[];
};

async function existing(model: string, extra: unknown[] = []): Promise<Map<string, number>> {
  const rows = await rpc.kw<{ id: number; name: string }[]>(model, "search_read", [extra], { fields: ["name"] });
  return new Map(rows.map((r) => [r.name, r.id]));
}

const locs = await existing("stock.location", [["name", "=", CONSUMPTION_LOCATION]]);
if (!locs.size) await rpc.kw("stock.location", "create", [{ name: CONSUMPTION_LOCATION, usage: "inventory" }]);

const emps = await existing("hr.employee");
for (const e of site.employees) {
  if (!emps.has(e.name)) await rpc.kw("hr.employee", "create", [{ name: e.name, job_title: e.role }]);
}

const eqs = await existing("maintenance.equipment");
for (const name of site.equipment) {
  if (!eqs.has(name)) await rpc.kw("maintenance.equipment", "create", [{ name }]);
}

const [stock] = await rpc.kw<{ id: number }[]>("stock.location", "search_read", [[["usage", "=", "internal"]]], { fields: ["id"], limit: 1 });
const prods = await existing("product.product", [["detailed_type", "=", "product"]]);
let created = 0;
for (const [i, p] of site.parts.entries()) {
  if (prods.has(p.name)) continue;
  const tmpl = await rpc.kw<number>("product.template", "create", [{ name: p.name, detailed_type: "product", default_code: `PART-${String(i + 1).padStart(3, "0")}` }]);
  const [variant] = await rpc.kw<number[]>("product.product", "search", [[["product_tmpl_id", "=", tmpl]]]);
  // Starting stock via an inventory adjustment, the way a storeroom count would.
  const quant = await rpc.kw<number>("stock.quant", "create", [{ product_id: variant, location_id: stock.id, inventory_quantity: p.quantity }]);
  await rpc.kw("stock.quant", "action_apply_inventory", [[quant]]);
  created++;
}
if (process.argv.includes("--reset-stock")) {
  const all = await existing("product.product", [["detailed_type", "=", "product"]]);
  for (const p of site.parts) {
    const productId = all.get(p.name)!;
    const quants = await rpc.kw<{ id: number }[]>("stock.quant", "search_read", [[["product_id", "=", productId], ["location_id", "=", stock.id]]], { fields: ["id"] });
    const quant = quants[0]?.id ?? (await rpc.kw<number>("stock.quant", "create", [{ product_id: productId, location_id: stock.id }]));
    await rpc.kw("stock.quant", "write", [[quant], { inventory_quantity: p.quantity }]);
    await rpc.kw("stock.quant", "action_apply_inventory", [[quant]]);
  }
  console.log(`Stock reset to fixture quantities for ${site.parts.length} parts.`);
}
console.log(`Odoo seeded: ${site.employees.length} employees, ${site.equipment.length} equipment, ${created} new parts with stock.`);
