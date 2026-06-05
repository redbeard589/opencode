import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260605000000_add_folds",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`fold\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`start_msg_id\` text NOT NULL,
          \`end_msg_id\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`idf_terms\` (
          \`session_id\` text NOT NULL,
          \`word\` text NOT NULL,
          \`doc_count\` integer NOT NULL,
          PRIMARY KEY (\`session_id\`, \`word\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`idf_metadata\` (
          \`session_id\` text PRIMARY KEY,
          \`total_docs\` integer NOT NULL,
          \`last_msg_id\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration