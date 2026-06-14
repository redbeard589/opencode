import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, SessionID, PartID } from "../../src/session/schema"
import { substituteFolds, type FoldInfo } from "../../src/session/fold"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Schema } from "effect"

const sessionID = SessionID.make("session-fold-test")

function makeMsg(index: number, role: "user" | "assistant" = "user"): SessionV1.WithParts {
  const id = MessageID.make(`msg-test-${String(index).padStart(4, "0")}`)
  const baseInfo = {
    id,
    sessionID,
    time: role === "user"
      ? { created: 1_700_000_000_000 + index }
      : { created: 1_700_000_000_000 + index, completed: 1_700_000_000_000 + index },
  }
  const info: SessionV1.User | SessionV1.Assistant =
    role === "user"
      ? {
          ...baseInfo,
          role: "user",
          agent: "test",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        }
      : {
          ...baseInfo,
          role: "assistant",
          parentID: id,
          agent: "test",
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          mode: "test",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
  return {
    info,
    parts: [
      {
        type: "text",
        id: PartID.make(`prt-test-${String(index).padStart(4, "0")}`),
        sessionID,
        messageID: id,
        text: `message ${index}`,
      },
    ],
  }
}

function makeFold(startIndex: number, endIndex: number, summary: string, id = "fold-test-001"): FoldInfo {
  const startID = `msg-test-${String(startIndex).padStart(4, "0")}`
  const endID = `msg-test-${String(endIndex).padStart(4, "0")}`
  return {
    id,
    sessionID,
    startMsgID: startID,
    endMsgID: endID,
    startIndex,
    endIndex,
    summary,
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

describe("substituteFolds", () => {
  test("returns the input unchanged when there are no folds", () => {
    const msgs = [makeMsg(0), makeMsg(1), makeMsg(2)]
    const out = substituteFolds(msgs, [])
    expect(out).toBe(msgs)
  })

  test("replaces a fold range with a single synthetic User message", () => {
    // 12 messages; fold at 1..3 (well before the tail window [7..11]).
    const msgs = Array.from({ length: 12 }, (_, i) => makeMsg(i, i % 2 === 0 ? "user" : "assistant"))
    const fold = makeFold(1, 3, "Worked on refactor")
    const out = substituteFolds(msgs, [fold], 1_700_000_000_999)
    // Expect 12 - 3 collapsed + 1 synth = 10.
    expect(out.length).toBe(10)
    expect(out[0]).toBe(msgs[0])
    const synth = out[1]
    expect(synth.info.role).toBe("user")
    expect(synth.info.id).toBe(MessageID.make("msg-fold-fold-test-001"))
    expect(synth.parts).toHaveLength(1)
    const part = synth.parts[0]
    expect(part.type).toBe("text")
    if (part.type === "text") {
      expect(part.synthetic).toBe(true)
      expect(part.text).toContain("<!-- fold:1-3 -->")
      expect(part.text).toContain('count="3"')
      expect(part.text).toContain("Worked on refactor")
      expect(part.text).not.toContain("preserved as ghosts")
    }
    // After the synth, the rest of the originals follow with shifted indices.
    expect(out[2]).toBe(msgs[4])
    expect(out[9]).toBe(msgs[11])
  })

  test("keeps the live-tail portion live when a fold extends into it", () => {
    // 12 messages; tailLiveCutoff = 11-5 = 6. Fold at 4..9: collapse [4..6]
    // (3 messages), keep [7..9] live (3 messages). Result:
    // msgs[0..3] + synth + msgs[7..9] + msgs[10..11] = 4 + 1 + 3 + 2 = 10.
    const msgs = Array.from({ length: 12 }, (_, i) => makeMsg(i, i % 2 === 0 ? "user" : "assistant"))
    const fold = makeFold(4, 9, "Partial tail fold")
    const out = substituteFolds(msgs, [fold], 1_700_000_000_999)
    expect(out.length).toBe(10)
    expect(out[0]).toBe(msgs[0])
    expect(out[1]).toBe(msgs[1])
    expect(out[2]).toBe(msgs[2])
    expect(out[3]).toBe(msgs[3])
    const synth = out[4]
    expect(synth.info.role).toBe("user")
    expect(synth.info.id).toBe(MessageID.make("msg-fold-fold-test-001"))
    if (synth.parts[0].type === "text") {
      // count reflects only the collapsed portion, not the live-tail ghosts.
      expect(synth.parts[0].text).toContain('count="3"')
      expect(synth.parts[0].text).not.toContain("preserved as ghosts")
    }
    // Live-tail portion of the fold stays as live originals.
    expect(out[5]).toBe(msgs[7])
    expect(out[6]).toBe(msgs[8])
    expect(out[7]).toBe(msgs[9])
    expect(out[8]).toBe(msgs[10])
    expect(out[9]).toBe(msgs[11])
  })

  test("skips substitution when a fold is entirely within the live-tail window", () => {
    // 10 messages; tailLiveCutoff = 9-5 = 4. Fold at 5..9 starts after
    // tailLiveCutoff — model already has the originals as live context,
    // so the fold adds no value at the prompt level.
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(i, i % 2 === 0 ? "user" : "assistant"))
    const fold = makeFold(5, 9, "Tail fold")
    const out = substituteFolds(msgs, [fold], 1_700_000_000_999)
    // Output is structurally identical to the input (same length, same
    // message references in the same order).
    expect(out).toEqual(msgs)
  })

  test("handles multiple non-overlapping folds in ascending order", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => makeMsg(i))
    const f1 = makeFold(2, 4, "First", "fold-aaa")
    const f2 = makeFold(10, 12, "Second", "fold-bbb")
    const out = substituteFolds(msgs, [f2, f1], 1_700_000_000_999)
    // tailFloor = 19-5+1 = 15. f1: 2..4 (end < 15) → 1 synth replaces 3 originals.
    // f2: 10..12 (end < 15) → 1 synth replaces 3 originals.
    // total: msgs[0,1] + synth(aaa) + msgs[5..9] + synth(bbb) + msgs[13..19] = 2 + 1 + 5 + 1 + 7 = 16
    expect(out.length).toBe(16)
    expect(out[0]).toBe(msgs[0])
    expect(out[1]).toBe(msgs[1])
    expect(out[2].info.id).toBe(MessageID.make("msg-fold-fold-aaa"))
    expect(out[3]).toBe(msgs[5])
    expect(out[4]).toBe(msgs[6])
    expect(out[5]).toBe(msgs[7])
    expect(out[6]).toBe(msgs[8])
    expect(out[7]).toBe(msgs[9])
    expect(out[8].info.id).toBe(MessageID.make("msg-fold-fold-bbb"))
    expect(out[9]).toBe(msgs[13])
    expect(out[15]).toBe(msgs[19])
  })

  test("skips folds whose endpoints are missing from the messages array", () => {
    const msgs = [makeMsg(0), makeMsg(1), makeMsg(2)]
    const fold = makeFold(0, 2, "stale")
    fold.startMsgID = "msg-test-missing-start"
    fold.endMsgID = "msg-test-missing-end"
    const out = substituteFolds(msgs, [fold])
    expect(out).toBe(msgs)
  })

  test("skips folds with reversed endpoints (start > end)", () => {
    const msgs = [makeMsg(0), makeMsg(1), makeMsg(2)]
    const fold: FoldInfo = {
      ...makeFold(0, 0, "bad"),
      startMsgID: "msg-test-0002",
      endMsgID: "msg-test-0001",
    }
    const out = substituteFolds(msgs, [fold])
    expect(out).toBe(msgs)
  })

  test("synthetic User message has a valid MessageID and a TextPart id starting with prt-", () => {
    // 10 messages; tailFloor = 5. Fold at 0..1 is well outside the tail.
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(i, i % 2 === 0 ? "user" : "assistant"))
    const fold = makeFold(0, 1, "x")
    const out = substituteFolds(msgs, [fold], 42)
    const synth = out[0]
    expect(synth.info.id.startsWith("msg-")).toBe(true)
    expect(() => Schema.decodeUnknownSync(MessageID)(synth.info.id)).not.toThrow()
    const part = synth.parts[0]
    if (part.type === "text") {
      expect(part.id.startsWith("prt-")).toBe(true)
      expect(() => Schema.decodeUnknownSync(PartID)(part.id)).not.toThrow()
      expect(part.messageID).toBe(synth.info.id)
      expect(part.synthetic).toBe(true)
    } else {
      throw new Error("expected text part")
    }
    expect((synth.info as { time: { created: number } }).time.created).toBe(42)
  })
})
