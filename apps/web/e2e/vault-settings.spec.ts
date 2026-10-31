import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("the vault offers to connect Vaultwarden", async ({ page }, testInfo) => {
  await signup(page, `vault-settings-${Date.now()}@rakazo.test`, "password12", "Vault");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "vault");
  await expect(settings.getByTestId("credential-add")).toBeVisible();
  await expect(settings.getByTestId("vaultwarden-connect")).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-settings-connect-vaultwarden");

  await settings.getByTestId("vaultwarden-connect").click();
  const dialog = page.getByRole("dialog", { name: "Vaultwarden" });
  await expect(dialog.getByLabel("Server URL")).toBeVisible();
  await expect(dialog.getByTestId("vaultwarden-connect-submit")).toBeDisabled();
  await captureScreenshot(page, testInfo, "vault-settings-vaultwarden-dialog");
});
