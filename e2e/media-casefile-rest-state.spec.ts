import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  execRuntimeSql,
  firstTranscriptRow,
  openCasefile,
  uploadFixture,
} from "./support/appliance";

// Rest-state contract: after the rollback of the media-casefile layout work
// (#53/#54), the casefile media surface keeps its player-first presentation:
// the full media player leads the casefile main column, a compact segment
// chip strip sits between the player and the transcript document whenever the
// window can afford it, and the transcript review surface stays below both.
// The vertical-budget rule is part of the rest state too: on short
// laptop-height windows (>=1100px wide, <=920px tall) the pinned transport
// collapses the chip rail so the review surface keeps room - every segment
// still seeks from its transcript row timestamp. On phone-width viewports
// the review surface is safety-gated behind the tablet-or-desktop notice
// while the player stays available. A future layout change must update this
// spec deliberately instead of silently reverting the rest state.
//
// Pinned transcript zone (casefile-pin-transcript-zone): on desktop the case
// header, the media box, the transport, and the segment rail form a pinned
// zone inside the bounded page - the window itself carries no scroll range,
// so no browser-window scroll can move them - and ONLY the transcript
// segments list scrolls, inside its own viewport below the pinned zone.
// Follow-scroll stays dormant at the player-led rest state, activates on the
// first playback tick or an accepted explicit seek, then centers the active
// card - with both neighbours on each side fully visible at 1280x800 where
// geometry allows (audio casefiles at that canonical size; video casefiles
// keep several full cards below the original-size frame per the captain's
// 2026-08-19 ruling); the first and final cards anchor honestly at the
// viewport's block edges.

async function waitForRestStateTranscript(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await firstTranscriptRow(page).isVisible().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(2_000);
    await page.reload();
  }

  await expect(firstTranscriptRow(page)).toBeVisible();
}

test("video casefile rest state: full player leads, compact chip strip below, transcript last", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Tall reference window: the vertical-budget rule below is exercised
  // separately; here the full rest state (rail included) is on display.
  await page.setViewportSize({ width: 1280, height: 960 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Media rest state record",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);

  // Promote the uploaded audio record to a video casefile the same way the
  // appliance labels real video uploads.
  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await openCasefile(page, recordingId);

  const video = page.locator("video[controls]");
  await expect(video).toBeVisible();

  const transport = page.locator(".media-transport");
  const rail = transport.getByRole("list", { name: "Transcript segments" });
  const transcript = page.getByTestId("transcript-start");
  await expect(rail).toBeVisible();
  await expect(transcript).toBeVisible();

  // The compact segment chip strip carries one seek chip per transcript
  // segment, kept squeezed between the player and the review surface.
  const segmentArticles = await page
    .getByRole("article", { name: /Transcript segment \d+, / })
    .count();
  const chips = rail.getByRole("button", { name: /Seek and review\.$/ });
  await expect(chips).toHaveCount(segmentArticles);
  expect(segmentArticles).toBeGreaterThan(0);

  // Rest-state geometry: the player hero sits above the chip strip, the
  // chip strip sits above the transcript document, and the media transport
  // owns the top of the casefile main column.
  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".casefile-main");
    const transportEl = main?.querySelector<HTMLElement>(".media-transport");
    const videoEl = main?.querySelector("video");
    const railEl = transportEl?.querySelector<HTMLElement>(
      ".media-transport__rail",
    );
    const transcriptEl = main?.querySelector<HTMLElement>(
      '[data-testid="transcript-start"]',
    );
    if (!main || !transportEl || !videoEl || !railEl || !transcriptEl) {
      return null;
    }

    const videoRect = videoEl.getBoundingClientRect();
    const railRect = railEl.getBoundingClientRect();
    const transcriptRect = transcriptEl.getBoundingClientRect();
    const transportFirst =
      (main.firstElementChild?.compareDocumentPosition(transportEl) ??
        0) === 0 ||
      Array.from(main.children).indexOf(transportEl) === 0;

    return {
      transportFirst,
      videoHeight: videoRect.height,
      videoAboveRail: videoRect.bottom <= railRect.top + 1,
      railAboveTranscript: railRect.bottom <= transcriptRect.top + 1,
      transportSpansMain: transportEl.getBoundingClientRect().top <= videoRect.top + 1,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.transportFirst).toBe(true);
  // Original-size video frame (captain ruling 2026-08-19): the pre-pinned
  // 30vh cap is back and the withdrawn 96px band must not come back. The
  // promoted fixture has no decodable video track, so the element sits at
  // its intrinsic 150px height; the contract is the restored CSS cap, read
  // as the computed max-height against the current window height.
  const videoCap = await page.evaluate(() => {
    const video = document.querySelector("video");
    return video
      ? { cap: getComputedStyle(video).maxHeight, innerHeight: window.innerHeight }
      : null;
  });
  expect(videoCap).not.toBeNull();
  expect(videoCap?.cap).toBe(`${Math.round((videoCap?.innerHeight ?? 0) * 0.3)}px`);
  expect(geometry?.videoHeight).toBeGreaterThanOrEqual(96);
  expect(geometry?.videoAboveRail).toBe(true);
  expect(geometry?.railAboveTranscript).toBe(true);
  expect(geometry?.transportSpansMain).toBe(true);

  // Vertical-budget rest state: shrink to a laptop-height window and the
  // pinned transport collapses the chip rail; the transcript rows keep the
  // per-segment seek affordance.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".media-transport__rail")).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Play (or pause segment|from) / }).first(),
  ).toBeVisible();

  // Pinned-zone contract: the window itself carries no scroll range, so the
  // case header, media transport, and action bar cannot be scrolled away.
  const pinnedBefore = await page.evaluate(() => {
    const top = (selector: string) =>
      Math.round(document.querySelector(selector)!.getBoundingClientRect().top);
    return {
      header: top(".case-header"),
      transport: top(".media-transport"),
      actionBar: top(".casefile-action-bar"),
      scrollRange:
        document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(pinnedBefore.scrollRange).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    window.scrollTo(0, 500);
    document.documentElement.scrollTop = 400;
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 600, bubbles: true }));
  });
  const pinnedAfter = await page.evaluate(() => {
    const top = (selector: string) =>
      Math.round(document.querySelector(selector)!.getBoundingClientRect().top);
    return {
      header: top(".case-header"),
      transport: top(".media-transport"),
      actionBar: top(".casefile-action-bar"),
      scrollY: window.scrollY,
    };
  });
  expect(pinnedAfter.scrollY).toBe(0);
  expect(pinnedAfter.header).toBe(pinnedBefore.header);
  expect(pinnedAfter.transport).toBe(pinnedBefore.transport);
  expect(pinnedAfter.actionBar).toBe(pinnedBefore.actionBar);

  // ONLY the transcript segments list scrolls, in its own viewport; the main
  // column itself is no longer a scroller.
  const scrollerShape = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(
      ".transcript-document__segments",
    )!;
    const main = document.querySelector<HTMLElement>(".casefile-main")!;
    return {
      viewportOverflow: getComputedStyle(viewport).overflowY,
      mainOverflow: getComputedStyle(main).overflowY,
      viewportHeight: viewport.clientHeight,
      viewportScrollTop: viewport.scrollTop,
    };
  });
  expect(scrollerShape.viewportOverflow).toBe("auto");
  expect(scrollerShape.mainOverflow).not.toBe("auto");
  // Several-segment floor (captain ruling 2026-08-19): the video frame is
  // back at its original 30vh size, so the 1280x800 video casefile holds
  // the audio middle-2..middle+2 contract no longer; its budget guarantee is
  // several full cards below the video box (a card costs 42px plus a 4px
  // gap, so 176px holds three whole cards and part of the fourth). The
  // dormant rest state opens at the top of the list.
  expect(scrollerShape.viewportHeight).toBeGreaterThanOrEqual(176);
  expect(scrollerShape.viewportScrollTop).toBe(0);
});

// Near-max changes-requested note (validateApprovalNote caps notes at 500
// characters) with explicit line breaks, so the banner note always spans
// more lines than its compact internal scrollport shows.
const LONG_CHANGES_NOTE = Array.from(
  { length: 6 },
  (_, index) =>
    `Line ${index + 1}: please restore the missing governed detail in this block before approval.`,
).join("\n");

test("changes-requested banner keeps the pinned-zone budget at 1280x800 with a long note", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Changes-note pin-budget record",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);

  // Mint a changes-requested decision with a near-max note on the latest
  // revision, the same row the request-changes command writes.
  execRuntimeSql(
    `insert into approvals
       (id, recording_id, revision_id, state, actor_role, actor_display_name, created_at, note)
     values (
       ?,
       ?,
       (select id from revisions where recording_id = ? order by version desc limit 1),
       'changes_requested',
       'approver',
       'E2E Approver',
       ?,
       ?
     )`,
    [
      `e2e-changes-note-${recordingId}`,
      recordingId,
      recordingId,
      new Date().toISOString(),
      LONG_CHANGES_NOTE,
    ],
  );
  await openCasefile(page, recordingId);

  const readBannerGeometry = () =>
    page.evaluate(() => {
      const pageEl = document.querySelector<HTMLElement>(".casefile-page");
      const banner = document.querySelector<HTMLElement>(".changes-requested-banner");
      const note = banner?.querySelector<HTMLElement>(".changes-requested-banner__note");
      const viewport = document.querySelector<HTMLElement>(".transcript-document__segments");
      if (!pageEl || !banner || !note || !viewport) {
        return null;
      }

      return {
        scrollRange: document.documentElement.scrollHeight - window.innerHeight,
        pageOverflow: pageEl.scrollHeight - pageEl.clientHeight,
        viewportHeight: viewport.clientHeight,
        bannerBottom: banner.getBoundingClientRect().bottom,
        viewportTop: viewport.getBoundingClientRect().top,
        noteScrolls: note.scrollHeight > note.clientHeight + 1,
        noteClientHeight: note.clientHeight,
      };
    });

  const banner = page.locator(".changes-requested-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Changes requested");
  await expect(banner).toContainText(LONG_CHANGES_NOTE.split("\n")[0]);

  const audio = await readBannerGeometry();
  expect(audio).not.toBeNull();
  // Pin contract: the window carries no scroll range and the bounded page
  // never silently clips its content even with the maximal banner present.
  expect(audio?.scrollRange).toBeLessThanOrEqual(1);
  expect(audio?.pageOverflow).toBeLessThanOrEqual(1);
  // ...while the transcript viewport keeps the short-tier audio floor.
  expect(audio?.viewportHeight).toBeGreaterThanOrEqual(224);
  // The banner pins above the transcript...
  expect(audio?.bannerBottom).toBeLessThanOrEqual((audio?.viewportTop ?? 0) + 1);
  // ...in its compact treatment: the full long note stays readable inside
  // the note's own internal scrollport rather than consuming the budget.
  expect(audio?.noteScrolls).toBe(true);
  expect(audio?.noteClientHeight).toBeLessThanOrEqual(96);

  // The same budget holds on a video casefile: the video floor is lower.
  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await openCasefile(page, recordingId);
  await expect(page.locator(".changes-requested-banner")).toBeVisible();

  const video = await readBannerGeometry();
  expect(video).not.toBeNull();
  expect(video?.scrollRange).toBeLessThanOrEqual(1);
  expect(video?.pageOverflow).toBeLessThanOrEqual(1);
  expect(video?.viewportHeight).toBeGreaterThanOrEqual(144);
  expect(video?.bannerBottom).toBeLessThanOrEqual((video?.viewportTop ?? 0) + 1);
  expect(video?.noteScrolls).toBe(true);
});

test("pinned transcript zone: centered follow with honest edge anchoring", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Pinned zone follow record",
    durationMs: 40_000,
  });
  await waitForRestStateTranscript(page);

  // Densify the seeded transcript into twelve gapless segments so playback
  // can actually reach the middle of the list inside the 40s fixture.
  execRuntimeSql(
    `update revisions set segments_json = (
       select json_group_array(json_object(
         'id', recording_id || '-dense-' || seq,
         'speakerLabel', 'Speaker 1',
         'startMs', (seq - 1) * 3300,
         'endMs', seq * 3300,
         'text', 'Dense segment ' || seq || ' for the pinned-zone contract.',
         'confidence', 0.93
       ))
       from (select 1 as seq union select 2 union select 3 union select 4
             union select 5 union select 6 union select 7 union select 8
             union select 9 union select 10 union select 11 union select 12)
     )
     where recording_id = ?`,
    [recordingId],
  );
  await openCasefile(page, recordingId);
  await expect(firstTranscriptRow(page)).toBeVisible();

  const followState = () =>
    page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(
        ".transcript-document__segments",
      )!;
      const viewportRect = viewport.getBoundingClientRect();
      const rows = Array.from(
        viewport.querySelectorAll<HTMLElement>(".transcript-segment"),
      );
      const active = viewport.querySelector<HTMLElement>("[data-active]");
      const index = active ? rows.indexOf(active) : -1;
      const fullyVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.top >= viewportRect.top - 1 && rect.bottom <= viewportRect.bottom + 1
        );
      };
      const centerOffset = active
        ? Math.round(
            active.getBoundingClientRect().top +
              active.getBoundingClientRect().height / 2 -
              (viewportRect.top + viewportRect.height / 2),
          )
        : null;
      return {
        index,
        centerOffset,
        scrollTop: viewport.scrollTop,
        maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
        windowScrollY: window.scrollY,
        neighbours:
          index >= 2 && index + 2 < rows.length
            ? [
                fullyVisible(rows[index - 2]),
                fullyVisible(rows[index - 1]),
                fullyVisible(rows[index + 1]),
                fullyVisible(rows[index + 2]),
              ]
            : null,
        firstTopOffset:
          rows.length > 0
            ? Math.round(rows[0].getBoundingClientRect().top - viewportRect.top)
            : null,
        lastBottomOffset:
          rows.length > 0
            ? Math.round(
                rows[rows.length - 1].getBoundingClientRect().bottom -
                  viewportRect.bottom,
              )
            : null,
      };
    });

  // Dormant rest state: no follow until the track moves.
  const rest = await followState();
  expect(rest.scrollTop).toBe(0);
  expect(rest.windowScrollY).toBe(0);

  // Accepted explicit seek to the middle: follow activates, the active card
  // centers, and middle-2 through middle+2 are all fully visible.
  await page.evaluate(() => {
    const media = document.querySelector<HTMLMediaElement>("audio, video")!;
    void media.play().catch(() => undefined);
    media.currentTime = 19.8;
  });
  await expect
    .poll(async () => (await followState()).index, { timeout: 10_000 })
    .toBe(6);
  await expect
    .poll(async () => Math.abs((await followState()).centerOffset ?? 999), {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(2);
  // Freeze playback before the final read so the active row cannot advance
  // past the neighbour window mid-assertion.
  await page.evaluate(() => {
    document.querySelector<HTMLMediaElement>("audio, video")!.pause();
  });
  const middle = await followState();
  expect(middle.neighbours).toEqual([true, true, true, true]);
  expect(middle.windowScrollY).toBe(0);

  // First segment anchors at the viewport's top edge.
  await page.evaluate(() => {
    document.querySelector<HTMLMediaElement>("audio, video")!.currentTime = 0.2;
  });
  await expect
    .poll(async () => (await followState()).index, { timeout: 10_000 })
    .toBe(0);
  await expect
    .poll(async () => (await followState()).scrollTop, { timeout: 10_000 })
    .toBe(0);
  const first = await followState();
  expect(Math.abs(first.firstTopOffset ?? 999)).toBeLessThanOrEqual(2);

  // Final segment anchors at the viewport's bottom edge.
  await page.evaluate(() => {
    document.querySelector<HTMLMediaElement>("audio, video")!.currentTime = 38;
  });
  await expect
    .poll(async () => (await followState()).index, { timeout: 10_000 })
    .toBe(11);
  await expect
    .poll(
      async () => {
        const state = await followState();
        return Math.abs(state.scrollTop - state.maxScrollTop);
      },
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(2);
  const last = await followState();
  expect(Math.abs(last.lastBottomOffset ?? 999)).toBeLessThanOrEqual(2);
  expect(last.windowScrollY).toBe(0);
});

test("phone-width rest state: player stays available behind the review gate notice", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await bootstrapAndLogin(page, adminUser);
  const recordingId = await uploadFixture(page, {
    title: "Media rest state phone record",
    durationMs: 10_000,
  });
  await waitForRestStateTranscript(page);

  execRuntimeSql(
    "update recordings set media_kind = 'video', mime_type = 'video/mp4' where id = ?",
    [recordingId],
  );
  await openCasefile(page, recordingId);

  // Phone safety gate: review and decisions stay on tablet-or-desktop.
  await expect(
    page.getByText("Review and decisions require a tablet or desktop."),
  ).toBeVisible();

  // The media player is not hidden by the gate: the video hero still
  // renders at phone width.
  await expect(page.locator("video[controls]")).toBeVisible();
});
