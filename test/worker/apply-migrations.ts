import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Every test file starts from the real schema in migrations/.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
