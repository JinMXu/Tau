import { Component, type ErrorInfo, type ReactNode } from "react";
import type { MessageCatalog } from "../i18n";
import { reportFrontendError } from "../lib/report-error";

interface Props {
	children: ReactNode;
	/** Raw content for the fallback. May be a thunk so the happy path never pays
	 *  for serialising a message it is not going to show. */
	text?: string | (() => string);
	t: MessageCatalog;
}

interface State {
	error: Error | null;
}

function textOf(text: Props["text"]): string | undefined {
	return typeof text === "function" ? text() : text;
}

/**
 * Per-message error boundary.
 *
 * The root boundary in main.tsx is the only one, so a throw inside a single
 * message's renderer — markstream / shiki / mermaid are third-party and run on
 * every streamed delta — unmounts the whole app to a full-screen error card and
 * the transcript state is gone (the user can only reload). One bad message
 * should cost one message.
 *
 * Falls back to plain text: the content stays readable, the rest of the
 * conversation keeps rendering and streaming. The error clears itself when the
 * content changes (a streamed delta is a new attempt), and a Retry button
 * re-attempts the rich render on demand.
 */
export class MessageBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		reportFrontendError("message-boundary", `${error}\n${info.componentStack ?? ""}`);
	}

	componentDidUpdate(prevProps: Props) {
		if (!this.state.error) return;
		// New content = a fresh render attempt (a streamed delta, a committed
		// rewrite). Only evaluated while in the error state, so the happy path
		// never serialises anything.
		if (textOf(prevProps.text) !== textOf(this.props.text)) {
			this.setState({ error: null });
		}
	}

	private retry = () => this.setState({ error: null });

	render() {
		if (this.state.error) {
			const raw = textOf(this.props.text);
			return (
				<div className="markdown-host markdown-error" role="alert">
					<div className="markdown-error-head">
						<span>{raw != null ? this.props.t.chat.renderFailed : this.props.t.chat.renderFailedNoText}</span>
						<button type="button" className="markdown-error-retry" onClick={this.retry}>
							{this.props.t.chat.renderRetry}
						</button>
					</div>
					{raw != null && <pre className="markdown-plain">{raw}</pre>}
				</div>
			);
		}
		return this.props.children;
	}
}
