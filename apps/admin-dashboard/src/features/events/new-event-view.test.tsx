import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewEventView } from "./new-event-view";

const push = vi.hoisted(() => vi.fn());
const createEvent = vi.hoisted(() => vi.fn());
const createTicketType = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/context/bootstrap-provider", () => ({
  useBootstrap: () => ({
    organizationId: "org_1",
    brandId: "brd_1",
    brands: [],
  }),
}));
vi.mock("@/context/permission-provider", () => ({
  usePermissions: () => ({ can: () => true, loading: false }),
}));
vi.mock("@/hooks/use-all-events", () => ({
  useAllEvents: () => ({ events: [], loading: false }),
}));
vi.mock("@/lib/api", () => ({
  adminApi: {
    createEvent,
    createTicketType,
    createEventOccurrence: vi.fn(),
    duplicateEvent: vi.fn(),
    listPaymentAccounts: vi.fn(),
  },
}));

describe("NewEventView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEvent.mockResolvedValue({ ok: true, data: { id: "evt_new" } });
    createTicketType.mockResolvedValue({ ok: true, data: { id: "tt_1" } });
  });

  it("creates a durable blank draft and redirects to its launch center", async () => {
    render(<NewEventView />);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Community Night" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(createEvent.mock.calls[0][0]).toMatchObject({
      organizationId: "org_1",
      brandId: "brd_1",
      title: "Community Night",
    });
    expect(push).toHaveBeenCalledWith("/events/evt_new");
  });

  it("redirects to the existing draft when a preset side effect fails", async () => {
    createTicketType.mockResolvedValue({
      ok: false,
      error: { message: "inventory unavailable" },
    });
    render(<NewEventView />);
    fireEvent.click(screen.getByRole("radio", { name: /Free RSVP/ }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "RSVP Night" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        expect.stringMatching(/^\/events\/evt_new\?setupWarning=/),
      ),
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it("validates title before calling the API", async () => {
    render(<NewEventView />);
    const submit = screen.getByRole("button", { name: "Create draft" });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter an event title",
    );
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(createEvent).not.toHaveBeenCalled();
  });
});
