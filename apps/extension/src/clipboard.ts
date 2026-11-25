// Copies a picked component to the clipboard: Markdown text for a coding agent and,
// when a screenshot is available, a PNG for canvases. One clipboard item carries both,
// and the app you paste into picks the format it understands.

export interface CopyContent {
  text: string;
  image: Blob | undefined;
}

/** What reached the clipboard. */
export type CopyResult = "image+text" | "text" | "failed";

/**
 * Starts the clipboard write straight away, while the click still counts as a user
 * gesture, and fills it in when `content` resolves. Call it before the first await
 * in a click handler.
 */
export async function copyToClipboard(content: Promise<CopyContent>): Promise<CopyResult> {
  // navigator.clipboard only exists on https and localhost pages.
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const item = new ClipboardItem({
      "text/plain": content.then((c) => new Blob([c.text], { type: "text/plain" })),
      "image/png": content.then((c) => c.image ?? Promise.reject(new Error("no screenshot"))),
    });
    try {
      await navigator.clipboard.write([item]);
      return "image+text";
    } catch {
      // No screenshot, or the page refused the write. Fall through to text only.
    }
  }
  let text: string;
  try {
    text = (await content).text;
  } catch {
    return "failed";
  }
  try {
    await navigator.clipboard.writeText(text);
    return "text";
  } catch {
    return copyWithExecCommand(text) ? "text" : "failed";
  }
}

/** The old copy command. Works on http pages, where navigator.clipboard is missing. */
function copyWithExecCommand(text: string): boolean {
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("copy", onCopy, true);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    window.removeEventListener("copy", onCopy, true);
  }
}
