import {
	App,
	Plugin,
	Notice,
	MarkdownPostProcessorContext,
	PluginSettingTab,
	Setting,
} from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// ---------- Settings ----------

type DisplayMode = "notice" | "popup";

interface DiceRollerSettings {
	displayMode: DisplayMode;
	durationMs: number;
	enableControlRolls: boolean;
	enableFrequencyRolls: boolean;
	enableSkills: boolean;
}

const DEFAULT_SETTINGS: DiceRollerSettings = {
	displayMode: "notice",
	durationMs: 6000,
	enableControlRolls: true,
	enableFrequencyRolls: true,
	enableSkills: true,
};

let pluginRef: InlineDiceRollerPlugin | null = null;
function currentSettings(): DiceRollerSettings {
	return pluginRef?.settings ?? DEFAULT_SETTINGS;
}

// ---------- Token regex builders ----------
//
// Standard dice notation (1d6, 3D4-2, 10d6+3, 2d20 + 5) is always recognized.
// GURPS Control/Frequency rolls (CR12, FR9) are gated by settings.
// GURPS skill rolls (capitalized "Name N" with contextual anchoring) are gated too.

function buildPrimaryRegex(): RegExp {
	// Sides digits are optional to support GURPS shorthand like `1d`, `1d-1`,
	// `2d+3` (implicit d6).
	const alts: string[] = [
		"(?:\\d{1,4})[dD](?:\\d{1,4})?(?:\\s*[+-]\\s*\\d{1,4})?",
	];
	const s = currentSettings();
	const types: string[] = [];
	if (s.enableControlRolls) types.push("CR");
	if (s.enableFrequencyRolls) types.push("FR");
	if (types.length) alts.push(`(?:${types.join("|")})\\s?\\d{1,2}`);
	return new RegExp(`\\b(?:${alts.join("|")})\\b`, "gi");
}

// Skill name: capitalized word (optionally hyphenated) or a parenthesized specialty.
const SKILL_WORD = "(?:[A-Z][A-Za-z-]*|\\([^)]+\\))";
const SKILL_BODY = `${SKILL_WORD}(?:\\s${SKILL_WORD}){0,3}\\s\\d{1,2}`;

// Words that match the skill shape but are weapon stats or attributes, not
// rollable skills.
const SKILL_NAME_EXCLUDED = new Set(["acc", "rof", "shots", "tl"]);

// GURPS attributes/stats that should highlight even without a trailing
// `,` / `.` / `|` / EOL suffix. Matched case-insensitively.
const STAT_NAMES = [
	"Dodge",
	"Parry",
	"ST",
	"DX",
	"IQ",
	"HT",
	"Will",
	"Per",
	"HP",
	"FP",
];
const STAT_ALTERNATION = STAT_NAMES.join("|");

function buildSkillRegex(context: "read" | "live"): RegExp | null {
	if (!currentSettings().enableSkills) return null;
	const prefixChars = context === "live" ? "[:,|]" : "[:,]";
	const suffixChars = context === "live" ? "[,.|]" : "[,.]";
	// Allow markdown emphasis markers (*, _) as transparent padding in live
	// preview so `**Label:** Skill 12` and `*Skill 12*` still match.
	const gap = context === "live" ? "[\\s*_]*" : "\\s*";
	return new RegExp(
		`(?<=(?:^|${prefixChars})${gap})${SKILL_BODY}(?=${gap}(?:${suffixChars}|$))`,
		"gm"
	);
}

function buildStatRegex(context: "read" | "live"): RegExp | null {
	if (!currentSettings().enableSkills) return null;
	// Stats in the always-allow list match anywhere — no prefix or suffix
	// context required, just word boundaries on both sides.
	const gap = context === "live" ? "[\\s*_]+" : "\\s+";
	return new RegExp(
		`\\b(?:${STAT_ALTERNATION})${gap}\\d{1,2}\\b`,
		"gmi"
	);
}

function skillNameFromMatch(matchText: string): string {
	const m = /^(.+?)\s\d{1,2}$/.exec(matchText);
	return m ? m[1].trim().toLowerCase() : matchText.toLowerCase();
}

interface TokenMatch {
	start: number;
	end: number;
	text: string;
}

function findAllMatches(
	text: string,
	context: "read" | "live"
): TokenMatch[] {
	const matches: TokenMatch[] = [];

	const primary = buildPrimaryRegex();
	let m: RegExpExecArray | null;
	while ((m = primary.exec(text)) !== null) {
		matches.push({
			start: m.index,
			end: m.index + m[0].length,
			text: m[0],
		});
	}

	const addIfNew = (start: number, end: number, mt: string) => {
		if (SKILL_NAME_EXCLUDED.has(skillNameFromMatch(mt))) return;
		const overlaps = matches.some(
			(x) => !(end <= x.start || start >= x.end)
		);
		if (!overlaps) {
			matches.push({ start, end, text: mt });
		}
	};

	const skill = buildSkillRegex(context);
	if (skill) {
		while ((m = skill.exec(text)) !== null) {
			addIfNew(m.index, m.index + m[0].length, m[0]);
		}
	}

	const stat = buildStatRegex(context);
	if (stat) {
		while ((m = stat.exec(text)) !== null) {
			addIfNew(m.index, m.index + m[0].length, m[0]);
		}
	}

	matches.sort((a, b) => a.start - b.start);
	return matches;
}

function isTokenString(s: string): boolean {
	return parseToken(s.trim()) !== null;
}

// ---------- Parsing / rolling ----------

type ParsedToken =
	| {
			kind: "dice";
			notation: string;
			count: number;
			sides: number;
			sign: "+" | "-" | "";
			modifier: number;
	  }
	| {
			kind: "gurps";
			notation: string;
			type: "CR" | "FR";
			target: number;
	  }
	| {
			kind: "skill";
			notation: string;
			name: string;
			target: number;
	  };

function parseToken(raw: string): ParsedToken | null {
	const s = raw.trim();
	const diceMatch = /^(\d{1,4})[dD](\d{1,4})?(?:\s*([+-])\s*(\d{1,4}))?$/.exec(s);
	if (diceMatch) {
		const count = parseInt(diceMatch[1], 10);
		// GURPS shorthand: `1d`, `2d+3` etc. imply d6 when sides are omitted.
		const sides = diceMatch[2] ? parseInt(diceMatch[2], 10) : 6;
		const sign = (diceMatch[3] as "+" | "-" | undefined) ?? "";
		const modifier = diceMatch[4] ? parseInt(diceMatch[4], 10) : 0;
		if (count <= 0 || sides <= 0 || count > 1000 || sides > 10000) return null;
		return {
			kind: "dice",
			notation: s,
			count,
			sides,
			sign,
			modifier,
		};
	}
	const gurpsMatch = /^(CR|FR)\s?(\d{1,2})$/i.exec(s);
	if (gurpsMatch) {
		const type = gurpsMatch[1].toUpperCase() as "CR" | "FR";
		const target = parseInt(gurpsMatch[2], 10);
		if (target <= 0 || target > 99) return null;
		return { kind: "gurps", notation: s, type, target };
	}
	const skillMatch =
		/^((?:[A-Z][A-Za-z-]*|\([^)]+\))(?:\s(?:[A-Z][A-Za-z-]*|\([^)]+\))){0,3})\s(\d{1,2})$/.exec(
			s
		);
	if (skillMatch) {
		const name = skillMatch[1];
		if (SKILL_NAME_EXCLUDED.has(name.toLowerCase())) return null;
		const target = parseInt(skillMatch[2], 10);
		if (target <= 0 || target > 99) return null;
		return { kind: "skill", notation: s, name, target };
	}
	const statMatch = new RegExp(
		`^(${STAT_ALTERNATION})\\s(\\d{1,2})$`,
		"i"
	).exec(s);
	if (statMatch) {
		const name = statMatch[1];
		const target = parseInt(statMatch[2], 10);
		if (target <= 0 || target > 99) return null;
		return { kind: "skill", notation: s, name, target };
	}
	return null;
}

interface DiceRoll {
	kind: "dice";
	token: Extract<ParsedToken, { kind: "dice" }>;
	rolls: number[];
	subtotal: number;
	total: number;
}
interface GurpsRoll {
	kind: "gurps";
	token: Extract<ParsedToken, { kind: "gurps" }>;
	rolls: number[];
	total: number;
	margin: number; // target - total; positive = margin of success
	success: boolean;
}
interface SkillRoll {
	kind: "skill";
	token: Extract<ParsedToken, { kind: "skill" }>;
	rolls: number[];
	total: number;
	margin: number;
	success: boolean;
}
type RollOutcome = DiceRoll | GurpsRoll | SkillRoll;

function roll3d6(): { rolls: number[]; total: number } {
	const rolls: number[] = [];
	for (let i = 0; i < 3; i++) rolls.push(1 + Math.floor(Math.random() * 6));
	const total = rolls.reduce((a, b) => a + b, 0);
	return { rolls, total };
}

function rollToken(token: ParsedToken): RollOutcome {
	if (token.kind === "dice") {
		const rolls: number[] = [];
		for (let i = 0; i < token.count; i++) {
			rolls.push(1 + Math.floor(Math.random() * token.sides));
		}
		const subtotal = rolls.reduce((a, b) => a + b, 0);
		let total = subtotal;
		if (token.sign === "+") total += token.modifier;
		else if (token.sign === "-") total -= token.modifier;
		return { kind: "dice", token, rolls, subtotal, total };
	}
	const { rolls, total } = roll3d6();
	const margin = token.target - total;
	const success = total <= token.target;
	if (token.kind === "gurps") {
		return { kind: "gurps", token, rolls, total, margin, success };
	}
	return { kind: "skill", token, rolls, total, margin, success };
}

function buildRollContent(outcome: RollOutcome): DocumentFragment {
	const frag = document.createDocumentFragment();
	const wrap = frag.createDiv({ cls: "dice-roller-notice" });

	if (outcome.kind === "dice") {
		const r = outcome;
		wrap.createDiv({ text: `🎲 ${r.token.notation}` });
		if (r.token.count > 1) {
			wrap.createDiv({
				text: `Rolls: [${r.rolls.join(", ")}] = ${r.subtotal}`,
			});
		}
		if (r.token.modifier && r.token.sign) {
			wrap.createDiv({
				text: `${r.subtotal} ${r.token.sign} ${r.token.modifier}`,
			});
		}
		wrap.createDiv({
			cls: "dice-roller-total",
			text: `Total: ${r.total}`,
		});
	} else {
		const r = outcome;
		let label: string;
		if (r.kind === "skill") {
			label = "Skill Roll";
		} else if (r.token.type === "CR") {
			label = "Control Roll";
		} else {
			label = "Frequency Roll";
		}
		wrap.createDiv({
			text: `🎲 ${r.token.notation} (${label}, target ${r.token.target})`,
		});
		wrap.createDiv({ text: `3d6: [${r.rolls.join(", ")}] = ${r.total}` });
		const resultLine = wrap.createDiv({ cls: "dice-roller-total" });
		if (r.success) {
			resultLine.addClass("dice-roller-success");
			resultLine.setText(`SUCCESS by ${r.margin}`);
		} else {
			resultLine.addClass("dice-roller-failure");
			resultLine.setText(`FAILURE by ${-r.margin}`);
		}
	}
	return frag;
}

function showRollResult(notation: string, evt?: MouseEvent): void {
	const token = parseToken(notation);
	if (!token) {
		new Notice(`Could not parse: ${notation}`);
		return;
	}
	const outcome = rollToken(token);
	const settings = currentSettings();
	const content = buildRollContent(outcome);

	if (settings.displayMode === "popup" && evt) {
		showCursorPopup(content, evt.clientX, evt.clientY, settings.durationMs);
	} else {
		new Notice(content, settings.durationMs);
	}
}

// ---------- Cursor-anchored popup ----------

function showCursorPopup(
	content: Node,
	x: number,
	y: number,
	duration: number
): void {
	const el = document.createElement("div");
	el.className = "dice-roller-popup";
	el.appendChild(content);
	document.body.appendChild(el);

	const rect = el.getBoundingClientRect();
	const pad = 8;
	const offset = 14;
	let left = x + offset;
	let top = y + offset;
	if (left + rect.width + pad > window.innerWidth) {
		left = x - rect.width - offset;
	}
	if (top + rect.height + pad > window.innerHeight) {
		top = y - rect.height - offset;
	}
	if (left < pad) left = pad;
	if (top < pad) top = pad;
	el.style.left = `${left}px`;
	el.style.top = `${top}px`;

	requestAnimationFrame(() => el.addClass("dice-roller-popup-visible"));

	let dismissed = false;
	const dismiss = () => {
		if (dismissed) return;
		dismissed = true;
		el.removeClass("dice-roller-popup-visible");
		window.setTimeout(() => el.remove(), 180);
		document.removeEventListener("mousedown", onOutside, true);
		document.removeEventListener("keydown", onKey, true);
	};
	const onOutside = (e: MouseEvent) => {
		if (!el.contains(e.target as Node)) dismiss();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") dismiss();
	};

	window.setTimeout(dismiss, duration);
	window.setTimeout(() => {
		document.addEventListener("mousedown", onOutside, true);
		document.addEventListener("keydown", onKey, true);
	}, 0);
}

// ---------- Reading view (rendered markdown, incl. tables, callouts, embeds) ----------

function processReadingView(
	el: HTMLElement,
	_ctx: MarkdownPostProcessorContext
): void {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const candidates: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const t = node as Text;
		if (!t.parentElement) continue;
		if (
			t.parentElement.closest(
				"code, pre, .math, .MathJax, a, .dice-roller-inline"
			)
		)
			continue;
		const text = t.textContent ?? "";
		if (!text) continue;
		if (findAllMatches(text, "read").length > 0) {
			candidates.push(t);
		}
	}

	for (const textNode of candidates) {
		replaceTextNodeWithTokens(textNode);
	}
}

function replaceTextNodeWithTokens(textNode: Text): void {
	const text = textNode.textContent ?? "";
	const parent = textNode.parentNode;
	if (!parent) return;

	const matches = findAllMatches(text, "read");
	if (matches.length === 0) return;

	const frag = document.createDocumentFragment();
	let lastIndex = 0;
	for (const mm of matches) {
		if (mm.start > lastIndex) {
			frag.appendChild(
				document.createTextNode(text.slice(lastIndex, mm.start))
			);
		}
		const span = document.createElement("span");
		span.className = "dice-roller-inline";
		span.textContent = mm.text;
		span.setAttribute("data-dice", mm.text);
		span.setAttribute("aria-label", `Roll ${mm.text}`);
		span.setAttribute("role", "button");
		const notation = mm.text;
		span.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			showRollResult(notation, evt);
		});
		frag.appendChild(span);
		lastIndex = mm.end;
	}
	if (lastIndex < text.length) {
		frag.appendChild(document.createTextNode(text.slice(lastIndex)));
	}
	parent.replaceChild(frag, textNode);
}

// ---------- Live preview (CodeMirror 6) ----------

const SKIP_NODE_PATTERNS = [
	"inline-code",
	"codeblock",
	"code-block",
	"formatting-code",
	"math",
	"frontmatter",
	"comment",
	"hmd-internal-link",
	"hmd-barelink",
	"url",
	"link",
];

function isInsideSkippedNode(view: EditorView, pos: number): boolean {
	const tree = syntaxTree(view.state);
	let skip = false;
	tree.iterate({
		from: pos,
		to: pos + 1,
		enter: (nodeRef) => {
			const name = nodeRef.type.name.toLowerCase();
			for (const p of SKIP_NODE_PATTERNS) {
				if (name.includes(p)) {
					skip = true;
					return false;
				}
			}
			return undefined;
		},
	});
	return skip;
}

const diceDecorationSpec = Decoration.mark({
	class: "dice-roller-inline",
	attributes: { role: "button" },
});

function buildDiceDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const selection = view.state.selection;

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		const matches = findAllMatches(text, "live");
		for (const mm of matches) {
			const start = from + mm.start;
			const end = from + mm.end;

			let cursorOverlap = false;
			for (const r of selection.ranges) {
				if (r.from <= end && r.to >= start) {
					cursorOverlap = true;
					break;
				}
			}
			if (cursorOverlap) continue;
			if (isInsideSkippedNode(view, start)) continue;

			builder.add(start, end, diceDecorationSpec);
		}
	}
	return builder.finish();
}

const diceViewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDiceDecorations(view);
		}

		update(u: ViewUpdate): void {
			if (u.docChanged || u.viewportChanged || u.selectionSet) {
				this.decorations = buildDiceDecorations(u.view);
			}
		}
	},
	{
		decorations: (v) => v.decorations,
		eventHandlers: {
			mousedown(event: MouseEvent, view: EditorView) {
				if (event.button !== 0) return false;
				const target = event.target as HTMLElement | null;
				if (!target || !target.classList.contains("dice-roller-inline"))
					return false;
				if (
					event.shiftKey ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey
				) {
					return false;
				}

				const text = (target.textContent ?? "").trim();
				if (!isTokenString(text)) return false;

				event.preventDefault();
				event.stopPropagation();
				showRollResult(text, event);
				(view.contentDOM as HTMLElement).blur?.();
				return true;
			},
		},
	}
);

// ---------- Settings tab ----------

class DiceRollerSettingTab extends PluginSettingTab {
	plugin: InlineDiceRollerPlugin;

	constructor(app: App, plugin: InlineDiceRollerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Result display")
			.setDesc(
				"Where the roll result appears when you click a dice token."
			)
			.addDropdown((dd) =>
				dd
					.addOption("notice", "Corner toast (default)")
					.addOption("popup", "Popup near cursor")
					.setValue(this.plugin.settings.displayMode)
					.onChange(async (value) => {
						this.plugin.settings.displayMode =
							value as DisplayMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Duration (ms)")
			.setDesc(
				"How long the result stays visible before auto-dismissing."
			)
			.addText((text) =>
				text
					.setPlaceholder("6000")
					.setValue(String(this.plugin.settings.durationMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (Number.isFinite(n) && n >= 500 && n <= 60000) {
							this.plugin.settings.durationMs = n;
							await this.plugin.saveSettings();
						}
					})
			);

		const refreshViews = () => {
			this.app.workspace.updateOptions();
		};

		new Setting(containerEl)
			.setName("Recognize GURPS Control Rolls")
			.setDesc(
				"Highlight tokens like CR12 or CR 14. Reading view may need the note reopened to refresh."
			)
			.addToggle((tgl) =>
				tgl
					.setValue(this.plugin.settings.enableControlRolls)
					.onChange(async (value) => {
						this.plugin.settings.enableControlRolls = value;
						await this.plugin.saveSettings();
						refreshViews();
					})
			);

		new Setting(containerEl)
			.setName("Recognize GURPS Frequency Rolls")
			.setDesc(
				"Highlight tokens like FR9 or FR 12. Reading view may need the note reopened to refresh."
			)
			.addToggle((tgl) =>
				tgl
					.setValue(this.plugin.settings.enableFrequencyRolls)
					.onChange(async (value) => {
						this.plugin.settings.enableFrequencyRolls = value;
						await this.plugin.saveSettings();
						refreshViews();
					})
			);

		new Setting(containerEl)
			.setName("Recognize GURPS skill rolls")
			.setDesc(
				"Highlight capitalized skill names followed by a plain integer (e.g. Broadsword 14, Fast-Draw (Knife) 13). Reading view may need the note reopened to refresh."
			)
			.addToggle((tgl) =>
				tgl
					.setValue(this.plugin.settings.enableSkills)
					.onChange(async (value) => {
						this.plugin.settings.enableSkills = value;
						await this.plugin.saveSettings();
						refreshViews();
					})
			);
	}
}

// ---------- Plugin entry ----------

export default class InlineDiceRollerPlugin extends Plugin {
	settings: DiceRollerSettings = { ...DEFAULT_SETTINGS };
	private tableObserver?: MutationObserver;

	async onload(): Promise<void> {
		pluginRef = this;
		await this.loadSettings();

		this.registerMarkdownPostProcessor(processReadingView);
		this.registerEditorExtension(diceViewPlugin);
		this.addSettingTab(new DiceRollerSettingTab(this.app, this));

		// Obsidian renders live-preview tables as widgets that hide the
		// underlying source characters, so CodeMirror mark decorations never
		// appear inside cells. The markdown post-processor also does not
		// reliably fire for those widgets. Walk rendered table DOM directly.
		const processTable = (el: HTMLElement) => {
			processReadingView(
				el,
				null as unknown as MarkdownPostProcessorContext
			);
		};
		const rescanExistingTables = () => {
			document
				.querySelectorAll(".cm-editor table")
				.forEach((t) => processTable(t as HTMLElement));
		};
		this.app.workspace.onLayoutReady(rescanExistingTables);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", rescanExistingTables)
		);
		this.tableObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					if (node.nodeType !== Node.ELEMENT_NODE) return;
					const el = node as HTMLElement;
					if (el.classList.contains("dice-roller-inline")) return;
					if (!el.closest(".cm-editor")) return;
					if (el.tagName === "TABLE") {
						processTable(el);
					} else {
						el.querySelectorAll("table").forEach((t) =>
							processTable(t as HTMLElement)
						);
					}
				});
			}
		});
		this.tableObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});

		this.addCommand({
			id: "roll-selected-dice",
			name: "Roll selected dice notation",
			editorCallback: (editor) => {
				const sel = editor.getSelection().trim();
				if (sel && isTokenString(sel)) {
					showRollResult(sel);
				} else {
					new Notice(
						"Select valid notation (e.g. 3d6+2, CR12) first."
					);
				}
			},
		});
	}

	onunload(): void {
		this.tableObserver?.disconnect();
		this.tableObserver = undefined;
		pluginRef = null;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<DiceRollerSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
