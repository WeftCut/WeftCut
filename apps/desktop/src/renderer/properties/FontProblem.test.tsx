// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { FontIndex } from "../../shared/fonts/types";
import { MotifFontProblem, TextFontProblem } from "./FontProblem";

const { current } = vi.hoisted(() => ({ current: { index: null as unknown as FontIndex } }));
vi.mock("../render/fonts/fontIndexStore", () => ({ useFontIndex: () => current.index }));
// The key and its params, so a test reads what the note was asked to say.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, params: object) => `${key} ${JSON.stringify(params)}` }),
}));
afterEach(cleanup);

const exampleSans: FontIndex["faces"][number] = {
  families: ["Example Sans"], weight: 400, italic: false, source: "system", sha256: "a".repeat(64), size: 1, ttcIndex: null,
};

describe("FontProblem", () => {
  it("names a Text layer's missing family, its style, and what draws instead", () => {
    current.index = { revision: 1, complete: true, faces: [exampleSans] };
    render(<TextFontProblem text={{ font_family: "Missing Face, Example Sans", weight: 700, italic: false }} />);
    expect(screen.getByTestId("font-problem").textContent).toBe(
      `property_panel.font_missing ${JSON.stringify({ family: "Missing Face", style: "Bold", fallback: "Example Sans" })}`,
    );
  });

  it("says nothing while the system scan is pending", () => {
    current.index = { revision: 1, complete: false, faces: [] };
    render(<TextFontProblem text={{ font_family: "Missing Face", weight: 400, italic: false }} />);
    expect(screen.queryByTestId("font-problem")).toBeNull();
  });

  it("names a Motif prop's missing family without a style", () => {
    current.index = { revision: 1, complete: true, faces: [] };
    const manifest = { props_schema: { font_title: { type: "string" as const, default: "serif" } } };
    render(<MotifFontProblem manifest={manifest} props={{ font_title: "Missing Face" }} />);
    expect(screen.getByTestId("font-problem").textContent).toBe(
      `property_panel.font_missing ${JSON.stringify({ context: "motif_default", family: "Missing Face" })}`,
    );
  });
});
