import { expect, test } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  enterAdminActionMode,
  execRuntimeSql,
  login,
  openAssignedDraft,
  openCasefile,
  reviewerUser,
  uploadFixture,
} from "./support/appliance";

function variableHeightSegments() {
  return Array.from({ length: 7 }, (_, index) => ({
    id: `layout-seg-${index + 1}`,
    speakerLabel: index % 2 === 0 ? "Speaker 1" : "Speaker 2",
    startMs: index * 5_000,
    endMs: (index + 1) * 5_000,
    text: Array.from(
      { length: 28 },
      () => `Segment ${index + 1} keeps every governed word visible in approver mode.`,
    ).join(" "),
    confidence: 0.9,
  }));
}

async function transcriptGeometry(page: import("@playwright/test").Page) {
  return page.getByTestId("transcript-start").evaluate((transcript) => {
    const cards = Array.from(
      transcript.querySelectorAll<HTMLElement>(".transcript-segment"),
    ).slice(0, 5);
    const fifthCard = cards.at(-1);
    const transcriptRect = transcript.getBoundingClientRect();
    const fifthCardRect = fifthCard?.getBoundingClientRect();
    const summary = transcript.querySelector<HTMLElement>(
      ".transcript-document__summary-copy",
    );
    const summaryStyle = summary ? getComputedStyle(summary) : null;
    const main = transcript.closest<HTMLElement>(".casefile-main");
    const transport = main?.querySelector<HTMLElement>(".media-transport");
    const mainRect = main?.getBoundingClientRect();
    const transportRect = transport?.getBoundingClientRect();
    const firstCardRect = cards.at(0)?.getBoundingClientRect();
    const visibleTop = Math.max(0, mainRect?.top ?? 0);
    const visibleBottom = Math.min(window.innerHeight, mainRect?.bottom ?? 0);

    return {
      clientHeight: transcript.clientHeight,
      contentThroughFifthCard: fifthCardRect
        ? fifthCardRect.bottom - transcriptRect.top + transcript.scrollTop
        : 0,
      minHeight: Number.parseFloat(getComputedStyle(transcript).minHeight),
      summaryScrollWidth: summary?.scrollWidth ?? 0,
      summaryClientWidth: summary?.clientWidth ?? 0,
      summaryTextOverflow: summaryStyle?.textOverflow ?? "",
      summaryWhiteSpace: summaryStyle?.whiteSpace ?? "",
      firstFiveFullyVisible:
        Boolean(firstCardRect && fifthCardRect) &&
        firstCardRect!.top >= visibleTop - 1 &&
        fifthCardRect!.bottom <= visibleBottom + 1,
      transportFullyVisible:
        Boolean(transportRect) &&
        transportRect!.top >= visibleTop - 1 &&
        transportRect!.bottom <= visibleBottom + 1,
    };
  });
}

test("media casefiles preserve variable transcript content and player floors", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Measured media layout record",
    durationMs: 40_000,
  });
  await createAndAssignUsers(page, recordingId);
  await openAssignedDraft(page, reviewerUser);

  const summary = Array.from(
    { length: 20 },
    () => "This complete revision summary remains available to the approver.",
  ).join(" ");
  execRuntimeSql(
    "update revisions set summary = ?, segments_json = ? where recording_id = ? and state = 'draft'",
    [summary, JSON.stringify(variableHeightSegments()), recordingId],
  );

  await login(page, adminUser);
  await openCasefile(page, recordingId);
  await enterAdminActionMode(
    page,
    "reviewer",
    "Submit variable transcript content for the approver layout check.",
  );

  const reviewerAudioGeometry = await transcriptGeometry(page);
  expect.soft(reviewerAudioGeometry.transportFullyVisible).toBe(true);
  expect.soft(reviewerAudioGeometry.firstFiveFullyVisible).toBe(true);

  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await page.reload();
  await expect(page.locator("video[controls]")).toBeVisible();

  const reviewerVideoGeometry = await transcriptGeometry(page);
  expect.soft(reviewerVideoGeometry.transportFullyVisible).toBe(true);
  expect.soft(reviewerVideoGeometry.firstFiveFullyVisible).toBe(true);

  execRuntimeSql(
    "update recordings set media_kind = 'audio', mime_type = 'audio/wav' where id = ?",
    [recordingId],
  );
  await page.reload();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  const submitDialog = page.getByRole("dialog", { name: "Submit for approval" });
  await submitDialog
    .getByRole("button", { name: "Submit for approval" })
    .last()
    .click();
  await expect(page.getByText("Pending approval", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Exit action mode" }).click();
  await enterAdminActionMode(
    page,
    "approver",
    "Inspect variable transcript content at the reference desktop viewport.",
  );
  await expect(page.getByRole("article", { name: /Transcript segment/ })).toHaveCount(7);

  const banner = page.getByLabel("Admin action mode");
  await expect.soft(banner.locator("details")).toHaveCount(1);
  await expect.soft(banner).toHaveCSS("display", "flex");

  const audioGeometry = await transcriptGeometry(page);
  expect
    .soft(audioGeometry.minHeight)
    .toBeGreaterThanOrEqual(audioGeometry.contentThroughFifthCard - 1);
  expect
    .soft(audioGeometry.clientHeight)
    .toBeGreaterThanOrEqual(audioGeometry.contentThroughFifthCard - 1);
  expect.soft(audioGeometry.summaryTextOverflow).not.toBe("ellipsis");
  expect.soft(audioGeometry.summaryWhiteSpace).not.toBe("nowrap");
  expect
    .soft(audioGeometry.summaryScrollWidth)
    .toBeLessThanOrEqual(audioGeometry.summaryClientWidth + 1);

  const audioTransport = page.locator('.media-transport[data-media-kind="audio"]');
  const audioOverflow = await audioTransport.evaluate(
    (transport) => transport.scrollHeight - transport.clientHeight,
  );
  expect.soft(audioOverflow).toBeLessThanOrEqual(1);

  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await page.reload();

  const video = page.locator("video[controls]");
  await expect(video).toBeVisible();
  const videoHeight = await video.evaluate((element) => element.getBoundingClientRect().height);
  expect.soft(videoHeight).toBeGreaterThanOrEqual(96);

  const videoGeometry = await transcriptGeometry(page);
  expect
    .soft(videoGeometry.minHeight)
    .toBeGreaterThanOrEqual(videoGeometry.contentThroughFifthCard - 1);
  expect
    .soft(videoGeometry.clientHeight)
    .toBeGreaterThanOrEqual(videoGeometry.contentThroughFifthCard - 1);
});
