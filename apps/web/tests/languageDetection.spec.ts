import { expect, test } from '@playwright/test'

/**
 * The app opens in the reader's language and can be changed from settings.
 *
 * The rest of the suite pins the browser to zh-CN and tests the Chinese
 * product; this file is the other half, and the only place the English path is
 * exercised end to end.
 */

test.describe('an English browser', () => {
  test.use({ locale: 'en-US' })

  test('opens in English without being asked', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'AI Music Mentor', level: 1 }))
      .toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('can be switched to Chinese and remembers it', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByRole('radio', { name: '简体中文' }).check()
    await expect(page.getByRole('heading', { name: 'AI 音乐导师', level: 1 }))
      .toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')

    // The choice outlives the page, and an explicit choice beats the browser.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'AI 音乐导师', level: 1 }))
      .toBeVisible()
  })
})

test.describe('a traditional-script browser', () => {
  test.use({ locale: 'zh-TW' })

  test('opens in Simplified rather than English', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'AI 音乐导师', level: 1 }))
      .toBeVisible()
  })
})

test.describe('settings', () => {
  test('changes the theme and the case, and closes on Escape', async ({ page }) => {
    await page.goto('/')
    const root = page.locator('html')
    await expect(root).toHaveAttribute('data-theme', /light|dark/)

    await page.getByRole('button', { name: '设置' }).click()
    const dialog = page.getByRole('dialog')

    await dialog.getByRole('radio', { name: '浅色' }).check()
    await expect(root).toHaveAttribute('data-theme', 'light')

    await dialog.getByRole('radio', { name: '胡桃木' }).check()
    await expect(root).toHaveAttribute('data-finish', 'walnut')

    // The score is paper in every theme; only the room changes.
    await dialog.getByRole('radio', { name: '深色' }).check()
    await expect(root).toHaveAttribute('data-theme', 'dark')
    await expect(root).toHaveAttribute('data-finish', 'walnut')

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('pro is a real change, not a bigger font', async ({ page }) => {
    await page.goto('/')
    // Standard and Pro are one studio: the same type, the same corners, the
    // same shadows. They once differed in all three, and in Standard the
    // corner radius and shadow were not defined at all.
    const look = () => page.evaluate(() => {
      const button = document.querySelector('.settings-open')!
      return [getComputedStyle(document.body).fontSize,
        getComputedStyle(button).borderRadius,
        getComputedStyle(document.documentElement).getPropertyValue('--lift').trim() !== '']
    })
    const standard = await look()
    expect(standard[2]).toBe(true)
    await page.getByRole('button', { name: '设置' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: '专业' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-depth', 'pro')
    expect(await look()).toEqual(standard)
    await page.keyboard.press('Escape')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-depth', 'pro')
  })
})
