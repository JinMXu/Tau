import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";
import {
	oauthBegin,
	oauthCancel,
	oauthPromptResponse,
	oauthStatus,
	type OAuthFlowStatus,
} from "../pi";
import { openExternal } from "../lib/open-external";
import { CheckIcon, CopyIcon, LoaderIcon } from "../icons";
import { Modal } from "./Modal";

/** Overall budget for one login flow before it is auto-cancelled. */
const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

/**
 * Drives one sidecar OAuth login flow: begin → poll status → render
 * device-code / auth-url / prompts → done. Closing the dialog at any point
 * cancels the flow.
 */
export function OAuthDialog({
	t,
	provider,
	providerLabel,
	onDone,
	onClose,
}: {
	t: MessageCatalog;
	provider: string;
	/** Display name used in the title and toasts. */
	providerLabel: string;
	/** Flow finished: the host refreshes auth state and toasts. */
	onDone: () => void;
	onClose: () => void;
}) {
	const [status, setStatus] = useState<OAuthFlowStatus | null>(null);
	const [beginError, setBeginError] = useState<string | null>(null);
	const [timedOut, setTimedOut] = useState(false);
	const [promptValue, setPromptValue] = useState("");
	const [copied, setCopied] = useState<string | null>(null);

	const flowRef = useRef<string | null>(null);
	const doneRef = useRef(false);
	const pollRef = useRef<number>(0);
	const timeoutRef = useRef<number>(0);
	const copyTimerRef = useRef<number>(0);

	const stopTimers = useCallback(() => {
		window.clearInterval(pollRef.current);
		window.clearTimeout(timeoutRef.current);
	}, []);

	const cancelFlow = useCallback(() => {
		stopTimers();
		const fid = flowRef.current;
		flowRef.current = null;
		if (fid && !doneRef.current) {
			void oauthCancel(fid).catch(() => {});
		}
	}, [stopTimers]);

	const begin = useCallback(async () => {
		cancelFlow();
		setBeginError(null);
		setTimedOut(false);
		setStatus(null);
		setPromptValue("");
		try {
			const fid = await oauthBegin(provider);
			flowRef.current = fid;
			timeoutRef.current = window.setTimeout(() => {
				stopTimers();
				const id = flowRef.current;
				flowRef.current = null;
				if (id && !doneRef.current) {
					void oauthCancel(id).catch(() => {});
				}
				setTimedOut(true);
			}, FLOW_TIMEOUT_MS);
			pollRef.current = window.setInterval(() => {
				const id = flowRef.current;
				if (!id) return;
				oauthStatus(id)
					.then((s) => {
						setStatus(s);
						if (s.phase === "done") {
							doneRef.current = true;
							stopTimers();
							onDone();
							onClose();
						} else if (s.phase === "error" || s.phase === "cancelled") {
							stopTimers();
						}
					})
					.catch((e) => {
						// Terminal flows are single-read server-side; a vanished flow
						// or a dead sidecar both surface as an error here.
						stopTimers();
						setStatus({ phase: "error", event: null, prompt: null, error: String(e) });
					});
			}, POLL_INTERVAL_MS);
		} catch (e) {
			setBeginError(String(e));
		}
	}, [provider, cancelFlow, stopTimers, onDone, onClose]);

	useEffect(() => {
		void begin();
		return () => {
			cancelFlow();
			window.clearTimeout(copyTimerRef.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
	}, []);

	const handleClose = useCallback(() => {
		cancelFlow();
		onClose();
	}, [cancelFlow, onClose]);

	const copy = async (what: string, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(what);
			window.clearTimeout(copyTimerRef.current);
			copyTimerRef.current = window.setTimeout(() => setCopied(null), 1500);
		} catch {
			/* ignore */
		}
	};

	const submitPrompt = (value: string) => {
		const fid = flowRef.current;
		if (!fid) return;
		setPromptValue("");
		void oauthPromptResponse(fid, value).catch((e) => {
			stopTimers();
			setStatus({ phase: "error", event: null, prompt: null, error: String(e) });
		});
	};

	const event = status?.event ?? null;
	const prompt = status?.phase === "awaiting_prompt" ? status.prompt : null;
	const failed = beginError ?? (status?.phase === "error" ? (status.error ?? "") : null);
	const authUrl =
		event?.type === "auth_url"
			? (event.url ?? null)
			: event?.type === "device_code"
				? (event.verificationUri ?? null)
				: null;

	return (
		<Modal
			open
			onClose={handleClose}
			title={t.settings.oauthDialogTitle.replace("{provider}", providerLabel)}
			closeLabel={t.app.close}
			className="oauth-dialog"
		>
			{failed || timedOut ? (
				<>
					<div className="error-banner">
						{timedOut
							? t.settings.oauthTimeout
							: t.settings.oauthFailed.replace("{error}", failed ?? "")}
					</div>
					<div className="extension-dialog-actions">
						<button className="btn secondary" onClick={handleClose}>
							{t.app.close}
						</button>
						<button className="btn primary" onClick={() => void begin()}>
							{t.settings.oauthRetry}
						</button>
					</div>
				</>
			) : (
				<div className="oauth-flow">
					{event?.type === "device_code" && event.userCode && (
						<div className="oauth-device">
							<span className="cp-label">{t.settings.oauthUserCode}</span>
							<div className="oauth-code-row">
								<code className="oauth-code">{event.userCode}</code>
								<button
									className="btn secondary small"
									onClick={() => void copy("code", event.userCode ?? "")}
								>
									{copied === "code" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
									{copied === "code" ? t.settings.oauthCopied : t.settings.oauthCopy}
								</button>
							</div>
						</div>
					)}

					{authUrl && (
						<div className="oauth-url-row">
							<span className="oauth-url mono">{authUrl}</span>
							<div className="oauth-url-actions">
								<button
									className="btn primary small"
									onClick={() => void openExternal(authUrl).catch(() => {})}
								>
									{t.settings.oauthOpenBrowser}
								</button>
								<button className="btn secondary small" onClick={() => void copy("url", authUrl)}>
									{copied === "url" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
									{copied === "url" ? t.settings.oauthCopied : t.settings.oauthCopy}
								</button>
							</div>
						</div>
					)}

					{prompt ? (
						<div className="oauth-prompt">
							<p className="oauth-prompt-message">{prompt.message}</p>
							{prompt.kind === "select" && prompt.options ? (
								<div className="oauth-prompt-options">
									{prompt.options.map((o) => (
										<button
											key={o.id}
											className="btn secondary small"
											onClick={() => submitPrompt(o.id)}
										>
											{o.label ?? o.id}
										</button>
									))}
								</div>
							) : (
								<>
									<div className="oauth-prompt-input">
										<input
											type={prompt.kind === "secret" ? "password" : "text"}
											value={promptValue}
											autoFocus
											placeholder={
												prompt.placeholder ??
												(provider === "github-copilot" ? t.settings.oauthEnterpriseHint : undefined)
											}
											onChange={(e) => setPromptValue(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") submitPrompt(promptValue);
											}}
										/>
										<button className="btn primary small" onClick={() => submitPrompt(promptValue)}>
											{t.settings.oauthSubmit}
										</button>
									</div>
									{prompt.kind === "manual_code" && (
										<p className="cp-note">{t.settings.oauthManualCodeHint}</p>
									)}
								</>
							)}
						</div>
					) : (
						<p className="oauth-status-line">
							<LoaderIcon size={12} className="spin" />
							{(event?.type === "progress" || event?.type === "info") && event.message
								? event.message
								: t.settings.oauthWaiting}
						</p>
					)}
				</div>
			)}
		</Modal>
	);
}
