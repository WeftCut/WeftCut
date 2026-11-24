import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { renderLogMessage } from "./renderMessage";

const t = (key: string, options: Record<string, unknown>) => i18n.t(key, options);

afterEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("renderLogMessage", () => {
  it("joins the family names main sends as an array with the locale's list", async () => {
    const entry = { message: "fallback", i18n_key: "log.fonts_copied", i18n_args: { names: ["Inter", "思源黑体"], more: 0 } };
    await i18n.changeLanguage("en-US");
    expect(renderLogMessage(entry, t)).toMatch(/^Copied Inter, 思源黑体 into Fonts\//);
    await i18n.changeLanguage("zh-CN");
    expect(renderLogMessage(entry, t)).toMatch(/^已将 Inter、思源黑体 复制到 Fonts\//);
  });

  it("counts the families past the named ones", async () => {
    const entry = {
      message: "fallback", i18n_key: "log.fonts_copied_more",
      i18n_args: { names: ["Inter", "Source Han Sans"], more: 4 },
    };
    await i18n.changeLanguage("en-US");
    expect(renderLogMessage(entry, t)).toMatch(/^Copied Inter, Source Han Sans and 4 more into Fonts\//);
  });
});
