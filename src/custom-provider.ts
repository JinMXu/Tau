/**
 * Pure logic for the custom-provider dialog: form model, preset templates,
 * validation, and conversion between the form and models.json provider
 * configs. Kept component-free so it can be unit-tested without a DOM.
 */

/** pi `api` values the form can emit (models.json "Supported APIs"). */
export const PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

/** One model row in the dialog. */
export interface CustomProviderModel {
	id: string;
	/** Display name; empty = omit (pi falls back to id). */
	name: string;
	reasoning: boolean;
	/** True = image-capable (`input: ["text", "image"]`). */
	image: boolean;
	contextWindow: number;
	maxTokens: number;
}

/** Everything the dialog edits. `apiKey` goes to auth.json, not models.json. */
export interface CustomProviderForm {
	id: string;
	baseUrl: string;
	api: ProviderApi;
	apiKey: string;
	models: CustomProviderModel[];
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Validation error codes, mapped to i18n strings by the dialog. */
export type FormError =
	| "idRequired"
	| "idPattern"
	| "idBuiltin"
	| "idExists"
	| "baseUrlRequired"
	| "modelsRequired"
	| "modelIdRequired"
	| "positiveIntRequired";

export function blankModel(): CustomProviderModel {
	return {
		id: "",
		name: "",
		reasoning: false,
		image: false,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

export function blankForm(): CustomProviderForm {
	return {
		id: "",
		baseUrl: "",
		api: "openai-completions",
		apiKey: "",
		models: [blankModel()],
	};
}

/** A preset that pre-fills the form (and optionally extra config keys). */
export interface ProviderTemplate {
	/** i18n key suffix under settings.customProvider.templates. */
	key: "blank" | "volcengine" | "ollama" | "vllm";
	/** Suggested provider id; empty for the blank template. */
	providerId: string;
	baseUrl: string;
	api: ProviderApi;
	/** Extra models.json keys merged into the config (e.g. compat). */
	extra?: Record<string, unknown>;
	models: CustomProviderModel[];
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
	{
		key: "blank",
		providerId: "",
		baseUrl: "",
		api: "openai-completions",
		models: [blankModel()],
	},
	{
		key: "volcengine",
		providerId: "volcengine",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		api: "openai-completions",
		// Ark rejects the `developer` role, `reasoning_effort` and
		// `max_completion_tokens` — keep the request vanilla chat-completions.
		extra: {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		},
		models: [
			{
				id: "doubao-seed-1-6-250615",
				name: "Doubao Seed 1.6",
				reasoning: false,
				image: true,
				contextWindow: 256000,
				maxTokens: DEFAULT_MAX_TOKENS,
			},
		],
	},
	{
		key: "ollama",
		providerId: "ollama",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		extra: {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
		},
		models: [
			{
				id: "qwen2.5-coder:7b",
				name: "",
				reasoning: false,
				image: false,
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
			},
		],
	},
	{
		key: "vllm",
		providerId: "vllm",
		baseUrl: "http://localhost:8000/v1",
		api: "openai-completions",
		models: [blankModel()],
	},
];

/** Builds a fresh form from a template (deep-copied so edits never leak). */
export function formFromTemplate(template: ProviderTemplate): CustomProviderForm {
	return {
		id: template.providerId,
		baseUrl: template.baseUrl,
		api: template.api,
		apiKey: "",
		models: template.models.map((m) => ({ ...m })),
	};
}

/**
 * Validates the form. `builtinIds` holds pi's built-in catalog ids and
 * `existingIds` the other custom providers' ids; both are rejected in add
 * mode (the backend re-checks built-ins, these are the friendly pre-checks).
 * `idLocked` skips id checks when editing an existing custom provider (its
 * id is fixed and already passed validation).
 */
export function validateProviderForm(
	form: CustomProviderForm,
	opts: {
		builtinIds: readonly string[];
		existingIds: readonly string[];
		idLocked: boolean;
	},
): FormError | null {
	const id = form.id.trim();
	if (!opts.idLocked) {
		if (!id) return "idRequired";
		if (!PROVIDER_ID_PATTERN.test(id)) return "idPattern";
		if (opts.builtinIds.includes(id)) return "idBuiltin";
		if (opts.existingIds.includes(id)) return "idExists";
	}
	if (!form.baseUrl.trim()) return "baseUrlRequired";
	if (form.models.length === 0) return "modelsRequired";
	for (const m of form.models) {
		if (!m.id.trim()) return "modelIdRequired";
		if (
			!Number.isInteger(m.contextWindow) ||
			m.contextWindow <= 0 ||
			!Number.isInteger(m.maxTokens) ||
			m.maxTokens <= 0
		) {
			return "positiveIntRequired";
		}
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Builds the models.json provider config from the form. When `existing` is
 * given (edit mode), unknown top-level keys (compat, headers, apiKey, ...) and
 * unknown per-model keys (cost, compat, samplingParams, ...) are preserved:
 * models are merged by id, so a row that keeps its id keeps its extra keys.
 */
export function buildProviderConfig(
	form: CustomProviderForm,
	existing?: Record<string, unknown>,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	const config: Record<string, unknown> = {
		...(existing ? { ...existing } : {}),
		...(extra ? { ...extra } : {}),
	};
	config.baseUrl = form.baseUrl.trim();
	config.api = form.api;

	const existingModels = new Map<string, Record<string, unknown>>();
	for (const raw of Array.isArray(existing?.models) ? existing.models : []) {
		const rec = asRecord(raw);
		const mid = typeof rec?.id === "string" ? rec.id : "";
		if (rec && mid) existingModels.set(mid, rec);
	}

	config.models = form.models.map((m) => {
		const id = m.id.trim();
		const model: Record<string, unknown> = {
			...(existingModels.get(id) ?? {}),
		};
		model.id = id;
		if (m.name.trim()) model.name = m.name.trim();
		else delete model.name;
		if (m.reasoning) model.reasoning = true;
		else delete model.reasoning;
		model.input = m.image ? ["text", "image"] : ["text"];
		model.contextWindow = m.contextWindow;
		model.maxTokens = m.maxTokens;
		return model;
	});
	return config;
}

/** Inverse of buildProviderConfig: fills the form from a stored config. */
export function formFromConfig(id: string, config: Record<string, unknown>): CustomProviderForm {
	const modelsRaw = Array.isArray(config.models) ? config.models : [];
	const models: CustomProviderModel[] = modelsRaw.map((raw) => {
		const rec = asRecord(raw) ?? {};
		const input = Array.isArray(rec.input) ? rec.input : [];
		return {
			id: typeof rec.id === "string" ? rec.id : "",
			name: typeof rec.name === "string" ? rec.name : "",
			reasoning: rec.reasoning === true,
			image: input.includes("image"),
			contextWindow:
				typeof rec.contextWindow === "number" && rec.contextWindow > 0
					? rec.contextWindow
					: DEFAULT_CONTEXT_WINDOW,
			maxTokens:
				typeof rec.maxTokens === "number" && rec.maxTokens > 0 ? rec.maxTokens : DEFAULT_MAX_TOKENS,
		};
	});
	const api = PROVIDER_APIS.includes(config.api as ProviderApi)
		? (config.api as ProviderApi)
		: "openai-completions";
	return {
		id,
		baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
		api,
		apiKey: "",
		models: models.length > 0 ? models : [blankModel()],
	};
}
