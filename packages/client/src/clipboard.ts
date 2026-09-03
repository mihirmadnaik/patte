/**
 * Copy text to the clipboard, in a page that may not be a secure context.
 *
 * `navigator.clipboard` is undefined on plain HTTP, which is exactly how this
 * app gets opened from a phone on the same Wi-Fi. The old `execCommand` route
 * is deprecated but still works there, and is worth keeping for precisely this
 * case. Returns false when neither is available, so the caller can show the
 * text instead of silently doing nothing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or not a secure context after all. Try the old way.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Off-screen but still selectable; `display: none` cannot be selected.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
