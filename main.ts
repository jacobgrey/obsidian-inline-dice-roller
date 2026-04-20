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

// Matches either standard dice notation (1d6, 3D4-2, 10d6+3, 2d20 + 5)
// or GURPS control/frequency rolls (CR12, FR9, cr 14, etc.).
//
// Group layout:
//   1: dice count        e.g. "3" in "3d6"
//   2: dice sides        e.g. "6"
//   3: sign (+|-)        optional
//   4: modifier (digits) optional
//   5: gurps type        "CR" | "FR"
//   6: gurps target      digits
const TOKEN_SOURCE =
	"\\b(?:(\\d{1,4})[dD](\\d{1,4})(?:\\s*([+-])\\s*(\\d{1,4}))?|(CR|FR)\\s?(\\d{1,2}))\\b";
const TOKEN_FLAGS = "gi";

function freshTokenRegex(): RegExp {
	return new RegExp(TOKEN_SOURCE, TOKEN_FLAGS);
}

function isTokenString(s: string): boolean {
	return new RegExp("^(?:" + TOKEN_SOURCE.replace(/\\b/g, "") + ")$", "i").test(
		s.trim()
	);
}

// ---------- Settings ----------

type DisplayMode = "notice" | "popup";

interface DiceRollerSettings {
	displayMode: DisplayMode;
	durationMs: number;
}

const DEFAULT_SETTINGS: DiceRollerSettings = {
	displayMode: "notice",
	durationMs: 6000,
};

let pluginRef: InlineDiceRollerPlugin | null = null;
function currentSettings(): DiceRollerSettings {
	return pluginRef?.settings ?? DEFAULT_SETTINGS;
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
	  };

function parseToken(raw: string): ParsedToken | null {
	const s = raw.trim();
	const diceMatch = /^(\d{1,4})[dD](\d{1,4})(?:\s*([+-])\s*(\d{1,4}))?$/.exec(s);
	if (diceMatch) {
		const count = parseInt(diceMatch[1], 10);
		const sides = parseInt(diceMatch[2], 10);
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
type RollOutcome = DiceRoll | GurpsRoll;

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
	// GURPS: always 3d6 vs target
	const rolls: number[] = [];
	for (let i = 0; i < 3; i++) rolls.push(1 + Math.floor(Math.random() * 6));
	const total = rolls.reduce((a, b) => a + b, 0);
	const margin = token.target - total;
	return {
		kind: "gurps",
		token,
		rolls,
		total,
		margin,
		success: total <= token.target,
	};
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
		const label = r.token.type === "CR" ? "Control Roll" : "Frequency Roll";
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
		// Stateless test to avoid any lastIndex carry-over between nodes.
		if (freshTokenRegex().test(text)) {
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

	const frag = document.createDocumentFragment();
	let lastIndex = 0;
	const regex = freshTokenRegex();
	let m: RegExpExecArray | null;
	while ((m = regex.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		if (start > lastIndex) {
			frag.appendChild(
				document.createTextNode(text.slice(lastIndex, start))
			);
		}
		const span = document.createElement("span");
		span.className = "dice-roller-inline";
		span.textContent = m[0];
		span.setAttribute("data-dice", m[0]);
		span.setAttribute("aria-label", `Roll ${m[0]}`);
		span.setAttribute("role", "button");
		const notation = m[0];
		span.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			showRollResult(notation, evt);
		});
		frag.appendChild(span);
		lastIndex = end;
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
		const regex = freshTokenRegex();
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const start = from + match.index;
			const end = start + match[0].length;

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
	}
}

// ---------- Plugin entry ----------

export default class InlineDiceRollerPlugin extends Plugin {
	settings: DiceRollerSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		pluginRef = this;
		await this.loadSettings();

		this.registerMarkdownPostProcessor(processReadingView);
		this.registerEditorExtension(diceViewPlugin);
		this.addSettingTab(new DiceRollerSettingTab(this.app, this));

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
