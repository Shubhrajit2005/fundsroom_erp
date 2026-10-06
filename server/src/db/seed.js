import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

const users = [
  {
    name: "Avery Morgan",
    email: "admin@forgeflow.test",
    password: "Admin123!",
    role: "ADMIN",
  },
  {
    name: "Jordan Lee",
    email: "sales@forgeflow.test",
    password: "Sales123!",
    role: "SALES",
  },
];
const products = [
  ["IND-1001", "Precision Steel Shaft", "Machined parts", "pcs", 850, 200],
  ["IND-1002", "Hydraulic Pump HP-40", "Hydraulics", "pcs", 12500, 38],
  ["IND-1003", "Industrial Bearing 6205", "Bearings", "pcs", 420, 540],
  ["IND-1004", "Conveyor Roller 600mm", "Material handling", "pcs", 2100, 84],
  ["IND-1005", "Pneumatic Valve 1/2 in", "Pneumatics", "pcs", 1850, 120],
  ["IND-1006", "Stainless Steel Coupling", "Fittings", "pcs", 680, 265],
  ["IND-1007", "V-Belt B72", "Power transmission", "pcs", 390, 310],
  ["IND-1008", "Gearbox Lubricant 5L", "Maintenance", "can", 1450, 64],
];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const user of users) {
    const hash = await bcrypt.hash(user.password, 12);
    await client.query(
      `INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4)
      ON CONFLICT(email) DO UPDATE SET full_name=excluded.full_name,password_hash=excluded.password_hash,role=excluded.role,active=true`,
      [user.name, user.email, hash, user.role],
    );
  }
  for (const [code, name, category, unit, price, physical] of products) {
    const product = await client.query(
      `INSERT INTO products(product_code,name,category,unit,base_price) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(product_code) DO UPDATE SET name=excluded.name,category=excluded.category,unit=excluded.unit,base_price=excluded.base_price RETURNING id`,
      [code, name, category, unit, price],
    );
    await client.query(
      `INSERT INTO inventory(product_id,physical_quantity,reserved_quantity) VALUES($1,$2,0)
      ON CONFLICT(product_id) DO NOTHING`,
      [product.rows[0].id, physical],
    );
  }
  await client.query("COMMIT");
  console.log("Seeded demo accounts and 8 industrial products.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
