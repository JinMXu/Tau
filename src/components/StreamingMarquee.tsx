import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 流式预览的 tail-follow：文本每次增长后立即右对齐，保持最新 token 在视口末端。
 * （移植自 Percho；tailOffsetForWidths 内联。）
 */

function tailOffsetForWidths(textWidth: number, viewportWidth: number): number {
	if (!Number.isFinite(textWidth) || !Number.isFinite(viewportWidth)) return 0;
	return Math.max(0, textWidth - viewportWidth);
}

export function StreamingMarquee({ text }: { text: string }) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const primaryRef = useRef<HTMLSpanElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<() => void>(() => {});
	const [metrics, setMetrics] = useState({ viewportWidth: 0, textWidth: 0 });
	const [reducedMotion, setReducedMotion] = useState(
		() => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const overflowing = metrics.textWidth > metrics.viewportWidth;
	const offset = reducedMotion ? 0 : tailOffsetForWidths(metrics.textWidth, metrics.viewportWidth);

	useEffect(() => {
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		const primary = primaryRef.current;
		if (!viewport || !primary) return;
		const measure = () => {
			const next = { viewportWidth: viewport.clientWidth, textWidth: primary.scrollWidth };
			setMetrics((current) =>
				current.viewportWidth === next.viewportWidth && current.textWidth === next.textWidth
					? current
					: next,
			);
		};
		measureRef.current = measure;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		observer.observe(primary);
		return () => {
			observer.disconnect();
			measureRef.current = () => {};
		};
	}, []);

	// 文本 delta 不一定改变主 span 的布局盒尺寸，commit 后补量 scrollWidth 以立即追随最新
	// token。依赖 [text]：只在文本变化后的渲染补一次测量（无依赖数组会与 RO 回调形成
	// measure→setMetrics→重渲染反馈环，流式期间可能自激成无限更新）。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 故意以 text 为触发器
	useLayoutEffect(() => {
		measureRef.current();
	}, [text]);

	useLayoutEffect(() => {
		if (trackRef.current)
			trackRef.current.style.transform = `translate3d(-${offset}px, 0, 0)`;
	}, [offset]);

	return (
		<div ref={viewportRef} className="marquee-viewport">
			<div ref={trackRef} className={overflowing ? "marquee-track w-max" : "marquee-track"}>
				<span ref={primaryRef} className={overflowing ? "marquee-text" : "marquee-text truncate"}>
					{text}
				</span>
			</div>
		</div>
	);
}
