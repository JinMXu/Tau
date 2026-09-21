/**
 * Test-environment patches shared by every suite (guarded so the node-only
 * suites pay nothing).
 *
 * happy-dom ≥ 20 rejects an animation's `finished` promise with an AbortError
 * when the animation is cancelled. motion-dom attaches a `.then` to that
 * promise, so the rejection runs its rejection path asynchronously — which
 * schedules React work that can fire after the happy-dom environment has been
 * torn down (`window is not defined` in react-dom's scheduler) and, with no
 * terminal catch anywhere, also escapes as an unhandled rejection that fails
 * the run even when every assertion passed.
 *
 * Hand every WAAPI animation a `finished` that resolves on cancellation
 * instead: motion-dom's chain then never sees a rejection, and the original
 * promise still gets a handler so it can't surface as unhandled. The real
 * cancel (timer cleanup, playState reset, cancel event) is untouched — these
 * suites assert on DOM structure, never on animation completion, and a
 * resolved `finished` still settles anything awaiting normal completion.
 */
if (typeof globalThis.Element !== "undefined" && typeof globalThis.Animation !== "undefined") {
	const originalAnimate = globalThis.Element.prototype.animate;
	if (typeof originalAnimate === "function") {
		globalThis.Element.prototype.animate = function animatePatched(
			this: Element,
			...args: Parameters<Element["animate"]>
		): Animation {
			const animation = originalAnimate.apply(this, args);
			const settled = new Promise<void>((resolve) => {
				animation.finished.then(
					() => resolve(),
					() => resolve(),
				);
			});
			// The DOM lib types `finished` as readonly; happy-dom assigns it as a
			// plain instance field, so it is writable at runtime.
			(animation as unknown as { finished: Promise<void> }).finished = settled;
			return animation;
		};
	}
}
