import { expect, test } from '@playwright/test';

test('单人测试：开始 → 覆盖式转写 → 译文与回放按钮 → 结束', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '开始', exact: true }).click();

  const firstCard = page.locator('.segment-card').first();
  // P4 覆盖式渲染：先看到部分文本（text+stash），再被全量刷新
  await expect(firstCard.locator('.segment-source')).toContainText('今天天气', { timeout: 15_000 });
  await expect(firstCard.locator('.segment-source')).toContainText('今天天气很好，我们一起去公园散步。', { timeout: 15_000 });
  // 译文在 mock 延迟 3.5s 后到达
  await expect(firstCard.locator('.segment-target')).toContainText("let's go for a walk in the park together", { timeout: 15_000 });
  // 段落 done 后出现按段回放按钮（24k PCM → WAV，240ms → “▶ 0.2s”）
  await expect(firstCard.locator('.segment-meta button')).toContainText('▶', { timeout: 15_000 });

  await page.getByRole('button', { name: '结束', exact: true }).click();
  // 结束后回到可重新开始的状态
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeEnabled({ timeout: 10_000 });
});
