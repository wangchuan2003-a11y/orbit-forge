import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const test = base.extend<{ diagnostics: void }>({
  diagnostics: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await use();
      expect(errors).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(1);
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator("#reset").click();
});

test("pause, step, add by keyboard-accessible form, and reset keep diagnostics honest", async ({
  page,
}) => {
  await expect(page.locator("#ticks")).toHaveText("0");
  const baseline = await page.locator("#baseline-energy").textContent();
  await page.locator("#step").click();
  await expect(page.locator("#ticks")).toHaveText("1");
  await expect(page.locator("#sim-time")).toHaveText("t = 0.002");
  await expect(page.locator("#baseline-energy")).toHaveText(baseline!);
  await page.locator("#run").click();
  await expect
    .poll(async () => Number(await page.locator("#ticks").textContent()))
    .toBeGreaterThan(1);
  await page.locator("#run").click();
  const paused = await page.locator("#ticks").textContent();
  await page.waitForTimeout(150);
  await expect(page.locator("#ticks")).toHaveText(paused!);
  await page.locator("#mass").selectOption("0.5");
  await page.locator("#new-x").fill("1.2");
  await page.locator("#new-y").fill("2.1");
  await page.locator("#add-body").click();
  await expect(page.locator("#body-count")).toHaveText("3 / 8");
  await expect(page.locator("#ticks")).toHaveText("0");
  await expect(page.locator("#status")).toContainText("能量基准已重建");
  await expect(page.locator("#drift")).toHaveText("0.0000%");
  expect(await page.locator("#baseline-energy").textContent()).not.toBe(
    baseline,
  );
  await page.locator("#reset").click();
  await expect(page.locator("#body-count")).toHaveText("2 / 8");
});

test("pointer placement and form placement share the body limit, with undistorted canvas scaling", async ({
  page,
}) => {
  await page.locator("#place-mode").click();
  const canvas = page.locator("#universe");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width * 0.6 + 35,
    box.y + box.height * 0.45 - 20,
  );
  await page.mouse.up();
  await expect(page.locator("#body-count")).toHaveText("3 / 8");
  expect(Number(await page.locator("#new-vx").inputValue())).toBeGreaterThan(0);
  expect(Number(await page.locator("#new-vy").inputValue())).toBeGreaterThan(0);
  await page.locator("#view").selectOption("8");
  const ratios = await canvas.evaluate((element: HTMLCanvasElement) => ({
    x: element.width / element.clientWidth,
    y: element.height / element.clientHeight,
  }));
  expect(Math.abs(ratios.x - ratios.y)).toBeLessThan(0.01);
  for (let i = 0; i < 5; i++) await page.locator("#add-body").click();
  await expect(page.locator("#body-count")).toHaveText("8 / 8");
  await expect(page.locator("#add-body")).toBeDisabled();
  await expect(page.locator("#place-mode")).toBeDisabled();
  await page.locator("#reset").click();
  await expect(page.locator("#body-count")).toHaveText("2 / 8");
});

test("presets, snapshots, invalid hashes, and PNG export preserve observable state", async ({
  page,
}) => {
  await page.locator('[data-preset="binary"]').click();
  await expect(page.locator("#body-data tr")).toHaveCount(2);
  await expect(
    page.locator("#body-data tr").first().locator("td").nth(1),
  ).toHaveText("3.000");
  await page.locator('[data-preset="three"]').click();
  await expect(page.locator("#body-count")).toHaveText("3 / 8");
  await page.locator("#step").click();
  const table = await page.locator("#body-data").textContent();
  await page.locator("#share").click();
  await expect(page).toHaveURL(/#v1\./);
  const url = page.url();
  await page.goto("about:blank");
  await page.goto(url);
  await expect(page.locator("#body-data")).toHaveText(table!);
  await expect(page.locator("#ticks")).toHaveText("1");
  await expect(page.locator("#drift")).toHaveText("0.0000%");
  await page.goto("/#v1.invalid");
  await expect(page.locator("#status")).toContainText("当前系统保持不变");
  await expect(page.locator("#body-data")).toHaveText(table!);
  const pending = page.waitForEvent("download");
  await page.locator("#export-png").click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("orbit-forge.png");
  expect(await download.failure()).toBeNull();
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
});

test("single-step boundary failures keep the pause reason and the last valid snapshot", async ({
  page,
}) => {
  const hash =
    "#v1." +
    Buffer.from(
      JSON.stringify({ v: 1, t: 1_000_000_000, b: [[0, 1, 0, 0, 0, 0]] }),
    ).toString("base64url");
  await page.goto(`/${hash}`);
  await expect(page.locator("#ticks")).toHaveText("1000000000");
  const table = await page.locator("#body-data").textContent();
  await page.locator("#step").click();
  await expect(page.locator("#status")).toContainText("数值状态已超出");
  await expect(page.locator("#status")).not.toContainText("完成第");
  await expect(page.locator("#ticks")).toHaveText("1000000000");
  await expect(page.locator("#body-data")).toHaveText(table!);
  await expect(page.locator("#run-state")).toHaveText("已暂停");
  // The animation path must retain the same failure reason after it stops.
  await page.locator("#run").click();
  await expect(page.locator("#status")).toContainText("数值状态已超出");
  await expect(page.locator("#run-state")).toHaveText("已暂停");
  await expect(page.locator("#ticks")).toHaveText("1000000000");
});
