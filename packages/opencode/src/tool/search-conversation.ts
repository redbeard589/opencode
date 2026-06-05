import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as Fold from "@/session/fold"
import { MessageV2 } from "@/session/message-v2"
import type { WithParts, Part } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { IDFTermsTable, IDFMetadataTable } from "@opencode-ai/core/session/sql"
import { eq, and } from "drizzle-orm"
import DESCRIPTION from "./search-conversation.txt"

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  let current = ""
  for (const char of lower) {
    if (/\s/.test(char) || /[^\w]/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

function getMessageText(msg: WithParts): string {
  const parts: string[] = []
  for (const part of msg.parts) {
    if (part.type === "text") {
      parts.push(part.text)
    } else if (part.type === "reasoning") {
      parts.push(part.text)
    } else if (part.type === "tool") {
      const state = (part as Part & { state?: { status?: string; output?: string; title?: string } }).state
      if (state?.status === "completed") {
        parts.push(state.output ?? "")
      }
    }
  }
  return parts.join("\n")
}

function computeTF(tokens: string[], word: string): number {
  let count = 0
  for (const token of tokens) {
    if (token === word) count++
  }
  return count / tokens.length
}

function computeIDF(totalDocs: number, docCount: number): number {
  return Math.log((totalDocs + 1) / (docCount + 1))
}

function computeTFIDF(tokens: string[], word: string, totalDocs: number, docCount: number): number {
  const tf = computeTF(tokens, word)
  const idf = computeIDF(totalDocs, docCount)
  return tf * idf
}

function jaccardSimilarity(
  queryTokens: string[],
  windowTokens: string[],
  queryTF: Map<string, number>,
  idfCache: Map<string, number>,
  totalDocs: number,
): number {
  const querySet = new Set(queryTokens)
  const windowSet = new Set(windowTokens)

  const union = new Set([...querySet, ...windowSet])

  let intersectionSum = 0
  let unionSum = 0

  for (const word of union) {
    const queryTFIDF = queryTF.get(word) ?? 0
    const windowTFIDF = computeTFIDF(windowTokens, word, totalDocs, idfCache.get(word) ?? 0)

    if (querySet.has(word) && windowSet.has(word)) {
      intersectionSum += Math.min(queryTFIDF, windowTFIDF)
    }
    unionSum += Math.max(queryTFIDF, windowTFIDF)
  }

  if (unionSum === 0) return 0
  return intersectionSum / unionSum
}

function scoreMessage(
  msgTokens: string[],
  queryTokens: string[],
  queryTF: Map<string, number>,
  idfCache: Map<string, number>,
  totalDocs: number,
): number {
  if (queryTokens.length === 0 || msgTokens.length === 0) {
    return 0
  }

  const querySet = new Set(queryTokens)
  const N = queryTokens.length

  let maxScore = 0

  if (msgTokens.length < N) {
    maxScore = jaccardSimilarity(queryTokens, msgTokens, queryTF, idfCache, totalDocs)
  } else {
    for (let i = 0; i <= msgTokens.length - N; i++) {
      const window = msgTokens.slice(i, i + N)
      const score = jaccardSimilarity(queryTokens, window, queryTF, idfCache, totalDocs)
      if (score > maxScore) {
        maxScore = score
      }
    }
  }

  return maxScore
}

function truncateContent(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) return content
  return content.slice(0, maxLength) + "..."
}

interface SearchResult {
  index: number
  score: number
  content: string
  role: string
  isFolded: boolean
  beforeContent?: string
  afterContent?: string
}

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Query string to search for" }),
  offset: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(0))).annotate({ description: "Number of results to skip" }),
  position_bias: Schema.optional(Schema.Number).annotate({ description: "Bias results toward messages near a position (0=first, 100=last)" }),
})

export const SearchConversationTool = Tool.define(
  "search-conversation",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; offset: number; position_bias?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(ctx.sessionID).pipe(Effect.provideService(Database.Service, database))
          const folds = yield* Fold.list(ctx.sessionID).pipe(Effect.provideService(Database.Service, database))
          const queryTokens = tokenize(params.pattern)

          if (params.position_bias !== undefined) {
            if (!Number.isInteger(params.position_bias) || params.position_bias < 0 || params.position_bias > 100) {
              return {
                title: "Error",
                output: "Invalid position_bias: must be an integer between 0 and 100 inclusive.",
                metadata: { matches: 0, returned: 0 },
              }
            }
          }

          if (queryTokens.length === 0) {
            return {
              title: params.pattern,
              output: "No additional results.",
              metadata: { matches: 0, returned: 0 },
            }
          }

          const sessionID = ctx.sessionID
          const { db } = database

          let totalDocs = 0
          let lastMsgId: string | null = null

          const existingMeta = yield* db.select().from(IDFMetadataTable).where(eq(IDFMetadataTable.session_id, sessionID)).get().pipe(Effect.orElseSucceed(() => undefined))

          if (existingMeta) {
            totalDocs = existingMeta.total_docs
            lastMsgId = existingMeta.last_msg_id
          }

          const newMessages: WithParts[] = []
          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i]
            if (lastMsgId && msg.info.id <= lastMsgId) continue
            newMessages.push(msg)
          }

          if (newMessages.length > 0) {
            const wordToDocCount = new Map<string, Set<string>>()

            for (const msg of newMessages) {
              const text = getMessageText(msg)
              const tokens = tokenize(text)
              const uniqueTokens = [...new Set(tokens)]

              for (const word of uniqueTokens) {
                if (!wordToDocCount.has(word)) {
                  wordToDocCount.set(word, new Set())
                }
                wordToDocCount.get(word)!.add(msg.info.id)
              }
            }

            for (const [word, docSet] of wordToDocCount) {
              const existing = yield* db.select().from(IDFTermsTable)
                .where(and(eq(IDFTermsTable.session_id, sessionID), eq(IDFTermsTable.word, word)))
                .get().pipe(Effect.orElseSucceed(() => undefined))

              if (existing) {
                db.update(IDFTermsTable)
                  .set({ doc_count: existing.doc_count + 1 })
                  .where(and(eq(IDFTermsTable.session_id, sessionID), eq(IDFTermsTable.word, word)))
                  .run()
              } else {
                db.insert(IDFTermsTable).values({
                  session_id: sessionID,
                  word: word,
                  doc_count: 1,
                }).run()
              }
            }

            totalDocs += newMessages.length
            const latestMsg = msgs[msgs.length - 1]

            if (existingMeta) {
              db.update(IDFMetadataTable)
                .set({ total_docs: totalDocs, last_msg_id: latestMsg.info.id })
                .where(eq(IDFMetadataTable.session_id, sessionID))
                .run()
            } else {
              db.insert(IDFMetadataTable).values({
                session_id: sessionID,
                total_docs: totalDocs,
                last_msg_id: latestMsg.info.id,
              }).run()
            }
          }

          const idfCache = new Map<string, number>()
          const terms = yield* db.select().from(IDFTermsTable).where(eq(IDFTermsTable.session_id, sessionID)).all().pipe(Effect.orDie)
          for (const term of terms) {
            idfCache.set(term.word, term.doc_count)
          }

          const queryTF = new Map<string, number>()
          for (const word of queryTokens) {
            queryTF.set(word, computeTF(queryTokens, word))
          }

          const totalMessages = msgs.length
          let targetIndex: number | undefined
          if (params.position_bias !== undefined && totalMessages > 0) {
            targetIndex = (params.position_bias / 100) * (totalMessages - 1)
          }

          const results: SearchResult[] = []

          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i]
            const hasHideTool = msg.info.role === "assistant" && msg.parts.some((p: any) => p.type === "tool" && p.tool === "fold")
            if (hasHideTool) continue

            const text = getMessageText(msg)
            const msgTokens = tokenize(text)

            if (msgTokens.length === 0) continue

            let score = scoreMessage(msgTokens, queryTokens, queryTF, idfCache, totalDocs)

            if (targetIndex !== undefined) {
              const d = Math.abs(i - targetIndex) / totalMessages
              const positionWeight = Math.exp(-4 * d * d)
              score = score * positionWeight
            }

            if (score <= 0.3) continue

            let isFolded = false
            for (const fc of folds) {
              if (i >= fc.startIndex && i <= fc.endIndex) {
                isFolded = true
                break
              }
            }

            results.push({
              index: i,
              score,
              content: truncateContent(text),
              role: msg.info.role,
              isFolded,
            })
          }

          results.sort((a, b) => b.score - a.score)

          const filteredResults = results.filter(r => r.score > 0.3)

          const offset = params.offset ?? 0
          const paginatedResults = filteredResults.slice(offset, offset + 3)

          for (const result of paginatedResults) {
            if (result.index > 0) {
              const beforeMsg = msgs[result.index - 1]
              result.beforeContent = truncateContent(getMessageText(beforeMsg))
            }
            if (result.index < msgs.length - 1) {
              const afterMsg = msgs[result.index + 1]
              result.afterContent = truncateContent(getMessageText(afterMsg))
            }
          }

          const lines: string[] = []

          if (paginatedResults.length === 0) {
            lines.push("No additional results.")
          } else {
            for (const result of paginatedResults) {
              const foldInfo = result.isFolded ? " [folded]" : ""
              lines.push(`[score: ${result.score.toFixed(3)}] Index ${result.index}${foldInfo}: "${result.content}"`)
              if (result.beforeContent) {
                lines.push(`  Before: "${result.beforeContent}"`)
              }
              if (result.afterContent) {
                lines.push(`  After: "${result.afterContent}"`)
              }
            }
          }

          const remaining = filteredResults.length - (offset + paginatedResults.length)
          if (remaining > 0) {
            lines.push(`${remaining} additional results, call again with offset ${offset + 3} to view the next 3`)
          } else {
            lines.push("No additional results.")
          }

          return {
            title: params.pattern,
            output: lines.join("\n"),
            metadata: {
              matches: filteredResults.length,
              returned: paginatedResults.length,
            },
          }
        }),
    }
  }),
)