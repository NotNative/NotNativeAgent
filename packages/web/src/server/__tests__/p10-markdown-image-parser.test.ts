// SPDX-License-Identifier: Apache-2.0
/** P10-62 §G.6 parser: only real assistant-referenced markdown images. */
import { describe, expect, it } from "vitest";
import { collectMarkdownImageDestinations } from "../lib/markdown-image-grants/markdown-image-parser.ts";

describe("markdown image parser", () => {
  it("collects inline, bracketed, and reference destinations", () => {
    const text = [
      "![alpha](workspace/one.png)",
      "![beta](<workspace with space/two.png>)",
      "![gamma][]",
      "",
      "[gamma ref]: workspace/escaped gamma.png",
      "![gamma][gamma ref]",
      "![wide](workspace/wide.png \"title\")",
    ].join("\n\n");
    expect(collectMarkdownImageDestinations(text)).toEqual([
      "workspace/escaped gamma.png",
      "workspace/one.png",
      "workspace with space/two.png",
      "workspace/wide.png",
    ]);
  });

  it("ignores images inside code fences and spans", () => {
    const text = "\n```\n![hidden](no/one.png)\n```\nPlain: `![hidden](no/two.png)`\nWrapped: `hidden\n![hidden](no/three.png)`\nVisible: ![real](yes.png)";
    expect(collectMarkdownImageDestinations(text)).toEqual(["yes.png"]);
  });

  it("ignores escaped and bracket-like nonimages", () => {
    const text = "\\![not-image](wrong.png)\nA [reference] with no label point: not-image.png";
    expect(collectMarkdownImageDestinations(text)).toEqual([]);
  });
});
