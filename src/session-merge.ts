import type { Block } from "./chat-types";

/**
 * Reconcile pi's authoritative block list with what the stream already
 * rendered.
 *
 * markstream (and its smooth-streaming controller) treats a content change
 * that is not a prefix-extension of what it has as a hard reset: the whole
 * message re-parses and re-renders in a single frame. pi's snapshot can lag
 * the streamed text by a few characters, so a text block whose streamed
 * version is a prefix-extension of the authoritative one keeps the streamed
 * text — the tail is real content pi is about to confirm anyway, and dropping
 * it would produce exactly the end-of-output repaint this app avoids.
 *
 * Lived in App.tsx where nothing could reach it; it is pure, so it is here
 * with tests instead.
 */
export function keepStreamedText(streamed: Block[], authoritative: Block[]): Block[] {
	if (streamed.length !== authoritative.length) return authoritative;
	let kept = false;
	const merged = authoritative.map((block, index) => {
		const previous = streamed[index];
		if (
			block.kind === "text" &&
			previous?.kind === "text" &&
			previous.text.length > block.text.length &&
			previous.text.startsWith(block.text)
		) {
			kept = true;
			return previous;
		}
		return block;
	});
	return kept ? merged : authoritative;
}
