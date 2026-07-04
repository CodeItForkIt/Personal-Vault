import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	Vault,
	MetadataCache,
	normalizePath,
	requestUrl,
} from "obsidian";

interface ResolverSettings {
	useFrontmatterMatching: boolean;
	sourcePropertyKey: string;
	useFilenameMatching: boolean;
	matchAliases: boolean;
	clippingsRootFolder: string;
	excludeFolders: string;
	ignoreQueryParams: boolean;
	ignoreTrailingSlash: boolean;
	ignoreProtocol: boolean;
	ignoreWww: boolean;
	skipSelfLinks: boolean;
	preserveHeadingLinks: boolean;
	resolveRedirectsLive: boolean;
	redirectRequestDelayMs: number;
	redirectRequestTimeoutMs: number;
	redirectCache: Record<string, string>; // normalized requested URL -> canonical URL ("" = confirmed no redirect/no match)
}

const DEFAULT_SETTINGS: ResolverSettings = {
	useFrontmatterMatching: true,
	sourcePropertyKey: "source",
	useFilenameMatching: true,
	matchAliases: true,
	clippingsRootFolder: "Clippings",
	excludeFolders: "",
	ignoreQueryParams: true,
	ignoreTrailingSlash: true,
	ignoreProtocol: true,
	ignoreWww: true,
	skipSelfLinks: true,
	preserveHeadingLinks: true,
	resolveRedirectsLive: false,
	redirectRequestDelayMs: 1000,
	redirectRequestTimeoutMs: 8000,
	redirectCache: {},
};

interface FoundLink {
	start: number;
	end: number; // exclusive
	displayText: string;
	url: string;
}

/**
 * Scans for [text](url) or [text](url "title") links, correctly handling
 * nested/literal parentheses inside the URL or title (common in wiki links
 * like ".../Elantris_(city)"), which a single non-recursive regex can't
 * track reliably.
 */
function findMarkdownLinks(text: string): FoundLink[] {
	const results: FoundLink[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "[") {
			i++;
			continue;
		}

		// Find matching closing bracket for display text, allowing nesting.
		let depth = 1;
		let j = i + 1;
		while (j < text.length && depth > 0) {
			if (text[j] === "[") depth++;
			else if (text[j] === "]") depth--;
			j++;
		}
		if (depth !== 0) {
			i++;
			continue; // unbalanced, not a link
		}
		const closeBracket = j - 1;

		if (text[closeBracket + 1] !== "(") {
			i = closeBracket + 1;
			continue;
		}

		// Find matching closing paren, allowing nested parens.
		let pdepth = 1;
		let k = closeBracket + 2;
		while (k < text.length && pdepth > 0) {
			if (text[k] === "(") pdepth++;
			else if (text[k] === ")") pdepth--;
			k++;
		}
		if (pdepth !== 0) {
			i = closeBracket + 1;
			continue; // unbalanced, not a link
		}
		const closeParen = k - 1;
		const inner = text.slice(closeBracket + 2, closeParen);

		// inner is either just a URL, or `URL "optional title"`.
		const titleSplit = inner.match(/^(\S+)\s+"[^"]*"$/);
		const url = (titleSplit ? titleSplit[1] : inner).trim();
		const displayText = text.slice(i + 1, closeBracket);

		if (/^https?:\/\//.test(url)) {
			results.push({ start: i, end: k, displayText, url });
		}

		i = k;
	}
	return results;
}

/** Pulls the last URL path segment as a matchable "slug", e.g. /wiki/Worldhopper -> "worldhopper". */
function deriveSlugFromUrl(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl.trim());
		const segments = url.pathname.split("/").filter(Boolean);
		if (segments.length === 0) return null;
		let slug = segments[segments.length - 1];
		try {
			slug = decodeURIComponent(slug);
		} catch {
			// leave as-is if not valid percent-encoding
		}
		return slug.replace(/[_-]/g, " ").trim().toLowerCase();
	} catch {
		return null;
	}
}

/** Normalizes a note's basename the same way, so slugs and filenames compare on equal footing. */
function normalizeBasename(basename: string): string {
	let n = basename;
	try {
		n = decodeURIComponent(n);
	} catch {
		// leave as-is
	}
	return n.replace(/[_-]/g, " ").trim().toLowerCase();
}

/**
 * Extracts a URL's #fragment as an Obsidian heading subpath, e.g.
 * ".../Hoid#Abilities_and_Powers" -> "#Abilities and Powers".
 * Returns null if there's no fragment to preserve.
 *
 * Note: this only does standard percent-decoding + underscore-to-space.
 * Older MediaWiki sites sometimes dot-encode punctuation in anchors
 * (e.g. ".2C" for a comma) rather than percent-encoding it; those are not
 * unpacked here; the resulting subpath may not match the note's actual
 * heading text exactly in that case, so worth a manual glance for headings
 * containing punctuation.
 */
function deriveSubpathFromUrl(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl.trim());
		if (!url.hash || url.hash.length <= 1) return null;
		let heading = url.hash.slice(1);
		try {
			heading = decodeURIComponent(heading);
		} catch {
			// leave as-is if not valid percent-encoding
		}
		heading = heading.replace(/_/g, " ").trim();
		return heading.length > 0 ? "#" + heading : null;
	} catch {
		return null;
	}
}


function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Races a promise against a timeout. Obsidian's requestUrl doesn't publicly
 * document a timeout or AbortSignal option, so this is a "soft" timeout:
 * it stops us from waiting past the deadline, but can't guarantee the
 * underlying network request was actually cancelled under the hood if
 * requestUrl itself has no abort mechanism -- we just stop listening to it.
 */
class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

/**
 * Extracts the canonical URL from a fetched page's HTML, if present.
 * MediaWiki (and most well-behaved sites) emit a <link rel="canonical">
 * tag pointing at the "real" URL even when the requested URL was a
 * redirect -- this is the standard, skin-independent way to discover
 * "this URL is actually that page" without needing an API endpoint.
 * Falls back to an og:url meta tag if no canonical link is present.
 *
 * Attribute order isn't assumed (real-world HTML doesn't guarantee
 * rel="..." comes before href="..." or vice versa) -- each candidate tag
 * is matched as a whole, then its attributes are pulled out independently.
 */
function extractCanonicalUrl(html: string): string | null {
	const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
	for (const tag of linkTags) {
		if (!/rel=["']canonical["']/i.test(tag)) continue;
		const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
		if (hrefMatch) return hrefMatch[1];
	}

	const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
	for (const tag of metaTags) {
		if (!/property=["']og:url["']/i.test(tag)) continue;
		const contentMatch = tag.match(/content=["']([^"']+)["']/i);
		if (contentMatch) return contentMatch[1];
	}

	return null;
}


export default class ClippingLinkResolverPlugin extends Plugin {
	settings: ResolverSettings;
	private urlIndex: Map<string, TFile> = new Map();
	private slugIndex: Map<string, TFile[]> = new Map();
	private knownDomains: Set<string> = new Set();
	private redirectCache: Map<string, string> = new Map(); // "" value = confirmed dead end
	private lastRedirectRequestAt = 0;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "resolve-links-current-note",
			name: "Resolve external links to internal links (current note)",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.runOnFiles([file]);
				return true;
			},
		});

		this.addCommand({
			id: "resolve-links-whole-vault",
			name: "Resolve external links to internal links (entire vault)",
			callback: () => {
				const files = this.getEligibleFiles();
				this.runOnFiles(files);
			},
		});

		this.addSettingTab(new ResolverSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private getExcludedFolderSet(): string[] {
		return this.settings.excludeFolders
			.split(",")
			.map((s) => normalizePath(s.trim()))
			.filter((s) => s.length > 0);
	}

	private isExcluded(file: TFile, excluded: string[]): boolean {
		return excluded.some(
			(folder) => file.path === folder || file.path.startsWith(folder + "/")
		);
	}

	private getEligibleFiles(): TFile[] {
		const excluded = this.getExcludedFolderSet();
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => !this.isExcluded(f, excluded));
	}

	/** Normalize a URL for matching purposes based on current settings. */
	private normalizeUrl(raw: string): string | null {
		try {
			const url = new URL(raw.trim());
			let host = url.hostname.toLowerCase();
			if (this.settings.ignoreWww && host.startsWith("www.")) {
				host = host.slice(4);
			}
			let path = url.pathname;
			if (this.settings.ignoreTrailingSlash && path.length > 1 && path.endsWith("/")) {
				path = path.slice(0, -1);
			}
			const search = this.settings.ignoreQueryParams ? "" : url.search;
			const protocol = this.settings.ignoreProtocol ? "" : url.protocol;
			return `${protocol}//${host}${path}${search}`.toLowerCase();
		} catch {
			return null;
		}
	}

	/** Build (or rebuild) the map of normalized source URL -> TFile across the whole vault. */
	private buildUrlIndex(): void {
		this.urlIndex.clear();
		if (!this.settings.useFrontmatterMatching) return;
		const key = this.settings.sourcePropertyKey;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const rawUrl = fm?.[key];
			if (typeof rawUrl !== "string" || rawUrl.length === 0) continue;
			const normalized = this.normalizeUrl(rawUrl);
			if (!normalized) continue;
			// First note wins on duplicates; doesn't matter much in practice.
			if (!this.urlIndex.has(normalized)) {
				this.urlIndex.set(normalized, file);
			}
		}
	}

	/** Adds a file under a normalized key in the slug index, avoiding duplicate entries. */
	private addToSlugIndex(key: string, file: TFile): void {
		if (!key) return;
		const existing = this.slugIndex.get(key);
		if (existing) {
			if (!existing.includes(file)) existing.push(file);
		} else {
			this.slugIndex.set(key, [file]);
		}
	}

	/**
	 * Build (or rebuild) the map of normalized filename/alias -> TFile[],
	 * scoped to the clippings root folder. Indexing aliases alongside
	 * filenames matters for wikis (Coppermind included) where a page is
	 * commonly linked to under a redirect name that differs from its
	 * canonical title -- e.g. a note titled "Hoid - The Coppermind" with
	 * `aliases: [Wit, Wandersail]` should still resolve a link to
	 * ".../wiki/Wit".
	 */
	private buildSlugIndex(): void {
		this.slugIndex.clear();
		if (!this.settings.useFilenameMatching) return;
		const root = normalizePath(this.settings.clippingsRootFolder.trim());
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (root && root !== "/" && !(file.path === root || file.path.startsWith(root + "/"))) {
				continue;
			}
			this.addToSlugIndex(normalizeBasename(file.basename), file);

			if (this.settings.matchAliases) {
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				const rawAliases = fm?.aliases ?? fm?.alias;
				const aliasList: string[] = Array.isArray(rawAliases)
					? rawAliases
					: typeof rawAliases === "string"
					? [rawAliases]
					: [];
				for (const alias of aliasList) {
					if (typeof alias === "string" && alias.length > 0) {
						this.addToSlugIndex(normalizeBasename(alias), file);
					}
				}
			}
		}
	}

	/**
	 * Collects the set of domains you're already clipping from, so live
	 * redirect resolution (if enabled) only ever fires against sites you've
	 * demonstrably clipped before -- never an arbitrary domain a link
	 * happens to point at.
	 */
	private buildKnownDomains(): void {
		this.knownDomains.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const domainField = fm.domain;
			if (typeof domainField === "string" && domainField.length > 0) {
				this.knownDomains.add(domainField.toLowerCase().replace(/^www\./, ""));
			}
			const sourceField = fm[this.settings.sourcePropertyKey];
			if (typeof sourceField === "string" && sourceField.length > 0) {
				try {
					const host = new URL(sourceField).hostname.toLowerCase().replace(/^www\./, "");
					this.knownDomains.add(host);
				} catch {
					// not a valid URL, ignore
				}
			}
		}
	}

	/** The synchronous core matcher: checks a URL against the frontmatter and slug/alias indexes only. */
	private matchUrlAgainstIndexes(url: string, currentFilePath: string): TFile | null {
		if (this.settings.useFrontmatterMatching) {
			const normalized = this.normalizeUrl(url);
			if (normalized) {
				const match = this.urlIndex.get(normalized);
				if (match && !(this.settings.skipSelfLinks && match.path === currentFilePath)) {
					return match;
				}
			}
		}

		if (this.settings.useFilenameMatching) {
			const slug = deriveSlugFromUrl(url);
			if (slug) {
				let candidates = this.slugIndex.get(slug) ?? [];
				if (candidates.length === 0) {
					// Fall back to "starts with slug" (handles "Hoid - The Coppermind" for slug "hoid").
					for (const [key, files] of this.slugIndex.entries()) {
						if (key.startsWith(slug + " ")) candidates = candidates.concat(files);
					}
				}
				if (this.settings.skipSelfLinks) {
					candidates = candidates.filter((f) => f.path !== currentFilePath);
				}
				if (candidates.length === 1) return candidates[0];
				// 0 matches: nothing clipped yet. 2+ matches: ambiguous, skip rather than guess.
			}
		}

		return null;
	}

	/**
	 * Resolves a link's URL to a target note. Tries the fast synchronous
	 * indexes first; if those come up empty and live redirect resolution is
	 * enabled, falls back to actually fetching the URL (rate-limited,
	 * cached, and scoped to domains already present in the vault) to
	 * discover its canonical URL -- for cases like a wiki redirect
	 * ("Wit" -> "Hoid" on Coppermind) that no note's frontmatter or
	 * filename could ever reflect on its own.
	 */
	private async resolveTargetFile(rawUrl: string, currentFilePath: string): Promise<TFile | null> {
		const direct = this.matchUrlAgainstIndexes(rawUrl, currentFilePath);
		if (direct) return direct;

		if (!this.settings.resolveRedirectsLive) return null;

		let host: string;
		try {
			host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
		} catch {
			return null;
		}
		if (!this.knownDomains.has(host)) return null;

		const cacheKey = this.normalizeUrl(rawUrl) ?? rawUrl;
		let canonical: string;
		if (this.redirectCache.has(cacheKey)) {
			canonical = this.redirectCache.get(cacheKey)!;
		} else {
			// Rate-limit actual network calls; cache hits above skip this entirely.
			const wait = this.lastRedirectRequestAt + this.settings.redirectRequestDelayMs - Date.now();
			if (wait > 0) await sleep(wait);
			this.lastRedirectRequestAt = Date.now();

			canonical = "";
			try {
				const response = await withTimeout(
					requestUrl({ url: rawUrl, throw: false }),
					this.settings.redirectRequestTimeoutMs
				);
				if (response.status >= 200 && response.status < 400) {
					canonical = extractCanonicalUrl(response.text) ?? "";
				}
				// A completed response (found or not) is a real fact about the
				// page -- safe to cache either way.
				this.redirectCache.set(cacheKey, canonical);
			} catch (err) {
				// Timeouts and network-level failures (DNS, connection reset, etc.)
				// are transient conditions, not facts about the page -- deliberately
				// NOT cached, so a future run gets to try again rather than being
				// stuck with a false "no redirect" verdict from a bad moment.
				if (err instanceof TimeoutError) {
					console.warn(`Clipping Link Resolver: redirect lookup timed out for ${rawUrl}`);
				}
				return null;
			}
		}

		if (!canonical) return null;
		return this.matchUrlAgainstIndexes(canonical, currentFilePath);
	}

	private async runOnFiles(files: TFile[]): Promise<void> {
		this.buildUrlIndex();
		this.buildSlugIndex();
		this.buildKnownDomains();
		this.redirectCache = new Map(Object.entries(this.settings.redirectCache));

		let filesChanged = 0;
		let linksConverted = 0;

		for (const file of files) {
			const original = await this.app.vault.read(file);
			let replacedCount = 0;

			// Build replacements first.
			const matches = findMarkdownLinks(original);
			if (matches.length === 0) continue;

			let result = original;
			// Process in reverse so earlier indices remain valid as we splice.
			for (let i = matches.length - 1; i >= 0; i--) {
				const match = matches[i];
				const { start, end, displayText, url: rawUrl } = match;

				const targetFile = await this.resolveTargetFile(rawUrl, file.path);
				if (!targetFile) continue;

				const subpath = this.settings.preserveHeadingLinks
					? deriveSubpathFromUrl(rawUrl) ?? undefined
					: undefined;

				const linkText = this.app.fileManager.generateMarkdownLink(
					targetFile,
					file.path,
					subpath,
					displayText && displayText !== rawUrl ? displayText : undefined
				);

				result = result.slice(0, start) + linkText + result.slice(end);
				replacedCount++;
			}

			if (replacedCount > 0) {
				await this.app.vault.modify(file, result);
				filesChanged++;
				linksConverted += replacedCount;
				new Notice(
					`Clipping Link Resolver: updated ${file.basename} (${replacedCount} link${replacedCount === 1 ? "" : "s"})`,
					3000
				);
			}
		}

		if (this.settings.resolveRedirectsLive) {
			this.settings.redirectCache = Object.fromEntries(this.redirectCache);
			await this.saveSettings();
		}

		new Notice(
			`Clipping Link Resolver: converted ${linksConverted} link(s) across ${filesChanged} file(s).`
		);
	}
}

class ResolverSettingTab extends PluginSettingTab {
	plugin: ClippingLinkResolverPlugin;

	constructor(app: App, plugin: ClippingLinkResolverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Clipping Link Resolver" });
		containerEl.createEl("p", {
			text: "Converts external links to internal [[wikilinks]] when the URL matches another note in your vault — either via a frontmatter source property, or by filename, within your clippings folder.",
		});

		containerEl.createEl("h3", { text: "Frontmatter matching" });

		new Setting(containerEl)
			.setName("Match using frontmatter source property")
			.setDesc("Most precise: matches the link's URL against this property on every note.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useFrontmatterMatching)
					.onChange(async (value) => {
						this.plugin.settings.useFrontmatterMatching = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Source property key")
			.setDesc(
				"Frontmatter property that holds the original clipped URL (Web Clipper default is 'source')."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.sourcePropertyKey)
					.onChange(async (value) => {
						this.plugin.settings.sourcePropertyKey = value.trim() || "source";
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Filename matching (fallback)" });

		new Setting(containerEl)
			.setName("Match by filename when no frontmatter match is found")
			.setDesc(
				"Derives a slug from the link's URL (e.g. /wiki/Worldhopper -> 'worldhopper') and looks for a note whose filename starts with it, inside the clippings folder below. Works even if source isn't set."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useFilenameMatching)
					.onChange(async (value) => {
						this.plugin.settings.useFilenameMatching = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Clippings root folder")
			.setDesc(
				"Folder to search for filename matches (recurses into subfolders, e.g. per-site folders like Clippings/coppermind.net). Leave blank to search the whole vault."
			)
			.addText((text) =>
				text
					.setPlaceholder("Clippings")
					.setValue(this.plugin.settings.clippingsRootFolder)
					.onChange(async (value) => {
						this.plugin.settings.clippingsRootFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Also match against note aliases")
			.setDesc(
				"Checks each note's frontmatter 'aliases' property too, not just its filename. Useful for wikis where a page is commonly linked under a redirect name (e.g. a note titled 'Hoid' with an alias of 'Wit')."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.matchAliases)
					.onChange(async (value) => {
						this.plugin.settings.matchAliases = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "General" });

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Comma-separated list of folder paths to skip when converting links, e.g. Templates, Archive/Old")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.excludeFolders)
					.onChange(async (value) => {
						this.plugin.settings.excludeFolders = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore query parameters when matching")
			.setDesc("Treat ?utm_source=... etc. as irrelevant when comparing URLs.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ignoreQueryParams)
					.onChange(async (value) => {
						this.plugin.settings.ignoreQueryParams = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore trailing slash")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ignoreTrailingSlash)
					.onChange(async (value) => {
						this.plugin.settings.ignoreTrailingSlash = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore http vs https")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ignoreProtocol)
					.onChange(async (value) => {
						this.plugin.settings.ignoreProtocol = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore www. subdomain")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ignoreWww)
					.onChange(async (value) => {
						this.plugin.settings.ignoreWww = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Skip self-links")
			.setDesc("Don't replace a link with a link back to the same note.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipSelfLinks)
					.onChange(async (value) => {
						this.plugin.settings.skipSelfLinks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Preserve links to headings")
			.setDesc(
				"When a link points to a specific section (e.g. '...#Abilities'), convert it to [[Note#Abilities]] instead of dropping the heading and linking to the whole note."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.preserveHeadingLinks)
					.onChange(async (value) => {
						this.plugin.settings.preserveHeadingLinks = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Live redirect resolution (opt-in)" });
		containerEl.createEl("p", {
			text: "Handles true wiki redirects (e.g. Coppermind's 'Wit' silently redirecting to 'Hoid') that no frontmatter or filename could ever reflect on their own. When a link can't be matched any other way, this fetches the page directly (a normal page load, same as clicking the link — not an API call) and reads its <link rel=\"canonical\"> tag to find the real target. Off by default since it performs real network requests; when on, it's scoped to domains you're already clipping from, cached, and rate-limited.",
		});

		new Setting(containerEl)
			.setName("Resolve wiki redirects via live lookup")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.resolveRedirectsLive)
					.onChange(async (value) => {
						this.plugin.settings.resolveRedirectsLive = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Delay between lookups (ms)")
			.setDesc("Politeness delay before each new (uncached) live lookup. Please don't set this too low.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.redirectRequestDelayMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.redirectRequestDelayMs = Number.isFinite(n) && n >= 0 ? n : 1000;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Lookup timeout (ms)")
			.setDesc(
				"Give up waiting on a single lookup after this long, so one slow or unresponsive page can't stall an entire vault-wide run. Note: this stops the plugin from waiting, but can't guarantee the underlying request is actually cancelled -- Obsidian's HTTP client doesn't expose a way to abort it outright."
			)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.redirectRequestTimeoutMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.redirectRequestTimeoutMs = Number.isFinite(n) && n > 0 ? n : 8000;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Clear redirect cache")
			.setDesc(
				`Currently caching ${Object.keys(this.plugin.settings.redirectCache).length} lookup(s). Clear if a wiki has reorganized and old redirect targets may be stale.`
			)
			.addButton((button) =>
				button.setButtonText("Clear").onClick(async () => {
					this.plugin.settings.redirectCache = {};
					await this.plugin.saveSettings();
					new Notice("Redirect cache cleared.");
					this.display();
				})
			);
	}
}
