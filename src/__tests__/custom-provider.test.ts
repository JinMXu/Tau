import { describe, expect, it } from "vitest";
import {
	PROVIDER_TEMPLATES,
	blankForm,
	buildProviderConfig,
	formFromConfig,
	formFromTemplate,
	validateProviderForm,
	type CustomProviderForm,
} from "../custom-provider";

function volcengineForm(): CustomProviderForm {
	const tpl = PROVIDER_TEMPLATES.find((p) => p.key === "volcengine")!;
	return formFromTemplate(tpl);
}

describe("validateProviderForm", () => {
	const base = { builtinIds: ["anthropic"], existingIds: ["ollama"], idLocked: false };

	it("accepts a valid form", () => {
		expect(validateProviderForm(volcengineForm(), base)).toBeNull();
	});

	it("rejects empty and malformed ids", () => {
		const form = volcengineForm();
		expect(validateProviderForm({ ...form, id: "" }, base)).toBe("idRequired");
		expect(validateProviderForm({ ...form, id: "Volcengine" }, base)).toBe("idPattern");
		expect(validateProviderForm({ ...form, id: "-lead" }, base)).toBe("idPattern");
		expect(validateProviderForm({ ...form, id: "has space" }, base)).toBe("idPattern");
	});

	it("rejects built-in and already-taken ids", () => {
		const form = volcengineForm();
		expect(validateProviderForm({ ...form, id: "anthropic" }, base)).toBe("idBuiltin");
		expect(validateProviderForm({ ...form, id: "ollama" }, base)).toBe("idExists");
	});

	it("skips id checks when editing (idLocked)", () => {
		const form = { ...volcengineForm(), id: "ollama" };
		expect(validateProviderForm(form, { ...base, idLocked: true })).toBeNull();
	});

	it("requires baseUrl and at least one model with an id", () => {
		const form = volcengineForm();
		expect(validateProviderForm({ ...form, baseUrl: " " }, base)).toBe("baseUrlRequired");
		expect(validateProviderForm({ ...form, models: [] }, base)).toBe("modelsRequired");
		expect(validateProviderForm({ ...form, models: [{ ...form.models[0], id: " " }] }, base)).toBe(
			"modelIdRequired",
		);
	});

	it("requires positive integer windows", () => {
		const form = volcengineForm();
		expect(
			validateProviderForm({ ...form, models: [{ ...form.models[0], contextWindow: 0 }] }, base),
		).toBe("positiveIntRequired");
		expect(
			validateProviderForm({ ...form, models: [{ ...form.models[0], maxTokens: 1.5 }] }, base),
		).toBe("positiveIntRequired");
	});
});

describe("buildProviderConfig", () => {
	it("emits a models.json-shaped config", () => {
		const config = buildProviderConfig(volcengineForm());
		expect(config.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
		expect(config.api).toBe("openai-completions");
		expect(config.models).toEqual([
			{
				id: "doubao-seed-1-6-250615",
				name: "Doubao Seed 1.6",
				input: ["text", "image"],
				contextWindow: 256000,
				maxTokens: 16384,
			},
		]);
		// apiKey goes to auth.json, never to models.json.
		expect(config.apiKey).toBeUndefined();
	});

	it("omits optional model fields when unset", () => {
		const form = blankForm();
		form.id = "x";
		form.baseUrl = "http://localhost:8000/v1";
		form.models[0].id = "m1";
		const config = buildProviderConfig(form);
		const model = (config.models as Record<string, unknown>[])[0];
		expect(model.name).toBeUndefined();
		expect(model.reasoning).toBeUndefined();
		expect(model.input).toEqual(["text"]);
	});

	it("keeps template extras (e.g. Ollama compat)", () => {
		const tpl = PROVIDER_TEMPLATES.find((p) => p.key === "ollama")!;
		const config = buildProviderConfig(formFromTemplate(tpl), undefined, tpl.extra);
		expect(config.compat).toEqual({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		});
	});

	it("volcengine template ships Ark-compatible defaults", () => {
		const tpl = PROVIDER_TEMPLATES.find((p) => p.key === "volcengine")!;
		const config = buildProviderConfig(formFromTemplate(tpl), undefined, tpl.extra);
		// Ark rejects the developer role, reasoning_effort and
		// max_completion_tokens; the template must pre-empt all three.
		expect(config.compat).toEqual({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		});
	});

	it("passes unknown top-level and per-model keys through on edit", () => {
		const existing = {
			baseUrl: "http://old",
			api: "openai-completions",
			headers: { "x-custom": "1" },
			models: [
				{
					id: "m1",
					cost: { input: 1, output: 2 },
					compat: { maxTokensField: "max_tokens" },
				},
			],
		};
		const form = formFromConfig("my-provider", existing);
		// User edits the display name only; id stays "m1".
		form.models[0].name = "Renamed";
		const config = buildProviderConfig(form, existing);
		expect(config.headers).toEqual({ "x-custom": "1" });
		const model = (config.models as Record<string, unknown>[])[0];
		expect(model.name).toBe("Renamed");
		expect(model.cost).toEqual({ input: 1, output: 2 });
		expect(model.compat).toEqual({ maxTokensField: "max_tokens" });
	});
});

describe("formFromConfig", () => {
	it("round-trips through buildProviderConfig", () => {
		const original = buildProviderConfig(volcengineForm());
		const form = formFromConfig("volcengine", original);
		expect(form.id).toBe("volcengine");
		expect(form.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
		expect(form.models[0].image).toBe(true);
		expect(buildProviderConfig(form)).toEqual(original);
	});

	it("falls back to defaults and one blank row for sparse configs", () => {
		const form = formFromConfig("proxy", { baseUrl: "https://x" });
		expect(form.api).toBe("openai-completions");
		expect(form.models).toHaveLength(1);
		expect(form.models[0].contextWindow).toBe(128000);
		expect(form.models[0].maxTokens).toBe(16384);
	});
});
