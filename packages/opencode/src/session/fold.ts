import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FoldTable } from "@opencode-ai/core/session/sql"
import { ascending } from "@opencode-ai/core/id/id"
import type { WithParts } from "@opencode-ai/core/v1/session"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

export type VisibleMapEntry =
  | { type: "msg"; msgID: string }
  | { type: "fold"; foldID: string; startMsgID: string; endMsgID: string }

export type FoldInfo = {
  id: string
  sessionID: SessionSchema.ID
  startMsgID: string
  endMsgID: string
  startIndex: number
  endIndex: number
  summary: string
  time: { created: number; updated: number }
}

function serialize(row: typeof FoldTable.$inferSelect): FoldInfo {
  return {
    id: row.id,
    sessionID: row.session_id,
    startMsgID: row.start_msg_id,
    endMsgID: row.end_msg_id,
    startIndex: row.start_index ?? 0,
    endIndex: row.end_index ?? 0,
    summary: row.summary,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

export function create(input: {
  sessionID: SessionSchema.ID
  startMsgID: string
  endMsgID: string
  startIndex: number
  endIndex: number
  summary: string
}): Effect.Effect<FoldInfo, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = ascending("fold")
    const now = Date.now()

    const existing = yield* list(input.sessionID)
    for (const fold of existing) {
      const overlaps = input.startMsgID <= fold.endMsgID && input.endMsgID >= fold.startMsgID
      if (overlaps) {
        yield* Effect.die(new Error(`Fold overlaps with existing fold ${fold.id}`))
      }
    }

    db.insert(FoldTable).values({
      id,
      session_id: input.sessionID,
      start_msg_id: input.startMsgID,
      end_msg_id: input.endMsgID,
      start_index: input.startIndex,
      end_index: input.endIndex,
      summary: input.summary,
      time_created: now,
      time_updated: now,
    }).run()

    return {
      id,
      sessionID: input.sessionID,
      startMsgID: input.startMsgID,
      endMsgID: input.endMsgID,
      startIndex: input.startIndex,
      endIndex: input.endIndex,
      summary: input.summary,
      time: { created: now, updated: now },
    }
  })
}

export function list(sessionID: SessionSchema.ID): Effect.Effect<FoldInfo[], never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(FoldTable)
      .where(eq(FoldTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.map(serialize)
  })
}

export function remove(id: string): Effect.Effect<void, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    db.delete(FoldTable).where(eq(FoldTable.id, id)).run()
  })
}

export function removeAll(sessionID: SessionSchema.ID): Effect.Effect<void, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    db.delete(FoldTable).where(eq(FoldTable.session_id, sessionID)).run()
  })
}

export function buildVisibleMap(sessionID: SessionSchema.ID, msgs: WithParts[]): Effect.Effect<Map<number, VisibleMapEntry>, never, Database.Service> {
  return Effect.gen(function* () {
    const visibleMap = new Map<number, VisibleMapEntry>()
    const folds = yield* list(sessionID)
    if (!folds.length) {
      for (let i = 0; i < msgs.length; i++) {
        visibleMap.set(i, { type: "msg", msgID: msgs[i].info.id })
      }
      return visibleMap
    }

    const msgIdToIndex = new Map<string, number>()
    for (let i = 0; i < msgs.length; i++) {
      msgIdToIndex.set(msgs[i].info.id, i)
    }

    const foldRanges: { startIdx: number; endIdx: number; foldID: string }[] = []
    for (const fold of folds) {
      const startIdx = msgIdToIndex.get(fold.startMsgID)
      const endIdx = msgIdToIndex.get(fold.endMsgID)
      if (startIdx === undefined || endIdx === undefined) continue
      foldRanges.push({ startIdx, endIdx, foldID: fold.id })
    }

    foldRanges.sort((a, b) => a.startIdx - b.startIdx)

    for (let i = 0; i < msgs.length; i++) {
      const fold = foldRanges.find((f) => f.startIdx === i)
      if (fold) {
        visibleMap.set(i, {
          type: "fold",
          foldID: fold.foldID,
          startMsgID: msgs[fold.startIdx].info.id,
          endMsgID: msgs[fold.endIdx].info.id,
        })
        i = fold.endIdx
      } else {
        visibleMap.set(i, { type: "msg", msgID: msgs[i].info.id })
      }
    }

    return visibleMap
  })
}

export * as Fold from "./fold"