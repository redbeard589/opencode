import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FoldTable } from "@opencode-ai/core/session/sql"
import { ascending } from "@opencode-ai/core/id/id"
import type { TextPart, User, WithParts } from "@opencode-ai/core/v1/session"
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

// The model always needs a small recent tail of live context. Folds are
// not allowed to cover the last FOLD_TAIL_LIVE messages, so the
// substitution never has to decide which originals to keep inside a
// fold's range — they're already outside the fold.
export const FOLD_TAIL_LIVE = 5

// Pure substitution. Walks the message array and replaces each fold's
// range with a single synthetic User message carrying the fold's
// summary text. The last FOLD_TAIL_LIVE messages are always kept live
// (by definition they're outside every fold). Folds whose range falls
// entirely inside the tail live window are dropped — there's nothing
// to collapse because the model already has the originals.
//
// The returned array stays in the same shape and order as `msgs`
// (minus collapsed ranges) so downstream `tagMessage` indices remain
// meaningful.
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

  // Fold's range that lies entirely inside the tail-live window is a
  // no-op — the model still has the originals. Clip the end to
  // `lastOriginalIndex - FOLD_TAIL_LIVE` so we collapse the part that's
  // actually outside the live window.
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
      // Fold entirely in the live tail: keep originals.
      for (let g = r.start; g <= r.end; g++) {
        out.push(msgs[g])
      }
      i = r.end + 1
      continue
    }
    const collapsedEnd = Math.min(r.end, tailLiveCutoff)
    if (collapsedEnd < r.start) {
      // Defensive: shouldn't happen because of the early continue above.
      for (let g = r.start; g <= r.end; g++) out.push(msgs[g])
      i = r.end + 1
      continue
    }
    const collapsedCount = collapsedEnd - r.start + 1
    const anchor = msgs[r.start]
    const synthMsgID = `msg-fold-${r.fold.id}` as User["id"]
    const synthPartID = `prt-fold-${r.fold.id}` as TextPart["id"]
    const summaryBlock = [
      `<!-- fold:${r.start}-${r.end} -->`,
      `<fold_summary session="${anchor.info.sessionID}" range="${r.start}-${r.end}" count="${collapsedCount}">`,
      r.fold.summary,
      "</fold_summary>",
    ].join("\n")
    // Build the synth User info explicitly. The anchor may be an Assistant,
    // so spreading it would drop the required `model` field on User.
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
    // Push the live-tail portion of the fold (the part the model still
    // needs) as live originals.
    for (let g = collapsedEnd + 1; g <= r.end; g++) {
      out.push(msgs[g])
    }
    i = r.end + 1
  }
  return out
}

export * as Fold from "./fold"