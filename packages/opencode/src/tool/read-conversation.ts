import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { MessageV2 } from "@/session/message-v2"
import DESCRIPTION from "./read-conversation.txt"

const Parameters = Schema.Struct({
  start_index: Schema.Number.annotate({ description: "Start message index from <!-- msg:N --> tags (0-based, inclusive)" }),
  limit: Schema.Number.annotate({ description: "Maximum number of messages to return (default: 10)" }),
})

type Meta = { start: number; limit: number; returned: number; total: number }

export const ReadConversationTool = Tool.define(
  "read-conversation",
  // @ts-expect-error TypeScript can't infer Init<Parameters, Meta> from Effect.succeed
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: { start_index: number; limit: number }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const effectiveLimit = params.limit ?? 10
        const msgs = yield* MessageV2.filterCompactedEffect(ctx.sessionID)

        if (msgs.length === 0) {
          return {
            title: "Read conversation from index 0",
            output: "No messages found",
            metadata: { start: 0, limit: effectiveLimit, returned: 0, total: 0 } satisfies Meta,
          }
        }

        if (params.start_index < 0) {
          return {
            title: "Error",
            output: "Invalid start_index: must be a valid message index for this session.",
            metadata: { start: 0, limit: 0, returned: 0, total: 0 } satisfies Meta,
          }
        }

        if (params.start_index >= msgs.length) {
          return {
            title: `Read conversation from index ${params.start_index}`,
            output: "No messages found",
            metadata: { start: params.start_index, limit: effectiveLimit, returned: 0, total: msgs.length } satisfies Meta,
          }
        }

        if (effectiveLimit === 0) {
          return {
            title: `Read conversation from index ${params.start_index}`,
            output: "",
            metadata: { start: params.start_index, limit: 0, returned: 0, total: msgs.length } satisfies Meta,
          }
        }

        const lines: string[] = []
        let returned = 0
        let i = params.start_index

        while (i < msgs.length && returned < effectiveLimit) {
          const msg = msgs[i]
          lines.push(`[msg:${i}] (${msg.info.role})`)
          for (const part of msg.parts) {
            if (part.type === "text") {
              lines.push(part.text)
            } else if (part.type === "reasoning") {
              lines.push(`[reasoning] ${part.text}`)
            } else if (part.type === "tool") {
              const state = (part as any).state
              lines.push(
                `  tool: ${(part as any).tool} -> ${state?.status === "completed" ? state?.title : state?.status}`,
              )
            }
          }
          lines.push("")
          returned++
          i++
        }

        const hasMore = i < msgs.length
        if (hasMore) {
          lines.push(`--- Showing ${returned} messages (start=${params.start_index}) ---`)
          lines.push(`Use read-conversation with start_index=${i} to see more.`)
        } else {
          lines.push(`--- End of conversation (${returned} messages shown) ---`)
        }

        return {
          title: `Read conversation from index ${params.start_index}`,
          output: lines.join("\n"),
          metadata: { start: params.start_index, limit: effectiveLimit, returned, total: msgs.length } satisfies Meta,
        }
      }),
  }),
)