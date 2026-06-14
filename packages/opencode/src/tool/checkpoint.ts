import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as Fold from "@/session/fold"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { FoldTable } from "@opencode-ai/core/session/sql"
import { desc, eq } from "drizzle-orm"
import DESCRIPTION from "./checkpoint.txt"

const TAIL_LIVE = Fold.FOLD_TAIL_LIVE

type CheckpointMeta = {
  foldID: string
  startIndex: number
  endIndex: number
  messageCount: number
}

const Parameters = Schema.Struct({
  summary: Schema.String.annotate({ description: "Concise summary of the conversation history being compressed" }),
})

export const CheckpointTool = Tool.define(
  "checkpoint",
  Effect.gen(function* () {
    const database = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<CheckpointMeta>) =>
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(ctx.sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
          const maxIndex = msgs.length - 1

          const { db } = database
          const lastFold = yield* db
            .select()
            .from(FoldTable)
            .where(eq(FoldTable.session_id, ctx.sessionID))
            .orderBy(desc(FoldTable.start_index))
            .limit(1)
            .get()
            .pipe(Effect.orElseSucceed(() => undefined))

          const start = lastFold ? (lastFold.end_index ?? 0) + 1 : 0
          // Leave the last TAIL_LIVE messages live so the model always
          // has recent context. Without this floor the fold would cover
          // the tail and substituteFolds would re-emit those messages
          // as ghosts, producing ~0 token reduction.
          const end = maxIndex - TAIL_LIVE

          const EMPTY: CheckpointMeta = { foldID: "", startIndex: 0, endIndex: 0, messageCount: 0 }

          if (start > end) {
            return {
              title: "Checkpoint",
              output: "Nothing to fold.",
              metadata: EMPTY,
            }
          }

          const startMsg = msgs[start]
          const endMsg = msgs[end]

          if (!startMsg || !endMsg) {
            return {
              title: "Error",
              output: "Invalid indices for checkpoint.",
              metadata: EMPTY,
            }
          }

          const fold = yield* Fold.create({
            sessionID: ctx.sessionID,
            startMsgID: startMsg.info.id,
            endMsgID: endMsg.info.id,
            startIndex: start,
            endIndex: end,
            summary: params.summary,
          }).pipe(
            Effect.provideService(Database.Service, database),
          )

          const count = end - start + 1
          return {
            title: `Checkpoint fold ${start}-${end}`,
            output: `Folded ${count} messages (indices ${start}-${end}) into summary. Original message range: ${startMsg.info.id} to ${endMsg.info.id}. Fold ID: ${fold.id}`,
            metadata: {
              foldID: fold.id,
              startIndex: start,
              endIndex: end,
              messageCount: count,
            } as CheckpointMeta,
          }
        }),
    }
  }),
)