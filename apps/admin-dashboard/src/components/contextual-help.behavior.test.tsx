import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextualHelp } from "./contextual-help";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/context/permission-provider", () => ({
  usePermissions: () => ({ permissions: ["events.read"], loading: false }),
}));
vi.mock("@/lib/docs", () => ({
  dashboardDocUrl: (routeId: string) => `https://docs.example.test/${routeId}`,
}));
vi.mock("@tixkit/docs-core", () => ({
  helpForPath: () => ({
    id: "workspace",
    title: "Workspace readiness",
    summary: "Finish required workspace setup.",
    docRouteId: "workspace",
    commonTasks: [{ label: "Configure a brand", docRouteId: "brands" }],
    troubleshooting: [{ symptom: "Setup is blocked", docRouteId: "workspace" }],
  }),
  filterHelpByPermissions: (entries: unknown[]) => entries,
}));

describe("ContextualHelp behavior", () => {
  it("moves focus into the popup and returns it after Escape", async () => {
    render(<ContextualHelp />);
    const trigger = screen.getByRole("button", { name: "Help" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses when a pointer interaction happens outside", () => {
    render(<ContextualHelp />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
