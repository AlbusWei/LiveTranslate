import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('文件配音：上传 → 全速预处理 → 双栏工作台 → 导出 SRT', async ({ page }) => {
  await page.goto('/#/filedub');
  await page.setInputFiles('input[type="file"]', resolve(__dirname, '..', 'fixtures', 'dub-input.wav'));
  await page.getByRole('button', { name: '开始预处理' }).click();

  // 全速管道（P8 无 sleep）+ mock finish 冲刷：双栏工作台很快就绪
  await expect(page.locator('.dub-cell .segment-source').first()).toContainText('今天天气很好', { timeout: 60_000 });
  await expect(page.locator('.dub-cell .segment-target').first()).toContainText('The weather is very nice today', { timeout: 10_000 });
  // 译文栏有按段播放按钮（mock 回了 240ms 音频）
  await expect(page.getByRole('button', { name: '▶ 播放译文' }).first()).toBeVisible();
  // 导出入口就绪（GET /export/srt，T26）
  await expect(page.getByRole('link', { name: '导出 SRT' })).toBeVisible();
});
