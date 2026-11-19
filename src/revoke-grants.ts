// `npm run revoke-grants`: signs out every connected client (they'll have to reconnect).
// Use it if a token may have leaked. Stop the server first (`deploy/ctl.sh revoke` does stop →
// revoke → start); a running server keeps its own copy of the grants and would write them back.
import fs from "node:fs";
import path from "node:path";
import { OAuthStore } from "./auth/store.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data"));
const n = new OAuthStore(dataDir).revokeAll();
console.log(`Revoked ${n} grant(s) in ${dataDir}.`);
