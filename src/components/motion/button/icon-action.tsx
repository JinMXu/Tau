"use client";
// beui.dev/components/motion/button — icon action (lightweight variant)
//
// A small ghost pill for header-row actions (refresh / reload / check now):
// icon + label that swap through idle → busy → done states. The busy icon
// spins (or pulses under prefers-reduced-motion), the label slides, and an
// async action finishes with a brief check pop before settling back. Sync
// onClicks (no promise) get a one-shot 360° spin as click feedback instead.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { SPRING_PRESS } from "@/lib/ease";

export interface IconActionButtonProps {
	/** Idle icon (14px-ish stroke icons look best). */
	icon: ReactNode;
	/** Idle label. */
	children: ReactNode;
	/** Label while busy; defaults to the idle label. */
	busyLabel?: ReactNode;
	/** Label for the done flash; defaults to the idle label. */
	doneLabel?: ReactNode;
	/** Externally controlled busy (usage refresh, update check). When set it
	 *  wins over the internal promise tracking. */
	busy?: boolean;
	/** Show the check pop after a busy period ends (default true). */
	showDone?: boolean;
	onClick?: () => void | Promise<void>;
	disabled?: boolean;
	title?: string;
	"aria-label"?: string;
	className?: string;
}

type Phase = "idle" | "busy" | "done";

export const IconActionButton = forwardRef<HTMLButtonElement, IconActionButtonProps>(
	function IconActionButton(
		{
			icon,
			children,
			busyLabel,
			doneLabel,
			busy: externalBusy,
			showDone = true,
			onClick,
			disabled,
			title,
			"aria-label": ariaLabel,
			className,
		},
		ref,
	) {
		const reduce = useReducedMotion() ?? false;
		const [phase, setPhase] = useState<Phase>("idle");
		// One-shot spin nonce for sync onClicks: bumping the key remounts the
		// icon wrapper, replaying its rotate animation once.
		const [spinNonce, setSpinNonce] = useState(0);
		const doneTimer = useRef<number | undefined>(undefined);
		const busy = externalBusy ?? phase === "busy";
		useEffect(
			() => () => {
				if (doneTimer.current) window.clearTimeout(doneTimer.current);
			},
			[],
		);

		const flashDone = useCallback(() => {
			if (!showDone) {
				setPhase("idle");
				return;
			}
			setPhase("done");
			if (doneTimer.current) window.clearTimeout(doneTimer.current);
			doneTimer.current = window.setTimeout(() => setPhase("idle"), 900);
		}, [showDone]);

		const handleClick = useCallback(async () => {
			const result = onClick?.();
			// Sync action: a single 360° spin reads as "acknowledged, running".
			if (result == null) {
				if (!reduce) setSpinNonce((n) => n + 1);
				return;
			}
			// Async action: internal busy tracking + done flash.
			setPhase("busy");
			try {
				await result;
				flashDone();
			} catch {
				setPhase("idle");
			}
		}, [onClick, reduce, flashDone]);

		const label = phase === "busy" ? (busyLabel ?? children) : phase === "done" ? (doneLabel ?? children) : children;

		return (
			<motion.button
				ref={ref}
				type="button"
				disabled={disabled || busy}
				aria-busy={busy}
				aria-label={ariaLabel}
				title={title}
				whileHover={disabled || busy || reduce ? undefined : { backgroundColor: "var(--hover)" }}
				whileTap={reduce ? undefined : { scale: 0.95 }}
				transition={SPRING_PRESS}
				onClick={() => void handleClick()}
				className={`icon-action-btn${className ? ` ${className}` : ""}`}
			>
				<span className="icon-action-slot">
					<AnimatePresence initial={false} mode="popLayout">
						{busy ? (
							<motion.span
								key="busy"
								className="icon-action-icon"
								initial={{ opacity: 0, scale: 0.6 }}
								animate={{ opacity: 1, scale: 1 }}
								exit={{ opacity: 0, scale: 0.6 }}
								transition={{ duration: 0.15 }}
							>
								<motion.span
									className="icon-action-spin"
									animate={reduce ? { opacity: [0.5, 1, 0.5] } : { rotate: 360 }}
									transition={
										reduce
											? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
											: { duration: 0.9, repeat: Infinity, ease: "linear" }
									}
									style={{ display: "inline-flex" }}
								>
									{icon}
								</motion.span>
							</motion.span>
						) : phase === "done" ? (
							<motion.span
								key="done"
								className="icon-action-icon"
								initial={{ opacity: 0, scale: 0.4 }}
								animate={{ opacity: 1, scale: 1 }}
								exit={{ opacity: 0, scale: 0.6 }}
								transition={{ type: "spring", stiffness: 500, damping: 22 }}
							>
								<Check className="size-3.5" />
							</motion.span>
						) : (
							<motion.span
								key={`idle-${spinNonce}`}
								className="icon-action-icon"
								// Remount (spinNonce) replays the one-shot spin; the spring
								// return keeps the resting state identical to a plain icon.
								initial={false}
								animate={spinNonce > 0 ? { rotate: [0, 360] } : { rotate: 0 }}
								transition={spinNonce > 0 ? { duration: 0.6, ease: "easeInOut" } : SPRING_PRESS}
								exit={{ opacity: 0, scale: 0.6 }}
								style={{ display: "inline-flex" }}
							>
								{icon}
							</motion.span>
						)}
					</AnimatePresence>
				</span>
				<span className="icon-action-text">
					<AnimatePresence initial={false} mode="popLayout">
						<motion.span
							key={typeof label === "string" ? label : phase}
							initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
							animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
							exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
							transition={{ duration: 0.15 }}
							className="icon-action-label"
						>
							{label}
						</motion.span>
					</AnimatePresence>
				</span>
			</motion.button>
		);
	},
);
