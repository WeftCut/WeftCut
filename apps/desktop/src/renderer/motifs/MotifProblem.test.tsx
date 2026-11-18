// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { MotifProblem } from "./MotifProblem";

afterEach(async () => { cleanup(); await i18n.changeLanguage("en-US"); });

describe("a project Motif that cannot render, as the app says it", () => {
  it("words a missing folder in the user's language, from its status alone", async () => {
    render(<MotifProblem id="end-slate" status="missing" />);
    expect(screen.getByText("Motifs/end-slate/ is missing")).toBeTruthy();
    cleanup();
    await i18n.changeLanguage("zh-CN");
    render(<MotifProblem id="end-slate" status="missing" />);
    expect(screen.getByText("Motifs/end-slate/ 不存在")).toBeTruthy();
  });

  it("keeps an invalid package's error as written, under a localized lead", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<MotifProblem id="torn" status="invalid" diagnostic="manifest.json: Unexpected token" />);
    expect(screen.getByText("Motifs/torn/ 不是有效的 Motif")).toBeTruthy();
    expect(screen.getByText("manifest.json: Unexpected token")).toBeTruthy();
  });
});
