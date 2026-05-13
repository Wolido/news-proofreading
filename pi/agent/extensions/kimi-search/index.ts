import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface SearchResult {
	site_name?: string;
	title: string;
	url: string;
	snippet?: string;
	content?: string;
	date?: string;
	icon?: string;
	mime?: string;
}

interface SearchResponse {
	search_results: SearchResult[];
}

interface WebSearchDetails {
	query: string;
	limit: number;
	resultCount: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

interface WebFetchDetails {
	url: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

const WebSearchParams = Type.Object({
	query: Type.String({ description: "搜索关键词" }),
	limit: Type.Optional(
		Type.Number({ description: "返回结果数量（默认 10，范围 1-20）", default: 10 }),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "目标网页 URL" }),
});

let cachedApiKey: string | undefined;

const tempDirs: string[] = [];

function getApiKey(): string {
	if (cachedApiKey) {
		return cachedApiKey;
	}

	const envKey = process.env.KIMI_API_KEY;
	if (envKey) {
		cachedApiKey = envKey;
		return cachedApiKey;
	}

	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const configPath = join(__dirname, "config.json");

	let configRaw: string;
	try {
		configRaw = readFileSync(configPath, "utf-8");
	} catch (err: any) {
		if (err.code === "ENOENT") {
			throw new Error(
				"KIMI_API_KEY environment variable is not set and config.json was not found. " +
					"Please set the KIMI_API_KEY environment variable or configure apiKey in " +
					configPath,
			);
		}
		throw new Error(
			`Failed to read config.json at ${configPath}: ${err.message}`,
		);
	}

	let config: { apiKey?: string };
	try {
		config = JSON.parse(configRaw);
	} catch {
		throw new Error(
			`Failed to parse config.json at ${configPath}: invalid JSON format. ` +
				"Alternatively, set the KIMI_API_KEY environment variable.",
		);
	}

	const key = config.apiKey?.trim();
	if (!key || key === "your-kimi-api-key-here") {
		throw new Error(
			"KIMI_API_KEY environment variable is not set and config.json does not contain a valid apiKey. " +
				"Please set the KIMI_API_KEY environment variable or configure apiKey in " +
				configPath,
		);
	}

	cachedApiKey = key;
	return cachedApiKey;
}

async function saveToTempFile(content: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-kimi-search-"));
	tempDirs.push(tempDir);
	const tempFile = join(tempDir, "output.txt");
	await withFileMutationQueue(tempFile, async () => {
		await writeFile(tempFile, content, "utf8");
	});
	return tempFile;
}

async function applyTruncation<T extends WebSearchDetails | WebFetchDetails>(
	output: string,
	details: T,
): Promise<{ text: string; details: T }> {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let resultText = truncation.content;

	if (truncation.truncated) {
		const tempFile = await saveToTempFile(output);
		const newDetails = { ...details, truncation, fullOutputPath: tempFile };

		const truncatedLines = truncation.totalLines - truncation.outputLines;
		const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

		resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
		resultText += ` Full output saved to: ${tempFile}]`;

		return { text: resultText, details: newDetails };
	}

	return { text: resultText, details };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		for (const dir of tempDirs) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Kimi Search API. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { query, limit = 10 } = params;
			const actualLimit = Math.max(1, Math.min(20, limit));

			onUpdate?.({
				content: [{ type: "text", text: "Searching..." }],
				details: { query, limit: actualLimit, resultCount: 0 },
			});

			const apiKey = getApiKey();

			const response = await fetch("https://api.kimi.com/coding/v1/search", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					text_query: query,
					limit: actualLimit,
					enable_page_crawling: true,
					timeout_seconds: 30,
				}),
				signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "unknown error");
				throw new Error(`Kimi Search API error (${response.status}): ${body}`);
			}

			const data = (await response.json()) as SearchResponse;
			const results = data.search_results ?? [];

			let output = "";
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				output += `[${i + 1}] ${r.title}\n`;
				output += `URL: ${r.url}\n`;
				if (r.snippet) {
					output += `摘要: ${r.snippet}\n`;
				}
				if (r.content) {
					output += `内容: ${r.content}\n`;
				}
				output += "\n";
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No search results found" }],
					details: { query, limit: actualLimit, resultCount: 0 },
				};
			}

			let details: WebSearchDetails = {
				query,
				limit: actualLimit,
				resultCount: results.length,
			};

			const { text, details: newDetails } = await applyTruncation(output, details);
			details = newDetails;

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.limit !== undefined) {
				text += theme.fg("muted", ` limit=${args.limit}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as WebSearchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			if (!details || details.resultCount === 0) {
				return new Text(theme.fg("dim", "No results found"), 0, 0);
			}

			let text = theme.fg("success", `${details.resultCount} results`);
			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 20) {
						text += `\n${theme.fg("muted", "...")}`;
					}
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a webpage and return its content as markdown using Kimi Search API. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { url } = params;

			onUpdate?.({
				content: [{ type: "text", text: "Fetching..." }],
				details: { url },
			});

			const apiKey = getApiKey();

			const response = await fetch("https://api.kimi.com/coding/v1/fetch", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					Accept: "text/markdown",
				},
				body: JSON.stringify({ url, timeout_seconds: 30 }),
				signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "unknown error");
				throw new Error(`Kimi Fetch API error (${response.status}): ${body}`);
			}

			const output = await response.text();

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No content fetched" }],
					details: { url },
				};
			}

			let details: WebFetchDetails = { url };
			const { text, details: newDetails } = await applyTruncation(output, details);
			details = newDetails;

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			text += theme.fg("accent", args.url);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as WebFetchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const content = result.content[0];
			const hasContent = content?.type === "text" && content.text.length > 0;

			if (!hasContent) {
				return new Text(theme.fg("dim", "No content"), 0, 0);
			}

			let text = theme.fg("success", "Fetched");
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			if (expanded) {
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 20) {
						text += `\n${theme.fg("muted", "...")}`;
					}
				}
				if (details?.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
