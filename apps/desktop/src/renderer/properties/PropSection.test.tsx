// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PropSection,
  clearPropSectionMemory,
  requestPropSectionExpand,
} from "./PropSection";

afterEach(() => {
  cleanup();
  clearPropSectionMemory();
});

function renderSection(
  props: Partial<Parameters<typeof PropSection>[0]> = {},
) {
  return render(
    <PropSection layerKind="VideoClip" sectionId="envelope" title="Layer" {...props}>
      <p>section body</p>
    </PropSection>,
  );
}

describe("PropSection collapse defaults", () => {
  it("renders its children by default", () => {
    renderSection();
    expect(screen.getByText("section body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Layer" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("does not mount children when defaultCollapsed", () => {
    renderSection({ defaultCollapsed: true });
    expect(screen.queryByText("section body")).toBeNull();
    expect(screen.getByRole("button", { name: "Layer" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("PropSection toggle", () => {
  it("mounts and unmounts children as the header is clicked", () => {
    renderSection({ defaultCollapsed: true });
    const header = screen.getByRole("button", { name: "Layer" });

    fireEvent.click(header);
    expect(screen.getByText("section body")).toBeTruthy();
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(screen.queryByText("section body")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("PropSection session memory", () => {
  it("remembers an override per layer kind across remounts", () => {
    // Expand the advanced bucket on one Video layer…
    const first = renderSection({ sectionId: "advanced", title: "Advanced", defaultCollapsed: true });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText("section body")).toBeTruthy();
    first.unmount();

    // …another Video layer keeps it expanded…
    const second = renderSection({ sectionId: "advanced", title: "Advanced", defaultCollapsed: true });
    expect(screen.getByText("section body")).toBeTruthy();
    second.unmount();

    // …but a Text layer still gets the collapsed default.
    renderSection({ layerKind: "Text", sectionId: "advanced", title: "Advanced", defaultCollapsed: true });
    expect(screen.queryByText("section body")).toBeNull();
  });

  it("re-derives the collapsed state when the layer kind changes on a mounted section", () => {
    const { rerender } = render(
      <PropSection layerKind="VideoClip" sectionId="advanced" title="Advanced" defaultCollapsed>
        <p>section body</p>
      </PropSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText("section body")).toBeTruthy();

    // Same component instance, new kind: the Video expansion must not leak.
    rerender(
      <PropSection layerKind="Text" sectionId="advanced" title="Advanced" defaultCollapsed>
        <p>section body</p>
      </PropSection>,
    );
    expect(screen.queryByText("section body")).toBeNull();

    // …and switching back to Video recalls its stored override.
    rerender(
      <PropSection layerKind="VideoClip" sectionId="advanced" title="Advanced" defaultCollapsed>
        <p>section body</p>
      </PropSection>,
    );
    expect(screen.getByText("section body")).toBeTruthy();
  });
});

// The command's half of the contract: revealing the Attribute Panel is not
// enough on its own, because a section that stays collapsed leaves the user
// hunting for a header. Both orders are real — the Panel may be closed when the
// command runs, or already showing the very layer it is about.
describe("PropSection expand requests", () => {
  it("expands a section that is already mounted", () => {
    renderSection({ sectionId: "pauses", title: "Pauses", defaultCollapsed: true });
    expect(screen.queryByText("section body")).toBeNull();

    act(() => requestPropSectionExpand("VideoClip", "pauses"));
    expect(screen.getByText("section body")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pauses" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("expands a section that mounts after the request", () => {
    act(() => requestPropSectionExpand("VideoClip", "pauses"));
    renderSection({ sectionId: "pauses", title: "Pauses", defaultCollapsed: true });
    expect(screen.getByText("section body")).toBeTruthy();
  });

  // Keyed, or one command would open every collapsed section on screen.
  it("leaves other sections and other kinds alone", () => {
    render(
      <>
        <PropSection layerKind="VideoClip" sectionId="advanced" title="Advanced" defaultCollapsed>
          <p>advanced body</p>
        </PropSection>
        <PropSection layerKind="Text" sectionId="pauses" title="Text pauses" defaultCollapsed>
          <p>text body</p>
        </PropSection>
      </>,
    );
    act(() => requestPropSectionExpand("VideoClip", "pauses"));
    expect(screen.queryByText("advanced body")).toBeNull();
    expect(screen.queryByText("text body")).toBeNull();
  });

  // The request is an EVENT, not a latch: re-collapsing after acting on one has
  // to stick, or the header's own toggle would fight a stale flag.
  it("does not re-open a section the user collapsed after the request", () => {
    renderSection({ sectionId: "pauses", title: "Pauses", defaultCollapsed: true });
    act(() => requestPropSectionExpand("VideoClip", "pauses"));
    fireEvent.click(screen.getByRole("button", { name: "Pauses" }));
    expect(screen.queryByText("section body")).toBeNull();
  });
});
