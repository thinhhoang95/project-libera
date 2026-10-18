import { loadConfig } from "../config.js";
import { openDatabase } from "./database.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const database = await openDatabase(config.DATABASE_URL);
try {
  const ran = await migrate(database);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
} finally {
  await database.close();
}
