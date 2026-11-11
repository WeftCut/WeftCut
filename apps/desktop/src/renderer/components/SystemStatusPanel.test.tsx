// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { receiveSaveStatus, useSaveStatusStore } from "../state/saveStatusStore";

let revision = 0;
const fail = (code: string | null) =>
  receiveSaveStatus({
    state: "failing", revision: ++revision, since: "2026-01-02T03:04:05.000Z", last_saved_at: null,
    code, path: "/home/u/Projects/Demo/project.json", dir: "/home/u/Projects/Demo",
  });
const saveActions = () => ({
  retry: vi.fn(async () => {}),
  saveAs: vi.fn(),
  openFolder: vi.fn(async (_dir: string) => {}),
});

afterEach(() => {
  cleanup();
  useSaveStatusStore.setState({ status: { state: "ok", revision: 0 } });
  revision = 0;
});
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("SystemStatusPanel", () => {
  it("owns the interactive system card and closes independently", async () => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <SystemStatusPanel
        notices={[{ level: "warn", code: "keyring_unavailable" }]}
        onClose={onClose}
        onOpenSettings={onOpenSettings}
        saveActions={saveActions()}
      />,
    );
    expect(screen.queryByTestId("save-failure-card")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "打开 API 密钥设置" }));
    expect(onOpenSettings).toHaveBeenCalledWith("speech");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the save-failure card with no notices: reason, file, last save, and its three actions", async () => {
    const actions = saveActions();
    fail("ENOSPC");
    render(<SystemStatusPanel notices={[]} onClose={vi.fn()} onOpenSettings={vi.fn()} saveActions={actions} />);
    const card = screen.getByTestId("save-failure-card");
    expect(card.textContent).toContain("项目未保存");
    expect(card.textContent).toContain("磁盘已满。");
    expect(card.textContent).toContain("/home/u/Projects/Demo/project.json");
    expect(card.textContent).toContain("本次打开后尚未保存");

    await userEvent.click(screen.getByRole("button", { name: "立即重试" }));
    expect(actions.retry).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "另存为…" }));
    expect(actions.saveAs).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(actions.openFolder).toHaveBeenCalledWith("/home/u/Projects/Demo");
  });

  it("says when a retry fails, and leads above the notices", async () => {
    const actions = { ...saveActions(), retry: vi.fn(async () => { throw new Error("ENOSPC") }) };
    fail("ENOSPC");
    render(
      <SystemStatusPanel
        notices={[{ level: "warn", code: "keyring_unavailable" }]}
        onClose={vi.fn()} onOpenSettings={vi.fn()} saveActions={actions}
      />,
    );
    const card = screen.getByTestId("save-failure-card");
    const notices = screen.getByRole("button", { name: "打开 API 密钥设置" });
    expect(card.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "立即重试" }));
    expect(await screen.findByText("仍未保存。")).toBeTruthy();
  });

  it("drops the card once main reports the project saved", () => {
    fail("EACCES");
    render(<SystemStatusPanel notices={[]} onClose={vi.fn()} onOpenSettings={vi.fn()} saveActions={saveActions()} />);
    expect(screen.getByTestId("save-failure-card")).toBeTruthy();
    act(() => receiveSaveStatus({ state: "ok", revision: ++revision }));
    expect(screen.queryByTestId("save-failure-card")).toBeNull();
  });
});
