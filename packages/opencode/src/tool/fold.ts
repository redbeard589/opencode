import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as Fold from "@/session/fold"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import DESCRIPTION from "./fold.txt"

type FoldMeta = {
  foldID: string
  startIndex: number
  endIndex: number
  messageCount: number
}

const Parameters = Schema.Struct({
  start_index: Schema.Number.annotate({ description: "Start message index from <!-- msg:N --> tags (inclusive)" }),
  end_index: Schema.Number.annotate({ description: "End message index from <!-- msg:N --> tags (inclusive)" }),
  summary: Schema.String.annotate({ description: "Concise summary capturing the key outcomes and decisions from the folded range" }),
})

function resolveIndex(
  index: number,
  visibleMap: Map<number, Fold.VisibleMapEntry>,
): string {
  const entry = visibleMap.get(index)
  if (!entry) {
    throw new Error(`Visible index ${index} not found in visibleMap`)
  }
  if (entry.type === "fold") {
    return entry.startMsgID
  }
  return entry.msgID
}

function resolveEndIndex(
  index: number,
  visibleMap: Map<number, Fold.VisibleMapEntry>,
): string {
  const entry = visibleMap.get(index)
  if (!entry) {
    throw new Error(`Visible index ${index} not found in visibleMap`)
  }
  if (entry.type === "fold") {
    return entry.endMsgID
  }
  return entry.msgID
}

export const FoldTool = Tool.define(
  "fold",
  Effect.gen(function* () {
    const database = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<FoldMeta>) =>
        Effect.gen(function* () {
          const EMPTY: FoldMeta = { foldID: "", startIndex: 0, endIndex: 0, messageCount: 0 }

          if (params.end_index < params.start_index) {
            return {
              title: "Error",
              output: "Invalid indices: start_index and end_index must be valid message indices for this session with start_index ≤ end_index.",
              metadata: EMPTY,
            }
          }

          const msgs = yield* MessageV2.filterCompactedEffect(ctx.sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
          const visibleMap = yield* Fold.buildVisibleMap(ctx.sessionID, msgs).pipe(
            Effect.provideService(Database.Service, database),
          )
          const maxIndex = msgs.length - 1

          if (params.start_index > maxIndex || params.end_index > maxIndex) {
            return {
              title: "Error",
              output: "Invalid indices: start_index and end_index must be valid message indices for this session with start_index ≤ end_index.",
              metadata: EMPTY,
            }
          }

          if (!visibleMap.has(params.start_index) || !visibleMap.has(params.end_index)) {
            return {
              title: "Error",
              output: "Invalid indices: start_index and end_index must be valid message indices for this session with start_index ≤ end_index.",
              metadata: EMPTY,
            }
          }

          const startMsgID = resolveIndex(params.start_index, visibleMap)
          const endMsgID = resolveEndIndex(params.end_index, visibleMap)

          const startMsg = msgs.find((m) => m.info.id === startMsgID)
          const endMsg = msgs.find((m) => m.info.id === endMsgID)

          if (!startMsg || !endMsg) {
            return {
              title: "Error",
              output: "Invalid indices: start_index and end_index must be valid message indices for this session with start_index ≤ end_index.",
              metadata: EMPTY,
            }
          }

          const activeFolds = yield* Fold.list(ctx.sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
          let newStartIdx = msgs.findIndex((m) => m.info.id === startMsg.info.id)
          let newEndIdx = msgs.findIndex((m) => m.info.id === endMsg.info.id)

          const startEntry = visibleMap.get(params.start_index)
          const endEntry = visibleMap.get(params.end_index)
          if (
            startEntry?.type === "fold" &&
            endEntry?.type === "fold" &&
            startEntry.foldID === endEntry.foldID
          ) {
            const existingFold = activeFolds.find((f) => f.id === startEntry.foldID)
            if (existingFold) {
              yield* Fold.remove(existingFold.id).pipe(
                Effect.provideService(Database.Service, database),
              )
              newStartIdx = existingFold.startIndex
              newEndIdx = existingFold.endIndex
            }
          } else {
            const foldData = activeFolds.map((fold) => ({
              fold,
              startIdx: msgs.findIndex((m) => m.info.id === fold.startMsgID),
              endIdx: msgs.findIndex((m) => m.info.id === fold.endMsgID),
            })).filter((d) => d.startIdx >= 0 && d.endIdx >= 0)

            const overlapping = foldData.filter((d) => newStartIdx <= d.endIdx && newEndIdx >= d.startIdx)
            const hasPartial = overlapping.some((d) => newStartIdx > d.startIdx || newEndIdx < d.endIdx)

            if (hasPartial) {
              return {
                title: "Error",
                output: "Invalid range: the requested range partially overlaps an existing fold. Use a range that fully contains or is fully outside existing folds.",
                metadata: EMPTY,
              }
            }

            for (const d of overlapping) {
              yield* Fold.remove(d.fold.id).pipe(
                Effect.provideService(Database.Service, database),
              )
            }
          }

          const fold = yield* Fold.create({
            sessionID: ctx.sessionID,
            startMsgID: startMsg.info.id,
            endMsgID: endMsg.info.id,
            startIndex: newStartIdx,
            endIndex: newEndIdx,
            summary: params.summary,
          }).pipe(
            Effect.provideService(Database.Service, database),
          )

          const count = params.end_index - params.start_index + 1
          return {
            title: `Folded msgs ${params.start_index}-${params.end_index}`,
            output: `Folded ${count} visible positions (indices ${params.start_index}-${params.end_index}) into summary. Original message range: ${startMsg.info.id} to ${endMsg.info.id}. Fold ID: ${fold.id}`,
            metadata: {
              foldID: fold.id,
              startIndex: params.start_index,
              endIndex: params.end_index,
              messageCount: count,
            } as FoldMeta,
          }
        }),
    }
  }),
)