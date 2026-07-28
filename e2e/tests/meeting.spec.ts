import { expect, test } from '@playwright/test';

test('会议热座：两人各一轮发言 → 状态机完整流转 → 结束与导出入口', async ({ page }) => {
  await page.goto('/#/meeting');
  await page.getByLabel('参会人（逗号或换行分隔）').fill('Alice, Bob');
  await page.getByRole('button', { name: '开始会议' }).click();

  const banner = page.locator('.hotseat-banner');
  await expect(banner).toContainText('空座，可抓占发言', { timeout: 15_000 });

  // —— Alice 一轮 ——
  await page.getByRole('button', { name: 'Alice 发言' }).click();
  await expect(banner).toContainText('Alice 正在发言…', { timeout: 10_000 });
  // 占座后其他席位禁用（热座互斥）
  await expect(page.getByRole('button', { name: 'Bob 发言' })).toBeDisabled();
  // mock 收到音频后立即回 ASR；看到原文后点结束发言（早于 3.5s 译文到达，命中 translating 态）
  await expect(page.locator('.segment-card').first()).toContainText('今天天气', { timeout: 10_000 });
  await page.getByRole('button', { name: '结束发言' }).click();
  await expect(banner).toContainText('翻译 Alice 的发言…', { timeout: 5_000 });
  // 译文到达→播放 240ms→回到空座（playing 态短暂，不单独断言，以回到空座为准）
  await expect(banner).toContainText('空座，可抓占发言', { timeout: 20_000 });
  await expect(page.locator('.segment-card').first()).toContainText("let's go for a walk in the park together");

  // —— Bob 一轮（验证座位释放后可再抓占） ——
  await page.getByRole('button', { name: 'Bob 发言' }).click();
  await expect(banner).toContainText('Bob 正在发言…', { timeout: 10_000 });
  await expect(page.locator('.segment-card')).toHaveCount(2, { timeout: 10_000 });
  await page.getByRole('button', { name: '结束发言' }).click();
  await expect(banner).toContainText('空座，可抓占发言', { timeout: 20_000 });

  // —— 结束与导出 ——
  await page.getByRole('button', { name: '结束会议' }).click();
  await expect(page.getByRole('button', { name: '导出 Markdown' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '导出 TXT' })).toBeVisible();
});
