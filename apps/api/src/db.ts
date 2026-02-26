import { Pool } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.DATABASE_URL
});

export type DbUser = {
  id: string;
  username: string;
};
