import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260605000002_add_fold_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`fold_session_idx\` ON \`fold\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`fold_start_end_idx\` ON \`fold\` (\`start_index\`, \`end_index\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
