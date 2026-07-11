import { expect, requireReachable, test } from "./fixtures/validation-test";
import { expectNoAxeViolations } from "./helpers/axe";
import { adminBaseUrl } from "./helpers/env";

test.describe("dashboard documentation platform", () => {
  test.beforeEach(async ({ page }) => {
    await requireReachable(page, adminBaseUrl, "admin dashboard");
  });

  test("Help Center searches permitted tasks and exact troubleshooting destinations", async ({
    page,
  }, testInfo) => {
    await page.goto(`${adminBaseUrl}/help`);
    await expect(
      page.getByRole("heading", { name: "Help Center" }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search Help Center" })
      .fill("signature");
    const links = page.getByRole("link", { name: /Verify|Diagnose|Open/ });
    await expect(links.first()).toBeVisible();
    const destinations = await links.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLAnchorElement).href),
    );
    expect(
      destinations.some((href) =>
        href.includes("/developers/webhooks/verify-signatures"),
      ),
    ).toBe(true);
    await expectNoAxeViolations(page, testInfo);
  });

  test("developer console keeps secrets out of the page and separates API and webhook guidance", async ({
    page,
  }, testInfo) => {
    await page.goto(`${adminBaseUrl}/developer`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Developer" }),
    ).toBeVisible();
    await expect(page.getByText("Make a safe first API request")).toBeVisible();
    await expect(
      page.getByText("TIXKIT_API_KEY", { exact: false }).first(),
    ).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/\btk_[A-Za-z0-9_-]{8,}/);
    const apiHref = await page
      .getByRole("link", { name: "Open reference" })
      .getAttribute("href");
    const webhookHref = await page
      .getByRole("link", { name: "Open event catalog" })
      .getAttribute("href");
    expect(apiHref).toContain("/reference/api");
    expect(webhookHref).toContain("/reference/webhook-events");
    expect(apiHref).not.toBe(webhookHref);
    await expectNoAxeViolations(page, testInfo);
  });

  test("contextual Help manages focus, Escape, and outside dismissal", async ({
    page,
  }, testInfo) => {
    await page.goto(`${adminBaseUrl}/`);
    const trigger = page.getByRole("button", { name: "Help", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator("main").click({ position: { x: 8, y: 8 } });
    await expect(dialog).not.toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("readiness renders server-owned incomplete and complete states with explicit scope", async ({
    page,
  }) => {
    let complete = false;
    const readinessRequests: string[] = [];
    await page.route("**/organizations/*/readiness?*", async (route) => {
      const url = route.request().url();
      readinessRequests.push(url);
      const steps = [
        {
          id: "workspace_selection",
          status: "complete",
          priority: "required",
          reasonCodes: ["workspace_selected"],
          requiredPermission: null,
          actionId: null,
        },
        {
          id: "brand_identity",
          status: complete ? "complete" : "incomplete",
          priority: "required",
          reasonCodes: [
            complete
              ? "brand_identity_configured"
              : "brand_identity_incomplete",
          ],
          requiredPermission: "settings.write",
          actionId: complete ? null : "configure_brand",
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: "org_dev_local",
          brandId: "brd_dev_local",
          complete,
          computedAt: "2026-07-10T12:00:00.000Z",
          steps,
        }),
      });
    });
    await page.goto(`${adminBaseUrl}/`);
    await expect(page.getByText("Finish workspace setup")).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Workspace readiness progress" }),
    ).toBeVisible();
    complete = true;
    await page.reload();
    await expect(page.getByText("Workspace setup complete")).toBeVisible();
    expect(readinessRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      readinessRequests.every((url) =>
        url.includes("/organizations/org_dev_local/readiness"),
      ),
    ).toBe(true);
    expect(
      readinessRequests.every((url) => url.includes("brandId=brd_dev_local")),
    ).toBe(true);
  });
});
