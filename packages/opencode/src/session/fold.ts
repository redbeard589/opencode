import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FoldTable } from "@opencode-ai/core/session/sql"
import { ascending } from "@opencode-ai/core/id/id"
import type { TextPart, User, WithParts } from "@opencode-ai/core/v1/session"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

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

export const FOLD_TAIL_LIVE = 5

export function substituteFolds(msgs: WithParts[], folds: FoldInfo[], now: number = Date.now()): WithParts[] {
  if (folds.length === 0) return msgs

  const idToIndex = new Map<string, number>()
  for (let i = 0; i < msgs.length; i++) {
    idToIndex.set(msgs[i].info.id, i)
  }

  const ranges = folds
    .map((f) => {
      const start = idToIndex.get(f.startMsgID)
      const end = idToIndex.get(f.endMsgID)
      if (start === undefined || end === undefined || start > end) return undefined
      return { fold: f, start, end }
    })
    .filter((r): r is { fold: FoldInfo; start: number; end: number } => r !== undefined)
    .sort((a, b) => a.start - b.start)

  if (ranges.length === 0) return msgs

  const lastOriginalIndex = msgs.length - 1
  const tailLiveCutoff = lastOriginalIndex - FOLD_TAIL_LIVE

  const out: WithParts[] = []
  let i = 0
  while (i < msgs.length) {
    const r = ranges.find((r) => r.start === i)
    if (!r) {
      out.push(msgs[i])
      i++
      continue
    }
    if (r.start > tailLiveCutoff) {
      for (let g = r.start; g <= r.end; g++) {
        out.push(msgs[g])
      }
      i = r.end + 1
      continue
    }
    const collapsedEnd = Math.min(r.end, tailLiveCutoff)
    if (collapsedEnd < r.start) {
      for (let g = r.start; g <= r.end; g++) out.push(msgs[g])
      i = r.end + 1
      continue
    }
    const collapsedCount = collapsedEnd - r.start + 1
    const anchor = msgs[r.start]
    const synthMsgID = `msg-fold-${r.fold.id}` as User["id"]
    const synthPartID = `prt-fold-${r.fold.id}` as TextPart["id"]
    const summaryBlock = [
      `<fold_summary session="${anchor.info.sessionID}" range="${r.start}-${r.end}" count="${collapsedCount}">`,
      r.fold.summary,
      "</fold_summary>",
    ].join("\n")
    const synthInfo: User = {
      id: synthMsgID,
      sessionID: anchor.info.sessionID,
      role: "user",
      time: { created: now },
      agent: anchor.info.agent,
      model: "modelID" in anchor.info
        ? { providerID: anchor.info.providerID, modelID: anchor.info.modelID }
        : anchor.info.model,
    }
    const synthPart: TextPart = {
      type: "text",
      id: synthPartID,
      sessionID: anchor.info.sessionID,
      messageID: synthMsgID,
      text: summaryBlock,
      synthetic: true,
    }
    out.push({ info: synthInfo, parts: [synthPart] })
    for (let g = collapsedEnd + 1; g <= r.end; g++) {
      out.push(msgs[g])
    }
    i = r.end + 1
  }
  return out
}

export * as Fold from "./fold"