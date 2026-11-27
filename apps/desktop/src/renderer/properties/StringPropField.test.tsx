// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { canonicalizeProps, type Manifest } from "../../shared/motifs/catalog";
import "../i18n";
import { StringPropField } from "./MotifPropFields";

afterEach(cleanup);

const spec = { type: "string" as const, default: "", max_length: 50 };
const short = { type: "string" as const, default: "", max_length: 5 };

/// What the state actor's strict check says about committing `title` = `value`
/// under `max`: the field must never hand it a value this refuses.
const accepted = (value: string, max: number) => {
  const manifest = { props_schema: { title: { type: "string", default: "", max_length: max } } } as unknown as Manifest;
  try {
    canonicalizeProps(manifest, { title: value });
    return true;
  } catch {
    return false;
  }
};

describe("StringPropField", () => {
  it("commits the current text when Enter is pressed", async () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={spec} value="" onCommit={onCommit} />);
    const el = screen.getByRole("textbox");
    await userEvent.type(el, "hello");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("hello");
  });

  it("still commits on blur", async () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={spec} value="" onCommit={onCommit} />);
    await userEvent.type(screen.getByRole("textbox"), "world");
    await userEvent.click(document.body); // blur
    expect(onCommit).toHaveBeenCalledWith("world");
  });

  it("says the limit only once it cut the input, and not after the field is left", async () => {
    render(<StringPropField label="Title" spec={short} value="" onCommit={vi.fn()} />);
    const el = screen.getByRole("textbox");
    await userEvent.type(el, "abcde");
    expect(screen.queryByRole("status")).toBeNull();
    await userEvent.type(el, "f");
    expect(screen.getByRole("status").textContent).toContain(String(short.max_length));
    await userEvent.click(document.body);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stops at the limit the validator enforces, counting an emoji as one character", async () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={short} value="" onCommit={onCommit} />);
    const el = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Two emoji are four UTF-16 units: a native maxLength would stop at "😀😀a".
    await userEvent.type(el, "😀😀abcdef");
    expect(el.value).toBe("😀😀abc");
    await userEvent.click(document.body);
    const committed = onCommit.mock.calls[0]![0] as string;
    expect(committed).toBe("😀😀abc");
    expect(accepted(committed, short.max_length)).toBe(true);
  });

  it("cuts a paste past the limit", async () => {
    const user = userEvent.setup();
    render(<StringPropField label="Title" spec={short} value="" onCommit={vi.fn()} />);
    const el = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.click(el);
    await user.paste("abcdefgh");
    expect(el.value).toBe("abcde");
  });

  it("leaves an IME composition whole until it ends, then applies the limit", () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={short} value="" onCommit={onCommit} />);
    const el = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.compositionStart(el);
    fireEvent.input(el, { target: { value: "你好世界朋友们" }, isComposing: true });
    expect(el.value).toBe("你好世界朋友们");
    fireEvent.compositionEnd(el);
    expect(el.value).toBe("你好世界朋");
  });

  it("keeps a single-line prop on one line: Enter adds no newline, a pasted one becomes a space", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={spec} value="" onCommit={onCommit} />);
    const el = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.click(el);
    await user.paste("one\ntwo");
    expect(el.value).toBe("one two");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("one two");
  });

  it("lets a multiline prop take newlines, committing on blur only", async () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Text" spec={{ ...spec, multiline: true }} value="" onCommit={onCommit} />);
    const el = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(el, "one{Enter}two");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledWith("one\ntwo");
  });
});
