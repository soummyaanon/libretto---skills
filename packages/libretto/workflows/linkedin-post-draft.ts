import { workflow } from "libretto";

type PostDraftInput = {
  text?: string;
  publish?: boolean;
};

const DEFAULT_POST = `AI is useful only when it moves from demos to real workflows.

Lately I have been exploring how AI agents can work with browser automation to handle repetitive web tasks: searching, inspecting pages, drafting messages, checking results, and keeping a human approval step before anything important happens.

The interesting part is not just making the agent click buttons. It is making the workflow reliable, reviewable, and safe enough that a person can trust it.

If you are experimenting with AI agents or browser automation, I would love to compare notes.`;

function getPostText(input: unknown): string {
  if (!input || typeof input !== "object") return DEFAULT_POST;
  const value = (input as Record<string, unknown>).text;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_POST;
}

function shouldPublish(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  return (input as Record<string, unknown>).publish === true;
}

export default workflow("linkedin-post-draft", async ({ page }, input) => {
  const text = getPostText(input);
  const publish = shouldPublish(input);

  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.getByText("Start a post", { exact: true }).click();
  await page.waitForTimeout(2_000);

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.insertText(text);

  if (publish) {
    const dialog = page.locator('[role="dialog"]').last();
    await dialog.getByRole("button", { name: /^Post$/ }).click();
    await page.waitForTimeout(5_000);
  }

  return {
    status: publish ? "published" : "drafted",
    note: publish
      ? "Post was submitted from the LinkedIn composer."
      : "Post text is in the LinkedIn composer. The workflow does not click Post.",
    text,
  };
});
