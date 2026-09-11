/**
 * Strip ANSI escape sequences (CSI/OSC) from a string.
 *
 * Extensions report status text through pi's `setStatus` / `setWidget` /
 * `setTitle` UI hooks, and those strings routinely carry ANSI SGR color
 * codes — they render nicely in the pi TUI but the webview shows them
 * verbatim: the ESC byte becomes a tofu box and the parameters leak as
 * literal text (`□[38;2;138;190;183m … □[39m`). Display surfaces in the
 * GUI run through this before the text is stored/rendered.
 *
 * Two alternatives:
 * - OSC: `ESC ] … BEL` or `ESC ] … ESC \` (window titles, hyperlinks).
 *   The body excludes BEL/ESC so an unterminated sequence never swallows
 *   the rest of the string.
 * - CSI: `ESC [ <params 0x30-3F> <intermediates 0x20-2F> <final 0x40-7E>`
 *   (SGR colors/styles, cursor movement, erase — everything extensions
 *   actually emit).
 */
const ANSI_PATTERN = new RegExp(
	["\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", "\\u001B\\[[0-?]*[ -/]*[@-~]"].join("|"),
	"g",
);

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}
