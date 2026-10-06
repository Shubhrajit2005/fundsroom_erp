import "dotenv/config";
import { app } from "./app.js";
import { pool } from "./db/pool.js";

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL)
  throw new Error("DATABASE_URL and JWT_SECRET are required");
const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () =>
  console.log(`ForgeFlow  API listening on http://localhost:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    }),
  );
