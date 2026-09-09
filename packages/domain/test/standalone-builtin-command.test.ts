import { describe, expect, it } from "vitest";

import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  parseBuiltinGoalCommand,
} from "../src/shared-types.js";
import type { PromptInput, PromptMentionCommandOrigin } from "../src/index.js";

function promptCommandInput(
  name: string,
  args?: {
    origin?: PromptMentionCommandOrigin;
    text?: string;
  },
): PromptInput {
  const commandText = `/${name}`;
  const text = args?.text ?? commandText;
  const start = text.indexOf(commandText);
  if (start === -1) {
    throw new Error(`Missing ${commandText} command text in "${text}".`);
  }
  return {
    type: "text",
    text,
    mentions: [
      {
        start,
        end: start + commandText.length,
        resource: {
          kind: "command",
          trigger: "/",
          name,
          source: "command",
          origin: args?.origin ?? "builtin",
          label: name,
          argumentHint: null,
        },
      },
    ],
  };
}

function promptTextInput(text: string): PromptInput {
  return { type: "text", text, mentions: [] };
}

describe.each([
  ["compact", isStandaloneBuiltinCompactCommand],
  ["clear", isStandaloneBuiltinClearCommand],
] as const)("isStandaloneBuiltin%sCommand", (name, classify) => {
  it("classifies a standalone built-in mention", () => {
    expect(classify([promptCommandInput(name)])).toBe(true);
  });

  it("does not classify raw command text", () => {
    expect(classify([promptTextInput(`/${name}`)])).toBe(false);
  });

  it("does not classify user-origin commands", () => {
    expect(classify([promptCommandInput(name, { origin: "user" })])).toBe(
      false,
    );
  });

  it("does not classify mixed command input", () => {
    expect(
      classify([promptCommandInput(name, { text: `/${name} then summarize` })]),
    ).toBe(false);
  });
});

describe("parseBuiltinGoalCommand", () => {
  it("extracts the trailing objective from a built-in /goal mention", () => {
    expect(
      parseBuiltinGoalCommand([
        promptCommandInput("goal", { text: "/goal ship the hybrid loop" }),
      ]),
    ).toEqual({ objective: "ship the hybrid loop" });
  });

  it("treats a mention-only /goal as an empty objective", () => {
    expect(parseBuiltinGoalCommand([promptCommandInput("goal")])).toEqual({
      objective: "",
    });
  });

  it("does not parse raw /goal text without a mention", () => {
    expect(parseBuiltinGoalCommand([promptTextInput("/goal ship it")])).toBe(
      null,
    );
  });

  it("does not parse user-origin /goal (Codex native composer action)", () => {
    expect(
      parseBuiltinGoalCommand([
        promptCommandInput("goal", {
          origin: "user",
          text: "/goal ship it",
        }),
      ]),
    ).toBe(null);
  });

  it("does not parse /goal mixed with a file attachment", () => {
    expect(
      parseBuiltinGoalCommand([
        promptCommandInput("goal", { text: "/goal ship it" }),
        { type: "localFile", path: "/tmp/notes.md" },
      ]),
    ).toBe(null);
  });
});
